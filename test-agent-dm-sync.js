#!/usr/bin/env node
'use strict';
/**
 * test-agent-dm-sync.js — smoke test for plan item 4c (agent DM sync reply).
 *
 * Item 4b routed DMs and recorded async delivery. 4c adds the SYNC hold:
 * `awaitReply:true` holds the HTTP response and returns the recipient's next
 * assistant message — a cross-server request/response — by reusing the room
 * engine's state:final + runId watcher (across ALL sessions) with its
 * history-fallback for a busy/queued session, all inside one time budget.
 *
 *   A. Bearer required — the sync surface is agent-only (a cookie cannot reach it)
 *   B. sync reply lands — a 200 returns the recipient's assistant message on
 *      `dm.reply`, state:replied, and it is stored in the sender's mailbox
 *   C. sync no-reply — no assistant message yields 200 { timedOut:true }, the DM
 *      stays state:delivered (a hold never fails the call)
 *   D. concurrency cap — a second concurrent hold is refused 429 + Retry-After
 *      (so a fleet of blocking callers can't exhaust the portal) with no write
 *   E. history fallback — a busy session that acks WITHOUT a runId is recovered
 *      from chat.history (the watcher can't match), state:replied
 *   F. async regression — awaitReply:false still returns 202 (no hold)
 *   G. privacy — the reply body never reaches portal-audit.log; the audit carries
 *      only ids/state/booleans, and no token
 *   H. the reply is persisted to portal-agent-dm.json 0600 (with awaitReply)
 *   I. the replies metric is exported on /metrics
 *
 * Zero dependencies. Run: node test-agent-dm-sync.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-dmsync-')); made.push(d); return d; };
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

  // Reply orchestration the fake gateways consult on each chat.send.
  const syncReplyText = 'sync-reply-' + Math.random().toString(36).slice(2);
  const historyReplyText = 'history-reply-' + Math.random().toString(36).slice(2);
  let bobReplies = true;         // B: emit a state:final for bob's acks
  const sentHome = [];
  const sentLab = [];

  const home = await new FakeGateway({
    agents: [{ id: 'alice', name: 'Alice' }, { id: 'cara', name: 'Cara' }],
    onRequest: (method, params) => {
      if (method === 'chat.send') { sentHome.push(params); return { runId: 'rh-' + sentHome.length, status: 'accepted' }; }
      return {};
    },
  }).start();

  let labSeq = 0;
  const lab = await new FakeGateway({
    agents: [{ id: 'bob', name: 'Bob' }, { id: 'dave', name: 'Dave' }],
    onRequest: (method, params) => {
      if (method === 'chat.send') {
        labSeq++;
        sentLab.push(params);
        if (params.sessionKey === 'agent:bob:main') {
          const runId = 'rlab-' + labSeq;
          if (bobReplies) {
            // Deliver the assistant message AFTER chat.send acks — exactly a
            // real agent run. The watcher matches this runId across sessions.
            setTimeout(() => lab.broadcast({
              type: 'event', event: 'chat', payload: {
                state: 'final', runId, sessionKey: 'agent:bob:main',
                message: { content: [{ type: 'text', text: syncReplyText }] },
              },
            }), 150);
          }
          return { runId, status: 'accepted' };
        }
        if (params.sessionKey === 'agent:dave:main') {
          // Busy/queued session: acks WITHOUT a runId, so the runId watcher is
          // skipped and the history fallback must recover the real reply.
          return { status: 'accepted' };
        }
        return { runId: 'rlab-' + labSeq, status: 'accepted' };
      }
      if (method === 'chat.history') {
        if (params.sessionKey === 'agent:dave:main') {
          return { messages: [{ role: 'assistant', content: [{ type: 'text', text: historyReplyText }], timestamp: Date.now() }] };
        }
        return { messages: [] };
      }
      return {};
    },
  }).start();

  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
  ];

  const d = tmp();
  // A short hold budget keeps the no-reply case fast; maxConcurrent:1 lets the
  // cap be proven deterministically with a single overlapping request.
  setup(d, { gateways, agentDmAwaitReplyMs: 6000, agentDmSyncMaxConcurrent: 1 });
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const admin = await login(base, 'admin', PW);
    const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
    const bobRef = 'agent:lab:bob';
    const daveRef = 'agent:lab:dave';

    // Both live gateways must be connected before routing can resolve them.
    await waitFor(async () => {
      const j = await (await fetch(`${base}/api/agent/roster`, { headers: bearer(alice) })).json();
      const live = (j.servers || []).filter((x) => x.connected).map((x) => x.id).sort();
      return live.join(',') === 'home,lab';
    });

    // ── A. Bearer required + cookie inert ─────────────────────────────────
    {
      const r = await sendDm(base, undefined, { to: bobRef, text: 'x', awaitReply: true });
      assert.equal(r.status, 401, `A: no-token sync DM should be 401, got ${r.status}`);
      const cookieSent = await fetch(`${base}/api/agent/dm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({ to: bobRef, text: 'x', awaitReply: true }),
      });
      assert.equal(cookieSent.status, 401, `A: a cookie session must be inert on the agent DM surface (got ${cookieSent.status})`);
      console.log('✓ A: the sync DM surface requires a Bearer token (cookie session inert)');
      pass++;
    }

    // ── B. sync reply lands ───────────────────────────────────────────────
    {
      const before = sentLab.length;
      const r = await sendDm(base, alice, { to: 'lab:bob', text: 'sync please', awaitReply: true });
      const j = await r.json();
      assert.equal(r.status, 200, `B: a sync DM should 200, got ${r.status} ${JSON.stringify(j)}`);
      assert.equal(j.timedOut, false, 'B: timedOut should be false when the reply landed');
      assert.equal(j.dm.state, 'replied', `B: state should be replied, got ${j.dm.state}`);
      assert.equal(j.dm.reply, syncReplyText, `B: reply should be the recipient message, got ${JSON.stringify(j.dm.reply)}`);
      assert.ok(j.dm.replyTs > 0, 'B: replyTs not stamped');
      assert.equal(j.dm.awaitReply, true, 'B: awaitReply should be recorded');
      assert.equal(sentLab.length, before + 1, 'B: the recipient must have been prompted once');
      // Sender's mailbox must show the reply.
      const mine = await (await readDm(base, alice)).json();
      const replied = mine.dms.find((m) => m.to === bobRef && m.state === 'replied');
      assert(replied && replied.reply === syncReplyText, 'B: the reply was not persisted to the mailbox');
      console.log('✓ B: awaitReply returns the recipient\'s assistant message (200, state:replied)');
      pass++;
    }

    // ── C. sync no-reply → timedOut, state stays delivered ────────────────
    {
      bobReplies = false;
      const started = Date.now();
      const r = await sendDm(base, alice, { to: 'lab:bob', text: 'anyone there?', awaitReply: true });
      const j = await r.json();
      assert.equal(r.status, 200, `C: a timed-out sync hold should still 200, got ${r.status}`);
      assert.equal(j.timedOut, true, 'C: timedOut should be true when no reply arrives');
      assert.equal(j.dm.state, 'delivered', `C: a no-reply sync DM stays delivered, got ${j.dm.state}`);
      assert.equal(j.dm.reply, null, 'C: no reply should be stored');
      assert(Date.now() - started >= 5000, `C: the hold should have waited the budget (~6s), got ${Date.now() - started}ms`);
      console.log('✓ C: a sync hold with no reply returns 200 { timedOut:true }, state stays delivered');
      pass++;
      bobReplies = true;
    }

    // ── D. concurrency cap: a second concurrent hold is refused 429 ───────
    {
      bobReplies = false; // hold C' for the full budget so D overlaps it
      const before = readStore(d).dms.length;
      const hold = sendDm(base, alice, { to: 'lab:bob', text: 'hold the line', awaitReply: true }); // in flight
      await sleep(700); // let it enter the hold (past chat.send)
      const r2 = await sendDm(base, alice, { to: daveRef, text: 'second', awaitReply: true });
      assert.equal(r2.status, 429, `D: a concurrent sync DM should 429, got ${r2.status}`);
      assert.equal(r2.headers.get('retry-after'), '5', 'D: the 429 should carry Retry-After');
      const j2 = await r2.json();
      assert(/concurrent/i.test(j2.error || ''), `D: 429 error should mention concurrency, got ${JSON.stringify(j2.error)}`);
      const hr = await hold; // drain
      assert.equal((await hr.json()).timedOut, true, 'D: the first hold should still resolve (no reply)');
      assert.equal(readStore(d).dms.length, before + 1, 'D: a refused concurrent sync DM must store nothing');
      console.log('✓ D: the concurrent-hold cap refuses a second sync DM 429 + Retry-After, no write');
      pass++;
      bobReplies = true;
    }

    // ── E. history fallback recovers a busy session ───────────────────────
    {
      const r = await sendDm(base, alice, { to: 'lab:dave', text: 'busy?', awaitReply: true });
      const j = await r.json();
      assert.equal(r.status, 200, `E: a recovered sync DM should 200, got ${r.status}`);
      assert.equal(j.timedOut, false, 'E: the history fallback should have recovered a reply');
      assert.equal(j.dm.state, 'replied', `E: state should be replied, got ${j.dm.state}`);
      assert.equal(j.dm.reply, historyReplyText, `E: reply should come from history, got ${JSON.stringify(j.dm.reply)}`);
      console.log('✓ E: a busy session that acks without a runId is recovered from chat.history');
      pass++;
    }

    // ── F. async regression: awaitReply:false still 202 ───────────────────
    {
      const r = await sendDm(base, alice, { to: 'lab:bob', text: 'just async', awaitReply: false });
      const j = await r.json();
      assert.equal(r.status, 202, `F: async DM should 202, got ${r.status}`);
      assert.equal(j.dm.state, 'delivered', `F: async state should be delivered, got ${j.dm.state}`);
      assert.equal(j.dm.awaitReply, false, 'F: async DM must not be marked awaitReply');
      console.log('✓ F: awaitReply:false keeps the async 202 path unchanged');
      pass++;
    }

    // ── G. privacy: reply body never in the audit log ─────────────────────
    {
      const { raw, lines } = auditLines(d);
      assert.ok(!raw.includes(syncReplyText), 'G: the sync reply body leaked into the audit log');
      assert.ok(!raw.includes(historyReplyText), 'G: the history reply body leaked into the audit log');
      for (const t of secrets) assert.ok(!raw.includes(t), 'G: an agent token leaked into the audit log');
      const dmEvents = lines.filter((l) => l.action === 'agent_dm');
      assert(dmEvents.length >= 1, 'G: agent_dm not audited');
      for (const e of dmEvents) {
        assert(!('text' in (e.detail || {})), 'G: agent_dm audit carried the body');
        assert(!('reply' in (e.detail || {})), 'G: agent_dm audit carried the reply body');
      }
      assert(dmEvents.some((e) => e.detail && e.detail.replied === true), 'G: a replied DM was not audited with replied:true');
      assert(lines.some((l) => l.action === 'agent_dm_rejected'), 'G: a refused sync DM was not audited');
      console.log('✓ G: DM bodies stay out of the audit log; audit carries ids/state/booleans, no token');
      pass++;
    }

    // ── H. persistence: reply + awaitReply stored 0600 ────────────────────
    {
      const p = path.join(d, 'portal-agent-dm.json');
      assert(fs.existsSync(p), 'H: portal-agent-dm.json missing');
      assert.equal(mode(p), '600', `H: DM file mode ${mode(p)}, expected 600`);
      const st = readStore(d);
      const replied = st.dms.find((m) => m.to === bobRef && m.state === 'replied');
      assert(replied && replied.reply === syncReplyText, 'H: the reply was not persisted');
      assert.equal(replied.awaitReply, true, 'H: awaitReply was not persisted');
      console.log('✓ H: the reply persists to portal-agent-dm.json 0600 with awaitReply');
      pass++;
    }

    // ── I. metrics export the replies counter ─────────────────────────────
    {
      const r = await fetch(`${base}/metrics`);
      assert.equal(r.status, 200, `I: /metrics should 200 on loopback, got ${r.status}`);
      const text = await r.text();
      assert(/cirrus_portal_agent_dm_replies_total \d+/.test(text), 'I: the replies metric is missing');
      const m = /cirrus_portal_agent_dm_replies_total (\d+)/.exec(text);
      assert(Number(m[1]) >= 1, `I: replies metric should be >=1, got ${m[1]}`);
      console.log('✓ I: /metrics exports cirrus_portal_agent_dm_replies_total');
      pass++;
    }
  } finally {
    s.stop();
    home.stop();
    lab.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/9 agent-dm-sync checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-dm-sync test FAILED:', e.stack || e.message);
  process.exit(1);
});
