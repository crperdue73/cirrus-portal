'use strict';
/**
 * test/rbac.test.js — role-based access control (plan item 13).
 *
 * Roles are ranked student(1) < instructor(2) < admin(3); they are NOT tenant
 * boundaries (see DEPLOYMENT.md). These tests pin the real access matrix over
 * HTTP so a route can never quietly widen its audience.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withServer, login, api, makeUser } = require('./helpers');

const PWS = { admin: 'L0ng-Harbor-Pass-42', teacher: 'L0ng-Harbor-Inst-43', kid: 'L0ng-Harbor-Stud-44' };

function seed() {
  return [
    makeUser({ username: 'root', password: PWS.admin, role: 'admin' }),
    makeUser({ username: 'teacher', password: PWS.teacher, role: 'instructor' }),
    makeUser({ username: 'kid', password: PWS.kid, role: 'student' }),
  ];
}

async function sessions(s) {
  return {
    admin: await login(s.base, 'root', PWS.admin),
    teacher: await login(s.base, 'teacher', PWS.teacher),
    kid: await login(s.base, 'kid', PWS.kid),
  };
}

test('rbac: a student is denied every staff surface', async () => {
  await withServer({ users: seed() }, async (s) => {
    const { kid } = await sessions(s);

    // Allowed: their own identity + the agent list.
    assert.equal((await api(s.base, kid, 'GET', '/api/me')).json.user.role, 'student');
    assert.equal((await api(s.base, kid, 'GET', '/api/agents')).status, 200);

    // Denied: staff/admin surfaces.
    for (const path of ['/api/users', '/api/rooms', '/api/audit', '/api/gateways', '/api/dashboard']) {
      const r = await api(s.base, kid, 'GET', path);
      assert.equal(r.status, 403, `student must not read ${path}`);
    }

    // Denied: creating a room.
    const create = await api(s.base, kid, 'POST', '/api/rooms', { name: 'Nope', agents: ['ghost'] });
    assert.equal(create.status, 403);
  });
});

test('rbac: an instructor sees only students and cannot administer', async () => {
  await withServer({ users: seed() }, async (s) => {
    const { teacher } = await sessions(s);

    const users = await api(s.base, teacher, 'GET', '/api/users');
    assert.equal(users.status, 200);
    assert.deepEqual(users.json.users.map((u) => u.username), ['kid'],
      'instructor sees exactly the student roster');

    assert.equal((await api(s.base, teacher, 'GET', '/api/dashboard')).status, 200);
    assert.equal((await api(s.base, teacher, 'GET', '/api/rooms')).status, 200);

    // Admin-only: no user creation, no audit, no gateway config.
    assert.equal((await api(s.base, teacher, 'POST', '/api/users',
      { username: 'x', password: 'Quiet-River-Pass-909' })).status, 403);
    assert.equal((await api(s.base, teacher, 'GET', '/api/audit')).status, 403);
    assert.equal((await api(s.base, teacher, 'GET', '/api/gateways')).status, 403);
  });
});

test('rbac: an admin has the full surface', async () => {
  await withServer({ users: seed() }, async (s) => {
    const { admin } = await sessions(s);

    const users = await api(s.base, admin, 'GET', '/api/users');
    assert.equal(users.status, 200);
    assert.deepEqual(
      users.json.users.map((u) => u.username).sort(),
      ['kid', 'root', 'teacher'],
      'admin sees every account',
    );

    for (const path of ['/api/audit', '/api/gateways', '/api/dashboard', '/api/rooms']) {
      assert.equal((await api(s.base, admin, 'GET', path)).status, 200, `admin may read ${path}`);
    }
  });
});

test('rbac: an unauthenticated caller gets 401 on protected routes', async () => {
  await withServer({ users: seed() }, async (s) => {
    for (const path of ['/api/users', '/api/rooms', '/api/gateways', '/api/audit']) {
      const r = await api(s.base, { cookie: '', csrf: '' }, 'GET', path);
      assert.equal(r.status, 401, `${path} must require auth`);
    }
  });
});
