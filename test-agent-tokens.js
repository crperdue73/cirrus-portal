#!/usr/bin/env node
'use strict';
/**
 * test-agent-tokens.js — smoke test for plan item 1a (agent token store).
 *
 * Runs the REAL server in a throwaway temp dir and drives the admin
 * /api/agent-tokens API exactly as the admin UI would. Asserts:
 *   A. access control — anon 401, student 403, admin 200 (empty)
 *   B. mint — secret returned exactly once; stored HASHED (scrypt) with a
 *      sha256 lookup index; identity fields only; 0600 secrets file; the raw
 *      secret never lands on disk or in any API response
 *   C. rotate — brand-new secret, old secret's lookup gone, identity preserved
 *   D. revoke — record removed; further rotate/delete 404
 *   E. CSRF — a token-mutating POST without the CSRF header is refused
 *   F. audit — mint/rotate/revoke each leave an audit entry (no secret in it)
 *
 * Zero dependencies. Run: node test-agent-tokens.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-atok-')); made.push(d); return d; };

function setup(dir) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    port: 19300 + Math.floor(Math.random() * 200),
    bind: '127.0.0.1',
    gateways: [],
    portalPassword: PW,
    sessionTtlHours: 12,
  }, null, 2));
}

function startServer(dir) {
  return new Promise((resolve) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'],
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
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function login(base, username, password) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  assert(r.ok, `login ${username} failed (${r.status}) ${JSON.stringify(j)}`);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j.csrfToken };
}

// Create a second (non-admin) account via the admin API, then log it in.
async function makeStudent(base, admin, username) {
  const pw = 'Stu-' + crypto.randomBytes(6).toString('hex') + '-9a';
  const cr = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify({ username, password: pw, role: 'student' }),
  });
  assert(cr.ok, `user create failed (${cr.status}) ${await cr.text()}`);
  return login(base, username, pw);
}

(async () => {
  let pass = 0;
  const d = tmp();
  setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  const secretsPath = path.join(d, 'portal-secrets.json');
  try {
    const admin = await login(base, 'admin', PW);
    const student = await makeStudent(base, admin, 'stu1');

    // ── A. access control ──────────────────────────────────────────────
    {
      const anon = await fetch(`${base}/api/agent-tokens`);
      assert(anon.status === 401, `A: anon status ${anon.status}, expected 401`);
      const sr = await fetch(`${base}/api/agent-tokens`, { headers: { Cookie: student.cookie } });
      assert(sr.status === 403, `A: student status ${sr.status}, expected 403`);
      const ar = await fetch(`${base}/api/agent-tokens`, { headers: { Cookie: admin.cookie } });
      assert(ar.ok, `A: admin status ${ar.status}`);
      const aj = await ar.json();
      assert(Array.isArray(aj.agentTokens) && aj.agentTokens.length === 0, 'A: expected an empty token list');
      console.log('✓ A: anon 401 · student 403 · admin 200 (empty list)');
      pass++;
    }

    // ── B. mint: hashed at rest, returned once, never leaked ───────────
    let minted;
    {
      const mr = await fetch(`${base}/api/agent-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({ agentId: 'noah', gatewayId: 'home', label: 'noah@home' }),
      });
      const mj = await mr.json();
      assert(mr.ok, `B: mint failed (${mr.status}) ${JSON.stringify(mj)}`);
      const token = mj.token;
      assert(typeof token === 'string' && token.startsWith('cpat_') && token.length > 20, 'B: no plaintext secret returned');
      const rec = mj.agentToken;
      assert(rec && rec.id && rec.agentId === 'noah' && rec.gatewayId === 'home' && rec.label === 'noah@home', 'B: identity fields wrong');
      assert(!('token' in rec) && !('hash' in rec) && !('salt' in rec) && !('lookup' in rec), 'B: response leaked credential fields');
      minted = { token, id: rec.id };

      // on disk: hashed, 0600, identity preserved, secret absent
      const sec = readJson(secretsPath);
      assert(sec.agentTokens && sec.agentTokens[rec.id], 'B: record not persisted to portal-secrets.json');
      const stored = sec.agentTokens[rec.id];
      assert(stored.hash && stored.salt && stored.lookup, 'B: stored record missing hash/salt/lookup');
      assert(stored.lookup === sha256(token), 'B: lookup is not sha256(secret)');
      const want = crypto.scryptSync(token, stored.salt, 64).toString('hex');
      assert(stored.hash === want, 'B: stored hash is not scrypt(secret, salt)');
      assert(mode(secretsPath) === '600', `B: secrets mode is ${mode(secretsPath)}, expected 600`);
      const rawFile = fs.readFileSync(secretsPath, 'utf8');
      assert(rawFile.indexOf(token) === -1, 'B: raw secret found in portal-secrets.json!');
      const cfgRaw = fs.readFileSync(path.join(d, 'portal-config.json'), 'utf8');
      assert(cfgRaw.indexOf(token) === -1, 'B: raw secret found in portal-config.json!');

      // list must not reveal the secret or the credential columns
      const lr = await fetch(`${base}/api/agent-tokens`, { headers: { Cookie: admin.cookie } });
      const lj = await lr.json();
      assert(lj.agentTokens.length === 1, 'B: list should hold one token');
      assert(lj.agentTokens[0].id === rec.id && lj.agentTokens[0].agentId === 'noah', 'B: list identity wrong');
      assert(JSON.stringify(lj).indexOf(token) === -1, 'B: list leaked the secret!');
      assert(!('hash' in lj.agentTokens[0]) && !('salt' in lj.agentTokens[0]) && !('lookup' in lj.agentTokens[0]), 'B: list leaked credential columns!');
      console.log('✓ B: minted secret returned once; stored hashed (scrypt + sha256 lookup), 0600; never leaked');
      pass++;
    }

    // ── C. rotate: new secret, old lookup gone, identity kept ──────────
    let rotated;
    {
      const rr = await fetch(`${base}/api/agent-tokens/${minted.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({}),
      });
      const rj = await rr.json();
      assert(rr.ok, `C: rotate failed (${rr.status}) ${JSON.stringify(rj)}`);
      const newTok = rj.token;
      assert(newTok && newTok !== minted.token, 'C: rotate did not issue a new secret');
      assert(rj.agentToken.agentId === 'noah' && rj.agentToken.gatewayId === 'home', 'C: rotate lost identity fields');
      assert(rj.agentToken.rotatedAt, 'C: rotatedAt not stamped');
      rotated = newTok;

      const sec = readJson(secretsPath);
      const stored = sec.agentTokens[minted.id];
      assert(stored.lookup === sha256(newTok), 'C: lookup not updated to the new secret');
      assert(stored.lookup !== sha256(minted.token), 'C: old secret still resolves — rotate did not invalidate it');
      assert(fs.readFileSync(secretsPath, 'utf8').indexOf(newTok) === -1, 'C: new secret stored in the clear!');
      console.log('✓ C: rotate issues a new secret, invalidates the old one, keeps identity');
      pass++;
    }

    // ── D. revoke ──────────────────────────────────────────────────────
    {
      const dr = await fetch(`${base}/api/agent-tokens/${minted.id}`, {
        method: 'DELETE', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      });
      assert(dr.ok, `D: revoke failed (${dr.status})`);
      const lr = await fetch(`${base}/api/agent-tokens`, { headers: { Cookie: admin.cookie } });
      const lj = await lr.json();
      assert(lj.agentTokens.length === 0, 'D: token still listed after revoke');
      const sec = readJson(secretsPath);
      assert(!sec.agentTokens[minted.id], 'D: record still on disk after revoke');
      const again = await fetch(`${base}/api/agent-tokens/${minted.id}/rotate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf }, body: '{}',
      });
      assert(again.status === 404, `D: rotate of a revoked token returned ${again.status}, expected 404`);
      console.log('✓ D: revoke removes the record; further rotate 404s');
      pass++;
    }

    // ── E. CSRF gate on token mutations ────────────────────────────────
    {
      const noCsrf = await fetch(`${base}/api/agent-tokens`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({ agentId: 'x' }),
      });
      assert(noCsrf.status === 403, `E: mint without CSRF returned ${noCsrf.status}, expected 403`);
      console.log('✓ E: token mutation without the CSRF header is refused');
      pass++;
    }

    // ── F. audit trail (and no secret in it) ───────────────────────────
    {
      const lines = fs.readFileSync(path.join(d, 'portal-audit.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const actions = new Set(lines.map(e => e.action));
      for (const want of ['agent_token_mint', 'agent_token_rotate', 'agent_token_revoke']) {
        assert(actions.has(want), `F: missing audit action ${want}`);
      }
      const raw = fs.readFileSync(path.join(d, 'portal-audit.log'), 'utf8');
      assert(raw.indexOf(minted.token) === -1 && raw.indexOf(rotated) === -1, 'F: a secret leaked into the audit log!');
      console.log('✓ F: mint/rotate/revoke audited; no secret in the audit log');
      pass++;
    }
  } finally {
    s.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 agent-token checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-tokens test FAILED:', e.message);
  process.exit(1);
});
