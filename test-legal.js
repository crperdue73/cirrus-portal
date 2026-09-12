#!/usr/bin/env node
'use strict';
/**
 * test-legal.js — smoke test for plan item 11 (license + legal).
 *
 * Legal files are DOCS deliverables, so this guards them against drift and
 * keeps the claims inside them honest:
 *   A. LICENSE is the real Apache-2.0 text with the correct copyright holder
 *   B. NOTICE exists, names the holder, and carries the trademark reservation
 *   C. THIRD-PARTY-NOTICES.md's "zero bundled deps" claim is TRUE (no
 *      package.json, no node_modules, every require() is a Node builtin)
 *   D. SECURITY.md is a usable disclosure policy (versions, private contact,
 *      response targets, scope, safe harbor)
 *   E. ACCEPTABLE-USE.md covers the public-host baseline + prohibited uses
 *   F. all five legal files ship in the release tarball + are linked from README
 *
 * Zero dependencies. Run: node test-legal.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { builtinModules } = require('module');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const HOLDER = 'Copyright 2026 CRPerdue Technologies, LLC';

let pass = 0;

// ── A. LICENSE is Apache-2.0 with the right holder ───────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'LICENSE')), 'A: LICENSE is missing');
  const lic = read('LICENSE');
  assert(/Apache License/.test(lic) && /Version 2\.0, January 2004/.test(lic),
    'A: LICENSE must be the Apache License, Version 2.0 (January 2004)');
  assert(/END OF TERMS AND CONDITIONS/.test(lic), 'A: LICENSE looks truncated (no end marker)');
  assert(lic.includes(HOLDER), `A: LICENSE appendix must read "${HOLDER}"`);
  assert(!/\[yyyy\]|\[name of copyright owner\]/.test(lic),
    'A: LICENSE appendix still has unfilled [bracketed] placeholders');
  console.log('✓ A: LICENSE = Apache-2.0, holder line correct, no placeholders');
  pass++;
}

// ── B. NOTICE ────────────────────────────────────────────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'NOTICE')), 'B: NOTICE is missing (required by Apache-2.0 §4(d))');
  const notice = read('NOTICE');
  assert(notice.includes(HOLDER), `B: NOTICE must carry "${HOLDER}"`);
  assert(/Apache License, Version 2\.0/.test(notice), 'B: NOTICE must reference the Apache-2.0 license');
  assert(/trademark/i.test(notice) && /Cirrus/.test(notice),
    'B: NOTICE must reserve the Cirrus trademarks (Apache-2.0 §6 grants none)');
  console.log('✓ B: NOTICE present with holder + trademark reservation');
  pass++;
}

// ── C. the "zero bundled deps" claim is actually true ────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'THIRD-PARTY-NOTICES.md')), 'C: THIRD-PARTY-NOTICES.md is missing');
  const tp = read('THIRD-PARTY-NOTICES.md');
  assert(/zero bundled third-party/i.test(tp), 'C: must state the zero-bundled-deps position');

  // Claim must match reality: no manifest, no node_modules in the shipped tree.
  assert(!fs.existsSync(path.join(SRC, 'package.json')),
    'C: package.json now exists — THIRD-PARTY-NOTICES.md is stale, re-inventory deps');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [path.join(dir, e.name)];
    if (e.name === '.git' || e.name === 'dist') return [];
    return e.isDirectory() ? walk(path.join(dir, e.name)) : [];
  });
  assert(walk(SRC).length === 0, 'C: node_modules found — THIRD-PARTY-NOTICES.md must list real deps');

  // Every require() in shipped server code must be a Node builtin.
  const src = read('portal-server.js');
  const reqs = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  const external = [...new Set(reqs)].filter((m) => !m.startsWith('node:') && !builtinModules.includes(m));
  assert(external.length === 0, `C: external require() found (${external.join(', ')}) — update THIRD-PARTY-NOTICES.md`);
  console.log(`✓ C: zero bundled deps verified (no manifest, no node_modules, ${new Set(reqs).size} builtins only)`);
  pass++;
}

// ── D. SECURITY.md is a usable disclosure policy ─────────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'SECURITY.md')), 'D: SECURITY.md is missing');
  const sec = read('SECURITY.md');
  assert(/[Ss]upported versions/.test(sec) && /\| *3\.x *\|/.test(sec),
    'D: must publish a supported-versions table covering 3.x');
  assert(/security@crperdue\.com/.test(sec), 'D: must give a private reporting contact');
  assert(/[Dd]o not open a public issue/.test(sec), 'D: must tell reporters not to file publicly');
  assert(/business days/.test(sec), 'D: must state response targets');
  assert(/In scope/.test(sec) && /Out of scope/.test(sec), 'D: must separate in-scope from out-of-scope');
  assert(/safe harbor|good faith/i.test(sec), 'D: must include a safe-harbor statement');
  console.log('✓ D: SECURITY.md complete (versions, contact, targets, scope, safe harbor)');
  pass++;
}

// ── E. ACCEPTABLE-USE.md baseline for public hosts ───────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'ACCEPTABLE-USE.md')), 'E: ACCEPTABLE-USE.md is missing');
  const aup = read('ACCEPTABLE-USE.md');
  assert(/self-hosted/i.test(aup) && /operator/i.test(aup), 'E: must frame the operator as responsible');
  assert(/TLS/.test(aup) && /default .*credential|No default/i.test(aup),
    'E: public-host baseline must require TLS and no default credentials');
  assert(/Prohibited uses/i.test(aup), 'E: must list prohibited uses');
  assert(/Enforcement/i.test(aup), 'E: must say who enforces it');
  console.log('✓ E: ACCEPTABLE-USE.md covers baseline, prohibitions, enforcement');
  pass++;
}

// ── F. ships in the tarball + linked from README ─────────────────────────────
{
  const rel = read('release.sh');
  const files = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'SECURITY.md', 'ACCEPTABLE-USE.md'];
  for (const f of files) {
    assert(new RegExp(`(^|\\s)${f.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(rel),
      `F: release.sh FILES must include ${f}`);
  }
  const readme = read('README.md');
  for (const f of ['LICENSE', 'SECURITY.md', 'ACCEPTABLE-USE.md']) {
    assert(readme.includes(`](${f})`), `F: README.md must link ${f}`);
  }
  console.log('✓ F: all 5 legal files ship in the release and are linked from README');
  pass++;
}

console.log(`\nall ${pass}/6 legal checks passed`);
