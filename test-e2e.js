#!/usr/bin/env node
'use strict';
/**
 * test-e2e.js — smoke test for plan item 18 (clean-box end-to-end verify).
 *
 * Asserts the repeatable clean-box verifier exists, is wired the right way,
 * and that its Docker-free backend actually runs the full journey green
 * (install → wizard → chat → upgrade → restore) inside a throwaway workspace.
 *
 * The Docker backend is exercised separately (in CI / locally):
 *     ./e2e-verify.sh --backend docker
 *
 * Zero dependencies. Run: node test-e2e.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = __dirname;
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let pass = 0;

// ── A. the verifier exists, is executable, and documents the journey ────────
{
  const p = path.join(SRC, 'e2e-verify.sh');
  assert(fs.existsSync(p), 'A: e2e-verify.sh must exist');
  assert(fs.statSync(p).mode & 0o111, 'A: e2e-verify.sh must be executable');
  const s = read('e2e-verify.sh');
  for (const stage of ['install', 'wizard', 'chat', 'upgrade', 'restore']) {
    assert(new RegExp(`\\b${stage}\\b`).test(s), `A: verifier must cover the "${stage}" stage`);
  }
  for (const back of ['docker', 'process']) {
    assert(s.includes(back), `A: verifier must support the "${back}" backend`);
  }
  // It must do its work in a throwaway workspace and clean up.
  assert(/mktemp -d/.test(s), 'A: verifier must use a mktemp workspace');
  // It must never target the LIVE container name as its own.
  assert(!/docker (rm|stop)[^\n]*\bagent-portal\b/.test(s), 'A: must not touch the live agent-portal container');
  // It must use the real helpers, not reinvent them.
  assert(/backup\.sh/.test(s), 'A: restore step must use the real backup.sh');
  assert(/install\.sh/.test(s), 'A: install step must use the real install.sh');
  console.log('✓ A: e2e-verify.sh — covers install→wizard→chat→upgrade→restore, docker+process backends, throwaway workspace');
  pass++;
}

// ── B. the Docker-free backend runs the whole journey green ─────────────────
{
  const r = spawnSync('bash', [path.join(SRC, 'e2e-verify.sh'), '--backend', 'process'], {
    cwd: SRC, encoding: 'utf8', timeout: 180000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert(r.status === 0, `B: process-backend e2e exited ${r.status}\n${out}`);
  assert(/clean-box E2E PASSED/.test(out), `B: expected the PASSED banner\n${out}`);
  // Each stage must have actually reported success.
  for (const check of [
    'setup required',
    'wizard created the admin',
    'message persisted to portal-rooms.json',
    'transcript survived the upgrade',
    'sha256-identical',
    'restored box boots and the admin logs in again',
  ]) {
    assert(out.includes(check), `B: missing evidence line: "${check}"\n${out}`);
  }
  console.log('✓ B: process backend — full install→wizard→chat→upgrade→restore journey passed');
  pass++;
}

// ── C. CI runs it (so it stays repeatable, not a one-off) ───────────────────
{
  const ci = read('.github/workflows/ci.yml');
  assert(/e2e-verify\.sh/.test(ci), 'C: CI must invoke the clean-box verifier');
  console.log('✓ C: CI invokes e2e-verify.sh (repeatable, not a one-off)');
  pass++;
}

console.log(`\nall ${pass}/3 e2e checks passed`);
