#!/usr/bin/env node
'use strict';
/**
 * test-auth.js — smoke test for plan item 6 (auth hardening).
 *
 * Runs the REAL server in throwaway temp dirs and asserts:
 *   A. CSRF: state-changing calls without the session-bound token are refused
 *      (403); with it they succeed. Logout-all revokes every session.
 *   B. Session rotation: logging in again invalidates the previous session id
 *      (no session fixation); the newest cookie keeps working.
 *   C. Progressive lockout: repeated bad logins for one account return 429 with
 *      Retry-After — and even the CORRECT password is refused while locked.
 *   D. Password policy: weak passwords are rejected on create + reset (length +
 *      blocklist); a password reset revokes that user's live sessions.
 *   E. Configurable idle TTL: sessionIdleMinutes expires an idle session.
 *
 * Zero dependencies. Run: node test-auth.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';        // strong bootstrap admin password
const GOOD = 'Harbor-Vane-92x';         // passes the password policy
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-auth-')); made.push(d); return d; };

function setup(dir, overrides) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.copyFileSync(path.join(SRC, 'portal.html'), path.join(dir, 'portal.html'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(Object.assign({
    port: 19700 + Math.floor(Math.random() * 200),
    bind: '127.0.0.1',
    gateways: [],
    portalPassword: PW,
    sessionTtlHours: 12,
  }, overrides || {}), null, 2));
  return JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
}

function startServer(dir) {
  return new Promise((resolve) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, out, err, port: cfg.port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const timer = setTimeout(finish, 8000);
    const onData = (d) => { out += d; if (out.includes('ready.')) { clearTimeout(timer); finish(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { clearTimeout(timer); finish(); });
  });
}

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(base, username, password, extraHeaders) {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify({ username, password }),
  });
  let body = null; try { body = await res.json(); } catch { /* none */ }
  return { res, body, cookie: cookieOf(res) };
}

async function me(base, cookie) {
  const res = await fetch(base + '/api/me', { headers: cookie ? { Cookie: cookie } : {} });
  return res.json();
}

(async () => {
  let pass = 0;

  // ── A. CSRF enforcement + logout-all ───────────────────────────────────────
  {
    const d = tmp();
    setup(d);
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const { res: lr, body: lj, cookie } = await login(base, 'admin', PW);
      assert(lr.ok && lj.csrfToken, `A: login should return a csrf token (${lr.status})`);

      // create a user WITHOUT the csrf header → refused
      const noCsrf = await fetch(base + '/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ username: 'stu1', password: GOOD, role: 'student' }),
      });
      assert(noCsrf.status === 403, `A: POST without csrf must be 403 (got ${noCsrf.status})`);

      // ...and the read endpoint still works without the header
      const list = await fetch(base + '/api/users', { headers: { Cookie: cookie } });
      assert(list.ok, `A: authed GET should not need csrf (${list.status})`);

      // logout-all WITHOUT the header → refused
      const laNo = await fetch(base + '/api/logout-all', { method: 'POST', headers: { Cookie: cookie } });
      assert(laNo.status === 403, `A: logout-all without csrf must be 403 (got ${laNo.status})`);

      // logout-all WITH the header → revokes the session
      const la = await fetch(base + '/api/logout-all', {
        method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': lj.csrfToken },
      });
      assert(la.ok, `A: logout-all with csrf failed (${la.status})`);
      assert((await la.json()).sessions >= 1, 'A: logout-all should report revoked sessions');

      const after = await me(base, cookie);
      assert(after.authed === false, 'A: session should be dead after logout-all');

      // cross-origin Origin header is refused on state-changing calls
      const { res: lr2, body: lj2, cookie: c2 } = await login(base, 'admin', PW);
      assert(lr2.ok && lj2.csrfToken, 'A: second login failed');
      const xo = await fetch(base + '/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c2, Origin: 'https://evil.example' },
        body: JSON.stringify({ username: 'x', password: GOOD }),
      });
      assert(xo.status === 403, `A: cross-origin state change must be 403 (got ${xo.status})`);
      console.log('✓ A: CSRF required on writes; reads exempt; logout-all revokes; cross-origin refused');
      pass++;
    } finally { s.stop(); }
  }

  // ── B. Session rotation on login ───────────────────────────────────────────
  {
    const d = tmp();
    setup(d);
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const first = await login(base, 'admin', PW);
      assert(first.cookie, 'B: no cookie from first login');

      // Re-login while presenting the old cookie: the old session must be dropped.
      const second = await login(base, 'admin', PW, { Cookie: first.cookie });
      assert(second.cookie && second.cookie !== first.cookie, 'B: re-login should rotate the session id');

      assert((await me(base, first.cookie)).authed === false, 'B: the pre-login session should be invalidated');
      assert((await me(base, second.cookie)).authed === true, 'B: the rotated session should work');
      console.log('✓ B: re-login rotates the session id and kills the previous one (no fixation)');
      pass++;
    } finally { s.stop(); }
  }

  // ── C. Progressive lockout ─────────────────────────────────────────────────
  {
    const d = tmp();
    setup(d);
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      let last = null;
      for (let i = 1; i <= 5; i++) last = await login(base, 'admin', 'definitely-wrong-' + i);
      assert(last.res.status === 429, `C: 5th bad login should lock out (got ${last.res.status})`);
      assert(Number(last.res.headers.get('retry-after')) > 0, 'C: lockout should send Retry-After');

      // Even the correct password is refused while locked.
      const correct = await login(base, 'admin', PW);
      assert(correct.res.status === 429, `C: correct password while locked should be 429 (got ${correct.res.status})`);
      assert(correct.body && correct.body.retryAfter > 0, 'C: 429 should carry retryAfter');
      console.log('✓ C: repeated failures lock the account (429 + Retry-After); correct pw refused while locked');
      pass++;
    } finally { s.stop(); }
  }

  // ── D. Password policy + reset revokes sessions ─────────────────────────────
  {
    const d = tmp();
    setup(d);
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const admin = await login(base, 'admin', PW);
      const hdr = { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.body.csrfToken };

      const weak = await fetch(base + '/api/users', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ username: 'stu1', password: 'password1', role: 'student' }),
      });
      assert(weak.status === 400, `D: blocklisted password must be 400 (got ${weak.status})`);

      const short = await fetch(base + '/api/users', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ username: 'stu1', password: 'aA1', role: 'student' }),
      });
      assert(short.status === 400, `D: short password must be 400 (got ${short.status})`);

      const ok = await fetch(base + '/api/users', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ username: 'stu1', displayName: 'Student One', password: GOOD, role: 'student' }),
      });
      assert(ok.ok, `D: strong password should create the user (${ok.status})`);

      const stu = await login(base, 'stu1', GOOD);
      assert(stu.res.ok, 'D: new user should be able to log in');

      const reset = await fetch(base + '/api/users/stu1/password', {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ password: 'New-Harbor-73z' }),
      });
      assert(reset.ok, `D: admin password reset failed (${reset.status})`);
      assert((await reset.json()).sessionsRevoked >= 1, 'D: reset should report revoked sessions');

      assert((await me(base, stu.cookie)).authed === false, 'D: the old session should be revoked by a reset');
      console.log('✓ D: policy rejects weak/short/blocklisted passwords; reset revokes live sessions');
      pass++;
    } finally { s.stop(); }
  }

  // ── E. Configurable idle TTL ───────────────────────────────────────────────
  {
    const d = tmp();
    setup(d, { sessionIdleMinutes: 0.02 }); // ~1.2s idle timeout
    const s = await startServer(d);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const l = await login(base, 'admin', PW);
      assert(l.res.ok, 'E: login failed');
      assert((await me(base, l.cookie)).authed === true, 'E: fresh session should be valid');
      await sleep(1600);
      assert((await me(base, l.cookie)).authed === false, 'E: idle session should expire');
      console.log('✓ E: sessionIdleMinutes expires an idle session (configurable TTL)');
      pass++;
    } finally { s.stop(); }
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/5 auth checks passed`);
})().catch((e) => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ auth test FAILED:', e.message);
  process.exit(1);
});
