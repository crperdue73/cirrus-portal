#!/usr/bin/env node
'use strict';
/**
 * test-agent-api.js — Phase 1 acceptance test (plan item 1d).
 *
 * The per-item tests (1a test-agent-tokens · 1b test-agent-bearer · 1c
 * test-agent-guardrails) each prove one slice. This is the Phase 1 GATE: it
 * dances all four foundation guarantees in a single end-to-end flow against the
 * REAL server — minting tokens through the admin API exactly as an operator
 * would, and calling /api/agent/* exactly as a remote agent would — so a
 * regression in any slice fails here first.
 *
 *   A. token auth        — a valid Bearer authenticates; an unknown agent route
 *                          404s WITHOUT leaking the secret or the token store
 *   B. scope isolation   — a token is inert on human/admin routes, and a cookie
 *                          session is inert on /api/agent/* (both directions)
 *   C. revoked token     — revocation is immediate and authoritative (401), and
 *                          does not disturb a sibling token
 *   D. rate limit        — the per-token budget is enforced (429 + Retry-After)
 *                          and does not bleed into another token
 *   E. audit             — calls + failures are logged; no secret ever lands
 *   F. disabled limit    — agentRateLimitPerMinute=0 turns the limiter off
 *
 * Zero dependencies. Run: node test-agent-api.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const AGENT_RATE = 4; // per-token budget (+0 burst) → the 5th call is 429
const made = [];
const tmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cirrus-aapi-${tag}-`)); made.push(d); return d; };

const secrets = []; // plaintext secrets we minted — must never appear in the audit log

function setup(dir, extra) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    port: 19900 + Math.floor(Math.random() * 90),
    bind: '127.0.0.1',
    gateways: [],
    portalPassword: PW,
    sessionTtlHours: 12,
    ...(extra || {}),
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

async function mint(base, admin, fields) {
  const r = await fetch(`${base}/api/agent-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(fields),
  });
  const j = await r.json();
  assert(r.ok, `mint failed (${r.status}) ${JSON.stringify(j)}`);
  secrets.push(j.token);
  return j;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const whoami = (base, t) => fetch(`${base}/api/agent/whoami`, { headers: bearer(t) });

function auditLines(dir) {
  const raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8');
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

(async () => {
  let pass = 0;
  const d1 = tmp('gate');
  setup(d1, { agentRateLimitPerMinute: AGENT_RATE, agentRateLimitBurst: 0 });
  const s1 = await startServer(d1);
  const base = `http://127.0.0.1:${s1.port}`;
  try {
    const admin = await login(base, 'admin', PW);

    // ── A. token auth: valid Bearer authenticates; unknown route 404s ────
    {
      const m = await mint(base, admin, { agentId: 'noah', gatewayId: 'home', label: 'noah@home' });
      const ok = await whoami(base, m.token);
      const j = await ok.json();
      assert(ok.ok, `A: valid token → ${ok.status} ${JSON.stringify(j)}`);
      assert(j.agent && j.agent.agentId === 'noah' && j.agent.gatewayId === 'home' && j.agent.label === 'noah@home',
        'A: identity did not round-trip from the token');
      const raw = JSON.stringify(j);
      assert(!('hash' in j.agent) && !('salt' in j.agent) && !('lookup' in j.agent) && !('token' in j.agent),
        'A: whoami leaked credential fields');
      assert(raw.indexOf(m.token) === -1, 'A: whoami leaked the secret');

      const nope = await fetch(`${base}/api/agent/nope`, { headers: bearer(m.token) });
      assert(nope.status === 404, `A: unknown agent route → ${nope.status}, expected 404`);
      const nj = await nope.json();
      assert(!nj.error || !/token|hash|salt|lookup/i.test(nj.error), 'A: 404 body hinted at credential internals');
      console.log('✓ A: valid Bearer authenticates; unknown agent route 404s with no secret/token-store leak');
      pass++;
    }

    // ── B. scope isolation, both directions ─────────────────────────────
    {
      const m = await mint(base, admin, { agentId: 'iso', gatewayId: 'home', label: 'iso@home' });
      // token must be inert on human/admin routes
      const me = await (await fetch(`${base}/api/me`, { headers: bearer(m.token) })).json();
      assert(me.authed === false, 'B: Bearer authenticated /api/me!');
      const agents = await fetch(`${base}/api/agents`, { headers: bearer(m.token) });
      assert(agents.status === 401, `B: Bearer on /api/agents → ${agents.status}, expected 401`);
      const toks = await fetch(`${base}/api/agent-tokens`, { headers: bearer(m.token) });
      assert(toks.status === 401, `B: Bearer on /api/agent-tokens → ${toks.status}, expected 401`);
      // cookie session must be inert on the agent surface
      const cookieTry = await fetch(`${base}/api/agent/whoami`, { headers: { Cookie: admin.cookie } });
      assert(cookieTry.status === 401, `B: cookie session reached /api/agent/* (${cookieTry.status})`);
      console.log('✓ B: Bearer inert on human/admin routes; cookie session inert on /api/agent/*');
      pass++;
    }

    // ── C. revoked token rejected immediately + authoritative ───────────
    {
      const m = await mint(base, admin, { agentId: 'doomed', gatewayId: 'home', label: 'doomed@home' });
      const before = await whoami(base, m.token);
      assert(before.ok, `C: fresh token rejected (${before.status})`);
      const sib = await mint(base, admin, { agentId: 'sibling', gatewayId: 'home', label: 'sibling@home' });
      const dr = await fetch(`${base}/api/agent-tokens/${m.agentToken.id}`, {
        method: 'DELETE', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      });
      assert(dr.ok, `C: revoke failed (${dr.status})`);
      const after = await whoami(base, m.token);
      assert(after.status === 401, `C: revoked token still works (${after.status})`);
      const sibOk = await whoami(base, sib.token);
      assert(sibOk.ok, `C: revoke disturbed a sibling token (${sibOk.status})`);
      console.log('✓ C: revocation is immediate (401) and leaves sibling tokens untouched');
      pass++;
    }

    // ── D. rate limit enforced, per-token, no bleed ─────────────────────
    {
      const m = await mint(base, admin, { agentId: 'loud', gatewayId: 'home', label: 'loud@home' });
      for (let i = 1; i <= AGENT_RATE; i++) {
        const r = await whoami(base, m.token);
        assert(r.ok, `D: call ${i}/${AGENT_RATE} → ${r.status}, expected 200`);
      }
      const over = await whoami(base, m.token);
      assert(over.status === 429, `D: call ${AGENT_RATE + 1} → ${over.status}, expected 429`);
      const retry = Number(over.headers.get('retry-after') || 0);
      assert(retry > 0, 'D: 429 did not carry a positive Retry-After');
      const calm = await mint(base, admin, { agentId: 'calm', gatewayId: 'home', label: 'calm@home' });
      const calmOk = await whoami(base, calm.token);
      assert(calmOk.ok, `D: one token's exhaustion bled into another (${calmOk.status})`);
      console.log(`✓ D: per-token budget enforced (429 + Retry-After ${retry}s); no bleed into other tokens`);
      pass++;
    }

    // ── E. audit trail complete, and secret-free ────────────────────────
    {
      const { raw, lines } = auditLines(d1);
      const actions = new Set(lines.map((e) => e.action));
      for (const want of ['agent_call', 'agent_auth_missing', 'agent_auth_reject', 'agent_rate_limited']) {
        assert(actions.has(want), `E: missing audit action ${want}`);
      }
      for (const s of secrets) assert(raw.indexOf(s) === -1, 'E: a secret leaked into the audit log!');
      for (const e of lines) {
        if (e.action && e.action.startsWith('agent_')) {
          assert(!e.detail || !('secret' in e.detail), 'E: audit detail carried a secret field');
        }
      }
      console.log('✓ E: agent calls + failures audited; no secret in the audit log');
      pass++;
    }
  } finally {
    s1.stop();
  }

  // ── F. agentRateLimitPerMinute=0 disables the limiter ─────────────────
  const d2 = tmp('off');
  setup(d2, { agentRateLimitPerMinute: 0, agentRateLimitBurst: 0 });
  const s2 = await startServer(d2);
  const base2 = `http://127.0.0.1:${s2.port}`;
  try {
    const admin2 = await login(base2, 'admin', PW);
    const m = await mint(base2, admin2, { agentId: 'free', gatewayId: 'home', label: 'free@home' });
    const N = AGENT_RATE * 3;
    for (let i = 1; i <= N; i++) {
      const r = await whoami(base2, m.token);
      assert(r.ok, `F: disabled limiter still throttled call ${i} (${r.status})`);
    }
    const { lines } = auditLines(d2);
    assert(!lines.some((e) => e.action === 'agent_rate_limited'), 'F: limiter fired while disabled');
    console.log(`✓ F: with the limiter off, ${N} calls pass and none are rate-limited`);
    pass++;
  } finally {
    s2.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 agent-api (phase 1) checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-api phase-1 test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
