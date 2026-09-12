'use strict';
/**
 * test/config.test.js — configuration loading + runtime effects (plan item 13).
 *
 * portal-config.json is the operator's source of truth; env overrides the file
 * for anything set. These tests boot the real server and assert the config it
 * actually honoured (port, session TTL) plus a drift guard on the example file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, freePort, request, login, api, makeUser, SRC } = require('./helpers');

const ADMIN = 'L0ng-Harbor-Pass-42';
const admin = () => makeUser({ username: 'admin', password: ADMIN, role: 'admin' });

// Every key a valid portal-config.json may carry (DEFAULTS + gateways + comment).
const KNOWN_CONFIG_KEYS = new Set([
  'port', 'bind', 'publicBind', 'gatewayUrl', 'gatewayToken', 'portalPassword',
  'sessionTtlHours', 'reconnectBaseMs', 'reconnectMaxMs', 'tlsMode', 'tlsCert',
  'tlsKey', 'trustProxy', 'insecurePlaintext', 'loginMaxAttempts',
  'loginWindowSeconds', 'loginLockoutSeconds', 'sessionIdleMinutes',
  'gateways', '_comment',
]);

test('config: PORT env overrides the port in portal-config.json', async () => {
  const filePort = await freePort();
  const envPort = await freePort();
  const s = await boot({
    users: [admin()],
    config: { port: filePort },
    env: { PORT: String(envPort) },
  });
  try {
    const base = `http://127.0.0.1:${envPort}`;
    assert.equal((await request(base, 'GET', '/api/me')).status, 200, 'env port must serve');

    // The file port must NOT be the one bound.
    await assert.rejects(
      () => request(`http://127.0.0.1:${filePort}`, 'GET', '/api/me'),
      /ECONNREFUSED|socket hang up/i,
      'file port should not be bound when PORT overrides it',
    );
  } finally {
    await s.stop();
  }
});

test('config: sessionTtlHours drives the session cookie Max-Age', async () => {
  const s = await boot({ users: [admin()], config: { sessionTtlHours: 3 } });
  try {
    const r = await request(s.base, 'POST', '/api/login', { body: { username: 'admin', password: ADMIN } });
    assert.equal(r.status, 200);
    assert.ok(
      r.setCookie.join(';').includes('Max-Age=10800'),
      `cookie must expire in 3h (10800s), got: ${r.setCookie.join(' | ')}`,
    );
  } finally {
    await s.stop();
  }
});

test('config: a configured gateway surfaces as offline without inventing agents', async () => {
  const s = await boot({ users: [admin()], config: { gateways: [] } });
  try {
    const sess = await login(s.base, 'admin', ADMIN);
    const r = await api(s.base, sess, 'GET', '/api/agents');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.agents, [], 'an unreachable gateway contributes no agents');
    assert.equal(r.json.servers.length, 1, 'the legacy single-gateway config synthesizes one server');
    assert.equal(r.json.servers[0].connected, false);
  } finally {
    await s.stop();
  }
});

test('config: portal-config.example.json is valid JSON with known keys only', () => {
  const raw = fs.readFileSync(path.join(SRC, 'portal-config.example.json'), 'utf8');
  const cfg = JSON.parse(raw);
  for (const key of Object.keys(cfg)) {
    assert.ok(KNOWN_CONFIG_KEYS.has(key), `unknown config key "${key}" — update DEFAULTS/example together`);
  }
  assert.equal(cfg.bind, '127.0.0.1', 'the shipped example must default to loopback');
  assert.deepEqual(Object.keys(cfg.gateways[0]).sort(), ['enabled', 'id', 'name', 'url'].sort(),
    'gateway example shape drifted');
});
