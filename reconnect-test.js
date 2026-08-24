// Reconnect hardening test — drives the REAL GatewayClient class from
// portal-server.js against a fake endpoint that rejects the WS upgrade
// with a plain HTTP 200 (non-101), the exact failure mode that killed
// the portal for 2 days on Aug 1.
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'portal-server.js'), 'utf8');
const marker = 'const gateway = new GatewayClient(CONFIG);';
const idx = src.indexOf(marker);
if (idx < 0) throw new Error('marker not found');
const classSrc = src.slice(0, idx); // requires + helpers + GatewayClient class

const testBody = `
// ── TEST HARNESS (appended) ──────────────────────────────────────────────
const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('not a websocket'); // non-101 rejection, like a gateway mid-restart
});
fake.listen(19999, '127.0.0.1');

let errors = 0, retries = 0;
const origWarn = console.warn, origLog = console.log;
console.warn = (...a) => { const s = a.join(' '); if (s.includes('connection failed')) errors++; origWarn(...a); };
console.log = (...a) => { const s = a.join(' '); if (s.includes('reconnect scheduled')) retries++; origLog(...a); };

const g = new GatewayClient({
  gatewayUrl: 'ws://127.0.0.1:19999',
  reconnectBaseMs: 300,
  reconnectMaxMs: 1500,
  gatewayToken: 'test-token',
});
g.start();

setTimeout(() => {
  console.warn = origWarn; console.log = origLog;
  console.log('\\n=== RESULT: ' + errors + ' failure(s), ' + retries + ' reconnect(s) scheduled in 4s ===');
  const pass = errors >= 3 && retries >= 3;
  console.log(pass
    ? 'PASS: retry loop stays alive under non-101 rejection (old code: 1 error, then silence)'
    : 'FAIL: retry loop not robust');
  g.destroyed = true;
  fake.close();
  process.exit(pass ? 0 : 1);
}, 4000);
`;

const runFile = path.join(__dirname, '.reconnect-test-run.js');
fs.writeFileSync(runFile, classSrc + testBody);
try {
  require(runFile); // synchronous; process.exit inside
} finally {
  try { fs.unlinkSync(runFile); } catch {}
}
