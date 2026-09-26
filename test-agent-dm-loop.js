#!/usr/bin/env node
'use strict';
/**
 * test-agent-dm-loop.js — plan item 4d (cross-server agent DM loop safety).
 *
 * Items 4a–4c shipped the mailbox, the router and the sync reply. 4d is the
 * loop-suppression layer that keeps a fleet of auto-responding agents from
 * ping-ponging forever. This drives the REAL server against fake gateways and
 * proves each bound — and that a human interjection releases them:
 *
 *   A. hop counter — a reply chain 0→1→2→3 is accepted; the next hop (> 3) is
 *      refused 429, not stored, audited (agent_dm_loop_blocked) and counted
 *   B. fresh chain — an unrelated pair still starts at hop 0 (the bound does not
 *      poison a new conversation)
 *   C. no-relay — a `noRelay` DM lets the recipient reply to the sender but
 *      blocks a relay to a third party (403, agent_dm_relay_blocked)
 *   D. privacy + persistence — no DM body or token reaches the audit log, and
 *      the store persists 0600 with hops + noRelay
 *   E. per-pair rate limit — a pair is capped (rate + burst); the (N+1)th send
 *      is 429 + Retry-After, audited (agent_dm_rate_limited), and the limit is
 *      direction-insensitive (both directions share one bucket)
 *   F. human involvement — a signed-in board post resets the pair budgets and
 *      closes any breaker (agent_dm_loops_broken), so the loop can be unstuck
 *   G. circuit breaker — the fleet-wide budget trips at the cap (503 +
 *      Retry-After, agent_dm_circuit_open), refuses everything while open, and
 *      recovers after the cooldown
 *
 * Zero dependencies. Run: node test-agent-dm-loop.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-dmloop-')); made.push(d); return d; };
const secrets = []; // plaintext tokens we minted — must never appear anywhere

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
    child.stdout.on('data', (d) => { out += d; if (out.includes('ready.')) { clearTimeout(timer); finish(); } });
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
  return j.token;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const sendDm = (base, t, body) => fetch(`${base}/api/agent/dm`, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, bearer(t)), body: JSON.stringify(body),
});
const readDm = (base, t, q = '') => fetch(`${base}/api/agent/dm${q}`, { headers: bearer(t) });
const postBoard = (base, sess, body) => fetch(`${base}/api/board/post`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: sess.cookie, 'X-CSRF-Token': sess.csrf },
  body: JSON.stringify(body),
});

function auditLines(dir) {
  const raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8');
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const readStore = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-agent-dm.json'), 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}
async function connected(base, t) {
  const j = await (await fetch(`${base}/api/agent/roster`, { headers: bearer(t) })).json();
  const live = (j.servers || []).filter((x) => x.connected).map((x) => x.id).sort();
  return live.join(',') === 'home,lab';
}

(async () => {
  let pass = 0;

  // One shared fleet on the other end of the WS for every portal instance.
  const sent = { home: [], lab: [] };
  const handler = (arr) => (method, params) => {
    if (method === 'chat.send') { arr.push(params); return { runId: 'r-' + arr.length, status: 'accepted' }; }
    return {};
  };
  const home = await new FakeGateway({
    agents: [{ id: 'alice', name: 'Alice' }, { id: 'cara', name: 'Cara' }], onRequest: handler(sent.home),
  }).start();
  const lab = await new FakeGateway({
    agents: [{ id: 'bob', name: 'Bob' }], onRequest: handler(sent.lab),
  }).start();
  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
  ];

  const servers = [];
  try {
    // ═══ Server A — hops + no-relay (generous pair/circuit budgets) ═══════
    {
      const d = tmp();
      setup(d, { gateways, agentDmHopWindowMs: 600000, agentDmPairRatePerMinute: 100, agentDmPairBurst: 100, agentDmCircuitMaxPerMinute: 1000 });
      const s = await startServer(d); servers.push(s);
      const base = `http://127.0.0.1:${s.port}`;
      const admin = await login(base, 'admin', PW);
      const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
      const bob = await mint(base, admin, { agentId: 'bob', gatewayId: 'lab', label: 'Bob@lab' });
      const cara = await mint(base, admin, { agentId: 'cara', gatewayId: 'home', label: 'Cara@home' });
      await waitFor(async () => connected(base, alice));

      // ── A. hop counter ────────────────────────────────────────────────
      {
        const chain = [];
        for (const [who, tok, to] of [
          ['alice', alice, 'lab:bob'], ['bob', bob, 'home:alice'],
          ['alice', alice, 'lab:bob'], ['bob', bob, 'home:alice'],
        ]) {
          const r = await sendDm(base, tok, { to, text: 'chain-' + who });
          const j = await r.json();
          assert([200, 202].includes(r.status), `A: chain send ${who}→${to} should be accepted, got ${r.status} ${JSON.stringify(j)}`);
          chain.push(j.dm.hops);
        }
        assert.deepEqual(chain, [0, 1, 2, 3], `A: hop chain should be 0,1,2,3, got ${JSON.stringify(chain)}`);
        // The 5th answers bob→alice(hop 3) → hop 4 > max 3 → refused.
        const before = readStore(d).dms.length;
        const r = await sendDm(base, alice, { to: 'lab:bob', text: 'chain-overflow' });
        const j = await r.json();
        assert.equal(r.status, 429, `A: hop overflow should be 429, got ${r.status} ${JSON.stringify(j)}`);
        assert.equal(readStore(d).dms.length, before, 'A: a hop-blocked DM must not be stored');
        const { lines } = auditLines(d);
        assert(lines.some((l) => l.action === 'agent_dm_loop_blocked' && l.detail && l.detail.hops === 4), 'A: agent_dm_loop_blocked (hops 4) not audited');
        const met = await (await fetch(`${base}/metrics`)).text();
        assert(/cirrus_portal_agent_dm_loop_blocked_total [1-9]/.test(met), 'A: the loop-blocked metric is missing');
        console.log('✓ A: hop counter chains 0→3 and refuses the 4th reply (429, no write, audited)');
        pass++;
      }

      // ── B. fresh chain resets to 0 ────────────────────────────────────
      {
        const r = await sendDm(base, cara, { to: 'lab:bob', text: 'fresh-cara' });
        const j = await r.json();
        assert([200, 202].includes(r.status), `B: a fresh send should be accepted, got ${r.status}`);
        assert.equal(j.dm.hops, 0, 'B: a fresh (non-reply) send must start at hop 0');
        console.log('✓ B: an unrelated conversation starts a fresh chain at hop 0');
        pass++;
      }

      // ── C. no-relay ───────────────────────────────────────────────────
      {
        const r = await sendDm(base, cara, { to: 'lab:bob', text: 'no-relay-body', noRelay: true });
        const j = await r.json();
        assert([200, 202].includes(r.status), `C: a noRelay send should be accepted, got ${r.status}`);
        assert.equal(j.dm.noRelay, true, 'C: noRelay must be stored on the DM');
        // bob may NOT relay to a third party (alice) …
        const relay = await sendDm(base, bob, { to: 'home:alice', text: 'relay-attempt' });
        assert.equal(relay.status, 403, `C: relaying a no-relay DM to a third party should be 403, got ${relay.status}`);
        // … but MAY reply to the sender (cara).
        const reply = await sendDm(base, bob, { to: 'home:cara', text: 'direct-reply' });
        assert([200, 202].includes(reply.status), `C: a direct reply to the sender should be allowed, got ${reply.status}`);
        const { lines, raw } = auditLines(d);
        assert(lines.some((l) => l.action === 'agent_dm_relay_blocked'), 'C: agent_dm_relay_blocked not audited');
        assert(!raw.includes('relay-attempt'), 'C: a refused relay body leaked to the audit log');
        console.log('✓ C: no-relay blocks a third-party relay (403) but allows replying to the sender');
        pass++;
      }

      // ── D. privacy + persistence ──────────────────────────────────────
      {
        const { raw } = auditLines(d);
        for (const body of ['chain-alice', 'chain-bob', 'fresh-cara', 'no-relay-body', 'direct-reply']) {
          assert(!raw.includes(body), `D: DM body "${body}" leaked into the audit log`);
        }
        for (const t of secrets) assert(!raw.includes(t), 'D: an agent token leaked into the audit log');
        const p = path.join(d, 'portal-agent-dm.json');
        assert.equal(mode(p), '600', `D: DM file mode ${mode(p)}, expected 600`);
        const st = readStore(d);
        const nr = st.dms.find((m) => m.noRelay === true);
        assert(nr, 'D: the no-relay DM was not persisted with noRelay');
        assert(st.dms.some((m) => m.hops === 3), 'D: the hop chain was not persisted');
        console.log('✓ D: no body/token in the audit log; the store persists 0600 with hops + noRelay');
        pass++;
      }
      s.stop();
    }

    // ═══ Server B — per-pair rate + human resets (generous circuit) ═══════
    {
      const d = tmp();
      setup(d, { gateways, agentDmPairRatePerMinute: 2, agentDmPairBurst: 1, agentDmCircuitMaxPerMinute: 1000 });
      const s = await startServer(d); servers.push(s);
      const base = `http://127.0.0.1:${s.port}`;
      const admin = await login(base, 'admin', PW);
      const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
      const bob = await mint(base, admin, { agentId: 'bob', gatewayId: 'lab', label: 'Bob@lab' });
      await waitFor(async () => connected(base, alice));

      // ── E. per-pair rate limit (direction-insensitive) ────────────────
      {
        for (let i = 1; i <= 3; i++) {
          const r = await sendDm(base, alice, { to: 'lab:bob', text: 'pair-' + i });
          assert([200, 202].includes(r.status), `E: send ${i} of 3 should pass (2 + burst 1), got ${r.status}`);
        }
        const r4 = await sendDm(base, alice, { to: 'lab:bob', text: 'pair-4' });
        assert.equal(r4.status, 429, `E: the 4th send should be pair-limited, got ${r4.status}`);
        assert(r4.headers.get('retry-after'), 'E: a pair-limited DM should carry Retry-After');
        // Direction-insensitive: bob→alice shares the same exhausted bucket.
        const rev = await sendDm(base, bob, { to: 'home:alice', text: 'pair-rev' });
        assert.equal(rev.status, 429, `E: the reverse direction must share the pair bucket, got ${rev.status}`);
        const { lines } = auditLines(d);
        assert(lines.some((l) => l.action === 'agent_dm_rate_limited'), 'E: agent_dm_rate_limited not audited');
        console.log('✓ E: the per-pair limit caps a pair (429 + Retry-After) and is direction-insensitive');
        pass++;
      }

      // ── F. human involvement resets the loop state ────────────────────
      {
        const pb = await postBoard(base, admin, { board: 'general', text: 'human interjection' });
        assert.equal(pb.status, 200, `F: the human board post should succeed, got ${pb.status}`);
        const { lines } = auditLines(d);
        assert(lines.some((l) => l.action === 'agent_dm_loops_broken'), 'F: agent_dm_loops_broken not audited');
        const r = await sendDm(base, alice, { to: 'lab:bob', text: 'after-human' });
        assert([200, 202].includes(r.status), `F: a human interjection should reset the pair budget, got ${r.status}`);
        console.log('✓ F: a human board post resets the pair budgets (agent_dm_loops_broken)');
        pass++;
      }
      s.stop();
    }

    // ═══ Server C — fleet circuit breaker (generous pair budget) ═════════
    {
      const d = tmp();
      setup(d, { gateways, agentDmPairRatePerMinute: 100, agentDmPairBurst: 100, agentDmCircuitMaxPerMinute: 3, agentDmCircuitCooldownMs: 1500 });
      const s = await startServer(d); servers.push(s);
      const base = `http://127.0.0.1:${s.port}`;
      const admin = await login(base, 'admin', PW);
      const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
      const bob = await mint(base, admin, { agentId: 'bob', gatewayId: 'lab', label: 'Bob@lab' });
      await waitFor(async () => connected(base, alice));

      // ── G. circuit breaker ────────────────────────────────────────────
      {
        for (let i = 1; i <= 3; i++) {
          const r = await sendDm(base, alice, { to: 'lab:bob', text: 'cb-' + i });
          assert([200, 202].includes(r.status), `G: fleet send ${i} of 3 should pass, got ${r.status}`);
        }
        const tripped = await sendDm(base, alice, { to: 'lab:bob', text: 'cb-4' });
        assert.equal(tripped.status, 503, `G: exceeding the fleet budget should open the circuit (503), got ${tripped.status}`);
        assert(tripped.headers.get('retry-after'), 'G: an open circuit should carry Retry-After');
        // While open, even a different pair is refused.
        const open = await sendDm(base, bob, { to: 'home:alice', text: 'cb-open' });
        assert.equal(open.status, 503, `G: the circuit should refuse every pair while open, got ${open.status}`);
        const { lines } = auditLines(d);
        assert(lines.some((l) => l.action === 'agent_dm_circuit_open'), 'G: agent_dm_circuit_open not audited');
        const met = await (await fetch(`${base}/metrics`)).text();
        assert(/cirrus_portal_agent_dm_circuit_open_total [1-9]/.test(met), 'G: the circuit-open metric is missing');
        // After the cooldown a probe is allowed again.
        await sleep(1700);
        const after = await sendDm(base, alice, { to: 'lab:bob', text: 'cb-after' });
        assert([200, 202].includes(after.status), `G: the circuit should close after the cooldown, got ${after.status}`);
        console.log('✓ G: the fleet circuit breaker trips at the cap (503), refuses all pairs, and recovers');
        pass++;
      }
      s.stop();
    }
  } finally {
    for (const s of servers) { try { s.stop(); } catch { /* gone */ } }
    home.stop();
    lab.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/7 agent-dm-loop checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-dm-loop test FAILED:', e.stack || e.message);
  process.exit(1);
});
