#!/usr/bin/env node
'use strict';
/**
 * test-roster-gate.js — Phase 3 acceptance gate for the phone book
 * (plan item 3b).
 *
 * Item 3a shipped a focused test (`test-agent-roster.js`) proving the route
 * answers. This is the missing regression gate that proves the phone book's
 * harder contract against the REAL server with live + dying gateways — the
 * phase-3 equivalent of `test-agent-api.js` (1d) and `test-board-gate.js` (2f).
 * It deliberately drives the INTEGRATION edges the 3a test does not:
 *
 *   A. token-scoped access — the roster needs a Bearer, a human cookie is inert
 *      on /api/agent/*, and the agent token is inert on the human /api/agents
 *   B. fleet merge, deterministic — two live gateways flatten into one list,
 *      ordered by config order then agent name, with the cross-server ref/key
 *      shape an agent needs to address a peer
 *   C. offline-from-start — a gateway whose server never answered is listed
 *      connected:false and contributes no live agents, without failing the call
 *   D. live → down reachability flip — the ROSTER_CACHE replay: an agent that
 *      was reachable flips to reachable:false (lastSeenAt retained) when its
 *      gateway drops, and the server is listed connected:false with a count, so
 *      the phone book survives a server outage instead of silently losing it
 *   E. per-token identity + revocation — two tokens resolve to their OWN `you`
 *      identity; revoking one 401s only that token and leaves its sibling live
 *   F. audit + no secret — the call is audited (agent_call + agent_roster counts)
 *      and no agent token ever reaches the response or the log
 *
 * Zero dependencies. Run: node test-roster-gate.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');
const { FakeGateway } = require('./test/fake-gateway');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-rgate-')); made.push(d); return d; };

const secrets = []; // plaintext agent tokens we minted — must never appear anywhere

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function setup(dir, cfg = {}) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(Object.assign({
    bind: '127.0.0.1', gateways: [], portalPassword: PW, sessionTtlHours: 12,
  }, cfg), null, 2));
}

async function startServer(dir) {
  const port = await freePort();
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
  cfg.port = port;
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(cfg, null, 2));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, get out() { return out; }, get err() { return err; }, port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const timer = setTimeout(finish, 12000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('users:')) { clearTimeout(timer); finish(); } });
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
const roster = (base, t) => fetch(`${base}/api/agent/roster`, t ? { headers: bearer(t) } : {});

function auditLines(dir) {
  const raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8');
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a predicate against the roster until it holds or the deadline passes.
async function waitFor(fn, ms = 10000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

(async () => {
  let pass = 0;

  // Two live gateways (home, lab) and one that is configured but dead from boot.
  const home = await new FakeGateway({ agents: [
    { id: 'noah', name: 'Noah', emoji: '🦖', default: true },
    { id: 'nora', name: 'Nora', emoji: '🔥' },
  ] }).start();
  const lab = await new FakeGateway({ agents: [
    { id: 'iris', name: 'Iris', emoji: '👁' },
  ] }).start();
  const DEAD = { id: 'ct-test', name: 'ct-test (down)', url: 'ws://127.0.0.1:1', token: 'dead-tok', enabled: true };
  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
    DEAD,
  ];

  const d1 = tmp();
  setup(d1, { gateways });
  const s1 = await startServer(d1);
  const base = `http://127.0.0.1:${s1.port}`;
  try {
    const admin = await login(base, 'admin', PW);
    const noah = await mint(base, admin, { agentId: 'noah', gatewayId: 'home', label: 'noah@home' });
    const iris = await mint(base, admin, { agentId: 'iris', gatewayId: 'lab', label: 'iris@lab' });

    // Wait for the two live gateways to finish their connect handshake.
    const ready = await waitFor(async () => {
      const j = await (await fetch(`${base}/api/agents`, { headers: { Cookie: admin.cookie } })).json();
      return j.servers && j.servers.filter((s) => s.connected).length === 2;
    }, 12000, 300);
    assert(ready, 'setup: live gateways never connected\n' + s1.err);

    // ── A. token-scoped access, both directions ──────────────────────────
    {
      const noAuth = await roster(base, null);
      assert(noAuth.status === 401, `A: roster without a token → ${noAuth.status}, expected 401`);
      const cookieOnly = await fetch(`${base}/api/agent/roster`, { headers: { Cookie: admin.cookie } });
      assert(cookieOnly.status === 401, `A: a human cookie must not satisfy /api/agent/* (got ${cookieOnly.status})`);
      const bearerHuman = await fetch(`${base}/api/agents`, { headers: bearer(noah.token) });
      assert(bearerHuman.status === 401, `A: an agent token must not satisfy the human /api/agents (got ${bearerHuman.status})`);
      const good = await roster(base, noah.token);
      assert(good.ok, `A: a valid Bearer should reach the roster (got ${good.status})`);
      console.log('✓ A: Bearer required; cookie inert on /api/agent/*; agent token inert on /api/agents');
      pass++;
    }

    // ── B. fleet merge, deterministically ordered ────────────────────────
    let merged = null;
    {
      const j = await (await roster(base, noah.token)).json();
      merged = j;
      const refs = j.agents.map((a) => a.ref);
      assert.deepEqual(refs, ['home:noah', 'home:nora', 'lab:iris'],
        `B: merged order wrong: ${JSON.stringify(refs)}`);
      const n = j.agents.find((a) => a.ref === 'home:noah');
      assert(n.name === 'Noah' && n.emoji === '🦖' && n.default === true, 'B: agent fields wrong');
      assert(n.server === 'home' && n.serverName === 'Home', 'B: gateway fields wrong');
      assert(n.key === 'agent:home:noah:main', `B: cross-server key wrong: ${n.key}`);
      assert(n.reachable === true && typeof n.lastSeenAt === 'number', 'B: a live agent must be reachable with lastSeenAt');
      assert(j.count === 3, `B: count should be 3, got ${j.count}`);
      console.log('✓ B: two gateways merge in config+name order with cross-server ref/key shape');
      pass++;
    }

    // ── C. a gateway that never answered is offline-listed, not fatal ────
    {
      const dead = merged.servers.find((s) => s.id === 'ct-test');
      assert(dead, 'C: the down gateway is missing from servers[]');
      assert(dead.connected === false && dead.error === 'offline', `C: down gateway not marked offline: ${JSON.stringify(dead)}`);
      assert(merged.connected === true, 'C: the fleet should still report connected (two live gateways)');
      assert(!merged.agents.some((a) => a.server === 'ct-test'), 'C: a down gateway must contribute no live agents');
      console.log('✓ C: a never-connected gateway is listed connected:false without failing the call');
      pass++;
    }

    // ── D. live → down reachability flip (ROSTER_CACHE replay) ───────────
    {
      const before = merged.agents.find((a) => a.ref === 'lab:iris');
      assert(before && before.reachable === true, 'D: lab:iris should start reachable');

      lab.stop(); // the Lab server drops out from under the portal
      const flipped = await waitFor(async () => {
        const j = await (await roster(base, noah.token)).json();
        const a = j.agents.find((x) => x.ref === 'lab:iris');
        return a && a.reachable === false ? j : null;
      }, 12000, 300);
      assert(flipped, 'D: lab:iris never flipped to reachable:false after the gateway dropped');

      const iris2 = flipped.agents.find((a) => a.ref === 'lab:iris');
      assert(iris2.lastSeenAt === before.lastSeenAt,
        `D: lastSeenAt not retained across the drop (${before.lastSeenAt} → ${iris2.lastSeenAt})`);
      const labSrv = flipped.servers.find((s) => s.id === 'lab');
      assert(labSrv && labSrv.connected === false && labSrv.error === 'offline',
        `D: lab server not marked offline: ${JSON.stringify(labSrv)}`);
      assert(labSrv.agentCount === 1, `D: offline lab server should still report its cached count, got ${labSrv.agentCount}`);
      // home is untouched by lab's outage
      assert(flipped.agents.find((a) => a.ref === 'home:noah').reachable === true, 'D: home agents disturbed by lab outage');
      console.log('✓ D: a dropped gateway replays its last-known agents as reachable:false (lastSeenAt kept)');
      pass++;
    }

    // ── E. per-token identity + revocation ───────────────────────────────
    {
      const y1 = await (await roster(base, noah.token)).json();
      const y2 = await (await roster(base, iris.token)).json();
      assert(y1.you.ref === 'home:noah' && y2.you.ref === 'lab:iris',
        `E: "you" did not track the calling token: ${y1.you.ref} / ${y2.you.ref}`);
      assert(y1.you.agentId !== y2.you.agentId && y1.you.gatewayId !== y2.you.gatewayId,
        'E: two tokens resolved to the same identity');
      // A token on a now-offline gateway still gets the phone book (lists the fleet).
      assert(y2.connected === true && y2.count === 3, 'E: an offline-gateway token should still list the live fleet');

      const dr = await fetch(`${base}/api/agent-tokens/${iris.agentToken.id}`, {
        method: 'DELETE', headers: { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      });
      assert(dr.ok, `E: revoke failed (${dr.status})`);
      const revoked = await roster(base, iris.token);
      assert(revoked.status === 401, `E: a revoked token still reached the roster (${revoked.status})`);
      const sibling = await roster(base, noah.token);
      assert(sibling.ok, `E: revoking one token disturbed its sibling (${sibling.status})`);
      console.log('✓ E: each token resolves to its own `you`; revocation 401s only that token');
      pass++;
    }

    // ── F. audit + no secret ─────────────────────────────────────────────
    {
      const { raw, lines } = auditLines(d1);
      for (const sec of secrets) assert(!raw.includes(sec), 'F: an agent token leaked into the audit log');
      const calls = lines.filter((l) => l.action === 'agent_roster');
      assert(calls.length >= 3, `F: expected several agent_roster entries, got ${calls.length}`);
      assert(calls.every((l) => l.user === 'noah' || l.user === 'iris'), 'F: agent_roster attributed to the wrong user');
      const last = calls[calls.length - 1];
      assert(last.detail && typeof last.detail.agents === 'number' && typeof last.detail.servers === 'number',
        `F: agent_roster counts missing: ${JSON.stringify(last.detail)}`);
      assert(lines.some((l) => l.action === 'agent_call'), 'F: per-call audit entry missing');
      console.log('✓ F: agent_roster audited with counts; no token in the log or the response');
      pass++;
    }
  } finally {
    s1.stop();
    home.stop();
    lab.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 roster-gate checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ roster-gate test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
