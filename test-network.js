#!/usr/bin/env node
'use strict';
/**
 * test-network.js — smoke test for plan item 7 (safe network defaults).
 *
 * Runs the REAL server in throwaway temp dirs and asserts:
 *   A. a bare server (no portal-config.json) binds 127.0.0.1 — never public
 *   B. a public bind (0.0.0.0) with NO opt-in is REFUSED before it listens
 *   C. opting in (publicBind:true) still hits the TLS gate — cleartext refused
 *   D. opt-in via env (PORTAL_PUBLIC_BIND=1) + --insecure-plaintext boots, loudly
 *   E. opt-in via argv (--public-bind) works the same way
 *   F. bootstrap.sh/install.sh/docs carry the loopback default + ufw helper
 *
 * Zero dependencies. Run: node test-network.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-net-')); made.push(d); return d; };

// Copy the code + branding; write a config only when one is given.
function setup(dir, cfg) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  if (cfg) fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(cfg, null, 2));
}

// Spawn the server; resolve when `matcher` matches, on exit, or after timeout.
function spawnServer(dir, env, matcher, timeoutMs = 8000, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['portal-server.js', ...args], {
      cwd: dir, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', code = null, done = false;
    const stop = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const finish = (timedOut) => {
      if (done) return; done = true;
      clearTimeout(t);
      if (timedOut) stop();
      resolve({ out, err, code, stop });
    };
    const onData = (d) => { out += d; if (matcher(out, err)) finish(false); };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { err += d; if (matcher(out, err)) finish(false); });
    child.on('exit', (c) => { code = c; finish(false); });
    const t = setTimeout(() => finish(true), timeoutMs);
  });
}

const rnd = (base) => base + Math.floor(Math.random() * 60);

(async () => {
  let pass = 0;

  // ── A. no bind specified → loopback default ────────────────────────────────
  {
    const d = tmp();
    // No `bind` key: the server must fall back to its safe DEFAULTS.bind.
    setup(d, { port: rnd(19700), gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12 });
    const s = await spawnServer(d, {}, (out) => out.includes('ready.'));
    assert(s.code === null, `A: server exited early (code ${s.code})\nstderr=${s.err}`);
    assert(/listen:\s+http:\/\/127\.0\.0\.1:/.test(s.out), `A: expected loopback listen banner\nstdout=${s.out}`);
    assert(!/0\.0\.0\.0/.test(s.out), `A: default must not expose 0.0.0.0\nstdout=${s.out}`);
    assert(/loopback only/.test(s.out), `A: expected loopback 'net:' banner\nstdout=${s.out}`);
    s.stop();
    console.log('✓ A: server defaults to 127.0.0.1 (loopback, never 0.0.0.0)');
    pass++;
  }

  // ── B. public bind, no opt-in → REFUSED ────────────────────────────────────
  {
    const d = tmp();
    setup(d, { port: rnd(19760), bind: '0.0.0.0', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'off' });
    const s = await spawnServer(d, {}, () => false, 6000);
    assert(s.code !== null, 'B: server should have exited, not stayed up');
    assert(s.code === 1, `B: refusal should exit 1 (got ${s.code})`);
    assert(/refusing to bind non-loopback interface "0\.0\.0\.0" without an explicit opt-in/.test(s.err), `B: expected network refusal\nstderr=${s.err}`);
    console.log('✓ B: public bind without an explicit opt-in is refused before it listens');
    pass++;
  }

  // ── C. opt-in via config, still no TLS → TLS gate refuses ──────────────────
  {
    const d = tmp();
    setup(d, { port: rnd(19790), bind: '0.0.0.0', publicBind: true, gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'off' });
    const s = await spawnServer(d, {}, () => false, 6000);
    assert(s.code === 1, `C: should exit 1 (got ${s.code})`);
    assert(/refusing to bind 0\.0\.0\.0 without TLS/.test(s.err), `C: expected TLS refusal\nstderr=${s.err}`);
    assert(!/explicit opt-in/.test(s.err), 'C: network gate should have been satisfied by publicBind:true');
    console.log('✓ C: opt-in alone is not enough — cleartext public bind still refused by the TLS gate');
    pass++;
  }

  // ── D. opt-in via env + insecure-plaintext → boots, loudly ─────────────────
  {
    const d = tmp();
    setup(d, { port: rnd(19820), bind: '0.0.0.0', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'off' });
    const s = await spawnServer(d, { PORTAL_PUBLIC_BIND: '1', PORTAL_INSECURE_PLAINTEXT: '1' }, (out) => out.includes('ready.'));
    assert(s.code === null, `D: env opt-in should boot (code ${s.code})\nstderr=${s.err}`);
    assert(/PUBLIC BIND: 0\.0\.0\.0 listens on ALL interfaces/.test(s.err), `D: expected loud public-bind warning\nstderr=${s.err}`);
    assert(/INSECURE-PLAINTEXT/.test(s.err), 'D: expected insecure warning');
    assert(/net:\s+⚠ PUBLIC/.test(s.out), `D: expected public net banner\nstdout=${s.out}`);
    s.stop();
    console.log('✓ D: PORTAL_PUBLIC_BIND=1 + --insecure-plaintext boots with loud warnings');
    pass++;
  }

  // ── E. opt-in via argv (--public-bind) ─────────────────────────────────────
  {
    const d = tmp();
    setup(d, { port: rnd(19850), bind: '0.0.0.0', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'off' });
    const s = await spawnServer(d, { PORTAL_INSECURE_PLAINTEXT: '1' }, (out) => out.includes('ready.'), 8000, ['--public-bind']);
    assert(s.code === null, `E: argv opt-in should boot (code ${s.code})\nstderr=${s.err}`);
    assert(/PUBLIC BIND: 0\.0\.0\.0/.test(s.err), `E: expected public-bind warning via argv\nstderr=${s.err}`);
    s.stop();
    console.log('✓ E: --public-bind argv flag opts in to a public bind');
    pass++;
  }

  // ── F. bootstrap/install/docs carry the safe defaults + ufw helper ─────────
  {
    const boot = fs.readFileSync(path.join(SRC, 'bootstrap.sh'), 'utf8');
    assert(/BIND="\$\{BIND:-127\.0\.0\.1\}"/.test(boot), 'F: bootstrap.sh must default BIND to 127.0.0.1');
    assert(/--firewall\) DO_FIREWALL=1/.test(boot), 'F: bootstrap.sh missing --firewall flag');
    assert(/ufw allow "\$port\/tcp"/.test(boot), 'F: bootstrap.sh missing ufw helper');
    assert(/"publicBind": \$\(\[ is_loopback_bind "\$BIND" \]/.test(boot), 'F: bootstrap.sh must write publicBind into config');

    const inst = fs.readFileSync(path.join(SRC, 'install.sh'), 'utf8');
    assert(/BIND="\$\{BIND:-127\.0\.0\.1\}"/.test(inst), 'F: install.sh must default BIND to 127.0.0.1');
    assert(/--firewall/.test(inst) && /ufw/.test(inst), 'F: install.sh must document --firewall/ufw');
    assert(/"publicBind": \$\(\[ is_loopback_bind "\$BIND" \]/.test(inst), 'F: install.sh must write publicBind into config');

    const repl = fs.readFileSync(path.join(SRC, 'REPLICATION.md'), 'utf8');
    assert(/ufw allow/.test(repl), 'F: REPLICATION.md must document the ufw rule');
    const readme = fs.readFileSync(path.join(SRC, 'README.md'), 'utf8');
    assert(/--firewall/.test(readme), 'F: README.md must document --firewall');
    console.log('✓ F: loopback default + ufw helper present in installer/bootstrap/docs');
    pass++;
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 network-default checks passed`);
})().catch((e) => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ network-default test FAILED:', e.message);
  process.exit(1);
});
