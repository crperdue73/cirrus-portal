#!/usr/bin/env node
'use strict';
/**
 * test-board-gate.js — Phase 2 acceptance gate for the bulletin board
 * (plan item 2f).
 *
 * Items 2a–2e each shipped a focused test (store · api · acl · ui · notify).
 * This is the missing regression gate that proves them TOGETHER in one
 * end-to-end flow against the REAL server — the board equivalent of the
 * phase-1 gate (`test-agent-api.js`, item 1d). It deliberately drives the
 * INTEGRATION edges the per-item tests do not:
 *
 *   A. one shared log across BOTH surfaces — a human and an agent post to
 *      `general` and each reads the other's post with a `since` cursor and a
 *      `limit` clamp, pinned to append order
 *   B. per-board ACL integrated with read/post/pagination — a restricted board
 *      is readable + postable by an allow-listed agent and 403s everyone else
 *      on read, write, AND stream; pagination still works inside it; the picker
 *      hides it; a refused write leaves the store untouched
 *   C. retention × cursor — under a small `boardMaxPosts` a `since` id that was
 *      PRUNED falls back to the newest window (no error, no stale), a retained
 *      `since` still pages, and the file is bounded on disk
 *   D. live stream, cross-surface — a human SSE subscriber receives an AGENT's
 *      post live; a denied identity cannot open the stream at all
 *   E. audit + no secret — every post and every ACL refusal is audited and no
 *      agent token ever reaches the log
 *
 * Zero dependencies. Run: node test-board-gate.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-bgate-')); made.push(d); return d; };

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
  const child = spawn(process.execPath, ['portal-server.js'], {
    cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '', settled = false;
  const done = new Promise((resolve) => {
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, 9000);
    const onOut = (d) => { out += d; if (/ready\./.test(out)) { clearTimeout(timer); finish(); } };
    child.stdout.on('data', onOut);
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { clearTimeout(timer); finish(); });
  });
  await done;
  return { port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, logs: () => ({ out, err }) };
}

async function login(base, username, password) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  assert(r.ok, `login ${username} failed (${r.status}) ${JSON.stringify(j)}`);
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j.csrfToken, username };
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

async function makeUser(base, admin, fields) {
  const r = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(fields),
  });
  const j = await r.json();
  assert(r.ok, `create user ${fields.username} failed (${r.status}) ${JSON.stringify(j)}`);
  return j;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const jget = (u) => ({ Cookie: u.cookie });
const humanRead = (base, who, qs = '') => fetch(`${base}/api/board${qs}`, { headers: jget(who) });
const humanPost = (base, who, body) => fetch(`${base}/api/board/post`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: who.cookie, 'X-CSRF-Token': who.csrf },
  body: JSON.stringify(body),
});
const agentRead = (base, tok, qs = '') => fetch(`${base}/api/agent/board${qs}`, { headers: bearer(tok) });
const agentPost = (base, tok, body) => fetch(`${base}/api/agent/board/post`, {
  method: 'POST', headers: { ...bearer(tok), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const apiPost = (base, who, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: who.cookie, 'X-CSRF-Token': who.csrf },
  body: JSON.stringify(body),
});

const auditLines = (dir) => fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const readBoard = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-board.json'), 'utf8'));
const boardPostCount = (dir, id) => readBoard(dir).posts.filter(p => p.board === id).length;
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

// Minimal SSE client (survives a write that lands before the waiter registers).
function sseClient(base, pathName, headers) {
  const ctrl = new AbortController();
  let buf = '', status = null;
  const waiters = [];
  (async () => {
    try {
      const r = await fetch(base + pathName, { headers, signal: ctrl.signal });
      status = r.status;
      if (!r.ok) return;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].re.test(buf)) waiters.splice(i, 1)[0].resolve(buf);
      }
    } catch { /* aborted */ } finally {
      for (const w of waiters.splice(0)) w.resolve(buf);
    }
  })();
  return {
    status: () => status,
    waitFor(re, timeoutMs = 6000) {
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

(async () => {
  let pass = 0;
  const d = tmp(); setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  const secrets = [];
  try {
    const admin = await login(base, 'admin', PW);
    await makeUser(base, admin, { username: 'stu', password: PW, role: 'student' });
    const stu = await login(base, 'stu', PW);

    const nora = (await mint(base, admin, { agentId: 'nora', gatewayId: 'home', label: 'nora@home' })).token;
    const noah = (await mint(base, admin, { agentId: 'noah', gatewayId: 'lab', label: 'noah@lab' })).token;
    secrets.push(nora, noah);

    // ── A. one shared log: post/read/pagination across both surfaces ────
    {
      const h1 = await (await humanPost(base, admin, { board: 'general', text: 'human one' })).json();
      const a1 = await (await agentPost(base, nora, { board: 'general', text: 'agent one' })).json();
      const h2 = await (await humanPost(base, admin, { board: 'general', text: 'human two' })).json();

      // Human reads the whole board — sees the agent's post between its own,
      // in append order, with the cursor pinned to the newest.
      const all = await (await humanRead(base, admin, '?board=general')).json();
      const texts = all.posts.map(p => p.text);
      assert.deepEqual(texts, ['human one', 'agent one', 'human two'], `A: shared log order ${JSON.stringify(texts)}`);
      assert(texts.indexOf('agent one') === 1, 'A: the agent post is not in the shared human log');
      assert.equal(all.cursor, h2.post.id, 'A: cursor is not the newest post id');

      // Agent reads with `since` = its own post → only the human's later post.
      const sinceAgent = await (await agentRead(base, nora, `?board=general&since=${a1.post.id}`)).json();
      assert.deepEqual(sinceAgent.posts.map(p => p.text), ['human two'],
        `A: agent since-cursor leaked the wrong window ${JSON.stringify(sinceAgent.posts.map(p => p.text))}`);

      // Human reads with `since` = the agent's post → only its own later post.
      const sinceHuman = await (await humanRead(base, admin, `?board=general&since=${a1.post.id}`)).json();
      assert.deepEqual(sinceHuman.posts.map(p => p.text), ['human two'], 'A: human since-cursor wrong');

      // limit keeps the NEWEST end.
      const lim = await (await humanRead(base, admin, '?board=general&limit=1')).json();
      assert.equal(lim.posts.length, 1, `A: limit=1 returned ${lim.posts.length}`);
      assert.equal(lim.posts[0].text, 'human two', 'A: limit kept the wrong end (want newest)');

      // The agent sees the human's first post with the right identity fields.
      const first = sinceAgent.posts.find(p => p.text === 'human two');
      assert(first && first.server === 'portal' && /^user:/.test(first.authorRef || ''),
        `A: human post identity on the agent surface ${JSON.stringify(first && { s: first.server, r: first.authorRef })}`);
      console.log('✓ A: human + agent share one log; each reads the other with since + limit, append order held');
      pass++;
    }

    // ── B. per-board ACL integrated with read/post/pagination + stream ──
    {
      const created = await apiPost(base, admin, '/api/boards', {
        id: 'team', name: 'Team', description: 'restricted',
        read: ['agent:nora'], post: ['agent:nora'],
      });
      assert(created.ok, `B: board create → ${created.status}`);

      // allow-listed agent: read + post OK; pagination works INSIDE the board.
      assert.equal((await agentRead(base, nora, '?board=team')).status, 200, 'B: allow-listed agent read');
      const t1 = await (await agentPost(base, nora, { board: 'team', text: 't-one' })).json();
      const t2 = await (await agentPost(base, nora, { board: 'team', text: 't-two' })).json();
      assert(t1.post && t2.post, 'B: allow-listed agent post failed');
      const page = await (await agentRead(base, nora, `?board=team&since=${t1.post.id}`)).json();
      assert.deepEqual(page.posts.map(p => p.text), ['t-two'],
        `B: pagination inside a restricted board wrong ${JSON.stringify(page.posts.map(p => p.text))}`);

      // everyone else: refused on read, write, and stream; store untouched.
      const before = boardPostCount(d, 'team');
      assert.equal((await agentRead(base, noah, '?board=team')).status, 403, 'B: non-listed agent read should 403');
      assert.equal((await agentPost(base, noah, { board: 'team', text: 'nope' })).status, 403, 'B: non-listed agent post should 403');
      assert.equal((await humanRead(base, stu, '?board=team')).status, 403, 'B: student read should 403');
      assert.equal((await humanPost(base, stu, { board: 'team', text: 'nope' })).status, 403, 'B: student post should 403');
      assert.equal(boardPostCount(d, 'team'), before, 'B: a refused write changed the store');

      // picker: the denied agent's general read must NOT advertise `team`.
      const gl = await (await agentRead(base, noah, '?board=general')).json();
      assert(!gl.boards.some(b => b.id === 'team'), 'B: picker leaked a board the caller cannot read');
      assert(!('read' in gl.board) && !('post' in gl.board), 'B: read response echoed ACL rules');
      console.log('✓ B: restricted board gates read/write/stream + hidden from the picker; pagination works inside it');
      pass++;
    }

    // ── D. live stream cross-surface (agent post → human subscriber) ────
    {
      const sse = sseClient(base, '/api/board/stream?board=general', jget(admin));
      const hello = await sse.waitFor(/event: hello/, 4000);
      assert(/event: hello/.test(hello), 'D: no hello event on the board stream');
      // The post comes from an AGENT, delivered to the HUMAN subscriber.
      await agentPost(base, nora, { board: 'general', text: 'agent-live-check' });
      const got = await sse.waitFor(/event: post/, 4000);
      sse.close();
      assert(/event: post/.test(got) && /agent-live-check/.test(got),
        'D: an agent post was not streamed live to the human subscriber');

      // A denied identity cannot open the stream at all.
      const denied = await fetch(`${base}/api/board/stream?board=team`, { headers: jget(stu) });
      assert.equal(denied.status, 403, `D: denied stream → ${denied.status}, expected 403`);
      console.log('✓ D: an agent post streams live to a human subscriber; a denied identity cannot open the stream');
      pass++;
    }

    // ── E. audit + no secret across the whole flow ──────────────────────
    {
      const raw = fs.readFileSync(path.join(d, 'portal-audit.log'), 'utf8');
      const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const posts = lines.filter(e => e.action === 'board_post');
      assert(posts.some(e => e.detail && e.detail.via === 'agent'), 'E: no board_post(via=agent) audit entry');
      assert(posts.some(e => e.action === 'board_post' && (!e.detail || e.detail.via !== 'agent')),
        'E: no human board_post audit entry');
      const denied = lines.filter(e => e.action === 'board_acl_denied');
      assert(denied.length >= 5, `E: expected ≥5 board_acl_denied entries, got ${denied.length}`);
      assert(denied.every(e => e.detail && e.detail.board && e.detail.kind), 'E: denial audit missing board/kind');
      for (const t of secrets) assert(raw.indexOf(t) === -1, 'E: an agent token leaked into the audit log');
      console.log(`✓ E: every post + refusal audited (${posts.length} post, ${denied.length} denied); no secret logged`);
      pass++;
    }
  } finally { s.stop(); }

  // ── C. retention × cursor (separate bound instance) ───────────────────
  {
    const d2 = tmp(); setup(d2, { boardMaxPosts: 10, boardRetentionDays: 0 });
    const s2 = await startServer(d2);
    try {
      const b = `http://127.0.0.1:${s2.port}`;
      const a2 = await login(b, 'admin', PW);
      const ids = [];
      for (let i = 1; i <= 14; i++) {
        const j = await (await humanPost(b, a2, { board: 'general', text: `p${i}` })).json();
        assert(j.post, `C: post p${i} failed`);
        ids.push(j.post.id);
      }
      // The count cap (floor 10) keeps only the newest 10 on disk.
      const st = readBoard(d2);
      assert.equal(st.posts.length, 10, `C: file should hold 10 posts, has ${st.posts.length}`);
      assert.equal(st.posts[st.posts.length - 1].text, 'p14', 'C: newest post was dropped');
      assert.equal(mode(path.join(d2, 'portal-board.json')), '600', 'C: board file not 0600');

      // A `since` id that was PRUNED falls back to the newest window (no error).
      const pruned = await (await humanRead(b, a2, `?board=general&since=${ids[0]}`)).json();
      assert(pruned.posts.length === 10 && pruned.posts[0].text === 'p5',
        `C: pruned since did not fall back to the newest window (${pruned.posts.map(p => p.text).join(',')})`);

      // A retained `since` still pages — only what came after it.
      const retained = await (await humanRead(b, a2, `?board=general&since=${ids[5]}`)).json();
      assert.deepEqual(retained.posts.map(p => p.text), ['p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13', 'p14'],
        `C: retained since paged the wrong window ${JSON.stringify(retained.posts.map(p => p.text))}`);
      assert.equal(retained.cursor, ids[13], 'C: cursor did not advance to the newest post');
      console.log('✓ C: pruned since falls back to the newest window; retained since still pages; file bounded 0600');
      pass++;
    } finally { s2.stop(); }
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/5 board-gate checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ board-gate test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
