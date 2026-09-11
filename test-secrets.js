#!/usr/bin/env node
'use strict';
/**
 * test-secrets.js — smoke test for plan item 3 (secrets at rest + leak guards).
 *
 * Runs the REAL server and the REAL secret-scan.sh in throwaway temp dirs and
 * asserts:
 *   A. legacy portal-config.json gateway tokens are MIGRATED to
 *      portal-secrets.json (0600) and STRIPPED from the config on boot
 *   B. gateway tokens are masked in every API response (hasToken, never value)
 *   C. a token added via the API is persisted to the secrets file, not config
 *   D. secret-scan.sh flags a planted token and reports the repo itself clean
 *
 * Zero dependencies. Run: node test-secrets.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-secret-')); made.push(d); return d; };

function setup(dir, { gateways, portalPassword, secrets } = {}) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    port: 19100 + Math.floor(Math.random() * 80),
    bind: '127.0.0.1',
    gateways: gateways || [],
    portalPassword: portalPassword || '',
    sessionTtlHours: 12,
  }, null, 2));
  if (secrets) fs.writeFileSync(path.join(dir, 'portal-secrets.json'), JSON.stringify(secrets, null, 2));
}

function startServer(dir) {
  return new Promise((resolve) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: 'Zx9-unique-Pass-42' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, out, err, port: cfg.port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const timer = setTimeout(finish, 8000);
    const onData = (d) => { out += d; if (out.includes('users:')) { clearTimeout(timer); finish(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { clearTimeout(timer); finish(); });
  });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

(async () => {
  let pass = 0;
  const LEGACY = 'legacy-gw-token-0123456789abcdef';
  const PW = 'Zx9-unique-Pass-42';

  // ── A. legacy config token keeps working but is MIGRATED + STRIPPED ────────
  {
    const d = tmp();
    setup(d, { gateways: [{ id: 'home', name: 'Home', url: 'ws://127.0.0.1:9', token: LEGACY, enabled: true }], portalPassword: PW });
    const s = await startServer(d);
    s.stop();
    const secretsPath = path.join(d, 'portal-secrets.json');
    const cfgPath = path.join(d, 'portal-config.json');
    assert(fs.existsSync(secretsPath), `A: portal-secrets.json not created\nstderr=${s.err}`);
    const secrets = readJson(secretsPath);
    assert(secrets.gatewayTokens && secrets.gatewayTokens.home === LEGACY, 'A: token not stored in secrets');
    assert(secrets.portalPassword === PW, 'A: bootstrap password not moved to secrets');
    assert(mode(secretsPath) === '600', `A: secrets mode is ${mode(secretsPath)}, expected 600`);
    const cfgRaw = fs.readFileSync(cfgPath, 'utf8');
    assert(!/"token"\s*:/.test(cfgRaw), `A: portal-config.json still contains a token:\n${cfgRaw}`);
    assert((s.out + s.err).includes('migrated'), `A: no migration log line\nstdout=${s.out}\nstderr=${s.err}`);
    console.log('✓ A: legacy config token migrated to portal-secrets.json (0600) + stripped from config');
    pass++;
  }

  // ── B/C. tokens masked in API responses; API-set token goes to secrets ─────
  {
    const d = tmp();
    setup(d, { gateways: [{ id: 'home', name: 'Home', url: 'ws://127.0.0.1:9', token: LEGACY, enabled: true }], portalPassword: PW });
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const lr = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: PW }),
      });
      assert(lr.ok, `B: login failed (${lr.status})`);
      const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
      assert(cookie, 'B: no session cookie');
      const csrf = (await lr.json()).csrfToken; // plan item 6: state-changing calls need it
      assert(csrf, 'B: login did not return a csrf token');

      let gr = await fetch(`${base}/api/gateways`, { headers: { Cookie: cookie } });
      let gj = await gr.json();
      assert(Array.isArray(gj.gateways) && gj.gateways.length === 1, 'B: unexpected gateway list');
      assert(gj.gateways[0].hasToken === true, 'B: hasToken should be true');
      assert(!('token' in gj.gateways[0]), 'B: response leaked a token field!');
      assert(JSON.stringify(gj).indexOf(LEGACY) === -1, 'B: response leaked the token value!');

      // add a second gateway with a fresh token via the API
      const NEWTOK = 'api-set-token-fedcba9876543210';
      const pr = await fetch(`${base}/api/gateways`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
        body: JSON.stringify({ id: 'lab', name: 'Lab', url: 'ws://127.0.0.1:8', token: NEWTOK, enabled: false }),
      });
      const pj = await pr.json();
      assert(pr.ok, `C: add gateway failed (${pr.status}) ${JSON.stringify(pj)}`);
      assert(JSON.stringify(pj).indexOf(NEWTOK) === -1, 'C: add response leaked the token value!');

      const cfgRaw = fs.readFileSync(path.join(d, 'portal-config.json'), 'utf8');
      assert(!/"token"\s*:/.test(cfgRaw), `C: config gained a token:\n${cfgRaw}`);
      const secrets = readJson(path.join(d, 'portal-secrets.json'));
      assert(secrets.gatewayTokens.lab === NEWTOK, 'C: API-set token missing from secrets');
      console.log('✓ B/C: API masks tokens; API-set token persisted to secrets, not config');
      pass++;
    } finally {
      s.stop();
    }
  }

  // ── D. secret-scan.sh: repo clean, planted token flagged ───────────────────
  {
    const repo = spawnSync('bash', [path.join(SRC, 'secret-scan.sh')], { encoding: 'utf8' });
    assert(repo.status === 0, `D: repo scan not clean (${repo.status})\n${repo.stdout}\n${repo.stderr}`);

    const dd = tmp();
    fs.mkdirSync(path.join(dd, 'stage'));
    fs.writeFileSync(path.join(dd, 'stage', 'portal-config.json'),
      JSON.stringify({ gateways: [{ token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }] }));
    const bad = spawnSync('bash', [path.join(SRC, 'secret-scan.sh'), '--dir', path.join(dd, 'stage')], { encoding: 'utf8' });
    assert(bad.status === 1, `D: planted token NOT flagged (exit ${bad.status})`);
    console.log('✓ D: secret-scan.sh — repo clean, planted token flagged');
    pass++;
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/3 secrets checks passed`);
})().catch((e) => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ secrets test FAILED:', e.message);
  process.exit(1);
});
