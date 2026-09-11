#!/usr/bin/env node
'use strict';
/**
 * test-tls.js — smoke test for plan item 5 (TLS + reverse-proxy by default).
 *
 * Runs the REAL server in throwaway temp dirs and asserts:
 *   A. loopback bind with no TLS boots normally (kept easy for local use)
 *   B. a PUBLIC bind with TLS off is REFUSED before it ever listens
 *   C. the refusal can be explicitly overridden with --insecure-plaintext
 *      (PORTAL_INSECURE_PLAINTEXT=1) — boots, loudly warned
 *   D. behind a trusted TLS proxy (trustProxy / tlsMode 'auto') cookies gain
 *      `Secure`, SameSite=Strict and HttpOnly stay, and HSTS is emitted
 *   E. the portal can terminate TLS itself (tlsCert + tlsKey → HTTPS), same
 *      Secure-cookie + HSTS guarantees
 *   F. the shipped Caddyfile + nginx template exist and do HSTS + 80→443
 *
 * Zero dependencies. Run: node test-tls.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-tls-')); made.push(d); return d; };

function writeConfig(dir, cfg) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(cfg, null, 2));
}

// Spawn the server; resolve when `matcher` matches, on exit, or after timeout.
// Resolving does NOT kill the server — call stop() when done (so live tests can
// make requests). The timeout path kills the child.
function spawnServer(dir, env, matcher, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', code = null, done = false;
    const stop = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const finish = (timedOut) => {
      if (done) return; done = true;
      clearTimeout(t);
      if (timedOut) stop();
      resolve({ out, err, code, stop });
    };
    const onData = (d) => { out += d; if (matcher(out, err)) finish(false); };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { err += d; if (matcher(out, err)) finish(false); });
    child.on('exit', (c) => { code = c; finish(false); });
    const t = setTimeout(() => finish(true), timeoutMs);
  });
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const cookieOf = (headers) => (headers.get('set-cookie') || '');

// Minimal HTTPS request helper (self-signed certs in tests).
function httpsReq(port, method, p, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method, path: p, rejectUnauthorized: false,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

function makeSelfSigned(dir) {
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  if (r.status !== 0) return null;
  return { cert, key };
}

(async () => {
  let pass = 0;

  // ── A. loopback, no TLS → boots (local use stays easy) ─────────────────────
  {
    const d = tmp();
    writeConfig(d, { port: 19500 + Math.floor(Math.random() * 60), bind: '127.0.0.1', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'off' });
    const s = await spawnServer(d, {}, (out) => out.includes('users:'));
    assert(s.code === null, `A: server exited early (code ${s.code})\nstderr=${s.err}`);
    assert(s.out.includes('tls:     off (loopback'), `A: expected loopback tls banner\nstdout=${s.out}`);
    s.stop();
    console.log('✓ A: loopback bind with TLS off boots (no proxy needed)');
    pass++;
  }

  // ── B. public bind, TLS off, no override → REFUSED ─────────────────────────
  {
    const d = tmp();
    writeConfig(d, { port: 19560 + Math.floor(Math.random() * 30), bind: '0.0.0.0', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'off' });
    const s = await spawnServer(d, {}, () => false, 6000); // wait for the process to exit
    assert(s.code !== null, 'B: server should have exited, not stayed up');
    assert(s.code === 1, `B: refusal should exit 1 (got ${s.code})`);
    assert(/FATAL: refusing to bind 0\.0\.0\.0 without TLS/.test(s.err), `B: expected refusal message\nstderr=${s.err}`);
    console.log('✓ B: public bind without TLS is refused before it listens');
    pass++;
  }

  // ── C. explicit override boots, loudly ─────────────────────────────────────
  {
    const d = tmp();
    writeConfig(d, { port: 19590 + Math.floor(Math.random() * 25), bind: '0.0.0.0', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'off' });
    const s = await spawnServer(d, { PORTAL_INSECURE_PLAINTEXT: '1' }, (out) => out.includes('users:'));
    assert(s.code === null, `C: override should boot (code ${s.code})\nstderr=${s.err}`);
    assert(/INSECURE-PLAINTEXT/.test(s.err), 'C: expected a loud insecure warning');
    assert(s.out.includes('tls:     ⚠ OFF'), `C: expected insecure banner\nstdout=${s.out}`);
    s.stop();
    console.log('✓ C: --insecure-plaintext override boots with a loud warning');
    pass++;
  }

  // ── D. trusted TLS proxy → Secure cookies + HSTS (even over plain HTTP) ────
  {
    const d = tmp();
    const port = 19620 + Math.floor(Math.random() * 25);
    writeConfig(d, { port, bind: '0.0.0.0', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'auto' });
    const s = await spawnServer(d, {}, (out) => out.includes('users:'));
    assert(s.code === null, `D: trust-proxy box should boot (code ${s.code})\nstderr=${s.err}`);
    assert(s.out.includes('terminated by a reverse proxy'), `D: expected proxy tls banner\nstdout=${s.out}`);
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Zx9-unique-Pass-42' }),
    });
    assert(r.ok, `D: login failed (${r.status})`);
    const ck = cookieOf(r.headers);
    assert(/HttpOnly/.test(ck), `D: cookie missing HttpOnly: ${ck}`);
    assert(/SameSite=Strict/.test(ck), `D: cookie missing SameSite=Strict: ${ck}`);
    assert(/Secure/.test(ck), `D: cookie missing Secure behind TLS proxy: ${ck}`);
    assert(/max-age=31536000/i.test(r.headers.get('strict-transport-security') || ''), 'D: missing HSTS header');
    s.stop();
    console.log('✓ D: behind a TLS proxy → Secure/HttpOnly/SameSite=Strict cookie + HSTS');
    pass++;
  }

  // ── E. direct HTTPS (tlsCert + tlsKey) ─────────────────────────────────────
  if (!hasOpenssl) {
    console.log('… E skipped: openssl not available to mint a test certificate');
  } else {
    const d = tmp();
    const port = 19660 + Math.floor(Math.random() * 25);
    const pem = makeSelfSigned(d);
    assert(pem, 'E: could not generate a self-signed certificate');
    writeConfig(d, { port, bind: '127.0.0.1', gateways: [], portalPassword: 'Zx9-unique-Pass-42', sessionTtlHours: 12, tlsMode: 'manual', tlsCert: pem.cert, tlsKey: pem.key });
    const s = await spawnServer(d, {}, (out) => out.includes('users:'));
    assert(s.code === null, `E: HTTPS server should boot (code ${s.code})\nstderr=${s.err}`);
    assert(s.out.includes('tls:     ON (served directly)'), `E: expected direct-TLS banner\nstdout=${s.out}`);
    const r = await httpsReq(port, 'POST', '/api/login', {
      body: { username: 'admin', password: 'Zx9-unique-Pass-42' },
    });
    assert(r.status === 200, `E: HTTPS login failed (${r.status})`);
    const ck = r.headers['set-cookie'] ? r.headers['set-cookie'].join(';') : '';
    assert(/Secure/.test(ck), `E: HTTPS cookie missing Secure: ${ck}`);
    assert(/max-age=31536000/i.test(r.headers['strict-transport-security'] || ''), 'E: missing HSTS header');
    s.stop();
    console.log('✓ E: portal serves HTTPS directly → Secure cookie + HSTS');
    pass++;
  }

  // ── F. shipped reverse-proxy templates ─────────────────────────────────────
  {
    const caddy = fs.readFileSync(path.join(SRC, 'deploy/Caddyfile'), 'utf8');
    assert(/Strict-Transport-Security/.test(caddy), 'F: Caddyfile missing HSTS');
    assert(/reverse_proxy 127\.0\.0\.1/.test(caddy), 'F: Caddyfile not proxying to loopback');
    const nginx = fs.readFileSync(path.join(SRC, 'deploy/nginx/cirrus-portal.conf'), 'utf8');
    assert(/Strict-Transport-Security/.test(nginx), 'F: nginx template missing HSTS');
    assert(/return 301 https:\/\//.test(nginx), 'F: nginx template missing 80→443 redirect');
    assert(/proxy_set_header X-Forwarded-Proto/.test(nginx), 'F: nginx template missing X-Forwarded-Proto');
    assert(/listen 80;/.test(nginx) && /listen 443 ssl;/.test(nginx), 'F: nginx template missing 80/443 listeners');
    console.log('✓ F: Caddyfile + nginx template ship with HSTS and 80→443 redirect');
    pass++;
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 TLS checks passed`);
})().catch((e) => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ TLS test FAILED:', e.message);
  process.exit(1);
});
