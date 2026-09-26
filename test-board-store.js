#!/usr/bin/env node
'use strict';
/**
 * test-board-store.js — smoke test for plan item 2a (bulletin board store).
 *
 * Runs the REAL server in a throwaway temp dir, optionally seeding a
 * `portal-board.json` before boot, then asserts the store the server actually
 * persisted. This exercises the bounded-on-disk discipline (the audit-log
 * pattern) that item 2a is about — no HTTP surface exists yet (that's 2b).
 *   A. first boot creates portal-board.json 0600 with the `general` board
 *   B. boardRetentionDays prunes posts older than the window, keeps fresh
 *   C. boardMaxPosts hard-caps the file, keeping the NEWEST posts
 *   D. boardMaxBytes trims oldest until the JSON fits, never below KEEP_MIN
 *   E. load normalizes boards + posts (dup/malformed dropped, `general` seeded)
 *   F. PORTAL_BOARD_MAX_POSTS env overrides the file (Docker-friendly)
 *
 * Zero dependencies. Run: node test-board-store.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-board-')); made.push(d); return d; };

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

function seedBoard(dir, obj) {
  fs.writeFileSync(path.join(dir, 'portal-board.json'), JSON.stringify(obj, null, 2));
}

async function startServer(dir, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['portal-server.js'], {
    cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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

const readBoard = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-board.json'), 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const post = (id, ts, text) => ({ id, board: 'general', author: 'tester', text: text || `post ${id}`, ts });

(async () => {
  let pass = 0;

  // ── A. first boot creates the file 0600 with the general board ─────────
  {
    const d = tmp(); setup(d);
    const s = await startServer(d);
    try {
      const bp = path.join(d, 'portal-board.json');
      assert(fs.existsSync(bp), 'A: portal-board.json was not created on first boot');
      assert.equal(mode(bp), '600', `A: board file mode ${mode(bp)}, expected 600`);
      const st = readBoard(d);
      assert(Array.isArray(st.boards) && st.boards.some(b => b.id === 'general'), 'A: general board missing');
      assert(Array.isArray(st.posts) && st.posts.length === 0, 'A: fresh store must have no posts');
      console.log('✓ A: first boot creates portal-board.json 0600 with the general board');
      pass++;
    } finally { s.stop(); }
  }

  // ── B. retention window prunes old posts, keeps fresh ──────────────────
  {
    const d = tmp(); setup(d, { boardRetentionDays: 1 });
    const now = Date.now();
    seedBoard(d, { boards: [{ id: 'general' }], posts: [
      post('old1', now - 3 * 86400_000), post('old2', now - 2 * 86400_000),
      post('new1', now - 3600_000), post('new2', now),
    ] });
    const s = await startServer(d);
    try {
      const ids = readBoard(d).posts.map(p => p.id);
      assert.deepEqual(ids, ['new1', 'new2'], `B: expected only fresh posts, got ${ids}`);
      console.log('✓ B: boardRetentionDays prunes old posts, keeps fresh ones');
      pass++;
    } finally { s.stop(); }
  }

  // ── C. maxPosts hard cap keeps the NEWEST posts ────────────────────────
  {
    const d = tmp(); setup(d, { boardMaxPosts: 12 });
    const now = Date.now();
    const posts = Array.from({ length: 25 }, (_, i) => post(`p${i}`, now - (25 - i) * 1000));
    seedBoard(d, { boards: [{ id: 'general' }], posts });
    const s = await startServer(d);
    try {
      const kept = readBoard(d).posts.map(p => p.id);
      assert.equal(kept.length, 12, `C: expected 12 posts, got ${kept.length}`);
      assert.deepEqual(kept, posts.slice(-12).map(p => p.id), 'C: kept posts are not the newest 12');
      console.log('✓ C: boardMaxPosts caps the file and keeps the newest posts');
      pass++;
    } finally { s.stop(); }
  }

  // ── D. maxBytes trims oldest until the JSON fits, floor at KEEP_MIN ────
  {
    const d = tmp(); setup(d, { boardMaxBytes: 64 * 1024 });
    const now = Date.now();
    const blob = 'x'.repeat(4000);
    const posts = Array.from({ length: 40 }, (_, i) => post(`b${i}`, now - (40 - i) * 1000, `${i}-${blob}`));
    seedBoard(d, { boards: [{ id: 'general' }], posts });
    const s = await startServer(d);
    try {
      const st = readBoard(d);
      const bytes = Buffer.byteLength(JSON.stringify(st.posts), 'utf8');
      assert(bytes <= 64 * 1024, `D: posts still ${bytes} bytes, cap 65536`);
      assert(st.posts.length >= 10, `D: dropped below KEEP_MIN floor (${st.posts.length})`);
      assert(st.posts.length < 40, 'D: nothing was trimmed');
      assert.equal(st.posts[st.posts.length - 1].id, 'b39', 'D: newest post was dropped');
      console.log(`✓ D: boardMaxBytes trims oldest to fit (kept ${st.posts.length}, ${bytes} bytes)`);
      pass++;
    } finally { s.stop(); }
  }

  // ── E. load normalizes boards/posts and re-seeds general ───────────────
  {
    const d = tmp(); setup(d);
    seedBoard(d, {
      boards: [{ id: 'General', name: 'General' }, { id: 'general' }, { id: '' },
        { name: 'no id' }, { id: 'announcements', description: '  notices  ' }],
      posts: [{ board: 'general', author: 'a', text: '' }, null, 'nope',
        { board: 'general', author: 'a', text: 'valid', ts: 1000, tags: ['ok', 7, ''] }],
    });
    const s = await startServer(d);
    try {
      const st = readBoard(d);
      assert.deepEqual(st.boards.map(b => b.id), ['general', 'announcements'], `E: boards ${JSON.stringify(st.boards)}`);
      assert.equal(st.boards[0].id, 'general', 'E: general must be seeded');
      assert.equal(st.posts.length, 1, `E: expected 1 post, got ${st.posts.length}`);
      const p = st.posts[0];
      assert.equal(p.text, 'valid', 'E: valid post lost');
      assert.deepEqual(p.tags, ['ok', '7'], `E: tags not normalized: ${JSON.stringify(p.tags)}`);
      console.log('✓ E: load normalizes boards/posts (dup + malformed dropped, general seeded)');
      pass++;
    } finally { s.stop(); }
  }

  // ── F. env override wins over the file ─────────────────────────────────
  {
    const d = tmp(); setup(d, { boardMaxPosts: 9999 });
    const now = Date.now();
    seedBoard(d, { boards: [{ id: 'general' }], posts: Array.from({ length: 30 }, (_, i) => post(`e${i}`, now - (30 - i) * 1000)) });
    const s = await startServer(d, { PORTAL_BOARD_MAX_POSTS: '11' });
    try {
      assert.equal(readBoard(d).posts.length, 11, 'F: PORTAL_BOARD_MAX_POSTS did not override the file');
      console.log('✓ F: PORTAL_BOARD_MAX_POSTS env overrides the configured cap');
      pass++;
    } finally { s.stop(); }
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 board-store checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ board-store test FAILED:', e.message);
  process.exit(1);
});
