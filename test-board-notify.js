#!/usr/bin/env node
'use strict';
/**
 * test-board-notify.js — Phase 2 acceptance test for board notify (plan item 2e).
 *
 * 2d gave the Board tab a client-side unread cursor (localStorage). 2e adds the
 * server-side one that the HEARTBEAT PULL reads, plus the opt-in @mention wake.
 * This drives the REAL server:
 *
 *   A. pull lifecycle — a fresh identity sees every post unread (cursor null);
 *      ack advances the cursor and drains unread; the cursor is MONOTONIC
 *      (a stale/replayed ack can't re-open consumed posts)
 *   B. per-board isolation + ACL — unread is counted per board, a restricted
 *      board 403s on unread and ack (and writes no cursor), unknown board 404s
 *   C. unread window — `limit` returns the OLDEST unread first (so a poller can
 *      consume in order and ack forward), `more` flags a truncated window
 *   D. ack validation — an unknown post id is refused (400, no cursor change)
 *   E. mentions — parsed on the post, lowercased + de-duped, persisted
 *   F. wake OFF (the default) — a mention posts fine and wakes NOBODY
 *   G. wake ON (opt-in) — an unroutable mention is audited (not crashed); the
 *      author is never woken by their own post; a repeat cools down; a post
 *      wakes at most BOARD_MENTION_MAX_TARGETS (per-post cap)
 *   H. the human surface shares the same cursor model and is audited; no secret
 *      ever reaches the audit log
 *
 * Zero dependencies. Run: node test-board-notify.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-bnotify-')); made.push(d); return d; };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function setup(dir, extraCfg = {}) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(Object.assign({
    bind: '127.0.0.1', gateways: [], portalPassword: PW, sessionTtlHours: 12,
  }, extraCfg), null, 2));
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
    child.stdout.on('data', (d) => { out += d; if (/ready\./.test(out)) { clearTimeout(timer); finish(); } });
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
  const r = await fetch(`${base}/api/board/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(body),
  });
  return r;
}

async function agentPost(base, token, body) {
  return fetch(`${base}/api/agent/board/post`, {
    method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function agentUnread(base, token, qs = '') {
  return fetch(`${base}/api/agent/board/unread${qs}`, { headers: bearer(token) });
}

async function agentAck(base, token, body) {
  return fetch(`${base}/api/agent/board/ack`, {
    method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function makeBoard(base, admin, body) {
  const r = await fetch(`${base}/api/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  assert(r.ok, `makeBoard ${JSON.stringify(body)} failed (${r.status}) ${JSON.stringify(j)}`);
  return j;
}

function auditLines(dir) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8'); } catch { /* none yet */ }
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const readBoard = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-board.json'), 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);

async function runDefaultServer() {
  let pass = 0;
  const d = tmp(); setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  let secret = null;
  try {
    const admin = await login(base, 'admin', PW);
    const tok = await mint(base, admin, { agentId: 'probe', gatewayId: 'home', label: 'probe@home' });
    secret = tok.token;

    // ── A. pull lifecycle: fresh → all unread → ack drains → monotonic ──
    {
      const p1 = (await (await humanPost(base, admin, { board: 'general', text: 'first' })).json()).post;
      const p2 = (await (await humanPost(base, admin, { board: 'general', text: 'second' })).json()).post;

      const u0 = await (await agentUnread(base, tok.token)).json();
      assert.equal(u0.ok, true, 'A: unread not ok');
      assert.equal(u0.total, 2, `A: fresh identity total ${u0.total}, expected 2`);
      const g0 = u0.boards.find(b => b.id === 'general');
      assert(g0 && g0.unread === 2, `A: general unread ${g0 && g0.unread}, expected 2`);
      assert.equal(g0.cursor, null, 'A: fresh cursor should be null');
      assert.equal(g0.latestId, p2.id, 'A: latestId did not point at the newest post');

      const a1 = await (await agentAck(base, tok.token, { board: 'general', since: p1.id })).json();
      assert(a1.ok && a1.cursor === p1.id && a1.changed === true, `A: ack#1 ${JSON.stringify(a1)}`);
      const u1 = await (await agentUnread(base, tok.token, '?board=general')).json();
      assert.equal(u1.board.unread, 1, `A: after ack#1 unread ${u1.board.unread}, expected 1`);

      const a2 = await (await agentAck(base, tok.token, { board: 'general', since: p2.id })).json();
      assert(a2.ok && a2.cursor === p2.id, `A: ack#2 ${JSON.stringify(a2)}`);
      const u2 = await (await agentUnread(base, tok.token, '?board=general')).json();
      assert.equal(u2.board.unread, 0, `A: after ack#2 unread ${u2.board.unread}, expected 0`);

      // Monotonic: re-acking the older post must NOT move the cursor back.
      const a3 = await (await agentAck(base, tok.token, { board: 'general', since: p1.id })).json();
      assert(a3.ok && a3.changed === false && a3.cursor === p2.id, `A: stale ack moved cursor: ${JSON.stringify(a3)}`);
      console.log('✓ A: unread cursor drains on ack and is monotonic (stale ack is a no-op)');
      pass++;
    }

    // ── B. per-board isolation + ACL ────────────────────────────────────
    {
      await makeBoard(base, admin, { id: 'team', name: 'Team', read: ['all'], post: ['all'] });
      await makeBoard(base, admin, { id: 'secret', name: 'Secret', read: ['agent:nora'], post: ['agent:nora'] });
      await humanPost(base, admin, { board: 'team', text: 'team only' });

      const all = await (await agentUnread(base, tok.token)).json();
      const team = all.boards.find(b => b.id === 'team');
      assert(team && team.unread === 1, `B: team unread ${team && team.unread}, expected 1`);
      assert(!all.boards.some(b => b.id === 'secret'), 'B: unread leaked an unreadable board into the list');

      const one = await (await agentUnread(base, tok.token, '?board=team')).json();
      assert(one.board && one.board.id === 'team' && one.total === 1, `B: board filter wrong: ${JSON.stringify(one.board)}`);

      const forbidden = await agentUnread(base, tok.token, '?board=secret');
      assert.equal(forbidden.status, 403, `B: unread of a restricted board → ${forbidden.status}, expected 403`);
      const ackForbidden = await agentAck(base, tok.token, { board: 'secret', since: 'whatever' });
      assert.equal(ackForbidden.status, 403, `B: ack of a restricted board → ${ackForbidden.status}, expected 403`);
      const st = readBoard(d);
      assert(!st.cursors || !st.cursors['agent:home:probe'] || !st.cursors['agent:home:probe'].secret,
        'B: a refused ack still wrote a cursor');

      const missing = await agentUnread(base, tok.token, '?board=nope');
      assert.equal(missing.status, 404, `B: unread of unknown board → ${missing.status}, expected 404`);
      console.log('✓ B: unread is per-board; a restricted board 403s on unread+ack and writes no cursor');
      pass++;
    }

    // ── C. unread window is oldest-first and flags truncation ────────────
    {
      await humanPost(base, admin, { board: 'team', text: 'team two' });
      await humanPost(base, admin, { board: 'team', text: 'team three' });
      const u = await (await agentUnread(base, tok.token, '?board=team&limit=2')).json();
      assert.equal(u.board.unread, 3, `C: expected 3 unread, got ${u.board.unread}`);
      assert.equal(u.board.posts.length, 2, `C: window len ${u.board.posts.length}, expected 2`);
      assert.equal(u.board.more, true, 'C: more flag not set on a truncated window');
      assert.equal(u.board.posts[0].text, 'team only', `C: window is not oldest-first (${u.board.posts[0].text})`);
      assert.equal(u.board.posts[1].text, 'team two', 'C: window order wrong');
      console.log('✓ C: unread window is oldest-first and flags truncation (more:true)');
      pass++;
    }

    // ── D. ack validation: unknown post id refused, no cursor change ─────
    {
      const before = (await (await agentUnread(base, tok.token, '?board=team')).json()).board.cursor;
      const bad = await agentAck(base, tok.token, { board: 'team', since: 'p-does-not-exist' });
      assert.equal(bad.status, 400, `D: ack unknown id → ${bad.status}, expected 400`);
      const after = (await (await agentUnread(base, tok.token, '?board=team')).json()).board.cursor;
      assert.equal(after, before, 'D: a refused ack changed the cursor');
      console.log('✓ D: an unknown cursor id is refused (400) with no cursor change');
      pass++;
    }

    // ── E. mentions parsed, lowercased, de-duped, persisted ─────────────
    {
      const r = await humanPost(base, admin, { board: 'general', text: 'hey @Nora and @home:Noah, plus @nora again' });
      const j = await r.json();
      assert(r.ok, `E: mention post failed ${r.status}`);
      assert.deepEqual(j.post.mentions, ['nora', 'home:noah'],
        `E: mentions ${JSON.stringify(j.post.mentions)}, expected ['nora','home:noah']`);
      const st = readBoard(d);
      const stored = st.posts.find(p => p.id === j.post.id);
      assert(stored && Array.isArray(stored.mentions) && stored.mentions.length === 2, 'E: mentions not persisted');
      console.log('✓ E: @mentions are parsed, lowercased, de-duped, and persisted');
      pass++;
    }

    // ── F. wake OFF (the default) — a mention wakes nobody ──────────────
    {
      const r = await humanPost(base, admin, { board: 'general', text: 'quiet ping @ghost' });
      assert(r.ok, `F: post with a mention failed ${r.status}`);
      const { lines } = auditLines(d);
      assert(!lines.some(e => String(e.action).startsWith('board_mention_')),
        'F: wake fired while boardMentionWake was off');
      console.log('✓ F: with wake off (default), a mention posts fine and wakes nobody');
      pass++;
    }

    // ── H. human surface shares the cursor model; audit is secret-free ──
    {
      const u = await fetch(`${base}/api/board/unread?board=general`, { headers: { Cookie: admin.cookie } });
      const uj = await u.json();
      assert.equal(u.status, 200, `H: human unread → ${u.status}`);
      assert(uj.board && typeof uj.board.unread === 'number', 'H: human unread shape wrong');
      const a = await fetch(`${base}/api/board/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
        body: JSON.stringify({ board: 'general' }),
      });
      const aj = await a.json();
      assert.equal(a.status, 200, `H: human ack → ${a.status} ${JSON.stringify(aj)}`);
      assert(aj.cursor, 'H: human ack did not return a cursor');
      const after = await (await fetch(`${base}/api/board/unread?board=general`, { headers: { Cookie: admin.cookie } })).json();
      assert.equal(after.board.unread, 0, `H: human ack did not drain unread (${after.board.unread})`);

      const { raw, lines } = auditLines(d);
      assert(lines.some(e => e.action === 'board_ack' && e.detail && e.detail.board === 'general'),
        'H: no board_ack audit entry');
      assert(raw.indexOf(secret) === -1, 'H: the agent secret leaked into the audit log');

      const bp = path.join(d, 'portal-board.json');
      assert.equal(mode(bp), '600', `H: board file mode ${mode(bp)}, expected 600`);
      assert(readBoard(d).cursors && readBoard(d).cursors['user:admin'], 'H: human cursor not persisted');
      console.log('✓ H: human unread/ack share the cursor model, are audited, and leak no secret');
      pass++;
    }
  } finally {
    s.stop();
  }
  return pass;
}

async function runWakeServer() {
  let pass = 0;
  const d = tmp(); setup(d, { boardMentionWake: true });
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const admin = await login(base, 'admin', PW);
    const tok = await mint(base, admin, { agentId: 'probe', gatewayId: 'home', label: 'probe@home' });
    const mentionAudits = () => auditLines(d).lines.filter(e => String(e.action).startsWith('board_mention_'));

    // ── G1. an unroutable mention is audited (not crashed) ──────────────
    {
      const r = await humanPost(base, admin, { board: 'general', text: 'ping @ghost please' });
      assert(r.ok, `G1: wake server post failed ${r.status}`);
      const a = mentionAudits();
      assert(a.some(e => e.action === 'board_mention_unrouted' && e.detail && e.detail.target === 'ghost'),
        'G1: no board_mention_unrouted audit for an unreachable target');
      assert(!a.some(e => e.action === 'board_mention_wake'), 'G1: an unreachable target was recorded as woken');
      console.log('✓ G1: an unroutable mention is audited (unrouted) and never crashes the post');
      pass++;
    }

    // ── G2. the author is never woken by their own post + cooldown ──────
    {
      const before = mentionAudits().length;
      const selfPost = await agentPost(base, tok.token, { board: 'general', text: 'talking to myself @probe' });
      assert(selfPost.ok, `G2: self-mention post failed ${selfPost.status}`);
      const afterSelf = mentionAudits().slice(before);
      assert(!afterSelf.some(e => e.detail && e.detail.target === 'probe'),
        'G2: the author was woken by their own mention');

      // cooldown: mentioning the same (unreachable) target twice → second suppressed
      await humanPost(base, admin, { board: 'general', text: 'again @ghost' });
      const first = mentionAudits().filter(e => e.detail && e.detail.target === 'ghost' && e.action === 'board_mention_unrouted').length;
      await humanPost(base, admin, { board: 'general', text: 'and @ghost once more' });
      const cooled = mentionAudits().some(e => e.action === 'board_mention_suppressed' && e.detail && e.detail.target === 'ghost' && e.detail.reason === 'cooldown');
      assert(cooled, 'G2: a repeat mention inside the cooldown was not suppressed');
      const still = mentionAudits().filter(e => e.detail && e.detail.target === 'ghost' && e.action === 'board_mention_unrouted').length;
      assert.equal(still, first, 'G2: a cooled-down mention still attempted a wake');
      console.log('✓ G2: the author is not self-woken, and a repeat mention is suppressed by cooldown');
      pass++;
    }

    // ── G3. per-post cap: at most BOARD_MENTION_MAX_TARGETS (5) per post ─
    {
      const r = await humanPost(base, admin, { board: 'general', text: '@a1 @a2 @a3 @a4 @a5 @a6 @a7 roll call' });
      assert(r.ok, `G3: roll-call post failed ${r.status}`);
      const mine = mentionAudits().filter(e => e.detail && (/^a[1-7]$/.test(String(e.detail.target || '')) || e.detail.reason === 'per-post cap'));
      const unrouted = mine.filter(e => e.action === 'board_mention_unrouted');
      const capped = mine.filter(e => e.action === 'board_mention_suppressed' && e.detail && e.detail.reason === 'per-post cap');
      assert.equal(unrouted.length, 5, `G3: ${unrouted.length} wake attempts for 7 mentions, expected 5`);
      assert.equal(capped.length, 1, `G3: expected 1 per-post-cap suppression, got ${capped.length}`);
      assert.equal(capped[0].detail.mentioned, 7, 'G3: cap audit did not report the mention count');
      console.log('✓ G3: a post wakes at most 5 targets; the excess is suppressed and audited');
      pass++;
    }
  } finally {
    s.stop();
  }
  return pass;
}

(async () => {
  const a = await runDefaultServer();
  const b = await runWakeServer();
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${a + b}/10 board-notify checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ board-notify test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
