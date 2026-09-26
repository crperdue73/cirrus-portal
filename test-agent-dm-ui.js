#!/usr/bin/env node
'use strict';
/**
 * test-agent-dm-ui.js — acceptance test for the Agent DM tab UI (plan item 4f).
 *
 * Items 4a–4e built the DM mailbox, router, sync reply, loop safety and privacy.
 * This proves the tab that sits on top of them plus the one new server surface
 * it needs: the admin-only live feed `/api/agent-dms/stream`. Crucially it proves
 * the UI is wired to the EXACT fields the server returns AND that the privacy
 * policy holds ON THE WIRE — in private mode a body is never in an SSE frame,
 * only its metadata + length hint.
 *
 *   A. static wiring — portal.html carries the (admin-only) Agent DM nav item,
 *      the view dispatch, the pair/thread containers, the live stream URL, the
 *      visibility switch target, and reads the real DM fields
 *   B. the inline script compiles (no syntax error shipped to Dad's browser)
 *   C. the stream is admin-only — a cookie-less caller and a non-admin are refused
 *   D. live traffic — a DM routed through the portal emits an SSE `dm` frame with
 *      the metadata the pair picker + transcript render (from/to/ts/state/id)
 *   E. reply state — an `awaitReply` DM that gets answered emits a `replied` frame
 *   F. privacy on the wire — private: metadata only, the body is ABSENT from every
 *      frame (redacted + textLength); a `policy` frame follows a flip to visible
 *      and bodies appear; flipping back restores redaction
 *
 * Zero dependencies. Run: node test-agent-dm-ui.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-dmui-')); made.push(d); return d; };

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
    let out = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const timer = setTimeout(finish, 12000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('ready.')) { clearTimeout(timer); finish(); } });
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
  return j.token;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const sendDm = (base, t, body) => fetch(`${base}/api/agent/dm`, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, bearer(t)), body: JSON.stringify(body),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}

// Minimal SSE client (same shape as the board/DM suites).
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
  const html = fs.readFileSync(path.join(SRC, 'portal.html'), 'utf8');

  // ── A. static wiring ────────────────────────────────────────────────
  {
    const need = [
      ["items.push({ key: 'agentdm', label: 'Agent DM' })", 'Agent DM nav item'],
      ["view === 'agentdm') renderAgentDm()", 'Agent DM view dispatch'],
      ['id="dmPairs"', 'pair picker container'],
      ['id="dmThread"', 'thread container'],
      ['id="dmFilter"', 'pair filter input'],
      ['id="dmVisibilityBtn"', 'visibility switch'],
      ["'/api/agent-dms/stream'", 'live DM stream'],
      ["api('/api/agent-dms?limit=200')", 'admin feed read'],
      ["api('/api/agent-dms/visibility'", 'visibility flip target'],
      ['function dmTeardown', 'view teardown'],
    ];
    for (const [frag, why] of need) {
      assert(html.includes(frag), `A: portal.html is missing ${why} (looked for: ${frag})`);
    }
    // The bubble + picker render these exact DM fields — a server rename breaks the UI.
    for (const field of ['dm.from', 'dm.to', 'dm.ts', 'dm.state', 'dm.redacted', 'dm.text', 'dm.textLength', 'dm.reply', 'dm.hops', 'dm.noRelay']) {
      assert(html.includes(field), `A: Agent DM view does not read ${field}`);
    }
    console.log('✓ A: Agent DM tab is wired (nav+dispatch, pair picker, thread, live stream, visibility switch)');
    pass++;
  }

  // ── B. the inline script compiles ───────────────────────────────────
  {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert(blocks.length === 1, `B: expected one inline <script>, found ${blocks.length}`);
    // eslint-disable-next-line no-new-func
    new Function(blocks[0]);
    console.log('✓ B: the inline script compiles cleanly');
    pass++;
  }

  // Two live gateways; lab's bob answers an awaitReply DM so we can see `replied`.
  const replyText = 'dm-ui-reply-' + Math.random().toString(36).slice(2);
  let labSeq = 0;
  const home = await new FakeGateway({
    agents: [{ id: 'alice', name: 'Alice' }, { id: 'cara', name: 'Cara' }],
    onRequest: (method, params) => (method === 'chat.send' ? { runId: 'rh-' + Date.now(), status: 'accepted' } : {}),
  }).start();
  const lab = await new FakeGateway({
    agents: [{ id: 'bob', name: 'Bob' }],
    onRequest: (method, params) => {
      if (method === 'chat.send') {
        const runId = 'rlab-' + (++labSeq);
        // Deliver bob's assistant message AFTER the ack — exactly a real run.
        setTimeout(() => lab.broadcast({
          type: 'event', event: 'chat', payload: {
            state: 'final', runId, sessionKey: 'agent:bob:main',
            message: { content: [{ type: 'text', text: replyText }] },
          },
        }), 150);
        return { runId, status: 'accepted' };
      }
      return {};
    },
  }).start();
  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
  ];

  const d = tmp();
  setup(d, { gateways, agentDmAwaitReplyMs: 5000 });
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const admin = await login(base, 'admin', PW);
    const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
    await createUser(base, admin, { username: 'stu', password: STUD_PW, role: 'student', displayName: 'Stu' });
    const stu = await login(base, 'stu', STUD_PW);

    // Both gateways must be connected before the router can resolve a target.
    await waitFor(async () => {
      const j = await (await fetch(`${base}/api/agent/roster`, { headers: bearer(alice) })).json();
      const live = (j.servers || []).filter((x) => x.connected).map((x) => x.id).sort();
      return live.join(',') === 'home,lab';
    });

    // ── C. the stream is admin-only ─────────────────────────────────
    {
      const anon = await fetch(`${base}/api/agent-dms/stream`);
      assert.equal(anon.status, 401, `C: cookie-less stream → ${anon.status}, expected 401`);
      const r = await fetch(`${base}/api/agent-dms/stream`, { headers: { Cookie: stu.cookie } });
      assert.equal(r.status, 403, `C: non-admin stream → ${r.status}, expected 403`);
      console.log('✓ C: the DM live stream is admin-only (401 anon · 403 non-admin)');
      pass++;
    }

    // ── D. live traffic: a `dm` frame carries renderable metadata ────
    {
      const sse = sseClient(base, '/api/agent-dms/stream', { Cookie: admin.cookie });
      const hello = await sse.waitFor(/event: hello/, 5000);
      assert(/event: hello/.test(hello) && /"visibility":"private"/.test(hello),
        'D: stream hello must announce the current (private) policy');
      const bodyD = 'dm-ui-body-d-' + Math.random().toString(36).slice(2);
      const r = await sendDm(base, alice, { to: 'lab:bob', text: bodyD });
      assert.equal(r.status, 202, `D: send → ${r.status}`);
      const frame = await sse.waitFor(/"state":"delivered"/, 5000);
      const dm = lastDmFrame(frame);
      assert(dm && dm.state === 'delivered', `D: no delivered dm frame: ${JSON.stringify(dm)}`);
      for (const f of ['id', 'from', 'to', 'ts', 'state']) {
        assert(f in dm && dm[f] != null, `D: dm frame missing ${f} (picker/bubble reads it)`);
      }
      assert.equal(dm.from, 'agent:home:alice', `D: from=${dm.from}`);
      assert.equal(dm.to, 'agent:lab:bob', `D: to=${dm.to}`);
      // Privacy: default private, so the frame must NOT carry the body.
      assert.equal(dm.redacted, true, 'D: private frame should be redacted');
      assert(dm.text == null, 'D: private frame leaked the body');
      assert(!frame.includes(bodyD), 'D: the DM body reached the SSE wire in private mode');
      sse.close();
      console.log('✓ D: live `dm` frame carries from/to/ts/state; the private body stays off the wire');
      pass++;
    }

    // ── E. reply state: an answered awaitReply emits a `replied` frame ─
    {
      // Flip to visible first so the reply body is observable (F proves the flip).
      await fetch(`${base}/api/agent-dms/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({ visibility: 'visible' }),
      });
      const sse = sseClient(base, '/api/agent-dms/stream', { Cookie: admin.cookie });
      await sse.waitFor(/event: hello/, 5000);
      const bodyE = 'dm-ui-body-e-' + Math.random().toString(36).slice(2);
      const r = await sendDm(base, alice, { to: 'lab:bob', text: bodyE, awaitReply: true });
      assert.equal(r.status, 200, `E: sync send → ${r.status}`);
      const frame = await sse.waitFor(/"state":"replied"/, 7000);
      const dm = lastDmFrame(frame);
      assert(dm && dm.state === 'replied', `E: no replied dm frame: ${JSON.stringify(dm)}`);
      assert.equal(dm.reply, replyText, 'E: replied frame did not carry the reply');
      sse.close();
      console.log('✓ E: an answered awaitReply DM emits a `replied` frame carrying the reply');
      pass++;
    }

    // ── F. privacy on the wire (private ↔ visible) ───────────────────
    {
      // Back to private (E left it visible).
      const back = await fetch(`${base}/api/agent-dms/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({ visibility: 'private' }),
      });
      assert.equal(back.status, 200, `F: flip back → ${back.status}`);
      const sse = sseClient(base, '/api/agent-dms/stream', { Cookie: admin.cookie });
      await sse.waitFor(/event: hello/, 5000);
      // Flip visible while the tab is open → a `policy` frame announces it.
      await fetch(`${base}/api/agent-dms/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({ visibility: 'visible' }),
      });
      const pol = await sse.waitFor(/event: policy/, 5000);
      assert(/"visibility":"visible"/.test(pol), 'F: no policy frame on the flip to visible');
      // Now a fresh DM's frame DOES carry the body (policy is visible).
      const bodyF = 'dm-ui-body-f-' + Math.random().toString(36).slice(2);
      await sendDm(base, alice, { to: 'lab:bob', text: bodyF });
      const visFrame = await sse.waitFor(new RegExp('"text":"' + bodyF.slice(0, 12)), 5000);
      const vdm = lastDmFrame(visFrame);
      assert(vdm && vdm.text === bodyF, `F: visible frame did not carry the body: ${JSON.stringify(vdm)}`);
      assert(!vdm.redacted, 'F: visible frame should not be redacted');
      sse.close();
      console.log('✓ F: privacy holds on the wire — private hides the body, the flip broadcasts a policy frame, visible reveals it');
      pass++;
    }
  } finally {
    s.stop();
    await home.stop();
    await lab.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 agent-dm-ui checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-dm-ui test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
