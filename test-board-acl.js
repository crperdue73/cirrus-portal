#!/usr/bin/env node
'use strict';
/**
 * test-board-acl.js — Phase 2 acceptance test for board access control
 * (plan item 2c).
 *
 * 2a proved the store and 2b the HTTP surface. This proves the ACL layer that
 * sits in the SHARED core: `general` is open to all; named boards carry `read`/
 * `post` allow-lists (all | role | user | agent | gateway rules); the policy is
 * enforced server-side on read AND write, on BOTH surfaces (human session and
 * agent Bearer), and on the SSE stream — so a restricted board can never leak
 * posts or accept a write through one path while refusing it on the other.
 *
 *   A. admin board management — /api/boards create + list (admin only); ACLs
 *      persisted; the general board cannot be locked down
 *   B. read enforcement — allowed caller reads, everyone else 403, on both the
 *      human and agent surfaces; the picker hides boards the caller can't read
 *   C. write enforcement — a caller with read-but-not-post is refused; admin
 *      bypasses; a refused write leaves the store unchanged
 *   D. default-deny — a named board with no rules is closed to non-admins
 *   E. SSE read gate — no stream on a board the caller may not read
 *   F. audit + metric — refusals are audited (board_acl_denied) and counted; no
 *      token/secret/post body in the log; ACL rules never echoed by a read
 *   G. load-time guard — a board file that tries to lock `general` is corrected
 *
 * Zero dependencies. Run: node test-board-acl.js
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
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-bacl-')); made.push(d); return d; };

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

// Admin JSON POST helper (cookie + CSRF).
async function apiPost(base, who, pathName, body) {
  return fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: who.cookie, 'X-CSRF-Token': who.csrf },
    body: JSON.stringify(body),
  });
}

function sseClient(base, pathName, headers) {
  const ctrl = new AbortController();
  let buf = '';
  const waiters = [];
  (async () => {
    try {
      const r = await fetch(base + pathName, { headers, signal: ctrl.signal });
      if (!r.ok) { buf += `\nSTATUS ${r.status}`; return; }
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
    waitFor(re, timeoutMs = 4000) {
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

const auditLines = (dir) => fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const readBoard = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-board.json'), 'utf8'));
const boardPostCount = (dir, id) => readBoard(dir).posts.filter(p => p.board === id).length;

(async () => {
  let pass = 0;
  const d = tmp(); setup(d);
  const s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  const secrets = [];
  try {
    const admin = await login(base, 'admin', PW);
    await makeUser(base, admin, { username: 'stu', password: PW, role: 'student' });
    await makeUser(base, admin, { username: 'teach', password: PW, role: 'instructor' });
    const stu = await login(base, 'stu', PW);
    const teach = await login(base, 'teach', PW);

    const mk = (f) => mint(base, admin, f);
    const nora = (await mk({ agentId: 'nora', gatewayId: 'home', label: 'nora@home' })).token;
    const noah = (await mk({ agentId: 'noah', gatewayId: 'lab', label: 'noah@lab' })).token;
    secrets.push(nora, noah);

    // ── A. admin board management + general is protected ────────────────
    {
      assert.equal((await fetch(`${base}/api/boards`, { headers: jget(stu) })).status, 403,
        'A: a student reached the admin board list');
      const created = await apiPost(base, admin, '/api/boards', {
        id: 'team', name: 'Team', description: 'restricted',
        read: ['agent:nora', 'role:admin', 'role:instructor'], post: ['agent:nora'],
      });
      const cj = await created.json();
      assert(created.ok, `A: board create → ${created.status} ${JSON.stringify(cj)}`);
      assert.equal(cj.created, true, 'A: first create should report created=true');

      const list = await (await fetch(`${base}/api/boards`, { headers: jget(admin) })).json();
      const team = list.boards.find(b => b.id === 'team');
      assert(team, 'A: created board missing from the admin list');
      assert.deepEqual(team.read, ['agent:nora', 'role:admin', 'role:instructor'], `A: read ACL ${JSON.stringify(team.read)}`);
      assert.deepEqual(team.post, ['agent:nora'], `A: post ACL ${JSON.stringify(team.post)}`);
      assert.equal(team.posts, 0, 'A: fresh board should count 0 posts');

      // The general board can never be locked down — even by an explicit edit.
      const lock = await apiPost(base, admin, '/api/boards', { id: 'general', read: ['agent:nora'], post: [] });
      const lj = await lock.json();
      assert(lock.ok, `A: general edit → ${lock.status} ${JSON.stringify(lj)}`);
      assert.deepEqual(lj.board.read, ['all'], `A: general read forced to all, got ${JSON.stringify(lj.board.read)}`);
      assert.deepEqual(lj.board.post, ['all'], `A: general post forced to all, got ${JSON.stringify(lj.board.post)}`);
      console.log('✓ A: admin creates boards with ACLs; general cannot be locked down');
      pass++;
    }

    // ── B. read enforcement on both surfaces + picker filtering ──────────
    {
      // agent nora (allow-listed) reads; agent noah does not.
      const ok = await fetch(`${base}/api/agent/board?board=team`, { headers: bearer(nora) });
      assert.equal(ok.status, 200, `B: allow-listed agent read → ${ok.status}`);
      const denied = await fetch(`${base}/api/agent/board?board=team`, { headers: bearer(noah) });
      assert.equal(denied.status, 403, `B: non-listed agent read → ${denied.status}, expected 403`);
      const dj = await denied.json();
      assert(!/read|post|nora/.test(JSON.stringify(dj)), 'B: refusal leaked board ACL detail');

      // human: instructor (role-listed) reads; student does not.
      assert.equal((await fetch(`${base}/api/board?board=team`, { headers: jget(teach) })).status, 200,
        'B: instructor (role-listed) read should be allowed');
      assert.equal((await fetch(`${base}/api/board?board=team`, { headers: jget(stu) })).status, 403,
        'B: student read of a restricted board should be 403');

      // picker: noah's general read must NOT advertise the team board.
      const gl = await (await fetch(`${base}/api/agent/board?board=general`, { headers: bearer(noah) })).json();
      assert(gl.boards.some(b => b.id === 'general'), 'B: general missing from picker');
      assert(!gl.boards.some(b => b.id === 'team'), 'B: picker leaked a board the caller cannot read');
      assert(!('read' in gl.board) && !('post' in gl.board), 'B: read response echoed ACL rules');

      const noraPick = await (await fetch(`${base}/api/agent/board?board=team`, { headers: bearer(nora) })).json();
      assert(noraPick.boards.some(b => b.id === 'team'), 'B: allow-listed caller should see team in the picker');
      console.log('✓ B: read is enforced per caller on both surfaces; the picker hides unreadable boards');
      pass++;
    }

    // ── C. write enforcement + admin bypass, store untouched on refusal ──
    {
      const before = boardPostCount(d, 'team');
      const deny = await fetch(`${base}/api/agent/board/post`, {
        method: 'POST', headers: { ...bearer(noah), 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: 'team', text: 'noah should not land' }),
      });
      assert.equal(deny.status, 403, `C: non-listed agent post → ${deny.status}, expected 403`);
      assert.equal(boardPostCount(d, 'team'), before, 'C: a refused post changed the store');

      const allow = await fetch(`${base}/api/agent/board/post`, {
        method: 'POST', headers: { ...bearer(nora), 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: 'team', text: 'nora lands' }),
      });
      assert.equal(allow.status, 200, `C: allow-listed agent post → ${allow.status}`);

      // instructor may READ team but is not on its post list → refused.
      const tpost = await apiPost(base, teach, '/api/board/post', { board: 'team', text: 'teacher no' });
      assert.equal(tpost.status, 403, `C: read-but-not-post caller → ${tpost.status}, expected 403`);

      // admin bypasses both lists.
      const apost = await apiPost(base, admin, '/api/board/post', { board: 'team', text: 'admin yes' });
      assert.equal(apost.status, 200, `C: admin post should bypass the ACL (${apost.status})`);
      assert.equal(boardPostCount(d, 'team'), 2, `C: expected 2 team posts, got ${boardPostCount(d, 'team')}`);

      // general stays open to a plain student.
      const spost = await apiPost(base, stu, '/api/board/post', { board: 'general', text: 'student ok' });
      assert.equal(spost.status, 200, `C: student post to general → ${spost.status}`);
      console.log('✓ C: write ACL enforced; admin bypasses; refused writes leave the store unchanged');
      pass++;
    }

    // ── D. default-deny on a rule-less named board ──────────────────────
    {
      await apiPost(base, admin, '/api/boards', { id: 'secret', name: 'Secret' }); // no read/post
      assert.equal((await fetch(`${base}/api/agent/board?board=secret`, { headers: bearer(nora) })).status, 403,
        'D: rule-less board should refuse even an allow-listed-to-elsewhere agent');
      assert.equal((await fetch(`${base}/api/board?board=secret`, { headers: jget(stu) })).status, 403,
        'D: rule-less board should refuse a student');
      assert.equal((await fetch(`${base}/api/agent/board?board=secret`, { headers: bearer(nora) })).status, 403, 'D: repeat stable');
      const adm = await fetch(`${base}/api/board?board=secret`, { headers: jget(admin) });
      assert.equal(adm.status, 200, 'D: admin should still read a rule-less board');
      console.log('✓ D: a named board with no rules is default-deny for non-admins');
      pass++;
    }

    // ── E. SSE read gate ────────────────────────────────────────────────
    {
      const denied = await fetch(`${base}/api/board/stream?board=team`, { headers: jget(stu) });
      assert.equal(denied.status, 403, `E: student stream on restricted board → ${denied.status}, expected 403`);
      const sse = sseClient(base, '/api/board/stream?board=team', { Cookie: teach.cookie });
      const hello = await sse.waitFor(/event: hello/, 4000);
      sse.close();
      assert(/event: hello/.test(hello), 'E: allow-listed caller did not get the stream');
      console.log('✓ E: the SSE stream is gated the same way as a read');
      pass++;
    }

    // ── F. audit + metric + no leak ─────────────────────────────────────
    {
      const lines = auditLines(d);
      const denied = lines.filter(e => e.action === 'board_acl_denied');
      assert(denied.length >= 4, `F: expected several board_acl_denied entries, got ${denied.length}`);
      assert(denied.every(e => e.detail && e.detail.board && e.detail.kind), 'F: denial audit missing board/kind');
      const raw = fs.readFileSync(path.join(d, 'portal-audit.log'), 'utf8');
      for (const t of secrets) assert(raw.indexOf(t) === -1, 'F: an agent token leaked into the audit log');
      assert(raw.indexOf('noah should not land') === -1, 'F: refused post body leaked into the audit log');

      const metrics = await (await fetch(`${base}/metrics`)).text();
      const m = /cirrus_portal_board_acl_denied_total (\d+)/.exec(metrics);
      assert(m && Number(m[1]) >= 4, `F: board_acl_denied metric missing/low: ${m && m[1]}`);
      console.log(`✓ F: refusals audited + counted (${denied.length}); no secret or refused body logged`);
      pass++;
    }

    // ── G. load-time guard: a file that locks `general` is corrected ─────
    {
      const d2 = tmp(); setup(d2);
      fs.writeFileSync(path.join(d2, 'portal-board.json'), JSON.stringify({
        boards: [{ id: 'general', name: 'General', read: ['agent:ghost'], post: ['agent:ghost'] }],
        posts: [],
      }, null, 2));
      const s2 = await startServer(d2);
      try {
        const b = `http://127.0.0.1:${s2.port}`;
        const a2 = await login(b, 'admin', PW);
        await makeUser(b, a2, { username: 'stu2', password: PW, role: 'student' });
        const u2 = await login(b, 'stu2', PW);
        const r = await fetch(`${b}/api/board?board=general`, { headers: jget(u2) });
        assert.equal(r.status, 200, 'G: a seeded locked general board stayed locked');
        const stored = JSON.parse(fs.readFileSync(path.join(d2, 'portal-board.json'), 'utf8')).boards.find(x => x.id === 'general');
        assert.deepEqual(stored.read, ['all'], `G: stored general read ${JSON.stringify(stored.read)}`);
        assert.deepEqual(stored.post, ['all'], `G: stored general post ${JSON.stringify(stored.post)}`);
        console.log('✓ G: load corrects a board file that tried to lock the general board');
        pass++;
      } finally { s2.stop(); }
    }
  } finally {
    s.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/7 board-acl checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ board-acl test FAILED:', e.message, e.stack ? '\n' + e.stack : '');
  process.exit(1);
});
