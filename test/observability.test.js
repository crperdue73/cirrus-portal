'use strict';
/**
 * test/observability.test.js — observability surface (plan item 16).
 *
 * Pins the new operational contract:
 *   A. /healthz — liveness, open, no auth, reports product/version/uptime.
 *   B. /readyz  — 200 when serving, 503 (setup_required) in first-run mode.
 *   C. /metrics — Prometheus text (loopback allowed), counters move with traffic.
 *   D. request ids + structured JSON access logs (echo + mint, parseable line).
 *   E. wiring — install.sh status/doctor, README, ADMIN, config example.
 *
 * Boots the REAL portal-server.js via the shared harness.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withServer, request, login, makeUser, SRC } = require('./helpers');

const ADMIN = 'L0ng-Harbor-Pass-42';
const admin = () => makeUser({ username: 'admin', password: ADMIN, role: 'admin' });
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

function metricValue(text, name, labels) {
  const re = labels
    ? new RegExp(`^${name}\\{${labels}\\}\\s+([0-9.eE+-]+)$`, 'm')
    : new RegExp(`^${name}\\s+([0-9.eE+-]+)$`, 'm');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

test('observability: /healthz is an open liveness probe', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const r = await request(s.base, 'GET', '/healthz');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.product, 'Cirrus Portal');
    assert.match(String(r.json.version), /^\d+\.\d+\.\d+/);
    assert.ok(typeof r.json.uptimeSeconds === 'number' && r.json.uptimeSeconds >= 0, 'uptimeSeconds');
    // No session, still open — probes must not need auth.
    assert.equal(r.headers['x-request-id'] && r.headers['x-request-id'].length > 0, true);
  });
});

test('observability: /readyz reports ready vs setup_required', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const r = await request(s.base, 'GET', '/readyz');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'ready');
    assert.equal(r.json.setupRequired, false);
    assert.ok(Number.isInteger(r.json.gateways.configured) && r.json.gateways.configured >= 0, 'configured gateways');
    assert.ok(r.json.gateways.connected <= r.json.gateways.configured, 'connected <= configured');
    assert.equal(r.json.users, 1);
  });

  // First-run: no accounts → not ready, but the probe still ANSWERS (503 + JSON).
  await withServer({ users: [] }, async (s) => {
    const r = await request(s.base, 'GET', '/readyz');
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.status, 'setup_required');
    assert.equal(r.json.setupRequired, true);
  });
});

test('observability: /metrics is Prometheus text and counts traffic', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    // Generate a failure, a success, an authenticated read, then scrape.
    await request(s.base, 'POST', '/api/login', { body: { username: 'admin', password: 'nope-nope-Nope1' } });
    const session = await login(s.base, 'admin', ADMIN);
    await request(s.base, 'GET', '/api/me');
    await new Promise((r) => setTimeout(r, 150));

    const m = await request(s.base, 'GET', '/metrics');
    assert.equal(m.status, 200, m.text);
    assert.match(m.headers['content-type'], /text\/plain/);
    assert.match(m.text, /# TYPE cirrus_portal_up gauge/);
    assert.equal(metricValue(m.text, 'cirrus_portal_up'), 1);
    assert.match(m.text, /cirrus_portal_build_info\{[^}]*product="cirrus-portal"[^}]*\} 1/);
    assert.ok(metricValue(m.text, 'cirrus_portal_http_requests_total', 'method="GET",status="2xx"') >= 1, 'GET 2xx counted');
    assert.equal(metricValue(m.text, 'cirrus_portal_logins_total'), 1);
    assert.ok(metricValue(m.text, 'cirrus_portal_login_failures_total') >= 1, 'failed login counted');
    assert.ok(metricValue(m.text, 'cirrus_portal_sessions_active') >= 1, 'active session counted');
    assert.equal(metricValue(m.text, 'cirrus_portal_users', 'role="admin"'), 1);
    assert.equal(metricValue(m.text, 'cirrus_portal_setup_required'), 0);

    // A CSRF-less write is rejected and counted.
    await request(s.base, 'POST', '/api/logout-all', { cookie: session.cookie });
    const m2 = await request(s.base, 'GET', '/metrics');
    assert.ok(metricValue(m2.text, 'cirrus_portal_csrf_rejects_total') >= 1, 'csrf reject counted');
  });
});

test('observability: request ids are echoed and structured logs are JSON', async () => {
  await withServer({ users: [admin()] }, async (s) => {
    const supplied = 'trace-abc-123';
    const a = await request(s.base, 'GET', '/healthz', { headers: { 'X-Request-Id': supplied } });
    assert.equal(a.headers['x-request-id'], supplied, 'caller-supplied id must be echoed');

    const b = await request(s.base, 'GET', '/healthz');
    const minted = b.headers['x-request-id'];
    assert.ok(/^[0-9a-f]{16}$/.test(minted), `minted id looks wrong: ${minted}`);

    // Give the finish handler a tick, then parse the structured access log.
    await new Promise((r) => setTimeout(r, 150));
    const lines = s.logs().out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
    const reqLines = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((o) => o.msg === 'request');
    assert.ok(reqLines.length >= 2, `expected structured request logs, saw ${reqLines.length}`);
    const traced = reqLines.find((o) => o.requestId === supplied);
    assert.ok(traced, 'no log line carried the supplied request id');
    assert.equal(traced.method, 'GET');
    assert.equal(traced.path, '/healthz');
    assert.equal(traced.status, 200);
    assert.equal(traced.level, 'info');
    assert.equal(traced.product, 'cirrus-portal');
    assert.ok(typeof traced.durationMs === 'number', 'durationMs present');
  });
});

test('observability: status/doctor and docs are wired to the probes', () => {
  const inst = read('install.sh');
  assert.match(inst, /\/healthz/, 'install.sh must probe /healthz');
  assert.match(inst, /\/readyz/, 'install.sh must probe /readyz');
  assert.match(inst, /\/metrics/, 'install.sh must mention /metrics');
  assert.match(inst, /logFormat/, 'doctor must check logFormat');

  const readme = read('README.md');
  assert.match(readme, /\/healthz/);
  assert.match(readme, /\/readyz/);
  assert.match(readme, /\/metrics/);
  assert.match(readme, /X-Request-Id/);

  const adminDoc = read('ADMIN.md');
  assert.match(adminDoc, /\/healthz/);
  assert.match(adminDoc, /\/metrics/);
  assert.match(adminDoc, /X-Request-Id/);

  const cfg = JSON.parse(read('portal-config.example.json'));
  assert.equal(cfg.logFormat, 'json');
  assert.equal(cfg.logRequests, true);
  assert.equal(cfg.metricsPublic, false);

  // healthcheck.js must use the liveness endpoint now that it exists.
  assert.match(read('healthcheck.js'), /\/healthz/);
});
