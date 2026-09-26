#!/usr/bin/env node
'use strict';
/**
 * test-agent-dm-privacy.js — plan item 4e (agent DM privacy).
 *
 * Items 4a–4d shipped the mailbox, the router, the sync reply and the loop
 * guards. 4e is the PRIVACY layer: cross-server agent DMs are private by
 * default — an admin sees that a DM happened, never its body — and a single
 * switch flips the policy, audited, with every agent told. This drives the REAL
 * server against a fake gateway and proves the policy is enforced SERVER-SIDE:
 *
 *   A. private is the default — whoami tells the agent; an admin read shows
 *      metadata (from/to/state) but the body is null + redacted, and the body
 *      string never appears in the admin response; the two parties still read
 *      their own copy.
 *   B. audit is policy-only — the admin read is audited (agent_dm_admin_read)
 *      but no DM body and no agent token ever reaches the audit log.
 *   C. flip → visible — the admin flip is accepted, audited
 *      (agent_dm_visibility {from,to}), counted, and the current policy is
 *      exposed as a gauge; agents are told via whoami AND via the DM send reply;
 *      the admin read now includes the bodies.
 *   D. flip → private — restores redaction; gauge returns to 0.
 *   E. access control — non-admin 403, agent Bearer inert on the human route
 *      (401), a flip without CSRF 403, an unknown value 400 (no change, no audit).
 *   F. persistence — the policy lives in the DM store (0600) and survives a
 *      server restart, so an admin flip is not lost on redeploy.
 *
 * Zero dependencies. Run: node test-agent-dm-privacy.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');
const { FakeGateway } = require('./test/fake-gateway');

const SRC = __dirname;
const PW = 'Zx9-unique-Pass-42';
const BODY_1 = 'PRIVATE-SECRET-BODY-1-do-not-leak';
const BODY_2 = 'PRIVATE-SECRET-BODY-2-do-not-leak';
const made = [];
const secrets = []; // plaintext tokens we minted — must never appear anywhere

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-dmpriv-')); made.push(d); return d; };

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

async function startServer(dir) {
  const port = await freePort();
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'));
  cfg.port = port;
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(cfg, null, 2));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['portal-server.js'], {
      cwd: dir, env: { ...process.env, PORTAL_ADMIN_PASSWORD: PW }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      resolve({ child, get out() { return out; }, get err() { return err; }, port, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
    };
    const timer = setTimeout(finish, 12000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('ready.')) { clearTimeout(timer); finish(); } });
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
  return j.token;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const sendDm = (base, t, body) => fetch(`${base}/api/agent/dm`, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, bearer(t)), body: JSON.stringify(body),
});
const whoami = (base, t) => fetch(`${base}/api/agent/whoami`, { headers: bearer(t) });
const readDm = (base, t, q = '') => fetch(`${base}/api/agent/dm${q}`, { headers: bearer(t) });
const adminDms = (base, a, q = '') => fetch(`${base}/api/agent-dms${q}`, { headers: { Cookie: a.cookie } });
const flip = (base, a, visibility, opts = {}) => fetch(`${base}/api/agent-dms/visibility`, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json', Cookie: a.cookie }, opts.csrf === false ? {} : { 'X-CSRF-Token': a.csrf }),
  body: JSON.stringify({ visibility }),
});

function auditLines(dir) {
  const raw = fs.readFileSync(path.join(dir, 'portal-audit.log'), 'utf8');
  return { raw, lines: raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const readStore = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'portal-agent-dm.json'), 'utf8'));
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}
async function connected(base, t) {
  const j = await (await fetch(`${base}/api/agent/roster`, { headers: bearer(t) })).json();
  const live = (j.servers || []).filter((x) => x.connected).map((x) => x.id).sort();
  return live.join(',') === 'home,lab';
}

(async () => {
  let pass = 0;

  const sent = { home: [], lab: [] };
  const handler = (arr) => (method, params) => {
    if (method === 'chat.send') { arr.push(params); return { runId: 'r-' + arr.length, status: 'accepted' }; }
    return {};
  };
  const home = await new FakeGateway({ agents: [{ id: 'alice', name: 'Alice' }], onRequest: handler(sent.home) }).start();
  const lab = await new FakeGateway({ agents: [{ id: 'bob', name: 'Bob' }], onRequest: handler(sent.lab) }).start();
  const gateways = [
    { id: 'home', name: 'Home', url: home.wsUrl(), token: 'home-tok', enabled: true },
    { id: 'lab', name: 'Lab', url: lab.wsUrl(), token: 'lab-tok', enabled: true },
  ];

  const d = tmp();
  setup(d, { gateways });
  let s = await startServer(d);
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const admin = await login(base, 'admin', PW);
    // A second (non-admin) account to prove the admin gate.
    const cr = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf },
      body: JSON.stringify({ username: 'teach', password: 'An0ther-Str0ng-Pw', role: 'instructor' }),
    });
    assert(cr.ok, `E: could not create the instructor account (${cr.status})`);
    const teacher = await login(base, 'teach', 'An0ther-Str0ng-Pw');

    const alice = await mint(base, admin, { agentId: 'alice', gatewayId: 'home', label: 'Alice@home' });
    const bob = await mint(base, admin, { agentId: 'bob', gatewayId: 'lab', label: 'Bob@lab' });
    await waitFor(async () => connected(base, alice));

    // Seed two DMs (alice→bob, bob→alice).
    const s1 = await sendDm(base, alice, { to: 'lab:bob', text: BODY_1 });
    assert([200, 202].includes(s1.status), `seed DM 1 failed (${s1.status})`);
    const s2 = await sendDm(base, bob, { to: 'home:alice', text: BODY_2 });
    assert([200, 202].includes(s2.status), `seed DM 2 failed (${s2.status})`);

    // ── A. private by default ──────────────────────────────────────────
    {
      const w = await whoami(base, alice);
      const wj = await w.json();
      assert.equal(wj.dmVisibility, 'private', `A: whoami should report private, got ${JSON.stringify(wj)}`);
      assert(/private/i.test(wj.dmVisibilityNote || ''), 'A: whoami should carry the private note');

      const r = await adminDms(base, admin);
      const rj = await r.json();
      assert.equal(r.status, 200, `A: admin read failed (${r.status})`);
      assert.equal(rj.visibility, 'private', 'A: the read should report the private policy');
      assert.equal(rj.dms.length, 2, `A: expected 2 DMs, got ${rj.dms.length}`);
      const one = rj.dms.find((m) => m.text !== undefined || m.redacted);
      assert(one, 'A: no DM record returned');
      assert.equal(one.text, null, 'A: body must be null in private mode');
      assert.equal(one.redacted, true, 'A: body must be flagged redacted in private mode');
      assert(rj.dms.every((m) => m.from && m.to && typeof m.ts === 'number' && m.state), 'A: metadata (from/to/ts/state) must still be present');
      const rawBody = JSON.stringify(rj);
      assert(!rawBody.includes(BODY_1) && !rawBody.includes(BODY_2), 'A: a DM body leaked into the admin response');

      // The two parties still read their own content.
      const own = await (await readDm(base, alice)).json();
      assert(own.dms.some((m) => m.text === BODY_1), 'A: the sender could not read its own DM');
      assert.equal(own.visibility, 'private', 'A: the agent read should report the policy');
      console.log('✓ A: DMs are private by default — admin sees metadata, body redacted server-side, parties keep their copy');
      pass++;
    }

    // ── B. audit is policy-only ────────────────────────────────────────
    {
      const { raw, lines } = auditLines(d);
      assert(lines.some((l) => l.action === 'agent_dm_admin_read'), 'B: agent_dm_admin_read not audited');
      const read = lines.filter((l) => l.action === 'agent_dm_admin_read').pop();
      assert.equal(read.detail.redacted, true, 'B: the admin-read audit should record redacted:true in private mode');
      assert(!raw.includes(BODY_1) && !raw.includes(BODY_2), 'B: a DM body leaked into the audit log');
      for (const t of secrets) assert(!raw.includes(t), 'B: an agent token leaked into the audit log');
      console.log('✓ B: the admin read is audited (redacted:true) with no body and no token in the log');
      pass++;
    }

    // ── C. flip → visible (audited, counted, agents told) ──────────────
    {
      const r = await flip(base, admin, 'visible');
      const rj = await r.json();
      assert.equal(r.status, 200, `C: flip failed (${r.status}) ${JSON.stringify(rj)}`);
      assert.equal(rj.visibility, 'visible', 'C: flip should report the new policy');
      assert.equal(rj.changed, true, 'C: the flip should report changed:true');

      const { lines } = auditLines(d);
      const flipAudit = lines.filter((l) => l.action === 'agent_dm_visibility').pop();
      assert(flipAudit, 'C: agent_dm_visibility not audited');
      assert.equal(flipAudit.detail.from, 'private', 'C: the flip should record from:private');
      assert.equal(flipAudit.detail.to, 'visible', 'C: the flip should record to:visible');

      const wj = await (await whoami(base, alice)).json();
      assert.equal(wj.dmVisibility, 'visible', 'C: agents must be told the new policy via whoami');

      const sresp = await (await sendDm(base, alice, { to: 'lab:bob', text: 'visible-mode-body' })).json();
      assert.equal(sresp.visibility, 'visible', 'C: the DM send reply must tell the agent the policy');

      const rj2 = await (await adminDms(base, admin)).json();
      const withBody = rj2.dms.find((m) => m.text === BODY_1);
      assert(withBody, 'C: in visible mode the admin read must include the body');
      assert.equal(rj2.redacted, undefined, 'C: the response should not be flagged redacted in visible mode');

      const met = await (await fetch(`${base}/metrics`)).text();
      assert(/cirrus_portal_agent_dm_visibility_changes_total [1-9]/.test(met), 'C: the visibility-changes metric is missing');
      assert(/cirrus_portal_agent_dm_bodies_visible 1/.test(met), 'C: the bodies-visible gauge should be 1');
      console.log('✓ C: the flip is audited and counted; agents are told; the admin read now includes bodies');
      pass++;
    }

    // ── D. flip → private restores redaction ───────────────────────────
    {
      const rj = await (await flip(base, admin, 'private')).json();
      assert.equal(rj.changed, true, 'D: flipping back should report changed:true');
      const rj2 = await (await adminDms(base, admin)).json();
      assert(rj2.dms.every((m) => m.text === null && m.redacted === true), 'D: bodies must be redacted again');
      const met = await (await fetch(`${base}/metrics`)).text();
      assert(/cirrus_portal_agent_dm_bodies_visible 0/.test(met), 'D: the gauge should return to 0');
      console.log('✓ D: flipping back to private restores server-side redaction (gauge 0)');
      pass++;
    }

    // ── E. access control + validation ─────────────────────────────────
    {
      const no = await adminDms(base, teacher);
      assert.equal(no.status, 403, `E: a non-admin must not read the DM feed (got ${no.status})`);
      const bear = await fetch(`${base}/api/agent-dms`, { headers: bearer(alice) });
      assert.equal(bear.status, 401, `E: an agent Bearer must be inert on the human route (got ${bear.status})`);
      const nocsrf = await flip(base, admin, 'visible', { csrf: false });
      assert.equal(nocsrf.status, 403, `E: a flip without CSRF must be refused (got ${nocsrf.status})`);
      const bad = await flip(base, admin, 'bogus');
      assert.equal(bad.status, 400, `E: an unknown value must be refused (got ${bad.status})`);
      const { lines } = auditLines(d);
      assert(!lines.some((l) => l.action === 'agent_dm_visibility' && l.detail && l.detail.to === 'bogus'), 'E: a refused flip must not be audited as a change');
      // And the policy is unchanged (still private).
      const wj = await (await whoami(base, alice)).json();
      assert.equal(wj.dmVisibility, 'private', 'E: a refused flip must not change the policy');
      console.log('✓ E: non-admin 403 · Bearer inert (401) · no-CSRF 403 · unknown value 400 with no change');
      pass++;
    }

    // ── F. persistence across restart ──────────────────────────────────
    {
      const rj = await (await flip(base, admin, 'visible')).json();
      assert.equal(rj.visibility, 'visible', 'F: could not set visible before restart');
      assert.equal(mode(path.join(d, 'portal-agent-dm.json')), '600', 'F: the DM store must stay 0600');
      assert.equal(readStore(d).visibility, 'visible', 'F: the policy must be persisted in the DM store');
      s.stop();
      await sleep(400);
      s = await startServer(d);
      const base2 = `http://127.0.0.1:${s.port}`;
      await waitFor(async () => connected(base2, alice));
      const wj = await (await whoami(base2, alice)).json();
      assert.equal(wj.dmVisibility, 'visible', 'F: the policy must survive a restart');
      console.log('✓ F: the policy persists in the DM store (0600) and survives a restart');
      pass++;
    }
    s.stop();
  } finally {
    try { s.stop(); } catch { /* gone */ }
    home.stop();
    lab.stop();
  }

  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.log(`\nall ${pass}/6 agent-dm-privacy checks passed`);
})().catch((e) => {
  for (const dd of made) { try { fs.rmSync(dd, { recursive: true, force: true }); } catch { /* noop */ } }
  console.error('\n✗ agent-dm-privacy test FAILED:', e.stack || e.message);
  process.exit(1);
});
