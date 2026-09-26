#!/usr/bin/env node
'use strict';
/**
 * test-network-decision.js — drift guard for plan item 0c.
 *
 * Item 0c records Dad's Option A decision (remote-agent reachability) as a
 * durable artifact. This guards that record against drift:
 *   A. docs/NETWORK-DECISION.md exists, is titled, and names the decision
 *   B. it states all four parameters: LAN bind · TLS mandatory · remote agents
 *      reachable · firewall scoped to the fleet subnet
 *   C. it names the real enforcement gates (assertNetworkPolicy/assertTlsPolicy)
 *      and records that the live flip belongs to the migration window
 *   D. portal-config.example.json documents the decision and links the doc,
 *      while still shipping a LOOPBACK default (0c must not expose the example)
 *   E. README.md links the decision doc (discoverability)
 *
 * Zero dependencies. Run: node test-network-decision.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

let pass = 0;

// ── A. the record exists ─────────────────────────────────────────────────────
const DOC = 'docs/NETWORK-DECISION.md';
{
  assert(fs.existsSync(path.join(SRC, DOC)), `A: ${DOC} is missing`);
  const doc = read(DOC);
  assert(/^#\s+Network Decision/m.test(doc), 'A: doc must be titled "Network Decision …"');
  assert(/\bOption A\b/.test(doc), 'A: doc must name the chosen option (Option A)');
  assert(/2026-09-25/.test(doc), 'A: doc must carry the decision date');
  console.log(`✓ A: ${DOC} present, titled, and names Option A`);
  pass++;
}

// ── B. all four parameters are stated ────────────────────────────────────────
{
  const doc = read(DOC);
  assert(/LAN bind/i.test(doc), 'B: must state the LAN bind');
  assert(/TLS/i.test(doc) && /mandatory|required/i.test(doc), 'B: must state TLS is mandatory');
  assert(/remote agents|agents on other (fleet )?servers|reachable/i.test(doc),
    'B: must state remote agents can reach the agent API');
  assert(/firewall/i.test(doc) && /scoped to the fleet/i.test(doc),
    'B: must state the firewall is scoped to the fleet subnet');
  assert(/\/api\/agent\/\*/.test(doc), 'B: must scope the exposure to /api/agent/*');
  console.log('✓ B: LAN bind · TLS mandatory · remote reachable · firewall scoped — all recorded');
  pass++;
}

// ── C. names the real gates + the migration-window caveat ────────────────────
{
  const doc = read(DOC);
  const server = read('portal-server.js');
  assert(/assertNetworkPolicy/.test(doc) && /assertTlsPolicy/.test(doc),
    'C: doc must name both boot gates');
  assert(/function assertNetworkPolicy\b/.test(server) && /function assertTlsPolicy\b/.test(server),
    'C: the named gates must exist in portal-server.js (rename drift)');
  assert(/migration window/i.test(doc), 'C: doc must record that applying it is a migration-window step');
  assert(/agent-portal/.test(doc), 'C: doc must name the production container that is NOT to be restarted');
  console.log('✓ C: enforcement gates + migration-window caveat recorded (matches the real code)');
  pass++;
}

// ── D. example config documents it, still defaults to loopback ───────────────
{
  const cfg = JSON.parse(read('portal-config.example.json'));
  assert.equal(cfg.bind, '127.0.0.1', 'D: the shipped example must keep the loopback default');
  const c = String(cfg._comment || '');
  assert(/NETWORK-DECISION\.md/.test(c), 'D: example _comment must link the decision doc');
  assert(/agent API/i.test(c) && /firewall/i.test(c),
    'D: example _comment must state the agent-API + firewall decision');
  console.log('✓ D: portal-config.example.json documents the decision, still loopback-safe');
  pass++;
}

// ── E. README links the decision ─────────────────────────────────────────────
{
  const readme = read('README.md');
  assert(/\]\(docs\/NETWORK-DECISION\.md\)/.test(readme), 'E: README must link docs/NETWORK-DECISION.md');
  console.log('✓ E: README links the decision doc');
  pass++;
}

console.log(`\nall ${pass}/5 network-decision checks passed`);
