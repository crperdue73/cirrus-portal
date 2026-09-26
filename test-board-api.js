#!/usr/bin/env node
'use strict';
/**
 * test-board-api.js — Phase 2 acceptance test for the bulletin-board API
 * (plan item 2b).
 *
 * Item 2a proved the store; this proves the HTTP surface layered on it, against
 * the REAL server: the human surface (/api/board*, session+CSRF) and the agent
 * surface (/api/agent/board*, Bearer) calling the SAME read/post core, so both
 * identity resolutions land in one shared, persisted log.
 *
 *   A. human reads require a session — anon 401; a Bearer token is inert here
 *   B. a human post lands with the right identity (display name · portal) and
 *      is audited (board_post)
 *   C. read/pagination — `since` cursor, `limit` clamp, unknown board 404,
 *      empty text 400 (no state written)
 *   D. live SSE — a post reaches a subscriber watching that board
 *   E. agent read — Bearer GET /api/agent/board sees the human's post; an
 *      unknown board 404s on the agent surface too
 *   F. agent post — identity author=agentId / server=gatewayId, visible on the
 *      human surface, audited (board_post via=agent); no secret in the log
 *   G. the store is persisted 0600 with both posts
 *
 * Zero dependencies. Run: node test-board-api.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-bapi-')); made.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function setup(dir) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    bind: '127.0.0.1', gateways: [], portalPassword: PW, sessionTtlHours: 12,
  }, null, 2));
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

async function humanPost(base, admin, body) {
  return fetch(`${base}/api/board/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(body),
  });
}

async function humanRead(base, admin, qs = '') {
  return fetch(`${base}/api/board${qs}`, { headers: { Cookie: admin.cookie } });
}

// Minimal SSE client: pump the stream into a buffer and let a caller await a
// regex against everything seen so far (survives the write landing before the
// waiter is registered).
function sseClient(base, path, headers) {
  const ctrl = new AbortController();
  let buf = '';
  const waiters = [];
  (async () => {
    try {
      const r = await fetch(base + path, { headers, signal: ctrl.signal });
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

function auditLines(dir) {
  const raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8');
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const readBoard = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-board.json'), 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

(async () => {
  let pass = 0;
  const d = tmp(); setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  let secret = null;
  try {
    const admin = await login(base, 'admin', PW);

    // ── A. session required on the human surface ────────────────────────
    {
      const anon = await fetch(`${base}/api/board`);
      assert.equal(anon.status, 401, `A: anon /api/board → ${anon.status}, expected 401`);
      const m = await mint(base, admin, { agentId: 'probe', gatewayId: 'home', label: 'probe@home' });
      secret = m.token;
      const withBearer = await fetch(`${base}/api/board`, { headers: bearer(m.token) });
      assert.equal(withBearer.status, 401, `A: Bearer satisfied /api/board (${withBearer.status}) — must be session-only`);
      console.log('✓ A: human board reads require a session; a Bearer token is inert there');
      pass++;
    }

    // ── B. a human post lands with the right identity + audit ───────────
    {
      const r = await humanPost(base, admin, { board: 'general', text: 'board hello from Dad', tags: ['intro'] });
      const j = await r.json();
      assert(r.ok, `B: human post → ${r.status} ${JSON.stringify(j)}`);
      assert(j.post && j.post.text === 'board hello from Dad', 'B: post text did not round-trip');
      assert.equal(j.post.board, 'general', 'B: wrong board');
      assert.equal(j.post.server, 'portal', `B: server tag ${j.post.server}, expected portal`);
      assert.equal(j.post.authorRef, 'user:admin', `B: authorRef ${j.post.authorRef}, expected user:admin`);
      assert(j.post.author && j.post.author.length, 'B: author missing');
      const { lines } = auditLines(d);
      assert(lines.some((e) => e.action === 'board_post' && e.detail && e.detail.id === j.post.id),
        'B: no board_post audit entry for the human post');
      console.log(`✓ B: human post lands as "${j.post.author} · ${j.post.server}" and is audited`);
      pass++;
    }

    // ── C. read/pagination: cursor, limit, 404, 400 ─────────────────────
    {
      const p2 = await (await humanPost(base, admin, { board: 'general', text: 'second' })).json();
      const p3 = await (await humanPost(base, admin, { board: 'general', text: 'third' })).json();
      const all = await (await humanRead(base, admin, '?board=general')).json();
      assert(all.ok && all.posts.length >= 3, `C: expected ≥3 posts, got ${all.posts.length}`);
      assert(all.posts.map(p => p.text).join(',').endsWith('board hello from Dad,second,third'),
        'C: posts not in append order');

      const since = await (await humanRead(base, admin, `?board=general&since=${p2.post.id}`)).json();
      assert(since.posts.length === 1 && since.posts[0].text === 'third',
        `C: since cursor returned ${JSON.stringify(since.posts.map(p => p.text))}`);
      assert.equal(since.cursor, p3.post.id, 'C: cursor did not advance to the newest post');

      const lim = await (await humanRead(base, admin, '?board=general&limit=1')).json();
      assert.equal(lim.posts.length, 1, `C: limit=1 returned ${lim.posts.length}`);
      assert.equal(lim.posts[0].text, 'third', 'C: limit kept the wrong end (want newest)');

      const missing = await humanRead(base, admin, '?board=nope');
      assert.equal(missing.status, 404, `C: unknown board read → ${missing.status}, expected 404`);

      const empty = await humanPost(base, admin, { board: 'general', text: '   ' });
      assert.equal(empty.status, 400, `C: empty text post → ${empty.status}, expected 400`);

      const before = (await (await humanRead(base, admin, '?board=general')).json()).posts.length;
      assert.equal(before, all.posts.length, 'C: a rejected post changed the store');
      console.log('✓ C: cursor + limit work; unknown board 404s; empty text 400s without writing');
      pass++;
    }

    // ── D. live SSE delivery ────────────────────────────────────────────
    {
      const sse = sseClient(base, '/api/board/stream?board=general', { Cookie: admin.cookie });
      const hello = await sse.waitFor(/event: hello/, 4000);
      assert(/event: hello/.test(hello), 'D: no hello event on the board stream');
      await humanPost(base, admin, { board: 'general', text: 'live-sse-check' });
      const got = await sse.waitFor(/event: post/, 4000);
      sse.close();
      assert(/event: post/.test(got) && /live-sse-check/.test(got),
        'D: the new post was not streamed to the subscriber');
      console.log('✓ D: a new post reaches a live SSE subscriber');
      pass++;
    }

    // ── E. agent read (shared store) + agent 404 ───────────────────────
    {
      const m = await mint(base, admin, { agentId: 'noah', gatewayId: 'home', label: 'noah@home' });
      const r = await fetch(`${base}/api/agent/board?board=general`, { headers: bearer(m.token) });
      const j = await r.json();
      assert(r.ok, `E: agent read → ${r.status} ${JSON.stringify(j)}`);
      assert(j.posts.some(p => p.text === 'board hello from Dad'), 'E: agent did not see the human post (not a shared store)');
      assert(Array.isArray(j.boards) && j.boards.some(b => b.id === 'general'), 'E: board list missing from the read');
      const nf = await fetch(`${base}/api/agent/board?board=nope`, { headers: bearer(m.token) });
      assert.equal(nf.status, 404, `E: agent read of unknown board → ${nf.status}, expected 404`);
      console.log('✓ E: an agent sees the shared board; unknown board 404s on the agent surface');
      pass++;
    }

    // ── F. agent post: identity, shared visibility, audit, no secret ────
    {
      const m = await mint(base, admin, { agentId: 'noah', gatewayId: 'home', label: 'noah@home' });
      const r = await fetch(`${base}/api/agent/board/post`, {
        method: 'POST', headers: { ...bearer(m.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: 'general', text: 'agent says hi', tags: ['agent'] }),
      });
      const j = await r.json();
      assert(r.ok, `F: agent post → ${r.status} ${JSON.stringify(j)}`);
      assert.equal(j.post.author, 'noah', `F: agent author ${j.post.author}, expected noah`);
      assert.equal(j.post.server, 'home', `F: agent server ${j.post.server}, expected home`);
      assert.equal(j.post.authorRef, 'agent:home:noah', `F: agent authorRef ${j.post.authorRef}`);
      const human = await (await humanRead(base, admin, '?board=general')).json();
      assert(human.posts.some(p => p.text === 'agent says hi'), 'F: agent post invisible on the human surface');
      const { raw, lines } = auditLines(d);
      assert(lines.some((e) => e.action === 'board_post' && e.detail && e.detail.author === undefined
        && e.detail.via === 'agent' && e.detail.id === j.post.id), 'F: no board_post(via=agent) audit entry');
      assert(raw.indexOf(m.token) === -1, 'F: the agent secret leaked into the audit log');
      console.log('✓ F: agent post carries its gateway, is visible to humans, and is audited secret-free');
      pass++;
    }

    // ── G. store persisted 0600 with both authors ───────────────────────
    {
      const bp = path.join(d, 'portal-board.json');
      assert.equal(mode(bp), '600', `G: board file mode ${mode(bp)}, expected 600`);
      const st = readBoard(d);
      assert(st.posts.some(p => p.authorRef === 'user:admin'), 'G: human post not persisted');
      assert(st.posts.some(p => p.authorRef === 'agent:home:noah'), 'G: agent post not persisted');
      console.log('✓ G: posts from both surfaces are persisted 0600');
      pass++;
    }
  } finally {
    s.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/7 board-api checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ board-api test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
