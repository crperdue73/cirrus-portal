#!/usr/bin/env node
'use strict';
/**
 * test-agent-dm-gate.js — Phase 4 acceptance gate for cross-server agent DM
 * (plan item 4g).
 *
 * Items 4a–4f each shipped a focused test. This is the missing regression gate
 * that proves the whole DM phase works TOGETHER against the REAL server with
 * live gateways — the phase-4 equivalent of `test-agent-api.js` (1d),
 * `test-board-gate.js` (2f) and `test-roster-gate.js` (3b). It deliberately
 * drives the INTEGRATION edges the per-item suites do not:
 *
 *   A. cross-gateway delivery + isolation — one portal feeds two servers; a DM
 *      to lab lands in agent:bob:main on LAB and never on HOME (and vice-versa),
 *      the sender ref rides the prompt, and a target on a dead server is refused
 *      404 with no write (agent_dm_unrouted)
 *   B. roster-discovered addressing + a cross-server sync round trip — the
 *      sender resolves the peer from GET /api/agent/roster (no hardcoded ref),
 *      an awaitReply DM returns the peer's assistant message, and the peer's
 *      reply DM routes BACK across the servers into agent:alice:main — so the
 *      phone book and the DM router agree on addressing, end to end
 *   C. loop regression — the reply chain still chains 0→1→2→3 across servers and
 *      refuses the 4th (429, no write, audited), and an unrelated pair still
 *      starts a fresh chain at hop 0
 *   D. awaitReply regression — a sync reply lands (200 replied); a no-reply hold
 *      times out and stays delivered; the async path is still 202
 *   E. privacy on/off across every surface at once — private: the body is absent
 *      from the admin feed AND the admin SSE stream AND the audit log, while both
 *      parties read their own copy; a flip to visible reveals it on feed + stream
 *      (with a `policy` frame) and tells the agents; flipping back re-redacts
 *   F. access control + secret invariant — the feed and the stream are admin-only
 *      (403 non-admin, Bearer inert 401); no agent token ever reaches the audit
 *      log or a response; the mailbox persists 0600
 *   G. human-gated loop break — an AGENT board post does NOT clear the DM pair
 *      budget, but a signed-in HUMAN board post does (agent_dm_loops_broken),
 *      proving the loop release is human-only
 *
 * Zero dependencies. Run: node test-agent-dm-gate.js
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
const STUD_PW = 'Qw7-another-Pass-88';
const made = [];
const secrets = []; // plaintext tokens we minted — must never appear anywhere
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-dmgate-')); made.push(d); return d; };

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
  const cfgPath = path.join(dir, 'portal-config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.port = port;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, get err() { return err; }, port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
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

async function createUser(base, admin, body) {
  const r = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  assert(r.ok, `createUser failed (${r.status}) ${JSON.stringify(j)}`);
  return j;
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
const whoami = (base, t) => fetch(`${base}/api/agent/whoami`, { headers: bearer(t) });
const roster = (base, t) => fetch(`${base}/api/agent/roster`, { headers: bearer(t) });
const adminDms = (base, a, q = '') => fetch(`${base}/api/agent-dms${q}`, { headers: { Cookie: a.cookie } });
const flip = (base, a, visibility) => fetch(`${base}/api/agent-dms/visibility`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: a.cookie, 'X-CSRF-Token': a.csrf },
  body: JSON.stringify({ visibility }),
});
const postBoardHuman = (base, sess, body) => fetch(`${base}/api/board/post`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: sess.cookie, 'X-CSRF-Token': sess.csrf },
  body: JSON.stringify(body),
});
const postBoardAgent = (base, t, body) => fetch(`${base}/api/agent/board/post`, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, bearer(t)), body: JSON.stringify(body),
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

// Minimal SSE client (same shape as the board/DM-ui suites).
function sseClient(base, p, headers) {
  const ctrl = new AbortController();
  let buf = '';
  const waiters = [];
  (async () => {
    try {
      const r = await fetch(base + p, { headers, signal: ctrl.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].re.test(buf)) { const w = waiters.splice(i, 1)[0]; w.resolve(buf); }
        }
      }
    } catch { /* aborted */ } finally {
      for (const w of waiters.splice(0)) w.resolve(buf);
    }
  })();
  return {
    buf: () => buf,
    waitFor(re, timeoutMs = 8000) {
      if (re.test(buf)) return Promise.resolve(buf);
      return new Promise((resolve) => {
        const w = { re, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) waiters.splice(i, 1); resolve(buf); }, timeoutMs);
      });
    },
    close() { try { ctrl.abort(); } catch { /* noop */ } },
  };
}

const lastDmFrame = (buf) => {
  const ms = [...buf.matchAll(/event: dm\ndata: (.+)\n/g)];
  if (!ms.length) return null;
  return JSON.parse(ms[ms.length - 1][1]).dm;
};

(async () => {
  let pass = 0;
  const rid = () => Math.random().toString(36).slice(2);

  // Two live gateways (home, lab) plus one that is dead from boot.
  const sentHome = [];
  const sentLab = [];
  const home = await new FakeGateway({
    agents: [{ id: 'alice', name: 'Alice', emoji: '🅰' }, { id: 'cara', name: 'Cara' }],
    onRequest: (method, params) => {
      if (method === 'chat.send') { sentHome.push(params); return { runId: 'rh-' + sentHome.length, status: 'accepted' }; }
      if (method === 'chat.history') return { messages: [] };
      return {};
    },
  }).start();

  const replyText = 'gate-dm-reply-' + rid();
  let bobReplies = true;
  let labSeq = 0;
  const lab = await new FakeGateway({
    agents: [{ id: 'bob', name: 'Bob', emoji: '🅱' }, { id: 'dave', name: 'Dave' }],
    onRequest: (method, params) => {
      if (method === 'chat.send') {
        sentLab.push(params);
        const runId = 'rlab-' + (++labSeq);
        if (params.sessionKey === 'agent:bob:main' && bobReplies) {
          // Deliver bob's assistant message AFTER the ack — exactly a real run.
          setTimeout(() => lab.broadcast({
            type: 'event', event: 'chat', payload: {
              state: 'final', runId, sessionKey: 'agent:bob:main',
              message: { content: [{ type: 'text', text: replyText }] },
            },
          }), 150);
        }
        return { runId, status: 'accepted' };
      }
      if (method === 'chat.history') return { messages: [] };
      return {};
    },
  }).start();

  const DEAD = { id: 'ct-test', name: 'ct-test (down)', url: 'ws://127.0.0.1:1', token: 'dead-tok', enabled: true };
  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
    DEAD,
  ];

  const servers = [];
  try {
    // ═══ Instance 1 — discovery, delivery, sync, loop, privacy ═══════════
    const D1 = tmp();
    // Generous loop budgets so A–F exercise routing/privacy, not the bounds;
    // a short sync budget keeps D fast; hop window long enough to chain in C.
    setup(D1, {
      gateways, agentDmAwaitReplyMs: 5000, agentDmHopWindowMs: 600000,
      agentDmPairRatePerMinute: 1000, agentDmPairBurst: 1000, agentDmCircuitMaxPerMinute: 100000,
    });
    const s = await startServer(D1); servers.push(s);
    const base = `http://127.0.0.1:${s.port}`;
    const admin = await login(base, 'admin', PW);
    await createUser(base, admin, { username: 'stu', password: STUD_PW, role: 'instructor', displayName: 'Stu' });
    const stu = await login(base, 'stu', STUD_PW);
    const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
    const bob = await mint(base, admin, { agentId: 'bob', gatewayId: 'lab', label: 'Bob@lab' });
    const cara = await mint(base, admin, { agentId: 'cara', gatewayId: 'home', label: 'Cara@home' });
    const dave = await mint(base, admin, { agentId: 'dave', gatewayId: 'lab', label: 'Dave@lab' });
    const aliceRef = 'agent:home:alice';
    const bobRef = 'agent:lab:bob';

    // Both live gateways must be connected before the router can resolve a target.
    const ready = await waitFor(async () => {
      const j = await (await roster(base, alice)).json();
      const live = (j.servers || []).filter((x) => x.connected).map((x) => x.id).sort();
      return live.join(',') === 'home,lab';
    }, 12000, 300);
    assert(ready, 'setup: live gateways never connected\n' + s.err);

    const BODY_A_B = 'gate-body-ab-' + rid();
    const BODY_A_C = 'gate-body-ac-' + rid();

    // ── A. cross-gateway delivery + isolation + unrouted ────────────────
    {
      const rb = await sendDm(base, alice, { to: 'lab:bob', text: BODY_A_B });
      const jb = await rb.json();
      assert.equal(rb.status, 202, `A: cross-server send → ${rb.status} ${JSON.stringify(jb)}`);
      assert.equal(jb.dm.state, 'delivered', `A: state should be delivered, got ${jb.dm.state}`);
      assert.equal(jb.dm.from, aliceRef, `A: from=${jb.dm.from}`);
      assert.equal(jb.dm.to, bobRef, `A: to=${jb.dm.to}`);
      const toBob = sentLab.filter((p) => p.sessionKey === 'agent:bob:main');
      assert.equal(toBob.length, 1, `A: lab should see exactly 1 send to bob, saw ${toBob.length}`);
      assert.ok(toBob[0].message.includes(BODY_A_B), 'A: bob prompt did not carry the body');
      assert.ok(toBob[0].message.includes(aliceRef), 'A: bob prompt did not carry the sender ref');

      const rc = await sendDm(base, alice, { to: 'home:cara', text: BODY_A_C });
      const jc = await rc.json();
      assert.equal(rc.status, 202, `A: same-server send → ${rc.status}`);
      assert.equal(jc.dm.toGateway, 'home', `A: toGateway should be home, got ${jc.dm.toGateway}`);
      const toCara = sentHome.filter((p) => p.sessionKey === 'agent:cara:main');
      assert.equal(toCara.length, 1, `A: home should see exactly 1 send to cara, saw ${toCara.length}`);
      assert.ok(toCara[0].message.includes(BODY_A_C), 'A: cara prompt did not carry the body');

      // Isolation: neither body leaked to the other server's connections.
      assert.ok(!sentHome.some((p) => p.message && p.message.includes(BODY_A_B)), 'A: the lab DM leaked onto the home server');
      assert.ok(!sentLab.some((p) => p.message && p.message.includes(BODY_A_C)), 'A: the home DM leaked onto the lab server');

      // A target on a dead server is refused with no write and audited.
      const before = readStore(D1).dms.length;
      const rd = await sendDm(base, alice, { to: 'ct-test:ghost', text: 'nobody home' });
      assert.equal(rd.status, 404, `A: an unreachable target should 404, got ${rd.status}`);
      assert.equal(readStore(D1).dms.length, before, 'A: a refused DM must not be stored');
      assert(auditLines(D1).lines.some((l) => l.action === 'agent_dm_unrouted'), 'A: agent_dm_unrouted not audited');
      console.log('✓ A: one portal routes to two servers with no cross-leak; a dead-server target is refused 404, no write');
      pass++;
    }

    // ── B. roster-discovered addressing + cross-server sync round trip ──
    {
      // Resolve the peer from the phone book — no hardcoded ref (the roster
      // advertises `<gw>:<id>` + the cross-server key `agent:<gw>:<id>:main`).
      const peerRef = 'lab:bob';
      const rj = await (await roster(base, alice)).json();
      const bobEntry = (rj.agents || []).find((a) => a.ref === peerRef);
      assert(bobEntry, `B: roster did not advertise ${peerRef}`);
      assert.equal(bobEntry.key, 'agent:lab:bob:main', `B: roster key wrong: ${bobEntry.key}`);

      const bodyB = 'gate-body-b-' + rid();
      const r1 = await sendDm(base, alice, { to: bobEntry.ref, text: bodyB, awaitReply: true });
      const j1 = await r1.json();
      assert.equal(r1.status, 200, `B: sync send → ${r1.status} ${JSON.stringify(j1)}`);
      assert.equal(j1.timedOut, false, 'B: the sync reply should have landed');
      assert.equal(j1.dm.state, 'replied', `B: state should be replied, got ${j1.dm.state}`);
      assert.equal(j1.dm.reply, replyText, `B: reply should be the peer's assistant message, got ${JSON.stringify(j1.dm.reply)}`);
      assert.equal(j1.dm.to, bobRef, `B: to=${j1.dm.to}`);

      // The peer answers: its reply DM must route BACK across the servers into
      // agent:alice:main on HOME (discovered from the roster, not hardcoded).
      const selfRef = 'home:alice';
      const aliceEntry = (rj.agents || []).find((a) => a.ref === selfRef);
      assert(aliceEntry, `B: roster did not advertise ${selfRef}`);
      const backBody = 'gate-body-back-' + rid();
      const r2 = await sendDm(base, bob, { to: aliceEntry.ref, text: backBody });
      const j2 = await r2.json();
      assert.equal(r2.status, 202, `B: reply-back send → ${r2.status} ${JSON.stringify(j2)}`);
      assert.equal(j2.dm.toGateway, 'home', `B: the reply-back should route to home, got ${j2.dm.toGateway}`);
      assert.equal(j2.dm.hops, 1, `B: answering a recent peer DM should carry hop 1, got ${j2.dm.hops}`);
      const toAlice = sentHome.filter((p) => p.sessionKey === 'agent:alice:main' && p.message.includes(backBody));
      assert.equal(toAlice.length, 1, `B: the reply-back never reached agent:alice:main on home (saw ${toAlice.length})`);

      // Party scoping: an uninvolved agent sees none of these.
      const caraMail = await (await readDm(base, cara)).json();
      assert.equal(caraMail.dms.length, 1, `B: cara should only see her own DM, saw ${caraMail.dms.length}`);
      assert(caraMail.dms.every((m) => m.from === aliceRef || m.to === aliceRef), 'B: cara saw a DM she is not a party to');
      console.log('✓ B: a roster-discovered peer is DM\'d, the awaitReply returns, and the reply routes back cross-server');
      pass++;
    }

    // ── C. loop regression: hop chain + fresh reset ─────────────────────
    {
      // A distinct pair (alice↔dave) so it is independent of B's chain.
      const chain = [];
      for (const [tok, to] of [[alice, 'lab:dave'], [dave, 'home:alice'], [alice, 'lab:dave'], [dave, 'home:alice']]) {
        const r = await sendDm(base, tok, { to, text: 'gate-chain-' + rid() });
        const j = await r.json();
        assert([200, 202].includes(r.status), `C: chain link → ${r.status} ${JSON.stringify(j)}`);
        chain.push(j.dm.hops);
      }
      assert.deepEqual(chain, [0, 1, 2, 3], `C: hop chain should be 0,1,2,3, got ${JSON.stringify(chain)}`);
      const before = readStore(D1).dms.length;
      const over = await sendDm(base, alice, { to: 'lab:dave', text: 'gate-chain-overflow' });
      assert.equal(over.status, 429, `C: hop overflow should be 429, got ${over.status}`);
      assert.equal(readStore(D1).dms.length, before, 'C: a hop-blocked DM must not be stored');
      assert(auditLines(D1).lines.some((l) => l.action === 'agent_dm_loop_blocked' && l.detail && l.detail.hops === 4),
        'C: agent_dm_loop_blocked (hops 4) not audited');
      // An unrelated pair still starts fresh — the bound must not poison a new thread.
      const fresh = await (await sendDm(base, cara, { to: 'lab:dave', text: 'gate-fresh-' + rid() })).json();
      assert.equal(fresh.dm.hops, 0, 'C: an unrelated send must start at hop 0');
      console.log('✓ C: the reply chain chains 0→3 across servers and refuses the 4th (429, no write); a new pair resets to 0');
      pass++;
    }

    // ── D. awaitReply regression: reply / timeout / async ───────────────
    {
      const body = 'gate-sync-' + rid();
      const r1 = await sendDm(base, alice, { to: 'lab:bob', text: body, awaitReply: true });
      const j1 = await r1.json();
      assert.equal(r1.status, 200, `D: sync reply → ${r1.status}`);
      assert.equal(j1.timedOut, false, 'D: the reply should have landed');
      assert.equal(j1.dm.state, 'replied', `D: state should be replied, got ${j1.dm.state}`);

      bobReplies = false;
      const started = Date.now();
      const r2 = await sendDm(base, alice, { to: 'lab:bob', text: 'gate-noreply-' + rid(), awaitReply: true });
      const j2 = await r2.json();
      assert.equal(r2.status, 200, `D: a timed-out sync hold should still 200, got ${r2.status}`);
      assert.equal(j2.timedOut, true, 'D: no reply should have timed out');
      assert.equal(j2.dm.state, 'delivered', `D: a no-reply sync DM stays delivered, got ${j2.dm.state}`);
      assert(Date.now() - started >= 4000, `D: the hold should have waited the budget, got ${Date.now() - started}ms`);
      bobReplies = true;

      const r3 = await sendDm(base, alice, { to: 'lab:bob', text: 'gate-async-' + rid(), awaitReply: false });
      const j3 = await r3.json();
      assert.equal(r3.status, 202, `D: async should be 202, got ${r3.status}`);
      assert.equal(j3.dm.state, 'delivered', `D: async state should be delivered, got ${j3.dm.state}`);
      assert.equal(j3.dm.awaitReply, false, 'D: async must not be marked awaitReply');
      console.log('✓ D: awaitReply lands (200 replied), a no-reply hold times out (stays delivered), async stays 202');
      pass++;
    }

    // ── E. privacy on/off across feed + stream + audit, all at once ─────
    {
      const sse = sseClient(base, '/api/agent-dms/stream', { Cookie: admin.cookie });
      await sse.waitFor(/event: hello/, 5000);

      // Private (default): the body must be absent from EVERY surface.
      const privBody = 'gate-priv-' + rid();
      const rp = await sendDm(base, alice, { to: 'lab:bob', text: privBody });
      assert.equal(rp.status, 202, `E: private send → ${rp.status}`);
      const f1 = await sse.waitFor(/"state":"delivered"/, 6000);
      const dm1 = lastDmFrame(f1);
      assert(dm1 && dm1.redacted === true, 'E: the private frame should be redacted');
      assert.equal(dm1.text, null, 'E: the private frame leaked the body');
      assert(!f1.includes(privBody), 'E: the DM body reached the SSE wire in private mode');

      const feedPriv = await (await adminDms(base, admin)).json();
      assert.equal(feedPriv.visibility, 'private', 'E: feed should report private');
      const fp = feedPriv.dms.find((m) => m.id === dm1.id);
      assert(fp && fp.text === null && fp.redacted === true, 'E: the private admin feed must redact the body');
      assert(!JSON.stringify(feedPriv).includes(privBody), 'E: the DM body leaked into the admin feed');

      // Both parties still read their own copy.
      assert((await (await readDm(base, alice)).json()).dms.some((m) => m.text === privBody), 'E: the sender could not read its own DM');
      assert((await (await readDm(base, bob)).json()).dms.some((m) => m.text === privBody), 'E: the recipient could not read its own DM');
      assert(!auditLines(D1).raw.includes(privBody), 'E: the DM body reached the audit log');

      // Flip visible: a `policy` frame, the body now on feed + stream, agents told.
      await flip(base, admin, 'visible');
      const pol = await sse.waitFor(/event: policy/, 5000);
      assert(/"visibility":"visible"/.test(pol), 'E: no policy frame on the flip to visible');
      const visBody = 'gate-vis-' + rid();
      await sendDm(base, alice, { to: 'lab:bob', text: visBody });
      const f2 = await sse.waitFor(new RegExp('"text":"' + visBody.slice(0, 12)), 6000);
      const dm2 = lastDmFrame(f2);
      assert(dm2 && dm2.text === visBody, 'E: the visible frame should carry the body');
      assert(!dm2.redacted, 'E: the visible frame should not be redacted');
      assert.equal((await (await whoami(base, alice)).json()).dmVisibility, 'visible', 'E: agents should be told the policy');
      const feedVis = await (await adminDms(base, admin)).json();
      assert(feedVis.dms.some((m) => m.text === visBody), 'E: the visible admin feed should include the body');

      // Flip back private: redaction returns.
      await flip(base, admin, 'private');
      const feedBack = await (await adminDms(base, admin)).json();
      assert(feedBack.dms.every((m) => m.text === null && m.redacted === true), 'E: bodies must be redacted again');
      sse.close();
      console.log('✓ E: privacy holds on feed + stream + audit together; the flip reveals and re-redacts, and agents are told');
      pass++;
    }

    // ── F. access control + secret invariant ────────────────────────────
    {
      const noFeed = await adminDms(base, stu);
      assert.equal(noFeed.status, 403, `F: a non-admin must not read the feed (got ${noFeed.status})`);
      const noStream = await fetch(`${base}/api/agent-dms/stream`, { headers: { Cookie: stu.cookie } });
      assert.equal(noStream.status, 403, `F: a non-admin must not open the stream (got ${noStream.status})`);
      const anonStream = await fetch(`${base}/api/agent-dms/stream`);
      assert.equal(anonStream.status, 401, `F: a cookie-less stream → ${anonStream.status}, expected 401`);
      const bearFeed = await fetch(`${base}/api/agent-dms`, { headers: bearer(alice) });
      assert.equal(bearFeed.status, 401, `F: an agent Bearer must be inert on the human feed (got ${bearFeed.status})`);

      const { raw } = auditLines(D1);
      for (const t of secrets) assert(!raw.includes(t), 'F: an agent token leaked into the audit log');
      assert.equal(mode(path.join(D1, 'portal-agent-dm.json')), '600', 'F: the mailbox must persist 0600');
      console.log('✓ F: feed + stream are admin-only (403/401), Bearer inert, no token in the log, store 0600');
      pass++;
    }
    s.stop();

    // ═══ Instance 2 — human-gated loop break ════════════════════════════
    {
      const D2 = tmp();
      setup(D2, { gateways, agentDmPairRatePerMinute: 1, agentDmPairBurst: 0, agentDmCircuitMaxPerMinute: 100000 });
      const s2 = await startServer(D2); servers.push(s2);
      const base2 = `http://127.0.0.1:${s2.port}`;
      const admin2 = await login(base2, 'admin', PW);
      const alice2 = await mint(base2, admin2, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
      const bob2 = await mint(base2, admin2, { agentId: 'bob', gatewayId: 'lab', label: 'Bob@lab' });
      await waitFor(async () => {
        const j = await (await roster(base2, alice2)).json();
        return (j.servers || []).filter((x) => x.connected).length === 2;
      }, 12000, 300);

      // ── G. only a human interjection releases the loop ────────────────
      {
        const r1 = await sendDm(base2, alice2, { to: 'lab:bob', text: 'gate-pair-1' });
        assert([200, 202].includes(r1.status), `G: the first send (budget 1) should pass, got ${r1.status}`);
        const r2 = await sendDm(base2, alice2, { to: 'lab:bob', text: 'gate-pair-2' });
        assert.equal(r2.status, 429, `G: the second send should be pair-limited, got ${r2.status}`);

        // An AGENT board post is not human involvement: the budget stays spent.
        const ap = await postBoardAgent(base2, alice2, { board: 'general', text: 'agent bulletin' });
        assert.equal(ap.status, 200, `G: the agent board post should succeed, got ${ap.status}`);
        const r3 = await sendDm(base2, alice2, { to: 'lab:bob', text: 'gate-pair-3' });
        assert.equal(r3.status, 429, `G: an agent board post must NOT reset the pair budget, got ${r3.status}`);
        assert(!auditLines(D2).lines.some((l) => l.action === 'agent_dm_loops_broken'), 'G: an agent board post must not audit agent_dm_loops_broken');

        // A signed-in HUMAN board post DOES reset it.
        const hp = await postBoardHuman(base2, admin2, { board: 'general', text: 'human interjection' });
        assert.equal(hp.status, 200, `G: the human board post should succeed, got ${hp.status}`);
        assert(auditLines(D2).lines.some((l) => l.action === 'agent_dm_loops_broken' && l.detail && l.detail.reason === 'human_board_post'),
          'G: the human board post should audit agent_dm_loops_broken');
        const r4 = await sendDm(base2, alice2, { to: 'lab:bob', text: 'gate-pair-4' });
        assert([200, 202].includes(r4.status), `G: a human interjection should reset the pair budget, got ${r4.status}`);
        console.log('✓ G: an agent board post leaves the loop bound intact; a human board post releases it (human-only)');
        pass++;
      }
      s2.stop();
    }
  } finally {
    for (const s of servers) { try { s.stop(); } catch { /* gone */ } }
    home.stop();
    lab.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/7 agent-dm-gate checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-dm-gate test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
