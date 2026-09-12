#!/usr/bin/env node
/**
 * capture.js — repeatable screenshot pass for the Cirrus Portal docs.
 *
 * Renders the current build against a throwaway demo instance (mock gateway +
 * seeded accounts) and writes PNGs for the public docs. It never touches a
 * production system. Zero dependencies (Node 22+ built-in WebSocket).
 *
 * Usage:
 *   node capture.js <baseUrl> <outDir> [--user <u>] [--pass <p>]
 *
 * The demo instance must already be running and seeded (see
 * docs/screenshots/README.md for the full recipe). Requires chromium on PATH
 * (override with CHROMIUM=/path/to/chromium).
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:18890';
const OUT = process.argv[3] || __dirname;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const USER = arg('--user', 'admin');
const PASS = arg('--pass', 'Demo-Mission-Control-2026');
const CHROME = process.env.CHROMIUM || '/usr/bin/chromium';
const PORT = 9222;
const W = 1440, H = 1000;

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => {
  let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
}).on('error', rej));

(async () => {
  if (typeof globalThis.WebSocket !== 'function') {
    console.error('Node 22+ (global WebSocket) is required'); process.exit(1);
  }
  const profile = fs.mkdtempSync('/tmp/cirrus-chrome-');
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let ver;
  for (let i = 0; i < 60; i++) { try { ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); } }
  if (!ver) { console.error('chromium CDP never came up'); process.exit(1); }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else if (m.method) listeners.slice().forEach((fn) => fn(m));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }));
  });
  const waitEvent = (method, sessionId, timeout = 15000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting ' + method)), timeout);
    const fn = (m) => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { clearTimeout(t); listeners.splice(listeners.indexOf(fn), 1); res(m.params); } };
    listeners.push(fn);
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    const buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log('  ✓ ' + name + ' (' + Math.round(buf.length / 1024) + ' KB)');
  };
  const loginAs = async (u, p) => {
    await evalJs(`(async () => {
      document.getElementById('loginUser').value = ${JSON.stringify(u)};
      document.getElementById('loginPass').value = ${JSON.stringify(p)};
      await doLogin();
      await new Promise(r => setTimeout(r, 1200));
      return 'ok';
    })()`);
    await sleep(1200);
  };

  // 1) login page
  await send('Page.navigate', { url: BASE + '/' }, sessionId);
  await waitEvent('Page.loadEventFired', sessionId).catch(() => {});
  await sleep(800);
  await shot('01-login.png');

  // 2) admin: chat + the management views
  await loginAs(USER, PASS);
  await shot('02-agents-chat.png');
  const views = [
    ['dashboard', '03-dashboard.png'],
    ['rooms', '04-rooms.png'],
    ['users', '05-users.png'],
    ['gateways', '06-gateways.png'],
    ['audit', '07-audit.png'],
  ];
  for (const [view, file] of views) {
    await evalJs(`(async () => { setView(${JSON.stringify(view)}); await new Promise(r=>setTimeout(r,900)); return 'ok'; })()`);
    await sleep(900);
    await shot(file);
  }

  // 3) student view (restricted nav + context strip)
  await evalJs(`(async () => { await fetch('/api/logout', {method:'POST', headers:{'X-CSRF-Token': state.csrf}}); location.reload(); return 'ok'; })()`);
  await waitEvent('Page.loadEventFired', sessionId).catch(() => {});
  await sleep(1000);
  await loginAs('jordan', 'Student-Demo-2026xx');
  await shot('08-student-view.png');

  ws.close();
  chrome.kill('SIGKILL');
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log('done →', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
