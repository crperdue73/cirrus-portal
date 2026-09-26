#!/usr/bin/env node
'use strict';
/**
 * test-board-ui.js — acceptance test for the Board tab UI (plan item 2d).
 *
 * Item 2b/2c proved the board API + ACL. This proves the UI that sits on top of
 * them, and — crucially — that the UI is wired to the EXACT fields the server
 * returns, so a rename on the server (post.author → post.from) fails here
 * instead of silently breaking Dad's board.
 *
 *   A. static wiring — portal.html has the Board nav item + unread badge, the
 *      view dispatch, the picker/composer/filter controls, the live stream, and
 *      reads the real post fields (author/authorRef/server/ts/tags/text)
 *   B. the inline script compiles (no syntax error shipped to Dad's browser)
 *   C. read contract — GET /api/board returns { board, boards, posts, cursor };
 *      picker items expose ONLY { id, name, description } (no ACL leak)
 *   D. human post — identity round-trips as "<displayName> · portal"
 *      (authorRef "user:…"), the composer's target board
 *   E. live stream — the SSE `post` event payload carries the fields the
 *      transcript bubble renders (board + post.{id,author,server,ts,text})
 *   F. picker is the ACL — a board a caller may not read is absent from their
 *      `boards` list while `general` stays present
 *
 * Zero dependencies. Run: node test-board-ui.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const STUD_PW = 'Qw7-another-Pass-88';
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-bui-')); made.push(d); return d; };

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
  fs.copyFileSync(path.join(SRC, 'portal.html'), path.join(dir, 'portal.html'));
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
  let out = '', settled = false;
  const done = new Promise((resolve) => {
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, 9000);
    const onOut = (d) => { out += d; if (/ready\./.test(out)) { clearTimeout(timer); finish(); } };
    child.stdout.on('data', onOut);
    child.on('exit', () => { clearTimeout(timer); finish(); });
  });
  await done;
  return { port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
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

async function createBoard(base, admin, body) {
  const r = await fetch(`${base}/api/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  assert(r.ok, `createBoard failed (${r.status}) ${JSON.stringify(j)}`);
  return j;
}

async function humanPost(base, who, body) {
  return fetch(`${base}/api/board/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: who.cookie, 'X-CSRF-Token': who.csrf },
    body: JSON.stringify(body),
  });
}
const humanRead = (base, who, qs = '') => fetch(`${base}/api/board${qs}`, { headers: { Cookie: who.cookie } });

// Minimal SSE client (same shape as test-board-api.js).
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
  const html = fs.readFileSync(path.join(SRC, 'portal.html'), 'utf8');

  // ── A. static wiring ────────────────────────────────────────────────
  {
    const need = [
      ["{ key: 'board', label: 'Board' }", 'Board nav item'],
      ['navBoardBadge', 'nav unread badge id'],
      ["view === 'board') renderBoard()", 'Board view dispatch'],
      ['id="boardPicker"', 'board picker container'],
      ['id="boardPosts"', 'transcript container'],
      ['id="boardInput"', 'composer textarea'],
      ['id="boardAuthorFilter"', 'author filter input'],
      ['id="boardServerFilter"', 'server filter select'],
      ["'/api/board/stream?board='", 'live board stream'],
      ["api('/api/board/post'", 'composer POST target'],
      ['function boardSeenSave', 'unread cursor persisted'],
      ['unread-badge', 'unread badge style'],
    ];
    for (const [frag, why] of need) {
      assert(html.includes(frag), `A: portal.html is missing ${why} (looked for: ${frag})`);
    }
    // The bubble renders these exact post fields — a server rename breaks the UI.
    for (const field of ['p.authorRef', 'p.author', 'p.server', 'p.ts', 'p.text', 'p.tags', 'p.id']) {
      assert(html.includes(field), `A: transcript does not read ${field}`);
    }
    console.log('✓ A: Board tab is wired (nav+badge, picker, composer, filters, live stream, unread cursor)');
    pass++;
  }

  // ── B. the inline script compiles ───────────────────────────────────
  {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert(blocks.length === 1, `B: expected one inline <script>, found ${blocks.length}`);
    // eslint-disable-next-line no-new-func
    new Function(blocks[0]); // throws SyntaxError if the shipped script is broken
    console.log('✓ B: the inline script compiles cleanly');
    pass++;
  }

  const d = tmp(); setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const admin = await login(base, 'admin', PW);

    // ── C. read contract ─────────────────────────────────────────────
    {
      const r = await humanRead(base, admin, '?board=general');
      const j = await r.json();
      assert(r.ok, `C: read failed (${r.status})`);
      assert(j.ok && j.board && typeof j.board.id === 'string', 'C: response missing `board`');
      assert(Array.isArray(j.boards), 'C: response missing `boards` (the picker)');
      assert(Array.isArray(j.posts), 'C: response missing `posts`');
      assert('cursor' in j, 'C: response missing `cursor`');
      // The picker must expose ONLY the public shape — never the ACL rule lists.
      for (const b of j.boards) {
        const keys = Object.keys(b).sort();
        assert.deepEqual(keys, ['description', 'id', 'name'],
          `C: picker board leaked extra fields: ${JSON.stringify(keys)}`);
      }
      console.log('✓ C: /api/board returns { board, boards, posts, cursor }; picker items are ACL-free');
      pass++;
    }

    // ── D. human post identity (Dad posts as "<name> · portal") ───────
    {
      const r = await humanPost(base, admin, { board: 'general', text: 'ui-contract post' });
      const j = await r.json();
      assert(r.ok, `D: post failed (${r.status}) ${JSON.stringify(j)}`);
      assert.equal(j.post.server, 'portal', `D: server tag ${j.post.server}, expected portal`);
      assert(String(j.post.authorRef).startsWith('user:'), `D: authorRef ${j.post.authorRef}, expected user:*`);
      assert(j.post.author && j.post.author.length, 'D: author missing (UI shows it)');
      assert(typeof j.post.ts === 'number', 'D: ts missing (UI formats it)');
      const after = await (await humanRead(base, admin, '?board=general')).json();
      assert(after.posts.some(p => p.id === j.post.id), 'D: posted item not returned by read');
      assert.equal(after.cursor, j.post.id, 'D: cursor did not advance to the new post');
      console.log(`✓ D: human post round-trips as "${j.post.author} · ${j.post.server}" and advances the cursor`);
      pass++;
    }

    // ── E. live stream payload = what the bubble renders ─────────────
    {
      const sse = sseClient(base, '/api/board/stream?board=general', { Cookie: admin.cookie });
      const hello = await sse.waitFor(/event: hello/, 4000);
      assert(/event: hello/.test(hello), 'E: no hello event on the board stream');
      await humanPost(base, admin, { board: 'general', text: 'live-ui-check' });
      const raw = await sse.waitFor(/event: post/, 4000);
      sse.close();
      const m = raw.match(/event: post\ndata: (.+)\n/);
      assert(m, 'E: no `post` event with a data line');
      const payload = JSON.parse(m[1]);
      assert.equal(payload.board, 'general', 'E: stream payload missing/incorrect board');
      const p = payload.post;
      assert(p && p.id && p.board === 'general' && p.text === 'live-ui-check',
        `E: stream post payload not renderable: ${JSON.stringify(p)}`);
      for (const f of ['author', 'authorRef', 'server', 'ts']) {
        assert(f in p, `E: stream post missing ${f} (bubble reads it)`);
      }
      console.log('✓ E: live `post` event carries board + the fields the transcript bubble renders');
      pass++;
    }

    // ── F. the picker is the ACL (a restricted board never shows up) ──
    {
      await createBoard(base, admin, { id: 'staff-only', name: 'Staff only', read: ['role:instructor'], post: ['role:instructor'] });
      await createUser(base, admin, { username: 'stu', password: STUD_PW, role: 'student', displayName: 'Stu' });
      const stu = await login(base, 'stu', STUD_PW);
      const j = await (await humanRead(base, stu, '?board=general')).json();
      const ids = j.boards.map(b => b.id);
      assert(ids.includes('general'), 'F: general must be readable by everyone');
      assert(!ids.includes('staff-only'), `F: restricted board leaked into the picker: ${ids.join(',')}`);
      const r = await humanRead(base, stu, '?board=staff-only');
      assert.equal(r.status, 403, `F: reading a restricted board → ${r.status}, expected 403`);
      console.log('✓ F: the picker advertises only readable boards; restricted boards are absent + 403');
      pass++;
    }
  } finally {
    s.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 board-ui checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ board-ui test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
