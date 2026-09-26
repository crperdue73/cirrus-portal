#!/usr/bin/env node
'use strict';
/**
 * test-agent-bearer.js — smoke test for plan item 1b (agent Bearer auth).
 *
 * Runs the REAL server in a throwaway temp dir, mints an agent token through
 * the admin API, and drives /api/agent/* exactly as a remote agent would.
 * Asserts:
 *   A. valid Bearer on /api/agent/whoami → 200, identity from the token only
 *   B. bad credentials refused — missing header, wrong scheme (Basic), unknown
 *      token, and whitespace-only all 401
 *   C. revoke + rotate — the old secret stops working, the new one works
 *   D. scope isolation — a Bearer token does NOT authenticate any human/admin
 *      route (/api/me, /api/agents, /api/agent-tokens all ignore it), and a
 *      session cookie does NOT reach /api/agent/*
 *   E. no CSRF on the agent surface — an agent POST is not 403'd by the CSRF
 *      gate (it reaches the handler and 405s on method instead)
 *   F. audit — auth failures and successful agent calls are logged, and the
 *      secret never lands in the audit log
 *
 * Zero dependencies. Run: node test-agent-bearer.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-abear-')); made.push(d); return d; };

function setup(dir) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    port: 19500 + Math.floor(Math.random() * 200),
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

async function login(base, username, password) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  assert(r.ok, `login ${username} failed (${r.status}) ${JSON.stringify(j)}`);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j.csrfToken };
}

// Mint an agent token and return the plaintext secret.
async function mint(base, admin, fields) {
  const r = await fetch(`${base}/api/agent-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(fields),
  });
  const j = await r.json();
  assert(r.ok, `mint failed (${r.status}) ${JSON.stringify(j)}`);
  return j;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

(async () => {
  let pass = 0;
  const d = tmp();
  setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  let currentToken;
  try {
    const admin = await login(base, 'admin', PW);
    const m = await mint(base, admin, { agentId: 'noah', gatewayId: 'home', label: 'noah@home' });
    currentToken = m.token;

    // ── A. valid Bearer → identity from the token, nothing else ─────────
    {
      const r = await fetch(`${base}/api/agent/whoami`, { headers: bearer(currentToken) });
      const j = await r.json();
      assert(r.ok, `A: valid token status ${r.status} ${JSON.stringify(j)}`);
      assert(j.agent && j.agent.agentId === 'noah' && j.agent.gatewayId === 'home' && j.agent.label === 'noah@home', 'A: identity wrong');
      const raw = JSON.stringify(j);
      assert(!('hash' in j.agent) && !('salt' in j.agent) && !('lookup' in j.agent) && !('token' in j.agent), 'A: response leaked credential fields');
      assert(raw.indexOf(currentToken) === -1, 'A: response leaked the secret');
      console.log('✓ A: valid Bearer authenticates /api/agent/whoami; identity from token, no secret leaked');
      pass++;
    }

    // ── B. bad credentials all refused ─────────────────────────────────
    {
      const none = await fetch(`${base}/api/agent/whoami`);
      assert(none.status === 401, `B: no header → ${none.status}, expected 401`);
      const basic = await fetch(`${base}/api/agent/whoami`, { headers: { Authorization: 'Basic ' + Buffer.from('noah:x').toString('base64') } });
      assert(basic.status === 401, `B: Basic scheme → ${basic.status}, expected 401`);
      const unknown = await fetch(`${base}/api/agent/whoami`, { headers: bearer('cpat_' + crypto.randomBytes(24).toString('base64url')) });
      assert(unknown.status === 401, `B: unknown token → ${unknown.status}, expected 401`);
      const blank = await fetch(`${base}/api/agent/whoami`, { headers: { Authorization: 'Bearer   ' } });
      assert(blank.status === 401, `B: blank token → ${blank.status}, expected 401`);
      console.log('✓ B: missing / wrong-scheme / unknown / blank credentials all 401');
      pass++;
    }

    // ── C. rotate (old dies) then revoke (new dies) ────────────────────
    {
      const rr = await fetch(`${base}/api/agent-tokens/${m.agentToken.id}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf }, body: '{}',
      });
      const rj = await rr.json();
      assert(rr.ok, `C: rotate failed (${rr.status})`);
      const newTok = rj.token;
      assert(newTok && newTok !== currentToken, 'C: rotate did not issue a new secret');

      const oldTry = await fetch(`${base}/api/agent/whoami`, { headers: bearer(currentToken) });
      assert(oldTry.status === 401, `C: rotated-away secret still works (${oldTry.status})`);
      const newTry = await fetch(`${base}/api/agent/whoami`, { headers: bearer(newTok) });
      assert(newTry.ok, `C: new secret rejected (${newTry.status})`);
      currentToken = newTok;

      const dr = await fetch(`${base}/api/agent-tokens/${m.agentToken.id}`, {
        method: 'DELETE', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      });
      assert(dr.ok, `C: revoke failed (${dr.status})`);
      const revokedTry = await fetch(`${base}/api/agent/whoami`, { headers: bearer(currentToken) });
      assert(revokedTry.status === 401, `C: revoked token still works (${revokedTry.status})`);
      console.log('✓ C: rotate invalidates the old secret; revoke invalidates the new one');
      pass++;
    }

    // Re-mint for the remaining checks.
    const m2 = await mint(base, admin, { agentId: 'noah', gatewayId: 'home', label: 'noah@home' });
    const tok = m2.token;

    // ── D. scope isolation (both directions) ───────────────────────────
    {
      // Bearer must NOT authenticate any human/admin route.
      const me = await fetch(`${base}/api/me`, { headers: bearer(tok) });
      const meJ = await me.json();
      assert(meJ.authed === false, 'D: Bearer authenticated /api/me!');
      const agents = await fetch(`${base}/api/agents`, { headers: bearer(tok) });
      assert(agents.status === 401, `D: Bearer on /api/agents → ${agents.status}, expected 401`);
      const atok = await fetch(`${base}/api/agent-tokens`, { headers: bearer(tok) });
      assert(atok.status === 401, `D: Bearer on /api/agent-tokens → ${atok.status}, expected 401`);
      // A session cookie must NOT reach the agent surface.
      const cookieTry = await fetch(`${base}/api/agent/whoami`, { headers: { Cookie: admin.cookie } });
      assert(cookieTry.status === 401, `D: session cookie reached /api/agent/* (${cookieTry.status})`);
      console.log('✓ D: Bearer is inert on human/admin routes; cookie session is refused on /api/agent/*');
      pass++;
    }

    // ── E. no CSRF on the agent surface ────────────────────────────────
    {
      const post = await fetch(`${base}/api/agent/whoami`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(tok) }, body: '{}',
      });
      assert(post.status !== 403, `E: agent POST was CSRF-blocked (${post.status}) — the agent path must not require CSRF`);
      assert(post.status === 405, `E: agent POST → ${post.status}, expected 405 method-not-allowed`);
      console.log('✓ E: agent POST is not CSRF-gated (405 on method, not 403)');
      pass++;
    }

    // ── F. audit trail, and no secret in it ────────────────────────────
    {
      const raw = fs.readFileSync(path.join(d, 'portal-audit.log'), 'utf8');
      const lines = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
      const actions = new Set(lines.map(e => e.action));
      for (const want of ['agent_auth_missing', 'agent_auth_reject', 'agent_call']) {
        assert(actions.has(want), `F: missing audit action ${want}`);
      }
      assert(raw.indexOf(tok) === -1 && raw.indexOf(currentToken) === -1 && raw.indexOf(m.token) === -1, 'F: a secret leaked into the audit log!');
      for (const e of lines) {
        if (e.action && e.action.startsWith('agent_')) assert(!e.detail || !('secret' in e.detail), 'F: audit detail carried a secret field');
      }
      console.log('✓ F: auth failures + agent calls audited; no secret in the audit log');
      pass++;
    }
  } finally {
    s.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 agent-bearer checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-bearer test FAILED:', e.message);
  process.exit(1);
});
