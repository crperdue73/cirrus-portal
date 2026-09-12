'use strict';
/**
 * test/rooms.test.js — group-chat / panel rooms (plan item 13).
 *
 * Rooms are instructor+ only, rounds- or free-flow modes, capped at 12 agents,
 * and deletable only by their creator or an admin. No gateways are configured
 * here, so an unreachable agent is reported in-band instead of hanging the API.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withServer, login, api, makeUser } = require('./helpers');

const ROOT_PW = 'L0ng-Harbor-Pass-42';
const A_PW = 'L0ng-Harbor-Inst-43';
const B_PW = 'L0ng-Harbor-Inst-45';

function seed() {
  return [
    makeUser({ username: 'root', password: ROOT_PW, role: 'admin' }),
    makeUser({ username: 'teacha', password: A_PW, role: 'instructor' }),
    makeUser({ username: 'teachb', password: B_PW, role: 'instructor' }),
  ];
}

test('rooms: create → list → get → message → delete lifecycle', async () => {
  await withServer({ users: seed() }, async (s) => {
    const a = await login(s.base, 'teacha', A_PW);

    const created = await api(s.base, a, 'POST', '/api/rooms', {
      name: 'Study Hall', agents: ['ghost'], mode: 'rounds',
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.ok, true);
    const { id } = created.json.room;
    assert.ok(id.startsWith('room_'));
    assert.equal(created.json.room.name, 'Study Hall');
    assert.equal(created.json.room.createdBy, 'teacha');

    const list = await api(s.base, a, 'GET', '/api/rooms');
    assert.equal(list.status, 200);
    assert.ok(list.json.rooms.some((r) => r.id === id), 'new room appears in the list');

    const one = await api(s.base, a, 'GET', `/api/rooms/${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.room.id, id);

    const msg = await api(s.base, a, 'POST', `/api/rooms/${id}`, { action: 'message', text: 'hello team' });
    assert.equal(msg.status, 200);
    // The user's message is recorded immediately; an unreachable agent is
    // reported in-band by the background round, so don't assert an exact count.
    assert.equal(msg.json.room.transcript[0].sender, 'user');
    assert.equal(msg.json.room.transcript[0].text, 'hello team');

    const del = await api(s.base, a, 'DELETE', `/api/rooms/${id}`);
    assert.equal(del.status, 200);
    assert.equal((await api(s.base, a, 'GET', `/api/rooms/${id}`)).status, 404);
  });
});

test('rooms: payload validation is enforced', async () => {
  await withServer({ users: seed() }, async (s) => {
    const a = await login(s.base, 'teacha', A_PW);

    // Missing name / agents.
    assert.equal((await api(s.base, a, 'POST', '/api/rooms', { agents: ['ghost'] })).status, 400);
    assert.equal((await api(s.base, a, 'POST', '/api/rooms', { name: 'No agents' })).status, 400);

    // Too many agents (max 12).
    const thirteen = Array.from({ length: 13 }, (_, i) => `a${i + 1}`);
    const tooMany = await api(s.base, a, 'POST', '/api/rooms',
      { name: 'Crowd', agents: thirteen, mode: 'rounds' });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.error, /12 agents/i);

    // Free-flow needs at least two agents.
    const oneFree = await api(s.base, a, 'POST', '/api/rooms',
      { name: 'Solo', agents: ['ghost'], mode: 'free' });
    assert.equal(oneFree.status, 400);
    assert.match(oneFree.json.error, /2 agents|at least 2/i);

    // Unknown room / unknown action.
    assert.equal((await api(s.base, a, 'GET', '/api/rooms/room_missing')).status, 404);
  });
});

test('rooms: only the creator or an admin may delete', async () => {
  await withServer({ users: seed() }, async (s) => {
    const a = await login(s.base, 'teacha', A_PW);
    const b = await login(s.base, 'teachb', B_PW);
    const root = await login(s.base, 'root', ROOT_PW);

    const { json } = await api(s.base, a, 'POST', '/api/rooms', { name: 'Owned by A', agents: ['ghost'] });
    const { id } = json.room;

    // Another instructor is refused…
    const denied = await api(s.base, b, 'DELETE', `/api/rooms/${id}`);
    assert.equal(denied.status, 403);
    assert.match(denied.json.error, /creator or admin/i);

    // …but an admin can.
    const ok = await api(s.base, root, 'DELETE', `/api/rooms/${id}`);
    assert.equal(ok.status, 200);
  });
});
