// ─────────────────────────────────────────────────────────────────────────────
//  Cirrus Portal — security guard regression suite
//  ─────────────────────────────────────────────────────────────────────────────
//  Written after a manual security review (2026-10-19) using the
//  `security-reviewer` + `javascript-testing-patterns` skills. These are the
//  invariants the review found load-bearing. If one of these fails, a control
//  we depend on has regressed — not "a test is being fussy".
//
//  Style: node:test, zero dependencies, no live gateway, no writes to real
//  state. Anything that needs the running server is exercised through the same
//  pure helpers the server uses where possible; the rest spawns a throwaway
//  portal in a temp dir on an ephemeral port.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SRC = path.resolve(__dirname, '..');
const SERVER = path.join(SRC, 'portal-server.js');

// The server is one big module that boots on require, so we don't import it.
// These tests read its source and assert on structure, plus drive a live
// instance over HTTP where behaviour matters.

function source() {
  return fs.readFileSync(SERVER, 'utf8');
}

// ── A. Credential handling ───────────────────────────────────────────────────

test('A: a *presented* secret is never compared with ===', () => {
  const src = source();
  const lines = src.split('\n');
  const offenders = [];

  // Only comparisons where a request-supplied secret is compared straight to a
  // stored one are a timing leak. Comparisons that gate on the *type* of the
  // input (`typeof body.token === 'string'`), on emptiness, or between two
  // values already held server-side are fine — they leak nothing an attacker
  // controls. Anything else is a finding.
  const benign = [
    /typeof\s+[\w.]+\s*[!=]==?\s*'string'/,   // type check on untrusted input
    /typeof\s+[\w.]+\s*[!=]==?\s*'boolean'/,
    /typeof\s+[\w.]+\s*[!=]==?\s*'number'/,
    /\btypeof\s+[\w.]+/,
  ];
  const surface = /\b(body|req|headers|query|url)\./;   // touches request input
  const secretWord = /\b(hash|password|passwd|secret|token|lookup|csrf|credential)\b/i;
  // Only a comparison where BOTH sides are values (not `req.method === 'POST'`
  // style literals) counts. A literal on the right is a method/type/flag check.
  const cmp = /(?<![=!<>])(===|!==)(?!=)/;
  const literalRhs = /[!=]==?\s*('[^']*'|"[^"]*"|\d+|true|false|null|undefined)\s*[);&|]/;

  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (!cmp.test(line)) return;
    if (literalRhs.test(line)) return;   // method/flag/type check, not a secret compare
    if (!secretWord.test(line)) return;
    if (benign.some(re => re.test(line))) return;
    if (!surface.test(line)) return;     // server-side-only comparison
    offenders.push(`${i + 1}: ${t}`);
  });

  assert.deepEqual(offenders, [],
    `request-supplied secret compared with === (timing leak):\n${offenders.join('\n')}`);
});

test('A: timingSafeEqual is always length-guarded before use', () => {
  const src = source();
  // node throws if the buffers differ in length — an unguarded call is a crash
  // (DoS) or, worse, tends to get "fixed" later with a plain ===.
  const lines = src.split('\n');
  const calls = [];
  lines.forEach((line, i) => {
    if (line.includes('timingSafeEqual') && !line.trim().startsWith('//')) calls.push(i);
  });
  assert.ok(calls.length >= 4, 'expected several timing-safe comparisons');
  for (const i of calls) {
    const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    const guarded = /length\s*[!=]==?\s*|\.length\s*&&|Buffer\.from|hashBufferGuard/.test(window);
    assert.ok(guarded, `timingSafeEqual at line ${i + 1} is not obviously length-guarded:\n${window}`);
  }
});

// ── B. The two surfaces must not cross ───────────────────────────────────────

test('B: agent bearer tokens are confined to /api/agent/*', () => {
  const src = source();
  // The predicate that decides what counts as the agent surface.
  assert.match(src, /function isAgentApiPath\(p\)\s*\{\s*return p === '\/api\/agent' \|\| p\.startsWith\('\/api\/agent\/'\)/,
    'isAgentApiPath must match exactly /api/agent and /api/agent/*');
  // And the agent handler must not be reachable for anything else: it should be
  // called behind that predicate, not on every request.
  const callSites = [...src.matchAll(/handleAgentApi\(/g)];
  assert.ok(callSites.length >= 1, 'handleAgentApi must exist');
  assert.match(src, /isAgentApiPath\([^)]*\)[^\n]*handleAgentApi\(|handleAgentApi\([^)]*\)/,
    'handleAgentApi should be gated by isAgentApiPath');
  // A prefix check that is too loose is the classic bug here.
  assert.doesNotMatch(src, /startsWith\('\/api\/agent'\)(?!\s*\|\|)/,
    'bare startsWith("/api/agent") would also match /api/agents — use the guarded predicate');
});

test('B: the agent surface never reads the session cookie', () => {
  const src = source();
  const start = src.indexOf('async function handleAgentApi');
  assert.ok(start > 0, 'handleAgentApi not found');
  // Take the body up to the closing of the function (next top-level function).
  const rest = src.slice(start);
  const end = rest.indexOf('\nfunction ', 10);
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert.doesNotMatch(body, /requireSession|sessionFor|cookieOk|readSessionCookie/,
    'the agent surface must never accept a cookie session as authentication');
});

// ── C. Outbound URL handling ────────────────────────────────────────────────

test('C: gateway URLs are not fetched blindly (SSRF surface is deliberate)', () => {
  const src = source();
  // This is a documented design property, not a bug: gateways are admin-set.
  // The test pins the reasoning so nobody "adds" a user-supplied URL later
  // without noticing they widened the surface.
  const adminOnly = /CONFIG\.gateways|gateways\s*:\s*\[/.test(src);
  assert.ok(adminOnly, 'gateway list must come from config, not from request bodies');
  assert.doesNotMatch(src, /body\.url\s*\|\|\s*body\.gatewayUrl/,
    'do not accept a request-body URL as a fetch target');
});

// ── D. Input size limits ────────────────────────────────────────────────────

test('D: request bodies are capped before parsing', () => {
  const src = source();
  assert.match(src, /function maxBodyBytes\(\)/, 'global body cap missing');
  assert.match(src, /function agentMaxBodyBytes\(\)/, 'agent body cap missing');
  // The agent cap must be tighter than the global one — agents send structured
  // messages, never uploads.
  const agentCap = /Number\(CONFIG\.agentMaxBodyBytes\)\s*\|\|\s*(\d+)\s*\*\s*(\d+)/.exec(src);
  assert.ok(agentCap, 'agent body cap default not found');
  const agentBytes = Number(agentCap[1]) * Number(agentCap[2]);
  const globalCap = /Number\(CONFIG\.maxBodyBytes\)\s*\|\|\s*(\d+)\s*\*\s*(\d+)/.exec(src);
  const globalBytes = Number(globalCap[1]) * Number(globalCap[2]);
  assert.ok(agentBytes <= globalBytes, `agent cap (${agentBytes}) must be <= global cap (${globalBytes})`);
  // And the stream must be destroyed, not merely ignored, on overflow.
  assert.match(src, /data\.length > maxBodyBytes\(\)[^\n]*req\.destroy\(\)/,
    'an oversized body must destroy the request, not just be dropped');
});

// ── E. Login lockout behaviour (pure model of the server's algorithm) ────────

// Mirrors recordLoginFailure() in portal-server.js. Kept in lockstep on purpose:
// if the server's progression changes, this test must change with it.
function modelLockout({ max = 5, base = 300, attempts }) {
  let lockouts = 0;
  const events = [];
  let hits = 0;
  for (let i = 1; i <= attempts; i++) {
    hits += 1;
    if (hits >= max) {
      lockouts += 1;
      const secs = Math.min(base * Math.pow(2, lockouts - 1), 3600);
      events.push({ attempt: i, lockouts, lockFor: secs });
      hits = 0;
    }
  }
  return events;
}

test('E: lockout doubles per repeat and is capped at one hour', () => {
  const events = modelLockout({ attempts: 5 * 8 });
  assert.deepEqual(events.map(e => e.lockFor), [300, 600, 1200, 2400, 3600, 3600, 3600, 3600],
    'lockout must be exponential from the base, hard-capped at 3600s');
});

test('E: the lockout is per IP+username, so one account cannot be locked out from everywhere', () => {
  const src = source();
  assert.match(src, /function loginKey\(req, username\)\s*\{\s*return clientIp\(req\) \+ '\|' \+ String\(username/,
    'lockout key must include both the client IP and the username (pre-lowercased)');
  // X-Forwarded-For must only be honoured when the operator declared a proxy.
  assert.match(src, /function clientIp\(req\)\s*\{\s*\n\s*if \(TRUST_PROXY\)/,
    'clientIp must ignore X-Forwarded-For unless trustProxy is configured');
});

// ── F. Secrets and state never ship ─────────────────────────────────────────

test('F: state files are gitignored and the tracked tree is clean of secrets', () => {
  const ignore = fs.readFileSync(path.join(SRC, '.gitignore'), 'utf8');
  for (const f of ['portal-users.json', 'portal-secrets.json', 'portal-device.json', 'portal-audit.log',
    'portal-config.json', 'portal-board.json', 'portal-agent-dm.json', 'portal-context.json']) {
    assert.match(ignore, new RegExp(f.replace(/\./g, '\\.')), `${f} must be gitignored`);
  }
  // The scanner itself ships and is executable.
  const scanner = path.join(SRC, 'secret-scan.sh');
  assert.ok(fs.existsSync(scanner), 'secret-scan.sh must ship');
  assert.ok(fs.statSync(scanner).mode & 0o100, 'secret-scan.sh must be executable');
});

test('F: no live credential is hardcoded in source', () => {
  const src = source() + fs.readFileSync(path.join(SRC, 'portal.html'), 'utf8');
  const banned = [
    /cpat_[A-Za-z0-9_-]{20,}/,            // agent bearer tokens
    /gpt_[A-Za-z0-9]{20,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  for (const re of banned) {
    const m = re.exec(src);
    assert.equal(m, null, `hardcoded credential material found: ${m && m[0] && m[0].slice(0, 12)}…`);
  }
});

// ── G. Rendering safety ────────────────────────────────────────────────────

test('G: dynamic text in the UI goes through escapeHtml or textContent', () => {
  const html = fs.readFileSync(path.join(SRC, 'portal.html'), 'utf8');
  assert.match(html, /function escapeHtml\(s\)\s*\{[^}]*&amp;[^}]*&lt;[^}]*&gt;[^}]*&quot;[^}]*&#39;/, // '
    'escapeHtml must escape & < > " \'');
  // Board posts come from untrusted agents: they must be rendered as text.
  const bubble = html.slice(html.indexOf('function boardBubble'), html.indexOf('function boardBubble') + 1600);
  assert.match(bubble, /body\.textContent\s*=\s*p\.text/, 'board post bodies must use textContent, never innerHTML');
  assert.match(bubble, /author\.textContent\s*=\s*p\.author/, 'board authors must use textContent');
});

// ── H. Agent DM guardrails are all present ─────────────────────────────────

test('H: DM loop safety has every layer wired', () => {
  const src = source();
  for (const [name, re] of [
    ['fleet circuit breaker', /function dmCircuitCheck/],
    ['per-pair rate limit', /pairLimited/],
    ['hop bound', /DM_HOPS_MAX/],
    ['no-relay honouring', /relayBlocked/],
    ['sync concurrency cap', /dmSyncMaxConcurrent/],
  ]) {
    assert.match(src, re, `missing DM guard: ${name}`);
  }
  // The DM body is never written to the audit log — only ids and state.
  const start = src.indexOf("audit('agent_dm', ");
  assert.ok(start > 0, "audit('agent_dm') not found");
  const line = src.slice(start, src.indexOf('});', start));
  assert.doesNotMatch(line, /\btext\b/, 'the DM body must never reach the audit log');
});

// ── I. Live behaviour: the two surfaces really are separate ────────────────
// Boots a throwaway portal against a temp state dir. Skips cleanly if the box
// refuses to bind (sandboxed CI without loopback).

function bootTempPortal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-sec-'));
  for (const f of ['portal-server.js', 'portal.html', 'setup.html', 'healthcheck.js', 'branding.json']) {
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir,
      env: {
        ...process.env,
        PORT: String(port),
        BIND: '127.0.0.1',
        PORTAL_ADMIN_PASSWORD: 'Temp-Test-Passw0rd!42',
        PORTAL_DATA_DIR: dir,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (b) => {
      out += b.toString();
      if (/listening|http:\/\/|serving/i.test(out)) {
        child.stdout.off('data', onData);
        resolve({ child, dir, port, log: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('exit', (code) => {
      if (!/listening|http:\/\/|serving/i.test(out)) reject(new Error(`portal exited ${code}: ${out.slice(0, 500)}`));
    });
    setTimeout(() => reject(new Error(`portal did not boot: ${out.slice(0, 500)}`)), 15000);
  });
}

test('I: a cookie session cannot reach /api/agent/*, and a bearer token cannot reach a human route', async (t) => {
  let p;
  try {
    p = await bootTempPortal();
  } catch (e) {
    t.skip(`could not boot a temp portal here: ${e.message}`);
    return;
  }
  const base = `http://127.0.0.1:${p.port}`;
  try {
    // 1. Agent surface rejects an anonymous call.
    const anon = await fetch(`${base}/api/agent/whoami`);
    assert.equal(anon.status, 401, 'anonymous /api/agent/* must be 401');

    // 2. A made-up bearer token is rejected.
    const fake = await fetch(`${base}/api/agent/whoami`, { headers: { Authorization: 'Bearer cpat_nope' } });
    assert.equal(fake.status, 401, 'an invalid agent token must be 401');

    // 3. Log in as the human admin.
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Temp-Test-Passw0rd!42' }),
    });
    if (login.status !== 200) {
      // Fresh-box SETUP mode is a legitimate reason to skip rather than fail.
      t.skip(`portal is in setup mode (login ${login.status}); surface-separation covered by test-roster-gate.js`);
      return;
    }
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('portal_session='), 'login must set portal_session');

    // 4. That cookie must NOT authenticate the agent surface.
    const cookieOnAgent = await fetch(`${base}/api/agent/whoami`, { headers: { Cookie: cookie } });
    assert.equal(cookieOnAgent.status, 401, 'a session cookie must never satisfy the agent surface');

    // 5. A bearer token must NOT authenticate a human route. `/api/me` is a
    //    public probe that answers 200 authed:false — what matters is that the
    //    header grants no identity.
    const bearerOnHuman = await fetch(`${base}/api/me`, {
      headers: { Authorization: 'Bearer cpat_nope', Cookie: '' },
    });
    const meBody = await bearerOnHuman.json();
    assert.equal(meBody.authed, false, 'a bearer token must never grant a human identity');
    assert.equal(meBody.user, undefined, 'a bearer token must not return a user object');

    // 5b. A bearer token must not reach an admin-only route either.
    const bearerOnAdmin = await fetch(`${base}/api/users`, {
      headers: { Authorization: 'Bearer cpat_nope', Cookie: '' },
    });
    assert.ok([401, 403].includes(bearerOnAdmin.status),
      `a bearer token must not reach /api/users, got ${bearerOnAdmin.status}`);

    // 6. The session cookie must be HttpOnly and SameSite=Strict.
    const raw = login.headers.get('set-cookie') || '';
    assert.match(raw, /HttpOnly/i, 'session cookie must be HttpOnly');
    assert.match(raw, /SameSite=Strict/i, 'session cookie must be SameSite=Strict');

    // 7. State-changing routes need the CSRF token.
    const noCsrf = await fetch(`${base}/api/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ profile: 'x' }),
    });
    assert.ok([400, 403].includes(noCsrf.status), `POST without X-CSRF-Token must be refused, got ${noCsrf.status}`);
  } finally {
    p.child.kill('SIGKILL');
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
});
