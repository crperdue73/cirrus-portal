#!/usr/bin/env node
'use strict';
/**
 * test-setup.js — smoke test for plan item 4 (first-run setup wizard).
 *
 * Runs the REAL server in throwaway temp dirs and asserts:
 *   A. a bare fresh box (no users, no configured password) enters SETUP mode:
 *      `/` redirects to /setup, /api/setup/status says needed, and every other
 *      API (login included) is refused — no working default exists.
 *   B. the wizard rejects a weak password and creates NOTHING until it passes.
 *   C. a valid wizard POST mints the admin, records bind/port/TLS, returns a
 *      working session, and is the only way in.
 *   D. an installer/headless box (portalPassword in config) does NOT enter
 *      setup mode — item 2's auto-mint behavior is preserved.
 *
 * Waits for the server's final banner line (`ready.`) so the whole startup
 * banner is flushed before assertions run.
 *
 * Zero dependencies. Run: node test-setup.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-setup-')); made.push(d); return d; };

function setup(dir, { config } = {}) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.copyFileSync(path.join(SRC, 'setup.html'), path.join(dir, 'setup.html'));
  fs.copyFileSync(path.join(SRC, 'portal.html'), path.join(dir, 'portal.html'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(config || {
    port: 19300 + Math.floor(Math.random() * 90),
    bind: '127.0.0.1',
    gateways: [],
    portalPassword: '',
    sessionTtlHours: 12,
  }, null, 2));
}

function startServer(dir, env) {
  return new Promise((resolve) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, out, err, port: cfg.port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const timer = setTimeout(finish, 8000);
    const onData = (d) => { out += d; if (out.includes('ready.')) { clearTimeout(timer); finish(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { clearTimeout(timer); finish(); });
  });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

(async () => {
  let pass = 0;
  const GOOD = 'Wt7-harbor-Vane-92';

  // ── A. bare fresh box → SETUP mode, everything else refused ────────────────
  {
    const d = tmp();
    setup(d);
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      assert(s.out.includes('setup:   REQUIRED'), `A: no setup banner\nstdout=${s.out}`);

      const root = await fetch(base + '/', { redirect: 'manual' });
      assert(root.status === 302 && root.headers.get('location') === '/setup', `A: / did not redirect to /setup (${root.status} ${root.headers.get('location')})`);

      const page = await fetch(base + '/setup');
      assert(page.status === 200 && /setup wizard/i.test(await page.text()), 'A: /setup did not serve the wizard');

      const status = await (await fetch(base + '/api/setup/status')).json();
      assert(status.needed === true, 'A: setup/status.needed should be true');

      const login = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'anything' }),
      });
      assert(login.status === 503, `A: login should be refused during setup (got ${login.status})`);

      const me = await fetch(base + '/api/me');
      assert(me.status === 503, `A: /api/me should be refused during setup (got ${me.status})`);
      const meBody = await me.json();
      assert(meBody.setupRequired === true, 'A: refusal should flag setupRequired');
      console.log('✓ A: fresh box enters SETUP mode; / → /setup; all other APIs refused');
      pass++;
    } finally { s.stop(); }
  }

  // ── B/C. weak password rejected, then valid wizard creates the admin ───────
  {
    const d = tmp();
    setup(d);
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;

      const weak = await fetch(base + '/api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'robbie', password: 'admin', passwordConfirm: 'admin' }),
      });
      assert(weak.status === 400, `B: weak password should be 400 (got ${weak.status})`);
      assert(!fs.existsSync(path.join(d, 'portal-users.json')), 'B: no user file should exist after a rejected setup');

      const ok = await fetch(base + '/api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'robbie', displayName: 'Robbie', password: GOOD, passwordConfirm: GOOD,
          bind: '127.0.0.1', port: 0 + JSON.parse(fs.readFileSync(path.join(d, 'portal-config.json'), 'utf8')).port,
          tlsMode: 'auto',
          gateway: { id: 'home', url: 'ws://127.0.0.1:9', name: 'Home', token: 'setup-gw-token-0123456789abcdef' },
        }),
      });
      const body = await ok.json();
      assert(ok.ok, `C: valid setup failed (${ok.status}) ${JSON.stringify(body)}`);
      const cookie = (ok.headers.get('set-cookie') || '').split(';')[0];
      assert(cookie.startsWith('portal_session='), 'C: no session cookie from setup');

      // Users file now has the admin, hashed (never plaintext).
      const users = readJson(path.join(d, 'portal-users.json')).users;
      const admin = users.find((u) => u.role === 'admin');
      assert(admin && admin.username === 'robbie', 'C: admin account not written');
      assert(!JSON.stringify(users).includes(GOOD), 'C: password stored in plaintext!');

      // Config records bind/port/tlsMode and stays token/password-free.
      const cfgRaw = fs.readFileSync(path.join(d, 'portal-config.json'), 'utf8');
      assert(JSON.parse(cfgRaw).tlsMode === 'auto', 'C: tlsMode not recorded');
      assert(!/"token"\s*:/.test(cfgRaw), 'C: gateway token leaked into config');
      const secrets = readJson(path.join(d, 'portal-secrets.json'));
      assert(secrets.gatewayTokens && secrets.gatewayTokens.home === 'setup-gw-token-0123456789abcdef', 'C: gateway token not in secrets');

      // The setup session actually works, and login with the new password works.
      const me = await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json();
      assert(me.authed === true && me.user.username === 'robbie', 'C: setup session not authenticated');
      const login = await fetch(base + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'robbie', password: GOOD }),
      });
      assert(login.ok, `C: login with the new admin password failed (${login.status})`);

      // Setup cannot be re-run now.
      const again = await fetch(base + '/api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'sneaky', password: GOOD, passwordConfirm: GOOD }),
      });
      assert(again.status === 403, `C: re-running setup should be 403 (got ${again.status})`);

      // / now serves the app shell again.
      const root = await fetch(base + '/', { redirect: 'manual' });
      assert(root.status === 200, `C: / should serve the portal after setup (got ${root.status})`);
      console.log('✓ B/C: weak password rejected; wizard mints admin + records config; session works; setup closed');
      pass++;
    } finally { s.stop(); }
  }

  // ── D. installer/headless box skips setup (item 2 auto-mint preserved) ─────
  {
    const d = tmp();
    setup(d, { config: { port: 19400 + Math.floor(Math.random() * 80), bind: '127.0.0.1', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12 } });
    const s = await startServer(d);
    try {
      assert(!s.out.includes('setup:   REQUIRED'), `D: headless box should NOT require setup\nstdout=${s.out}`);
      const status = await (await fetch(`http://127.0.0.1:${s.port}/api/setup/status`)).json();
      assert(status.needed === false, 'D: setup should not be needed');
      const admin = readJson(path.join(d, 'portal-users.json')).users.find((u) => u.role === 'admin');
      assert(admin, 'D: admin was not minted on a headless box');
      console.log('✓ D: headless box with a configured password auto-mints (no wizard) — item 2 intact');
      pass++;
    } finally { s.stop(); }
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/3 setup checks passed`);
})().catch((e) => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ setup test FAILED:', e.message);
  process.exit(1);
});
