#!/usr/bin/env node
'use strict';
/**
 * test-container.js — smoke test for plan item 8 (container hardening).
 *
 * Asserts the shipped artifacts actually carry the hardening, and that the
 * one behavioural change it needed works:
 *   A. Dockerfile: digest-pinned base, non-root USER (uid:gid 10001), HEALTHCHECK
 *   B. docker-compose.yml: read-only rootfs, tmpfs, cap_drop ALL,
 *      no-new-privileges, cpu/mem/pid limits
 *   C. healthcheck.js: real loopback probe — exit 0 up, 1 down
 *   D. healthcheck.js ships (release.sh FILES) and reaches the image (Dockerfile COPY)
 *   E. install.sh/bootstrap.sh hand the bind-mounts to the container uid and
 *      doctor reports ownership drift
 *   F. secrets write survives a read-only image rootfs (non-renameable temp stage)
 *
 * Zero dependencies. Run: node test-container.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const SRC = __dirname;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-cont-')); made.push(d); return d; };
const rnd = (base) => base + Math.floor(Math.random() * 80);

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// Spawn the server; resolve once it prints its ready banner (or on exit/timeout).
function startServer(dir, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ out, err, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const t = setTimeout(finish, 8000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('users:')) { clearTimeout(t); finish(); } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { clearTimeout(t); finish(); });
  });
}

// Run a node script asynchronously (spawnSync would block the in-process test
// server's event loop, so the probe could never connect).
function runNode(script, cwd) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}

(async () => {
  let pass = 0;

  // ── A. Dockerfile hardening ────────────────────────────────────────────────
  {
    const df = read('Dockerfile');
    assert(/^FROM node:22-alpine@sha256:[0-9a-f]{64}$/m.test(df),
      'A: base image must be pinned by sha256 digest');
    assert(/ARG PORTAL_UID=10001/.test(df) && /ARG PORTAL_GID=10001/.test(df),
      'A: expected fixed PORTAL_UID/GID build args (10001)');
    assert(/adduser -u "\$PORTAL_UID"/.test(df) && /addgroup -g "\$PORTAL_GID"/.test(df),
      'A: expected a non-root user to be created');
    assert(/^USER \$PORTAL_UID:\$PORTAL_GID$/m.test(df), 'A: expected USER to be the non-root portal user');
    assert(!/USER\s+(root|0)\b/.test(df), 'A: must not run as root');
    assert(/HEALTHCHECK.+healthcheck\.js/s.test(df), 'A: expected a HEALTHCHECK hitting healthcheck.js');
    assert(/COPY .*healthcheck\.js/.test(df), 'A: healthcheck.js must be COPYed into the image');
    console.log('✓ A: Dockerfile — digest-pinned base, non-root USER(10001), HEALTHCHECK');
    pass++;
  }

  // ── B. docker-compose.yml hardening ────────────────────────────────────────
  {
    const yml = read('docker-compose.yml');
    assert(/read_only:\s*true/.test(yml), 'B: read_only: true missing');
    assert(/tmpfs:\s*\n\s*-\s*\/tmp:/.test(yml), 'B: /tmp tmpfs missing (needed by a read-only rootfs)');
    assert(/cap_drop:\s*\n\s*-\s*ALL/.test(yml), 'B: cap_drop ALL missing');
    assert(/no-new-privileges:true/.test(yml), 'B: no-new-privileges missing');
    assert(/mem_limit:\s*\d+\s*m/.test(yml), 'B: memory limit missing');
    assert(/cpus:\s*"?[\d.]+"?/.test(yml), 'B: cpu limit missing');
    assert(/pids_limit:\s*\d+/.test(yml), 'B: pids_limit missing');
    console.log('✓ B: docker-compose.yml — read-only rootfs + tmpfs + caps + limits');
    pass++;
  }

  // ── C. healthcheck.js is a real probe ──────────────────────────────────────
  {
    const chk = spawnSync(process.execPath, ['--check', path.join(SRC, 'healthcheck.js')], { encoding: 'utf8' });
    assert(chk.status === 0, `C: healthcheck.js failed node --check:\n${chk.stderr}`);

    const d = tmp();
    fs.copyFileSync(path.join(SRC, 'healthcheck.js'), path.join(d, 'healthcheck.js'));
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    fs.writeFileSync(path.join(d, 'portal-config.json'), JSON.stringify({ port, bind: '127.0.0.1' }, null, 2));

    const up = await runNode('healthcheck.js', d);
    assert(up.code === 0, `C: healthcheck should be healthy while serving (exit ${up.code})\n${up.err}`);
    await new Promise((r) => srv.close(r));

    const down = await runNode('healthcheck.js', d);
    assert(down.code === 1, `C: healthcheck should fail when nothing is listening (exit ${down.code})`);
    console.log('✓ C: healthcheck.js — exit 0 while serving, exit 1 when down');
    pass++;
  }

  // ── D. healthcheck.js ships ────────────────────────────────────────────────
  {
    assert(/^\s*healthcheck\.js\s*$/m.test(read('release.sh')), 'D: release.sh FILES must include healthcheck.js');
    assert(read('Dockerfile').includes('healthcheck.js'), 'D: Dockerfile must copy healthcheck.js');
    console.log('✓ D: healthcheck.js is shipped (release.sh + Dockerfile)');
    pass++;
  }

  // ── E. installers own the bind-mounts to the container uid ─────────────────
  {
    const inst = read('install.sh');
    assert(/PORTAL_UID="\$\{PORTAL_UID:-10001\}"/.test(inst), 'E: install.sh must default PORTAL_UID to 10001');
    assert(/chown_state_to_container/.test(inst), 'E: install.sh missing chown_state_to_container helper/call');
    assert(/chown "\$PORTAL_UID:\$PORTAL_GID"/.test(inst), 'E: install.sh must chown state to the container uid:gid');
    assert(/owned by container user/.test(inst), 'E: install.sh doctor must report container ownership');

    const boot = read('bootstrap.sh');
    assert(/chown 10001:10001/.test(boot), 'E: bootstrap.sh must chown state to 10001:10001');
    console.log('✓ E: install.sh/bootstrap.sh hand bind-mounts to uid:gid 10001; doctor flags drift');
    pass++;
  }

  // ── F. secrets write survives a read-only rootfs ───────────────────────────
  {
    const d = tmp();
    fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(d, 'portal-server.js'));
    fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(d, 'branding.json'));
    const LEGACY = 'ro-fs-token-0123456789abcdef';
    fs.writeFileSync(path.join(d, 'portal-config.json'), JSON.stringify({
      port: rnd(19600), bind: '127.0.0.1', tlsMode: 'off',
      gateways: [{ id: 'home', name: 'Home', url: 'ws://127.0.0.1:9', token: LEGACY, enabled: true }],
      portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12,
    }, null, 2));
    // Simulate a read-only image rootfs: the temp stage path can't be written
    // (here it's a directory → EISDIR), so only the direct write can succeed.
    fs.mkdirSync(path.join(d, 'portal-secrets.json.tmp'));

    const s = await startServer(d);
    s.stop();
    const sp = path.join(d, 'portal-secrets.json');
    assert(fs.existsSync(sp), `F: secrets file not written despite the fallback\nstderr=${s.err}`);
    const secrets = JSON.parse(fs.readFileSync(sp, 'utf8'));
    assert(secrets.gatewayTokens && secrets.gatewayTokens.home === LEGACY,
      `F: token not persisted via the read-only-safe path\nstderr=${s.err}`);
    assert(!fs.existsSync(path.join(d, 'portal-secrets.json.tmp')),
      'F: temp stage should have been cleaned up');
    console.log('✓ F: secrets write falls back cleanly when the temp stage is unavailable');
    pass++;
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 container-hardening checks passed`);
})().catch((e) => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ container-hardening test FAILED:', e.message);
  process.exit(1);
});
