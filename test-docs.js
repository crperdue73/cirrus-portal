#!/usr/bin/env node
'use strict';
/**
 * test-docs.js — smoke test for plan item 9 (deployment model + tenancy).
 *
 * The deployment model is a DOCS deliverable, so this guards it against drift:
 *   A. DEPLOYMENT.md exists and uses the canonical product name (branding.json)
 *   B. it states the tenancy decision (single-tenant, one org per install)
 *   C. its supported-platform claims match the REAL installer preflight
 *      (os-release match, disk gate, docker compose v2, Node 22, gateway port)
 *   D. it explicitly lists unsupported setups (no silent omissions)
 *   E. it ships in the release tarball (release.sh FILES) and is linked from README
 *
 * Zero dependencies. Run: node test-docs.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

let pass = 0;

// ── A. exists + canonical name ───────────────────────────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'DEPLOYMENT.md')), 'A: DEPLOYMENT.md is missing');
  const doc = read('DEPLOYMENT.md');
  const brand = JSON.parse(read('branding.json'));
  assert(doc.includes(brand.product), `A: DEPLOYMENT.md must use the canonical product name "${brand.product}"`);
  assert(/single-tenant/i.test(doc) && /self-hosted/i.test(doc), 'A: must name the deployment model');
  console.log(`✓ A: DEPLOYMENT.md present and uses canonical name "${JSON.parse(read('branding.json')).product}"`);
  pass++;
}

// ── B. tenancy decision stated unambiguously ─────────────────────────────────
{
  const doc = read('DEPLOYMENT.md');
  assert(/one (install|org(anization)?)[^\n]*per install|one org per install|one install[^\n]*one org/i.test(doc),
    'B: must state "one org per install"');
  assert(/not a tenant boundary|no tenant picker|no per-tenant|single account realm|one account realm/i.test(doc),
    'B: must explain that roles are not tenant boundaries');
  assert(/more than one org|run more than one install|scale out|one install per org/i.test(doc),
    'B: must tell people how to host >1 org (N installs)');
  console.log('✓ B: tenancy decision stated (one org per install; N installs to scale orgs)');
  pass++;
}

// ── C. supported-platform claims match the real installer preflight ──────────
{
  const doc = read('DEPLOYMENT.md');
  const inst = read('install.sh');

  // The installer's OS check is a grep for debian|ubuntu on /etc/os-release.
  assert(/debian\|ubuntu/.test(inst), 'C: install.sh preflight regex changed — re-check DEPLOYMENT.md');
  assert(/Debian 12\/13|Debian\/Ubuntu/.test(doc) && /Ubuntu 22\.04\/24\.04/.test(doc),
    'C: supported OS list must name Debian 12/13 + Ubuntu 22.04/24.04');

  // Disk gate: `need >500 MB free disk` in install.sh.
  assert(/>\s*500 MB free disk|500 MB free/.test(inst), 'C: install.sh disk gate changed — re-check DEPLOYMENT.md');
  assert(/>\s*500 MB free/i.test(doc), 'C: must document the >500 MB disk gate');

  // Runtime: docker compose v2 required.
  assert(/docker compose version/.test(inst), 'C: install.sh compose check changed');
  assert(/Compose v2/i.test(doc), 'C: must require the Compose v2 plugin');

  // Node 22+ for the non-Docker path.
  assert(/Node\.js`?[^\n]*22\+|Node 22\+/i.test(doc), 'C: must state Node 22+');

  // Gateway lives on the same host, loopback, default port 18790.
  assert(/18790/.test(doc), 'C: must state the gateway loopback port (18790)');
  console.log('✓ C: supported-platform claims match the installer preflight');
  pass++;
}

// ── D. unsupported setups are explicitly listed ──────────────────────────────
{
  const doc = read('DEPLOYMENT.md');
  assert(/##\s*\d?\.?\s*Explicitly unsupported setups/i.test(doc), 'D: needs an "Explicitly unsupported setups" section');
  for (const item of ['Multi-tenant', 'cleartext', 'Windows', 'macOS', 'Kubernetes', 'High availability']) {
    assert(new RegExp(item, 'i').test(doc), `D: unsupported list is missing: ${item}`);
  }
  console.log('✓ D: unsupported setups explicitly listed (multi-tenant, cleartext, Win/mac, k8s, HA)');
  pass++;
}

// ── E. ships in the tarball + linked from README ─────────────────────────────
{
  const rel = read('release.sh');
  assert(/DEPLOYMENT\.md/.test(rel), 'E: release.sh FILES must include DEPLOYMENT.md');
  const readme = read('README.md');
  assert(/\]\(DEPLOYMENT\.md\)/.test(readme) && /DEPLOYMENT\.md/.test(readme), 'E: README.md must link DEPLOYMENT.md');
  assert(/single-tenant,\s*\n?>?.*self-hosted|single-tenant, self-hosted/i.test(readme.replace(/\n/g, ' ')),
    'E: README one-liner must state the model');
  console.log('✓ E: DEPLOYMENT.md ships in the release and is linked from README');
  pass++;
}

console.log(`\nall ${pass}/5 deployment-docs checks passed`);
