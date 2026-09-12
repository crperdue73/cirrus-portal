'use strict';
/**
 * test/auth.test.js — authentication behaviour (plan item 13).
 *
 * Uses Node's built-in test runner. Run: node --test test/
 * Exercises the real server over HTTP: login, session cookies, CSRF on writes,
 * session rotation, logout-all, progressive lockout, and the password policy.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withServer, request, login, api, makeUser, sessionCookieFrom } = require('./helpers');

const ADMIN = 'L0ng-Harbor-Pass-42';
const admin = () => makeUser({ username: 'admin', password: ADMIN, role: 'admin' });

test('auth: bad password is refused, good password mints a session', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const bad = await request(s.base, 'POST', '/api/login', {
      body: { username: 'admin', password: 'wrong-Wrong-000' },
    });
    assert.equal(bad.status, 401);
    assert.match(bad.json.error, /wrong username or password/i);

    const sess = await login(s.base, 'admin', ADMIN);
    assert.ok(sess.cookie.startsWith('portal_session='), 'expected a session cookie');
    assert.match(sess.cookie, /^portal_session=[0-9a-f]{64}$/, 'session id is a 256-bit token');
    assert.equal(typeof sess.csrf, 'string');
    assert.ok(sess.csrf.length >= 32, 'csrf token present');

    const me = await request(s.base, 'GET', '/api/me', { cookie: sess.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.authed, true);
    assert.equal(me.json.user.role, 'admin');
  });
});

test('auth: every state-changing request needs the session CSRF token', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const sess = await login(s.base, 'admin', ADMIN);

    // No CSRF header → refused.
    const denied = await request(s.base, 'POST', '/api/logout', { cookie: sess.cookie });
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /csrf/i);

    // A wrong token is refused too.
    const wrong = await request(s.base, 'POST', '/api/logout', { cookie: sess.cookie, csrf: 'deadbeef' });
    assert.equal(wrong.status, 403);

    // Reads do not need it.
    const read = await request(s.base, 'GET', '/api/me', { cookie: sess.cookie });
    assert.equal(read.status, 200);

    // With the token the write goes through (and clears the cookie).
    const ok = await api(s.base, sess, 'POST', '/api/logout');
    assert.equal(ok.status, 200);
    assert.ok(ok.setCookie.join(';').includes('Max-Age=0'), 'logout expires the cookie');
  });
});

test('auth: session id rotates on login (a planted cookie cannot survive)', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const first = await login(s.base, 'admin', ADMIN);

    // Log in AGAIN while presenting the first session's cookie.
    const second = await request(s.base, 'POST', '/api/login', {
      body: { username: 'admin', password: ADMIN },
      cookie: first.cookie,
    });
    assert.equal(second.status, 200);
    const secondCookie = sessionCookieFrom(second.setCookie);
    assert.notEqual(secondCookie, first.cookie, 'a new session id was issued');

    // The rotated-away id is dead…
    const dead = await request(s.base, 'GET', '/api/me', { cookie: first.cookie });
    assert.equal(dead.json.authed, false);
    // …and the fresh one works.
    const live = await request(s.base, 'GET', '/api/me', { cookie: secondCookie });
    assert.equal(live.json.authed, true);
  });
});

test('auth: logout-all revokes every session for the user', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const a = await login(s.base, 'admin', ADMIN);
    const b = await login(s.base, 'admin', ADMIN);

    const r = await api(s.base, a, 'POST', '/api/logout-all');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.sessions, 2);

    for (const c of [a.cookie, b.cookie]) {
      const me = await request(s.base, 'GET', '/api/me', { cookie: c });
      assert.equal(me.json.authed, false, 'session must be revoked');
    }
  });
});

test('auth: repeated failures trigger a progressive lockout (429 + Retry-After)', async () => {
  await withServer(
    { users: [admin()], config: { loginMaxAttempts: 3, loginLockoutSeconds: 5 } },
    async (s) => {
      const bad = () => request(s.base, 'POST', '/api/login', {
        body: { username: 'admin', password: 'nope-Nope-000' },
      });
      assert.equal((await bad()).status, 401);
      assert.equal((await bad()).status, 401);
      const third = await bad();
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers['retry-after']) > 0, 'Retry-After header set');

      // While locked, even the CORRECT password is refused.
      const good = await request(s.base, 'POST', '/api/login', {
        body: { username: 'admin', password: ADMIN },
      });
      assert.equal(good.status, 429);
    },
  );
});

test('auth: the password policy is enforced when an admin creates a user', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const sess = await login(s.base, 'admin', ADMIN);

    const weak = await api(s.base, sess, 'POST', '/api/users', {
      username: 'newbie', password: 'short', role: 'student',
    });
    assert.equal(weak.status, 400);
    assert.match(weak.json.error, /at least/i);

    const blocklisted = await api(s.base, sess, 'POST', '/api/users', {
      username: 'newbie', password: 'Newbie-Long-Pass-123', role: 'student',
    });
    assert.equal(blocklisted.status, 400);
    assert.match(blocklisted.json.error, /must not contain the username/i);

    const okay = await api(s.base, sess, 'POST', '/api/users', {
      username: 'newbie', password: 'Quiet-River-Pass-909', role: 'student',
    });
    assert.equal(okay.status, 200);
    assert.equal(okay.json.user.username, 'newbie');

    // And the new account can log in.
    const newSess = await login(s.base, 'newbie', 'Quiet-River-Pass-909');
    assert.equal(newSess.user.role, 'student');
  });
});
