'use strict';
/**
 * test/helpers.js — shared harness for the Cirrus Portal node:test suite
 * (plan item 13).
 *
 * Boots the REAL `portal-server.js` inside a throwaway temp dir (copying the
 * server + branding.json, seeding `portal-config.json` / `portal-users.json`)
 * and gives tests a tiny HTTP client so they can drive the live API exactly the
 * way a browser would. Zero dependencies — Node built-ins only.
 *
 * This module is intentionally NOT named `*.test.js`, so `node --test test/`
 * runs only the suite files, never this harness.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..');
const READY_TIMEOUT_MS = Number(process.env.CIRRUS_READY_TIMEOUT_MS) || 15000;

// ── users ──────────────────────────────────────────────────────────────────
function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

// Build a portal-users.json record with a strong (non-default) password hash.
function makeUser({ username, password, role = 'student', agents, displayName }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const staff = role === 'admin' || role === 'instructor';
  return {
    username: String(username).toLowerCase(),
    displayName: displayName || username,
    role,
    agents: agents || (staff ? ['*'] : []),
    assignments: [],
    hash: scryptHash(password, salt),
    salt,
    createdAt: Date.now(),
  };
}

// ── networking ─────────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// Minimal HTTP client. Returns { status, headers, setCookie[], text, json }.
function request(base, method, pathname, { body, headers = {}, cookie, csrf } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = csrf;
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* not JSON */ }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            setCookie: res.headers['set-cookie'] || [],
            text: raw,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Extract the `portal_session=…` pair from a Set-Cookie header array.
function sessionCookieFrom(setCookie) {
  for (const line of [].concat(setCookie || [])) {
    const kv = String(line).split(';')[0].trim();
    if (kv.startsWith('portal_session=')) return kv;
  }
  return '';
}

// Log in and return { cookie, csrf, user }.
async function login(base, username, password) {
  const r = await request(base, 'POST', '/api/login', { body: { username, password } });
  if (r.status !== 200) {
    const e = new Error(`login ${username} failed: ${r.status} ${r.text}`);
    e.status = r.status;
    e.response = r;
    throw e;
  }
  return { cookie: sessionCookieFrom(r.setCookie), csrf: r.json.csrfToken, user: r.json.user };
}

// Authenticated request: attaches the session cookie and (for writes) CSRF.
function api(base, session, method, pathname, body) {
  const write = method !== 'GET' && method !== 'HEAD';
  return request(base, method, pathname, {
    body,
    cookie: session.cookie,
    csrf: write ? session.csrf : undefined,
  });
}

// ── server lifecycle ───────────────────────────────────────────────────────
/**
 * boot({ users, config, env, waitForReady }) → server handle
 *   dir    — temp working dir
 *   port   — the port we asked the server to bind
 *   base   — http://127.0.0.1:<port>
 *   child  — the spawned process
 *   out/err — accumulated stdout/stderr accessor: logs()
 *   stop() — kill + wait
 */
async function boot({ users = [], config = {}, env = {}, waitForReady = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-t-'));
  for (const f of ['portal-server.js', 'branding.json', 'portal.html', 'setup.html', 'nexus.html']) {
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }

  const port = await freePort();
  const cfg = Object.assign(
    { port, bind: '127.0.0.1', gateways: [], portalPassword: '', sessionTtlHours: 12 },
    config,
  );
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(cfg, null, 2));
  if (users.length) {
    fs.writeFileSync(path.join(dir, 'portal-users.json'), JSON.stringify({ users }, null, 2));
  }

  const child = spawn(process.execPath, ['portal-server.js'], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (e) => resolve({ code: 'spawn-error', error: e }));
  });

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const check = () => {
      if (/ready\./.test(out)) finish(resolve);
      else if (/refusing to (start|bind)/.test(out + err)) {
        finish(reject, new Error(`boot gate refused\n${out}\n${err}`));
      }
    };
    timer = setTimeout(
      () => finish(reject, new Error(`server not ready in ${READY_TIMEOUT_MS}ms\nstdout=${out}\nstderr=${err}`)),
      READY_TIMEOUT_MS,
    );
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    exited.then((x) => {
      if (/ready\./.test(out)) return;
      finish(reject, new Error(`server exited early (${x.code})\nstdout=${out}\nstderr=${err}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode) return;
    const killed = new Promise((resolve) => child.once('exit', resolve));
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await Promise.race([killed, new Promise((r) => setTimeout(r, 2000))]);
  };

  const handle = { dir, port, base, child, stop, logs: () => ({ out, err }) };

  if (waitForReady) {
    try {
      await ready;
    } catch (e) {
      await stop();
      throw e;
    }
  }
  return handle;
}

// Boot, run fn(server), always stop.
async function withServer(opts, fn) {
  const s = await boot(opts);
  try {
    return await fn(s);
  } finally {
    await s.stop();
  }
}

module.exports = {
  boot, withServer, request, login, api, makeUser, freePort, scryptHash, sessionCookieFrom, SRC,
};
