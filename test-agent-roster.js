#!/usr/bin/env node
'use strict';
/**
 * test-agent-roster.js — Phone book acceptance test (plan item 3a).
 *
 * `GET /api/agent/roster` is the agent-facing phone book: every agent on every
 * configured gateway, with its cross-server ref and reachability, so an agent
 * can discover who exists and how to address them. This test drives it against
 * the REAL server with TWO live fake gateways plus one dead one, exercising the
 * edges the route must get right:
 *
 *   A. auth          — Bearer required; a human cookie is inert on /api/agent/*
 *   B. fleet merge   — agents from every connected gateway appear, flattened,
 *                      with the cross-server ref (`gwId:agentId`) + key shape
 *   C. offline mark  — a configured-but-down gateway is listed connected:false
 *                      and contributes no live agents, without failing the call
 *   D. self identity — `you` reflects the calling token's agent + gateway
 *   E. no secret     — the token never appears in the response or the audit log
 *   F. audit         — the call is audited (agent_call + agent_roster counts)
 *   G. human parity  — /api/agents (human) returns the same merged fleet
 *
 * Zero dependencies. Run: node test-agent-roster.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { FakeGateway } = require('./test/fake-gateway');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const made = [];
const tmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cirrus-roster-${tag}-`)); made.push(d); return d; };

const secrets = []; // plaintext secrets we minted — must never appear in output

function setup(dir, gateways) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify({
    port: 19900 + Math.floor(Math.random() * 90),
    bind: '127.0.0.1',
    gateways,
    portalPassword: PW,
    sessionTtlHours: 12,
  }, null, 2));
}

function startServer(dir) {
  return new Promise((resolve) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, get out() { return out; }, get err() { return err; }, port: cfg.port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const timer = setTimeout(finish, 10000);
    const onData = (d) => { out += d; if (out.includes('users:')) { clearTimeout(timer); finish(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { clearTimeout(timer); finish(); });
  });
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
  secrets.push(j.token);
  return j;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const roster = (base, t) => fetch(`${base}/api/agent/roster`, t ? { headers: bearer(t) } : {});

function auditLines(dir) {
  const raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8');
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let pass = 0;
  const ok = (name) => { pass++; console.log(`  ok ${pass} - ${name}`); };

  // Two live gateways with agents, and one dead gateway (port 1 → refused).
  const home = await new FakeGateway({ agents: [
    { id: 'noah', name: 'Noah', emoji: '🦖', default: true },
    { id: 'nora', name: 'Nora', emoji: '🔥' },
  ] }).start();
  const lab = await new FakeGateway({ agents: [
    { id: 'iris', name: 'Iris', emoji: '👁' },
  ] }).start();
  const DEAD = { id: 'ct-test', name: 'ct-test (down)', url: 'ws://127.0.0.1:1', token: 'dead-tok', enabled: true };
  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
    DEAD,
  ];

  const d1 = tmp('main');
  setup(d1, gateways);
  const s1 = await startServer(d1);
  const base = `http://127.0.0.1:${s1.port}`;
  try {
    const admin = await login(base, 'admin', PW);
    const m = await mint(base, admin, { agentId: 'noah', gatewayId: 'home', label: 'noah@home' });

    // Wait for the two live gateways to finish their connect handshake.
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${base}/api/agents`, { headers: { Cookie: admin.cookie } });
      const j = await r.json();
      if (j.servers && j.servers.filter((s) => s.connected).length === 2) { ready = true; break; }
      await sleep(250);
    }
    assert(ready, 'A: live gateways never connected (fake-gateway handshake failed)\n' + s1.err);

    // ── A. auth required; human cookie inert ─────────────────────────────
    {
      const noAuth = await roster(base, null);
      assert(noAuth.status === 401, `A: roster without token → ${noAuth.status}`);
      const cookieOnly = await fetch(`${base}/api/agent/roster`, { headers: { Cookie: admin.cookie } });
      assert(cookieOnly.status === 401, `A: human cookie must NOT satisfy /api/agent/* (got ${cookieOnly.status})`);
      ok('Bearer required; a human session cookie is inert on the agent surface');
    }

    // ── B. fleet merge + shape ───────────────────────────────────────────
    let body = null;
    {
      const r = await roster(base, m.token);
      assert(r.ok, `B: valid token → ${r.status}`);
      body = await r.json();
      assert(Array.isArray(body.agents), 'B: agents[] missing');
      const byRef = new Map(body.agents.map((a) => [a.ref, a]));
      assert(byRef.has('home:noah') && byRef.has('home:nora') && byRef.has('lab:iris'),
        `B: merged fleet missing agents: ${[...byRef.keys()].join(',')}`);
      const noah = byRef.get('home:noah');
      assert(noah.name === 'Noah' && noah.emoji === '🦖' && noah.default === true, 'B: agent fields wrong');
      assert(noah.server === 'home' && noah.serverName === 'Home', 'B: gateway fields wrong');
      assert(noah.key === 'agent:home:noah:main', `B: key wrong: ${noah.key}`);
      assert(noah.reachable === true, 'B: live agent should be reachable');
      assert(body.count === 3, `B: count should be 3, got ${body.count}`);
      ok('merges agents from every live gateway with cross-server refs + key shape');
    }

    // ── C. offline gateway is listed, not fatal ──────────────────────────
    {
      const dead = body.servers.find((s) => s.id === 'ct-test');
      assert(dead, 'C: down gateway missing from servers[]');
      assert(dead.connected === false && dead.error === 'offline', `C: down gateway not marked offline: ${JSON.stringify(dead)}`);
      assert(body.connected === true, 'C: fleet should still report connected (two live gateways)');
      assert(!body.agents.some((a) => a.server === 'ct-test'), 'C: down gateway must contribute no live agents');
      ok('a down gateway is listed connected:false without failing the call');
    }

    // ── D. caller identity ───────────────────────────────────────────────
    {
      assert(body.you && body.you.agentId === 'noah' && body.you.gatewayId === 'home' && body.you.ref === 'home:noah',
        `D: you identity wrong: ${JSON.stringify(body.you)}`);
      ok('you reflects the calling token agent + gateway');
    }

    // ── E. no secret in response ─────────────────────────────────────────
    {
      const text = JSON.stringify(body);
      for (const sec of secrets) assert(!text.includes(sec), 'E: token leaked in roster response');
      ok('no token value appears in the roster response');
    }

    // ── F. audit ─────────────────────────────────────────────────────────
    {
      const { raw, lines } = auditLines(d1);
      for (const sec of secrets) assert(!raw.includes(sec), 'F: token leaked into audit log');
      assert(lines.some((l) => l.action === 'agent_roster' && l.user === 'noah'),
        'F: agent_roster audit entry missing');
      const entry = lines.find((l) => l.action === 'agent_roster');
      assert(entry && entry.detail && entry.detail.agents === 3, `F: audit counts wrong: ${JSON.stringify(entry && entry.detail)}`);
      ok('call audited (agent_call + agent_roster counts), no secret');
    }

    // ── G. human surface parity (shared builder) ─────────────────────────
    {
      const r = await fetch(`${base}/api/agents`, { headers: { Cookie: admin.cookie } });
      assert(r.ok, `G: /api/agents → ${r.status}`);
      const j = await r.json();
      const refs = new Set(j.agents.map((a) => a.ref));
      assert(refs.has('home:noah') && refs.has('lab:iris'), 'G: human view diverged from the roster');
      assert(j.servers.some((s) => s.id === 'ct-test' && !s.connected), 'G: human view lost the offline server note');
      ok('/api/agents (human) sees the same merged fleet');
    }
  } finally {
    s1.stop();
    home.stop();
    lab.stop();
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  console.log(`\n${pass}/7 passed`);
  process.exit(pass === 7 ? 0 : 1);
})().catch((e) => {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
});
