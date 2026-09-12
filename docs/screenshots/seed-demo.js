#!/usr/bin/env node
/**
 * seed-demo.js — idempotently seed a throwaway demo instance with the data the
 * screenshot pass expects (admin + instructor + student + one room + a little
 * course context). Zero dependencies (Node 22+ global fetch).
 *
 * Usage: node seed-demo.js <baseUrl>
 *
 * Admin credentials default to the throwaway demo password; override with
 * PORTAL_DEMO_PASSWORD. This script is for a loopback demo box only.
 */
'use strict';
const BASE = process.argv[2] || 'http://127.0.0.1:18890';
const ADMIN_PW = process.env.PORTAL_DEMO_PASSWORD || 'Demo-Mission-Control-2026';

let COOKIE = '';
let CSRF = '';

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (COOKIE) headers.Cookie = COOKIE;
  if (CSRF && opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = CSRF;
  const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) COOKIE = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  const login = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) });
  if (login.status !== 200) throw new Error('login failed: ' + JSON.stringify(login.body));
  CSRF = login.body.csrfToken;
  console.log('✓ logged in as admin');

  const users = (await api('/api/users')).body.users.map((u) => u.username);
  const ensureUser = async (u) => {
    if (users.includes(u.username)) { console.log('· user exists:', u.username); return; }
    const r = await api('/api/users', { method: 'POST', body: JSON.stringify(u) });
    console.log(r.status < 300 ? '✓ created user ' + u.username : '⚠ user ' + u.username + ': ' + JSON.stringify(r.body));
  };
  await ensureUser({ username: 'casey', displayName: 'Casey Rivera', role: 'instructor', agents: ['*'], password: 'Instructor-Demo-2026x' });
  await ensureUser({ username: 'jordan', displayName: 'Jordan Lee', role: 'student', agents: ['demo:labbot'], password: 'Student-Demo-2026xx' });

  const rooms = (await api('/api/rooms')).body.rooms.map((r) => r.name);
  if (!rooms.includes('Ops Standup')) {
    const r = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Ops Standup', agents: ['demo:labbot', 'demo:grader'], mode: 'rounds' }) });
    console.log(r.status < 300 ? '✓ created room Ops Standup' : '⚠ room: ' + JSON.stringify(r.body));
  } else { console.log('· room exists: Ops Standup'); }

  await api('/api/context/course', { method: 'POST', body: JSON.stringify({
    code: 'ENG 101', name: 'Intro to Systems', term: 'Fall 2026', syllabus: 'Weekly labs.',
    assignments: [{ id: 'a1', title: 'Help Desk Bot', due: '2026-10-01', brief: 'Build a support bot.' }],
  }) });
  console.log('✓ course context seeded');
  console.log('done.');
})().catch((e) => { console.error(e); process.exit(1); });
