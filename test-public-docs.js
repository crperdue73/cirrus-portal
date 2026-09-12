#!/usr/bin/env node
'use strict';
/**
 * test-public-docs.js — smoke test for plan item 12 (public documentation set).
 *
 * The public docs are a deliverable, so this guards them against drift AND
 * against leaking internal context into a public repo:
 *   A. README.md is a public QUICKSTART (has the essentials, no internal notes)
 *   B. ADMIN.md is a usable operator runbook
 *   C. THREAT-MODEL.md covers assets/boundaries/adversaries/controls/residuals
 *   D. UPGRADING.md is a backup-first upgrade + 2.x→3.x migration drill
 *   E. TROUBLESHOOTING.md maps symptoms → fixes and covers the boot gates
 *   F. the screenshot pass is real (8 PNGs + capture/seed scripts + README)
 *   G. all new docs ship in the release tarball (release.sh FILES)
 *   H. NO internal/personal context leaks into the public docs
 *
 * Zero dependencies. Run: node test-public-docs.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const NEW_DOCS = ['ADMIN.md', 'THREAT-MODEL.md', 'UPGRADING.md', 'TROUBLESHOOTING.md'];

let pass = 0;

// ── A. README is a public quickstart ─────────────────────────────────────────
{
  const r = read('README.md');
  assert(/^# Cirrus Portal/m.test(r), 'A: README must lead with the product name');
  assert(/Mission control for your OpenClaw fleet/.test(r), 'A: README must carry the tagline');
  assert(/## Quickstart/i.test(r), 'A: README needs a Quickstart section');
  assert(/install\.sh install/.test(r), 'A: README quickstart must show the install command');
  assert(/no default credential|No default credentials/i.test(r), 'A: README must state there are no default credentials');
  assert(/## Documentation/.test(r), 'A: README needs a docs index');
  for (const f of NEW_DOCS) assert(r.includes(`](${f})`), `A: README docs index must link ${f}`);
  assert(/\]\(docs\/screenshots\/\)/.test(r), 'A: README must link the screenshot pass');
  // The old internal dev-log content must be gone.
  assert(!/Dad'?s list|Phase I roadmap|CI30 context injection/i.test(r),
    'A: README still contains internal dev-log content');
  console.log('✓ A: README is a public quickstart (install, defaults, docs index, screenshots)');
  pass++;
}

// ── B. ADMIN.md is an operator runbook ───────────────────────────────────────
{
  const d = read('ADMIN.md');
  const need = [
    [/##\s*\d*\.?\s*Command surface/i, 'command surface'],
    [/##\s*\d*\.?\s*Install/i, 'install'],
    [/##\s*\d*\.?\s*Health & diagnostics|health/i, 'health'],
    [/##\s*\d*\.?\s*Backup & restore/i, 'backup/restore'],
    [/##\s*\d*\.?\s*Secrets/i, 'secrets'],
    [/##\s*\d*\.?\s*Users & roles/i, 'users/roles'],
    [/##\s*\d*\.?\s*Gateways/i, 'gateways'],
    [/##\s*\d*\.?\s*TLS/i, 'tls'],
    [/##\s*\d*\.?\s*Incident/i, 'incident'],
  ];
  for (const [re, label] of need) assert(re.test(d), `B: ADMIN.md is missing the ${label} section`);
  assert(/install\.sh (install|upgrade|status|doctor|backup|restore|uninstall)/.test(d), 'B: ADMIN.md must document the installer commands');
  console.log('✓ B: ADMIN.md covers install, health, backup, secrets, users, gateways, TLS, incidents');
  pass++;
}

// ── C. THREAT-MODEL.md ───────────────────────────────────────────────────────
{
  const d = read('THREAT-MODEL.md');
  assert(/##\s*\d*\.?\s*Assets/i.test(d), 'C: needs an Assets section');
  assert(/##\s*\d*\.?\s*Trust boundaries/i.test(d), 'C: needs a Trust boundaries section');
  assert(/##\s*\d*\.?\s*Adversar/i.test(d), 'C: needs an Adversaries section');
  assert(/residual/i.test(d), 'C: must state residual risk');
  assert(/out of scope|accepted/i.test(d), 'C: must state what is out of scope / accepted');
  assert(/single-tenant/i.test(d), 'C: must anchor on the single-tenant model');
  assert(/role.*not.*tenant boundary|not tenant boundaries/i.test(d.replace(/\*\*/g, '')),
    'C: must repeat that roles are not tenant boundaries');
  console.log('✓ C: THREAT-MODEL.md covers assets, boundaries, adversaries, controls, residuals');
  pass++;
}

// ── D. UPGRADING.md ──────────────────────────────────────────────────────────
{
  const d = read('UPGRADING.md');
  assert(/back up first|Back up first|backup first/i.test(d), 'D: must lead with backup-first');
  assert(/##\s*\d*\.?\s*Rollback/i.test(d), 'D: needs a Rollback section');
  assert(/3\.x/i.test(d) && /2\.x/i.test(d), 'D: must address the 2.x → 3.x move');
  assert(/portal-secrets\.json/.test(d), 'D: must cover the secrets-file migration');
  assert(/agent-portal/.test(d) && /cirrus-portal/.test(d), 'D: must cover the container rename');
  assert(/publicBind/.test(d), 'D: must cover the public-bind opt-in');
  console.log('✓ D: UPGRADING.md is a backup-first upgrade + 2.x→3.x migration drill');
  pass++;
}

// ── E. TROUBLESHOOTING.md ────────────────────────────────────────────────────
{
  const d = read('TROUBLESHOOTING.md');
  assert(/\|\s*Symptom\s*\|/i.test(d), 'E: must use symptom/cause/fix tables');
  for (const topic of ['Install & boot', 'Login & accounts', 'Agents & chat', 'TLS', 'Container', 'Backups', 'Escalation']) {
    assert(new RegExp(topic.replace('&', '&'), 'i').test(d), `E: missing topic: ${topic}`);
  }
  assert(/refuses? to boot|safety gate/i.test(d), 'E: must explain the intentional boot gates');
  assert(/SECURITY\.md/.test(d), 'E: must point security issues at SECURITY.md, not a public issue');
  console.log('✓ E: TROUBLESHOOTING.md maps symptoms→fixes and covers the boot gates');
  pass++;
}

// ── F. the screenshot pass is real ───────────────────────────────────────────
{
  const dir = path.join(SRC, 'docs/screenshots');
  assert(fs.existsSync(dir), 'F: docs/screenshots/ is missing');
  const shots = ['01-login.png', '02-agents-chat.png', '03-dashboard.png', '04-rooms.png',
    '05-users.png', '06-gateways.png', '07-audit.png', '08-student-view.png'];
  for (const s of shots) {
    const p = path.join(dir, s);
    assert(fs.existsSync(p), `F: missing screenshot ${s}`);
    const b = fs.readFileSync(p);
    assert(b.length > 10 * 1024, `F: ${s} is suspiciously small (${b.length} bytes) — blank capture?`);
    assert(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, `F: ${s} is not a PNG`);
  }
  assert(fs.existsSync(path.join(dir, 'README.md')), 'F: screenshots need a README (shot list + recipe)');
  assert(fs.existsSync(path.join(dir, 'capture.js')), 'F: missing the reproducible capture.js');
  assert(fs.existsSync(path.join(dir, 'seed-demo.js')), 'F: missing seed-demo.js (demo seeding)');
  console.log(`✓ F: ${shots.length} real PNGs + capture/seed scripts + README present`);
  pass++;
}

// ── G. all public docs ship in the release tarball ───────────────────────────
{
  const rel = read('release.sh');
  const shipped = [...NEW_DOCS, 'README.md',
    'docs/screenshots/README.md', 'docs/screenshots/capture.js', 'docs/screenshots/seed-demo.js',
    'docs/screenshots/01-login.png', 'docs/screenshots/08-student-view.png'];
  for (const f of shipped) {
    assert(new RegExp(`(^|\\s)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(rel),
      `G: release.sh FILES must include ${f}`);
  }
  console.log('✓ G: new docs + screenshots ship in the release tarball');
  pass++;
}

// ── H. no internal/personal context leaks into the public docs ───────────────
{
  const publicFiles = ['README.md', 'ADMIN.md', 'THREAT-MODEL.md', 'UPGRADING.md',
    'TROUBLESHOOTING.md', 'DEPLOYMENT.md', 'docs/screenshots/README.md'];
  const banned = [
    [/\bDad\b/, 'Dad'],
    [/\bNoah\b/, 'Noah'],
    [/(?<!CR)Perdue/, 'Perdue (bare)'],
    [/Pocket AEGIS/i, 'family chat name'],
    [/perdue-portal-2026/i, 'legacy shared password'],
    [/CI30 crosswalk|Phase I roadmap/i, 'internal roadmap'],
  ];
  for (const f of publicFiles) {
    const t = read(f);
    for (const [re, label] of banned) {
      assert(!re.test(t), `H: internal string "${label}" leaked into ${f}`);
    }
  }
  console.log('✓ H: no internal/personal context in the public docs');
  pass++;
}

console.log(`\nall ${pass}/8 public-docs checks passed`);
