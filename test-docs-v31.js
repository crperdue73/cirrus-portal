#!/usr/bin/env node
'use strict';
/**
 * test-docs-v31.js — smoke test for plan item 5a (v3.1.0 version + docs).
 *
 * 5a is a DOCS/version deliverable, so this guards it against drift:
 *   A. VERSION is 3.1.0 and the newest CHANGELOG release matches it (above 3.0.0)
 *   B. the CHANGELOG 3.1.0 section records the four shipping features
 *   C. README advertises the board + cross-server DM + phone book and links the log
 *   D. ADMIN documents the agent API, the board, and cross-server DM (and keeps §11)
 *   E. the example config carries the new v3.1 keys
 *   F. no personal/internal context leaks into the shipped docs
 *
 * Zero dependencies. Run: node test-docs-v31.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

let pass = 0;

// ── A. version consistency ───────────────────────────────────────────────────
{
  const version = read('VERSION').trim();
  assert(/^\d+\.\d+\.\d+$/.test(version), `A: VERSION must be semver, got "${version}"`);
  assert.strictEqual(version, '3.1.0', 'A: item 5a bumps VERSION to 3.1.0');

  const cl = read('CHANGELOG.md');
  const newest = cl.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert(newest, 'A: CHANGELOG has no released version heading');
  assert.strictEqual(newest[1], version, 'A: newest CHANGELOG release must equal VERSION');
  assert(/^## \[3\.1\.0\] — \d{4}-\d{2}-\d{2}$/m.test(cl), 'A: 3.1.0 needs a dated section');
  assert(cl.indexOf('## [3.1.0]') < cl.indexOf('## [3.0.0]'), 'A: 3.1.0 must sit above 3.0.0');
  console.log(`✓ A: VERSION ${version} matches the newest CHANGELOG release`);
  pass++;
}

// ── B. CHANGELOG records the shipping features ───────────────────────────────
{
  const cl = read('CHANGELOG.md').slice(0, read('CHANGELOG.md').indexOf('## [3.0.0]'));
  for (const feat of ['Agent API', 'Bulletin board', 'Cross-server agent DM', 'Phone book']) {
    assert(cl.includes(feat), `B: 3.1.0 CHANGELOG must record "${feat}"`);
  }
  assert(/###\s*Added/.test(cl) && /###\s*Security/.test(cl),
    'B: 3.1.0 must use Keep-a-Changelog headings');
  console.log('✓ B: CHANGELOG 3.1.0 records the four shipping features');
  pass++;
}

// ── C. README advertises the new capabilities ────────────────────────────────
{
  const r = read('README.md');
  assert(/Bulletin board/i.test(r), 'C: README must mention the bulletin board');
  assert(/Cross-server agent DM/i.test(r), 'C: README must mention cross-server agent DM');
  assert(/phone book/i.test(r), 'C: README must mention the phone book');
  assert(/## Bulletin board & cross-server agent DM/.test(r), 'C: README needs the v3.1 section');
  assert(r.includes('](CHANGELOG.md)'), 'C: README must link the changelog');
  console.log('✓ C: README advertises board + cross-server DM + phone book');
  pass++;
}

// ── D. ADMIN documents the new operator surface ──────────────────────────────
{
  const d = read('ADMIN.md');
  assert(/## 12\. Agent API/.test(d), 'D: ADMIN needs an Agent API section');
  assert(/## 13\. Bulletin board/.test(d), 'D: ADMIN needs a Bulletin board section');
  assert(/## 14\. Cross-server agent DM/.test(d), 'D: ADMIN needs a Cross-server agent DM section');
  assert(/## 11\. Compliance & abuse/.test(d), 'D: ADMIN §11 must stay put (test-compliance depends on it)');
  for (const topic of ['/api/agent-tokens', 'agentDmVisibility', 'boardMaxPosts', 'Bearer']) {
    assert(d.includes(topic), `D: ADMIN must document ${topic}`);
  }
  console.log('✓ D: ADMIN documents the agent API, board, and cross-server DM');
  pass++;
}

// ── E. example config carries the v3.1 keys ──────────────────────────────────
{
  const cfg = JSON.parse(read('portal-config.example.json'));
  const keys = [
    'agentRateLimitPerMinute', 'agentRateLimitBurst', 'agentMaxBodyBytes',
    'boardRetentionDays', 'boardMaxPosts', 'boardMaxBytes', 'boardMentionWake',
    'agentDmRetentionDays', 'agentDmMaxMessages', 'agentDmMaxBytes',
    'agentDmAwaitReplyMs', 'agentDmSyncMaxConcurrent', 'agentDmHopWindowMs',
    'agentDmPairRatePerMinute', 'agentDmPairBurst',
    'agentDmCircuitMaxPerMinute', 'agentDmCircuitCooldownMs', 'agentDmVisibility',
  ];
  for (const k of keys) assert.ok(k in cfg, `E: example config must carry ${k}`);
  console.log(`✓ E: example config carries all ${keys.length} v3.1 keys`);
  pass++;
}

// ── F. no personal/internal context in the shipped docs ──────────────────────
{
  const banned = [
    [/\bDad\b/, 'Dad'],
    [/\bNoah\b/, 'Noah'],
    [/(?<!CR)Perdue/, 'Perdue (bare)'],
    [/Pocket AEGIS/i, 'family chat name'],
    [/perdue-portal-2026/i, 'legacy shared password'],
  ];
  for (const f of ['README.md', 'ADMIN.md']) {
    const t = read(f);
    for (const [re, label] of banned) {
      assert(!re.test(t), `F: internal string "${label}" leaked into ${f}`);
    }
  }
  // The CHANGELOG legitimately quotes the retired shared password in its
  // history, so only the personal-name bans apply there.
  const cl = read('CHANGELOG.md');
  for (const [re, label] of banned.slice(0, 3)) {
    assert(!re.test(cl), `F: internal string "${label}" leaked into CHANGELOG.md`);
  }
  console.log('✓ F: no internal/personal context in the shipped docs');
  pass++;
}

console.log(`\nall ${pass}/6 v3.1 docs checks passed`);
