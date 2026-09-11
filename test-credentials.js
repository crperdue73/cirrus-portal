#!/usr/bin/env node
'use strict';
/**
 * test-credentials.js — smoke test for plan item 2 (kill default credentials).
 *
 * Runs the real server in throwaway temp dirs and asserts:
 *   A. fresh boot mints `admin` with the configured unique password (never "admin")
 *   B. the startup guard REFUSES to boot when an admin uses a known-default password
 *   C. PORTAL_ALLOW_INSECURE_DEFAULTS=1 overrides the guard (dev escape hatch)
 *
 * Zero dependencies. Run: node test-credentials.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const SRC = __dirname;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-cred-')); made.push(d); return d; };

function setup(dir, { users, portalPassword } = {}) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    port: 18900 + Math.floor(Math.random() * 90),
    bind: '127.0.0.1',
    gateways: [],
    portalPassword: portalPassword || '',
    sessionTtlHours: 12,
  }));
  if (users) fs.writeFileSync(path.join(dir, 'portal-users.json'), JSON.stringify({ users }, null, 2));
}

// Spawn the server and resolve when `matcher(stdout, stderr)` is true, when the
// process exits, or after `timeoutMs` (whichever first). Always kills the child.
function runUntil(dir, env, matcher, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', done = false;
    const finish = (code) => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ code, out, err });
    };
    const t = setTimeout(() => finish('timeout'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (matcher(out, err)) { clearTimeout(t); finish('matched'); } });
    child.stderr.on('data', (d) => { err += d; if (matcher(out, err)) { clearTimeout(t); finish('matched'); } });
    child.on('exit', (code) => { clearTimeout(t); finish(code); });
    child.on('error', () => { clearTimeout(t); finish('spawn-error'); });
  });
}

const scrypt = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

(async () => {
  let pass = 0;

  // ── A. fresh boot mints a unique admin password (from config) ──────────────
  {
    const d = tmp();
    const pw = 'Zx9-unique-Pass-42';
    setup(d, { portalPassword: pw });
    const r = await runUntil(d, {}, (out) => out.includes('users:'));
    assert(r.out.includes('users:'), `A: server never booted\nstdout=${r.out}\nstderr=${r.err}`);
    assert(r.err.includes('created "admin"'), `A: no mint message\nstderr=${r.err}`);
    const admin = JSON.parse(fs.readFileSync(path.join(d, 'portal-users.json'), 'utf8')).users.find((u) => u.role === 'admin');
    assert(admin, 'A: no admin account written');
    assert(scrypt('admin', admin.salt) !== admin.hash, 'A: admin password IS the default "admin"!');
    assert(scrypt(pw, admin.salt) === admin.hash, 'A: admin password does not match the configured secret');
    console.log('✓ A: fresh boot mints a unique admin (not admin/admin)');
    pass++;
  }

  // ── B. startup guard refuses to boot on a known-default credential ─────────
  {
    const d = tmp();
    const salt = crypto.randomBytes(16).toString('hex');
    setup(d, { users: [{ username: 'admin', displayName: 'Admin', role: 'admin', agents: ['*'], salt, hash: scrypt('admin', salt), createdAt: Date.now() }] });
    const r = await runUntil(d, {}, (out, err) => err.includes('refusing to start'));
    assert(r.err.includes('refusing to start'), `B: guard did not fire\nstdout=${r.out}\nstderr=${r.err}`);
    assert(r.out.includes('users:') === false, 'B: server booted anyway — guard ineffective');
    console.log('✓ B: startup guard refuses to run on admin/admin');
    pass++;
  }

  // ── C. dev override lets it boot (with a loud warning) ─────────────────────
  {
    const d = tmp();
    const salt = crypto.randomBytes(16).toString('hex');
    setup(d, { users: [{ username: 'admin', displayName: 'Admin', role: 'admin', agents: ['*'], salt, hash: scrypt('admin', salt), createdAt: Date.now() }] });
    const r = await runUntil(d, { PORTAL_ALLOW_INSECURE_DEFAULTS: '1' }, (out) => out.includes('users:'));
    assert(r.out.includes('users:'), `C: override did not let it boot\nstdout=${r.out}\nstderr=${r.err}`);
    assert(r.err.includes('PORTAL_ALLOW_INSECURE_DEFAULTS'), 'C: no warning emitted');
    console.log('✓ C: PORTAL_ALLOW_INSECURE_DEFAULTS=1 override works (with warning)');
    pass++;
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/3 credential checks passed`);
})().catch((e) => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ credential test FAILED:', e.message);
  process.exit(1);
});
