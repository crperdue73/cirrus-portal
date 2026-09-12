'use strict';
/**
 * test/routes.smoke.test.js — route smoke tests (plan item 13).
 *
 * Pins the HTTP surface: static pages, the public vs protected API split, 404s,
 * CORS preflight, and the first-run SETUP funnel (which must make the app shell
 * unreachable until an admin exists).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withServer, request, makeUser } = require('./helpers');

const ADMIN = 'L0ng-Harbor-Pass-42';
const admin = () => makeUser({ username: 'admin', password: ADMIN, role: 'admin' });

test('routes: static pages and the public/protected API split', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    // App shell.
    const home = await request(s.base, 'GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    assert.match(home.text, /Cirrus Portal/);

    // First-run wizard page is always served.
    const setup = await request(s.base, 'GET', '/setup');
    assert.equal(setup.status, 200);
    assert.match(setup.headers['content-type'], /text\/html/);

    // Nexus surface.
    assert.equal((await request(s.base, 'GET', '/nexus')).status, 200);

    // Unknown page → JSON 404.
    const nf = await request(s.base, 'GET', '/no-such-page');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error, 'not found');

    // /api/me is public and reports the anonymous state.
    const me = await request(s.base, 'GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.authed, false);

    // Protected routes require a session.
    assert.equal((await request(s.base, 'GET', '/api/agents')).status, 401);
    assert.equal((await request(s.base, 'GET', '/api/users')).status, 401);

    // CORS preflight.
    const pre = await request(s.base, 'OPTIONS', '/api/agents');
    assert.equal(pre.status, 204);
  });
});

test('routes: first-run SETUP mode funnels everything to the wizard', async () => {
  // No users, no bootstrap password → the portal serves the wizard instead of
  // minting a default admin, and every other route is refused.
  await withServer({ users: [] }, async (s) => {
    const home = await request(s.base, 'GET', '/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/setup');

    const me = await request(s.base, 'GET', '/api/me');
    assert.equal(me.status, 503);
    assert.equal(me.json.setupRequired, true);

    const login = await request(s.base, 'POST', '/api/login', {
      body: { username: 'admin', password: 'whatever-Whatever-1' },
    });
    assert.equal(login.status, 503);
    assert.equal(login.json.setupRequired, true);

    // The status endpoint advertises the wizard + the canonical product name.
    const status = await request(s.base, 'GET', '/api/setup/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.needed, true);
    assert.equal(status.json.product, 'Cirrus Portal');
  });
});
