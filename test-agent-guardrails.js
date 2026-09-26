#!/usr/bin/env node
'use strict';
/**
 * test-agent-guardrails.js — smoke test for plan item 1c (Agent API guardrails).
 *
 * Runs the REAL server in a throwaway temp dir with a deliberately tight agent
 * budget, mints agent tokens through the admin API, and drives /api/agent/*
 * exactly as a remote agent would. Asserts the three controls layered on top of
 * Bearer auth (1b):
 *   A. body cap — an oversized agent POST is refused with 413 BEFORE the method
 *      is even routed, and does NOT consume the token's rate budget
 *   B. per-token rate limit — the token's budget is spent, then 429 + Retry-After;
 *      the rejection is audited and counted in the metric
 *   C. isolation — a second token has its OWN budget (one noisy agent can't
 *      starve another)
 *   D. revocation — a revoked token is refused immediately (401 + audit) and
 *      leaves other tokens unaffected
 *   E. one audit entry per call, and no secret ever lands in the audit log
 *
 * Zero dependencies. Run: node test-agent-guardrails.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const AGENT_RATE = 3; // per-token budget (+0 burst) → 4th call is 429
const AGENT_BODY = 2048;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-aguard-')); made.push(d); return d; };

function setup(dir) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    port: 19700 + Math.floor(Math.random() * 200),
    bind: '127.0.0.1',
    gateways: [],
    portalPassword: PW,
    sessionTtlHours: 12,
    agentRateLimitPerMinute: AGENT_RATE,
    agentRateLimitBurst: 0,
    agentMaxBodyBytes: AGENT_BODY,
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
  return j;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const get = (base, t) => fetch(`${base}/api/agent/whoami`, { headers: bearer(t) });

function auditLines(dir) {
  const raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8');
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

(async () => {
  let pass = 0;
  const d = tmp();
  setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  const secrets = [];
  try {
    const admin = await login(base, 'admin', PW);
    const tBody = (await mint(base, admin, { agentId: 'body', gatewayId: 'home', label: 'body@home' })).token;
    const tRate = (await mint(base, admin, { agentId: 'rate', gatewayId: 'home', label: 'rate@home' })).token;
    const tOther = (await mint(base, admin, { agentId: 'other', gatewayId: 'home', label: 'other@home' })).token;
    secrets.push(tBody, tRate, tOther);

    // ── A. body cap: 413 before routing, and does NOT spend rate budget ──
    {
      const big = 'x'.repeat(AGENT_BODY + 2000);
      const post = await fetch(`${base}/api/agent/whoami`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(tBody) }, body: big,
      });
      const j = await post.json();
      assert(post.status === 413, `A: oversized agent body → ${post.status}, expected 413 (${JSON.stringify(j)})`);
      assert(!JSON.stringify(j).includes(tBody), 'A: response leaked the secret');

      // The 413 must not have consumed tBody's budget — a normal call still works.
      const ok = await get(base, tBody);
      assert(ok.status === 200, `A: budget consumed by the 413 (${ok.status}) — body cap must precede the rate check`);
      console.log(`✓ A: agent body > ${AGENT_BODY}B → 413, no budget spent, no secret leaked`);
      pass++;
    }

    // ── B. per-token rate limit → 429 + Retry-After, audited + counted ──
    {
      for (let i = 1; i <= AGENT_RATE; i++) {
        const r = await get(base, tRate);
        assert(r.status === 200, `B: call ${i}/${AGENT_RATE} → ${r.status}, expected 200`);
      }
      const over = await get(base, tRate);
      assert(over.status === 429, `B: call ${AGENT_RATE + 1} → ${over.status}, expected 429`);
      assert(over.headers.get('retry-after'), 'B: 429 is missing the Retry-After header');
      const oj = await over.json();
      assert(Number(oj.retryAfter) > 0, 'B: 429 body has no positive retryAfter');

      // metrics wiring: the rejection is counted.
      const m = await fetch(`${base}/metrics`);
      const mtxt = await m.text();
      const mm = /cirrus_portal_agent_rate_limited_total (\d+)/.exec(mtxt);
      assert(mm && Number(mm[1]) > 0, `B: metric cirrus_portal_agent_rate_limited_total not incremented (${mm && mm[1]})`);
      console.log('✓ B: token budget spent → 429 + Retry-After, audited and counted in /metrics');
      pass++;
    }

    // ── C. isolation: a second token has its own budget ──
    {
      const r = await get(base, tOther);
      assert(r.status === 200, `C: second token → ${r.status}; one token's budget must not starve another`);
      console.log('✓ C: per-token buckets are independent (second token still 200 while first is 429)');
      pass++;
    }

    // ── D. revocation: immediate 401, others unaffected ──
    {
      const recs = await fetch(`${base}/api/agent-tokens`, { headers: { Cookie: admin.cookie } });
      const list = await recs.json();
      const rateRec = list.agentTokens.find((t) => t.label === 'rate@home');
      assert(rateRec, 'D: could not find the rate token record to revoke');
      const dr = await fetch(`${base}/api/agent-tokens/${rateRec.id}`, {
        method: 'DELETE', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      });
      assert(dr.ok, `D: revoke failed (${dr.status})`);

      const revoked = await get(base, tRate);
      assert(revoked.status === 401, `D: revoked token → ${revoked.status}, expected 401`);
      const stillOk = await get(base, tOther);
      assert(stillOk.status === 200, `D: revoking one token broke another (${stillOk.status})`);
      console.log('✓ D: revoke invalidates immediately (401) without touching other tokens');
      pass++;
    }

    // ── E. one audit entry per call; no secret in the log ──
    {
      const { raw, lines } = auditLines(d);
      const actions = lines.map((e) => e.action);
      const count = (a) => actions.filter((x) => x === a).length;

      // Successful agent calls: tBody GET x1, tRate GET x3, tOther GET x2 = 6.
      assert(count('agent_call') === 6, `E: expected 6 agent_call entries, found ${count('agent_call')}`);
      assert(count('agent_body_rejected') === 1, `E: expected 1 agent_body_rejected, found ${count('agent_body_rejected')}`);
      assert(count('agent_rate_limited') === 1, `E: expected 1 agent_rate_limited, found ${count('agent_rate_limited')}`);
      assert(count('agent_auth_reject') >= 1, 'E: revoked-token rejection was not audited');

      for (const e of lines) {
        const blob = JSON.stringify(e);
        for (const sec of secrets) assert(!blob.includes(sec), 'E: a secret leaked into the audit log!');
        assert(!/"(hash|salt|lookup|secret)"\s*:/.test(blob), `E: audit entry carried a credential field: ${e.action}`);
      }
      console.log('✓ E: exactly one audit entry per call; no secret or credential field in the log');
      pass++;
    }
  } finally {
    s.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/5 agent-guardrail checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-guardrail test FAILED:', e.message);
  process.exit(1);
});
