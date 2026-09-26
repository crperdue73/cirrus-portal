#!/usr/bin/env node
'use strict';
/**
 * test-agent-dm-store.js — smoke test for plan item 4a (agent DM mailbox store).
 *
 * Runs the REAL server in a throwaway temp dir, optionally seeding a
 * `portal-agent-dm.json` before boot, then asserts the store the server actually
 * persisted. This exercises the bounded-on-disk discipline (the board/audit-log
 * pattern) that item 4a is about — no HTTP surface exists yet (that is 4b), so
 * every write today goes through load → prune → save.
 *   A. first boot creates portal-agent-dm.json 0600, empty mailbox
 *   B. load normalizes DM records (malformed dropped, state/hops/awaitReply clamped)
 *   C. agentDmRetentionDays prunes old TERMINAL dms but keeps in-flight ones
 *   D. agentDmMaxMessages hard-caps, dropping old TERMINAL dms before in-flight
 *   E. agentDmMaxBytes trims oldest-to-fit, never below the KEEP_MIN floor
 *   F. PORTAL_AGENT_DM_MAX_MESSAGES env overrides the file (Docker-friendly)
 *
 * Zero dependencies. Run: node test-agent-dm-store.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-dm-')); made.push(d); return d; };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function setup(dir, cfg = {}) {
  fs.copyFileSync(path.join(SRC, 'portal-server.js'), path.join(dir, 'portal-server.js'));
  fs.copyFileSync(path.join(SRC, 'branding.json'), path.join(dir, 'branding.json'));
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(Object.assign({
    bind: '127.0.0.1', gateways: [], portalPassword: PW, sessionTtlHours: 12,
  }, cfg), null, 2));
}

function seedDm(dir, obj) {
  fs.writeFileSync(path.join(dir, 'portal-agent-dm.json'), JSON.stringify(obj, null, 2));
}

async function startServer(dir, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['portal-server.js'], {
    cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '', settled = false;
  const done = new Promise((resolve) => {
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, 9000);
    const onOut = (d) => { out += d; if (/ready\./.test(out)) { clearTimeout(timer); finish(); } };
    child.stdout.on('data', onOut);
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => { clearTimeout(timer); finish(); });
  });
  await done;
  return { port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, logs: () => ({ out, err }) };
}

const readDm = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-agent-dm.json'), 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const dm = (id, ts, text, extra) => Object.assign({
  id, from: 'agent:gwA:alice', to: 'agent:gwB:bob', text: text || `dm ${id}`, ts,
}, extra || {});

(async () => {
  let pass = 0;

  // ── A. first boot creates the file 0600, empty mailbox ─────────────────
  {
    const d = tmp(); setup(d);
    const s = await startServer(d);
    try {
      const f = path.join(d, 'portal-agent-dm.json');
      assert(fs.existsSync(f), 'A: portal-agent-dm.json was not created on first boot');
      assert.equal(mode(f), '600', `A: DM file mode ${mode(f)}, expected 600`);
      const st = readDm(d);
      assert(Array.isArray(st.dms) && st.dms.length === 0, 'A: fresh store must have no DMs');
      console.log('✓ A: first boot creates portal-agent-dm.json 0600 with an empty mailbox');
      pass++;
    } finally { s.stop(); }
  }

  // ── B. load normalizes DM records ──────────────────────────────────────
  {
    const d = tmp(); setup(d);
    const now = Date.now();
    seedDm(d, { dms: [
      { from: 'agent:gwA:a', to: 'agent:gwB:b', text: 'hi', ts: now - 1000, state: 'bogus', hops: 99, awaitReply: 'yes' },
      { from: 'agent:gwA:a', to: 'agent:gwB:b', text: '', ts: now - 2000 },       // no body → dropped
      { to: 'agent:gwB:b', text: 'no sender', ts: now - 3000 },                    // no from → dropped
      { from: 'agent:gwA:a', text: 'no recipient', ts: now - 4000 },               // no to → dropped
      null, 'nope',                                                                // junk → dropped
      { from: 'agent:gwA:a', to: 'agent:gwB:b', text: 'reply body', ts: now - 5000,
        state: 'replied', reply: 'ok', replyTs: 6000, hops: 1, awaitReply: true },
    ] });
    const s = await startServer(d);
    try {
      const dms = readDm(d).dms;
      assert.equal(dms.length, 2, `B: expected 2 valid DMs, got ${dms.length}`);
      const [a, b] = dms;
      assert.equal(a.state, 'queued', `B: bogus state not reset to queued (got ${a.state})`);
      assert.equal(a.hops, 3, `B: hops not clamped to DM_HOPS_MAX (got ${a.hops})`);
      assert.equal(a.awaitReply, false, 'B: non-true awaitReply must coerce to false');
      assert.equal(a.reply, null, 'B: missing reply must stay null');
      assert.equal(b.state, 'replied', 'B: terminal state lost');
      assert.equal(b.reply, 'ok', 'B: reply body lost');
      assert.equal(b.replyTs, 6000, 'B: replyTs lost');
      assert.equal(b.hops, 1, 'B: valid hops changed');
      assert.equal(b.awaitReply, true, 'B: awaitReply true lost');
      console.log('✓ B: load normalizes DMs (malformed dropped, state/hops/awaitReply clamped)');
      pass++;
    } finally { s.stop(); }
  }

  // ── C. retention prunes old TERMINAL dms, keeps in-flight ──────────────
  {
    const d = tmp(); setup(d, { agentDmRetentionDays: 1 });
    const now = Date.now();
    seedDm(d, { dms: [
      dm('oldTerminal', now - 3 * 86400_000, 'old but finished', { state: 'replied' }),
      dm('oldInflight', now - 2 * 86400_000, 'old and still in flight', { state: 'queued' }),
      dm('newTerminal', now - 3600_000, 'fresh and finished', { state: 'failed' }),
      dm('newInflight', now, 'fresh and in flight', { state: 'delivered' }),
    ] });
    const s = await startServer(d);
    try {
      const ids = readDm(d).dms.map(m => m.id);
      assert.deepEqual(ids, ['oldInflight', 'newTerminal', 'newInflight'],
        `C: age-prune must drop only the old TERMINAL dm, got ${ids}`);
      console.log('✓ C: agentDmRetentionDays prunes old terminal DMs but never an in-flight one');
      pass++;
    } finally { s.stop(); }
  }

  // ── D. maxMessages drops old TERMINAL dms before in-flight ─────────────
  {
    const d = tmp(); setup(d, { agentDmMaxMessages: 10 });
    const now = Date.now();
    const dms = [];
    for (let i = 0; i < 12; i++) {
      // the two OLDEST are in-flight; everything else is terminal
      const state = i < 2 ? 'queued' : 'replied';
      dms.push(dm(`m${i}`, now - (12 - i) * 1000, `body ${i}`, { state }));
    }
    seedDm(d, { dms });
    const s = await startServer(d);
    try {
      const kept = readDm(d).dms.map(m => m.id);
      assert.equal(kept.length, 10, `D: expected 10 DMs, got ${kept.length}`);
      assert.ok(kept.includes('m0') && kept.includes('m1'),
        `D: the oldest IN-FLIGHT DMs were dropped (${kept.join(',')})`);
      assert.ok(!kept.includes('m2') && !kept.includes('m3'),
        `D: the oldest TERMINAL DMs should have been dropped first (${kept.join(',')})`);
      console.log('✓ D: agentDmMaxMessages caps the file, dropping old terminal DMs before in-flight');
      pass++;
    } finally { s.stop(); }
  }

  // ── E. maxBytes trims oldest-to-fit, floor at KEEP_MIN ─────────────────
  {
    const d = tmp(); setup(d, { agentDmMaxBytes: 64 * 1024 });
    const now = Date.now();
    const blob = 'x'.repeat(4000);
    const dms = Array.from({ length: 40 }, (_, i) => dm(`b${i}`, now - (40 - i) * 1000, `${i}-${blob}`, { state: 'replied' }));
    seedDm(d, { dms });
    const s = await startServer(d);
    try {
      const st = readDm(d);
      const bytes = Buffer.byteLength(JSON.stringify(st.dms), 'utf8');
      assert(bytes <= 64 * 1024, `E: DMs still ${bytes} bytes, cap 65536`);
      assert(st.dms.length >= 10, `E: dropped below KEEP_MIN floor (${st.dms.length})`);
      assert(st.dms.length < 40, 'E: nothing was trimmed');
      assert.equal(st.dms[st.dms.length - 1].id, 'b39', 'E: newest DM was dropped');
      console.log(`✓ E: agentDmMaxBytes trims oldest to fit (kept ${st.dms.length}, ${bytes} bytes)`);
      pass++;
    } finally { s.stop(); }
  }

  // ── F. env override wins over the file ─────────────────────────────────
  {
    const d = tmp(); setup(d, { agentDmMaxMessages: 9999 });
    const now = Date.now();
    seedDm(d, { dms: Array.from({ length: 30 }, (_, i) => dm(`e${i}`, now - (30 - i) * 1000, `body ${i}`, { state: 'replied' })) });
    const s = await startServer(d, { PORTAL_AGENT_DM_MAX_MESSAGES: '11' });
    try {
      assert.equal(readDm(d).dms.length, 11, 'F: PORTAL_AGENT_DM_MAX_MESSAGES did not override the file');
      console.log('✓ F: PORTAL_AGENT_DM_MAX_MESSAGES env overrides the configured cap');
      pass++;
    } finally { s.stop(); }
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 agent-dm-store checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-dm-store test FAILED:', e.message);
  process.exit(1);
});
