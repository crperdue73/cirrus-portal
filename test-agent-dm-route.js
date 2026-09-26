#!/usr/bin/env node
'use strict';
/**
 * test-agent-dm-route.js — smoke test for plan item 4b (agent DM routing).
 *
 * Item 4a shipped the durable mailbox; 4b is the router that fills it. This
 * drives the REAL server against two fake gateways and proves the routing
 * contract: one code path serves local AND remote delivery, delivery state is
 * recorded truthfully (delivered / failed), an unreachable target is refused
 * without polluting the mailbox, and DM bodies never touch the audit log.
 *
 *   A. Bearer required — the DM surface is agent-only (a cookie cannot reach it)
 *   B. cross-server delivery — alice@home DMs lab:bob; the portal resolves the
 *      target's gateway and `chat.send`s into agent:bob:main on the LAB server
 *   C. same-server delivery — alice@home DMs home:cara over the HOME server via
 *      the SAME route (proves "one code path, local and remote")
 *   D. unreachable target — a gateway that is down is refused 404, stores no DM,
 *      and is audited (agent_dm_unrouted), never silently queued
 *   E. mailbox read — the caller sees only its own sent+received DMs, with a
 *      `since` cursor + `limit` clamp
 *   F. delivery failure — a gateway that refuses chat.send records state:failed
 *      (not a silent success)
 *   G. privacy — the DM body appears ONLY in the recipient's chat.send; it never
 *      reaches portal-audit.log, and the audit carries no token/secret
 *   H. awaitReply (sync reply) is live (4c): a no-reply hold returns timedOut,
 *      never 501
 *   I. empty body is refused 400 with no write
 *   J. the mailbox persists to portal-agent-dm.json 0600
 *
 * Zero dependencies. Run: node test-agent-dm-route.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-dmroute-')); made.push(d); return d; };
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

(async () => {
  let pass = 0;

  // Two live gateways and one that is dead from boot.
  let failSend = false;
  const sentHome = [];
  const sentLab = [];
  const sendHandler = (arr) => (method, params) => {
    if (method === 'chat.send') {
      if (failSend) return { __error: { code: 'BOOM', message: 'stub refused send' } };
      arr.push(params);
      return { runId: 'r-' + arr.length, status: 'accepted' };
    }
    return {};
  };
  const home = await new FakeGateway({
    agents: [{ id: 'alice', name: 'Alice', emoji: '🅰' }, { id: 'cara', name: 'Cara' }],
    onRequest: sendHandler(sentHome),
  }).start();
  const lab = await new FakeGateway({
    agents: [{ id: 'bob', name: 'Bob', emoji: '🅱' }],
    onRequest: sendHandler(sentLab),
  }).start();
  const DEAD = { id: 'ct-test', name: 'ct-test (down)', url: 'ws://127.0.0.1:1', token: 'dead-tok', enabled: true };
  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
    DEAD,
  ];

  const d = tmp();
  // A short sync budget keeps the (now-live) awaitReply path fast here; the
  // dedicated sync suite is test-agent-dm-sync.js (plan item 4c).
  setup(d, { gateways, agentDmAwaitReplyMs: 5000 });
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const admin = await login(base, 'admin', PW);
    const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
    const bob = await mint(base, admin, { agentId: 'bob', gatewayId: 'lab', label: 'Bob@lab' });
    const cara = await mint(base, admin, { agentId: 'cara', gatewayId: 'home', label: 'Cara@home' });
    const aliceRef = 'agent:home:alice';
    const bobRef = 'agent:lab:bob';

    // Both live gateways must be connected before routing can resolve them.
    await waitFor(async () => {
      const j = await (await readDm(base, alice, '')).json();
      return j.ok === true;
    });
    await waitFor(async () => {
      const j = await (await fetch(`${base}/api/agent/roster`, { headers: bearer(alice) })).json();
      const live = (j.servers || []).filter((x) => x.connected).map((x) => x.id).sort();
      return live.join(',') === 'home,lab';
    });

    const BODY_B = 'dm-body-b-' + Math.random().toString(36).slice(2);
    const BODY_C = 'dm-body-c-' + Math.random().toString(36).slice(2);

    // ── A. Bearer required ────────────────────────────────────────────────
    {
      const r = await sendDm(base, undefined, { to: bobRef, text: 'x' });
      assert.equal(r.status, 401, `A: no-token DM should be 401, got ${r.status}`);
      const cookieSent = await fetch(`${base}/api/agent/dm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({ to: bobRef, text: 'x' }),
      });
      assert.equal(cookieSent.status, 401, `A: a cookie session must be inert on the agent DM surface (got ${cookieSent.status})`);
      console.log('✓ A: agent DM surface requires a Bearer token (cookie session inert)');
      pass++;
    }

    // ── B. cross-server delivery ──────────────────────────────────────────
    {
      const r = await sendDm(base, alice, { to: 'lab:bob', text: BODY_B });
      const j = await r.json();
      assert.equal(r.status, 202, `B: expected 202, got ${r.status} ${JSON.stringify(j)}`);
      assert.equal(j.dm.state, 'delivered', `B: state should be delivered, got ${j.dm.state}`);
      assert.equal(j.dm.toGateway, 'lab', `B: toGateway should be lab, got ${j.dm.toGateway}`);
      assert.equal(j.dm.toAgent, 'bob', `B: toAgent should be bob, got ${j.dm.toAgent}`);
      assert.equal(j.dm.from, aliceRef, `B: from should be ${aliceRef}, got ${j.dm.from}`);
      assert.equal(j.dm.to, bobRef, `B: to should be ${bobRef}, got ${j.dm.to}`);
      assert.ok(j.dm.deliveredTs > 0, 'B: deliveredTs not stamped');
      // The LAB server must have received the prompt in bob's main session.
      assert.equal(sentLab.length, 1, `B: lab should have seen 1 chat.send, saw ${sentLab.length}`);
      assert.equal(sentLab[0].sessionKey, 'agent:bob:main', `B: wrong session key ${sentLab[0].sessionKey}`);
      assert.ok(sentLab[0].message.includes(BODY_B), 'B: recipient prompt did not carry the DM body');
      assert.ok(sentLab[0].message.includes(aliceRef), 'B: recipient prompt did not carry the sender ref');
      assert.ok(!sentHome.some((p) => p.message && p.message.includes(BODY_B)), 'B: the DM leaked to the home server');
      console.log('✓ B: cross-server DM routes to the target gateway (chat.send → agent:bob:main on lab)');
      pass++;
    }

    // ── C. same-server delivery (one code path) ───────────────────────────
    {
      const r = await sendDm(base, alice, { to: 'home:cara', text: BODY_C });
      const j = await r.json();
      assert.equal(r.status, 202, `C: expected 202, got ${r.status}`);
      assert.equal(j.dm.state, 'delivered', `C: state should be delivered, got ${j.dm.state}`);
      assert.equal(j.dm.toGateway, 'home', `C: toGateway should be home, got ${j.dm.toGateway}`);
      const toCara = sentHome.filter((p) => p.sessionKey === 'agent:cara:main');
      assert.equal(toCara.length, 1, `C: home should have seen 1 send to cara, saw ${toCara.length}`);
      assert.ok(toCara[0].message.includes(BODY_C), 'C: cara did not receive the body');
      console.log('✓ C: same-server DM uses the identical route (chat.send → agent:cara:main on home)');
      pass++;
    }

    // ── D. unreachable target refused, no mailbox pollution ───────────────
    {
      const before = readStore(d).dms.length;
      const r = await sendDm(base, alice, { to: 'ct-test:ghost', text: 'nobody home' });
      assert.equal(r.status, 404, `D: unreachable target should 404, got ${r.status}`);
      assert.equal(readStore(d).dms.length, before, 'D: a refused DM must not be stored');
      const { lines } = auditLines(d);
      assert(lines.some((l) => l.action === 'agent_dm_unrouted'), 'D: agent_dm_unrouted not audited');
      console.log('✓ D: an unreachable target is refused 404, stores nothing, and is audited');
      pass++;
    }

    // ── E. mailbox read: own DMs only, cursor + limit ─────────────────────
    {
      // alice has SENT 2 (to bob, to cara) and RECEIVED none yet → 2.
      const a = await (await readDm(base, alice)).json();
      assert.equal(a.you, aliceRef, `E: you should be ${aliceRef}, got ${a.you}`);
      assert.equal(a.dms.length, 2, `E: alice should see 2 own DMs, saw ${a.dms.length}`);
      assert.equal(a.count, 2, `E: alice count should be 2, got ${a.count}`);
      // cara has RECEIVED 1 (from alice) and sent none.
      const c = await (await readDm(base, cara)).json();
      assert.equal(c.dms.length, 1, `E: cara should see 1 received DM, saw ${c.dms.length}`);
      assert.equal(c.dms[0].from, aliceRef, 'E: cara should see alice as sender');
      // bob received 1.
      const b = await (await readDm(base, bob)).json();
      assert.equal(b.dms.length, 1, `E: bob should see 1 received DM, saw ${b.dms.length}`);
      // since-cursor: reading after alice's first dm returns only the later one.
      const firstId = a.dms[0].id;
      const after = await (await readDm(base, alice, `?since=${encodeURIComponent(firstId)}`)).json();
      assert.equal(after.dms.length, 1, `E: since cursor should return 1 newer DM, got ${after.dms.length}`);
      assert.equal(after.dms[0].id, a.dms[1].id, 'E: since cursor returned the wrong DM');
      // limit clamp
      const lim = await (await readDm(base, alice, '?limit=1')).json();
      assert.equal(lim.dms.length, 1, 'E: limit=1 should return 1 DM');
      assert.equal(lim.dms[0].id, a.dms[1].id, 'E: limit should keep the newest');
      console.log('✓ E: mailbox read is caller-scoped with a since cursor + limit clamp');
      pass++;
    }

    // ── F. delivery failure recorded ──────────────────────────────────────
    {
      failSend = true;
      const r = await sendDm(base, alice, { to: 'lab:bob', text: 'will this bounce?' });
      const j = await r.json();
      failSend = false;
      assert.equal(r.status, 202, `F: a failed delivery is still accepted (recorded), got ${r.status}`);
      assert.equal(j.dm.state, 'failed', `F: state should be failed, got ${j.dm.state}`);
      assert.ok(j.dm.error, 'F: a failed DM should carry an error');
      assert(sentLab.length === 1, 'F: the refusing gateway should not have recorded the send');
      console.log('✓ F: a gateway that refuses chat.send is recorded state:failed, not a silent success');
      pass++;
    }

    // ── G. privacy: body never in the audit log, no secret ────────────────
    {
      const { raw, lines } = auditLines(d);
      assert.ok(!raw.includes(BODY_B), 'G: DM body B leaked into the audit log');
      assert.ok(!raw.includes(BODY_C), 'G: DM body C leaked into the audit log');
      for (const t of secrets) assert.ok(!raw.includes(t), 'G: an agent token leaked into the audit log');
      const dmEvents = lines.filter((l) => l.action === 'agent_dm');
      assert(dmEvents.length >= 1, 'G: agent_dm not audited');
      for (const e of dmEvents) {
        assert(!('text' in (e.detail || {})), 'G: agent_dm audit carried the body');
        assert(e.detail && e.detail.dm && e.detail.to, 'G: agent_dm audit missing routing ids');
      }
      console.log('✓ G: DM bodies stay out of the audit log; audit carries ids/state only, no token');
      pass++;
    }

    // ── H. awaitReply is live (4c): a no-reply hold times out, not 501 ────
    {
      const before = readStore(d).dms.length;
      const r = await sendDm(base, alice, { to: 'lab:bob', text: 'sync please', awaitReply: true });
      const j = await r.json();
      assert.equal(r.status, 200, `H: a sync DM should 200 now that 4c landed, got ${r.status}`);
      assert.equal(j.timedOut, true, 'H: no reply event was emitted, so the hold should time out');
      assert.equal(j.dm.state, 'delivered', `H: a no-reply sync DM stays delivered, got ${j.dm.state}`);
      assert.equal(readStore(d).dms.length, before + 1, 'H: the sync DM should be stored (delivered)');
      console.log('✓ H: awaitReply (sync reply, plan 4c) is live — a no-reply hold returns timedOut');
      pass++;
    }

    // ── I. empty body refused, no write ───────────────────────────────────
    {
      const before = readStore(d).dms.length;
      const r = await sendDm(base, alice, { to: 'lab:bob', text: '   ' });
      assert.equal(r.status, 400, `I: empty body should 400, got ${r.status}`);
      assert.equal(readStore(d).dms.length, before, 'I: an empty DM must store nothing');
      console.log('✓ I: an empty DM body is refused 400 with no write');
      pass++;
    }

    // ── J. mailbox persists 0600 ──────────────────────────────────────────
    {
      const p = path.join(d, 'portal-agent-dm.json');
      assert(fs.existsSync(p), 'J: portal-agent-dm.json missing');
      assert.equal(mode(p), '600', `J: DM file mode ${mode(p)}, expected 600`);
      const st = readStore(d);
      assert(st.dms.some((m) => m.from === aliceRef && m.to === bobRef), 'J: the delivered DM was not persisted');
      console.log('✓ J: the mailbox persists to portal-agent-dm.json 0600');
      pass++;
    }
  } finally {
    s.stop();
    home.stop();
    lab.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/10 agent-dm-route checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-dm-route test FAILED:', e.stack || e.message);
  process.exit(1);
});
