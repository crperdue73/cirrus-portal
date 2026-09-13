#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Cirrus Portal — full test suite (plan item 13)
#  ───────────────────────────────────────────────────────────────────────────
#  Runs everything, in one command:
#    1. the Node test-runner suite in test/ (auth · RBAC · rooms · config ·
#       route smoke): `node --test test/*.test.js`
#    2. the standalone smoke tests in the repo root (test-*.js): credentials ·
#       secrets · setup · tls · network · auth · container · installer · docs ·
#       legal · public-docs · release · migrate · backup · e2e · compliance
#
#  Zero dependencies. Usage: ./run-tests.sh
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
NODE="${NODE:-node}"
fail=0

echo "── node:test suite (test/) ─────────────────────────────────────────"
if [ -d test ]; then
  shopt -s nullglob
  suite_files=(test/*.test.js)
  shopt -u nullglob
  if [ "${#suite_files[@]}" -eq 0 ]; then
    echo "✗ no test/*.test.js files found"
    fail=1
  elif "$NODE" --test "${suite_files[@]}"; then
    echo "✓ node:test suite passed"
  else
    echo "✗ node:test suite FAILED"
    fail=1
  fi
else
  echo "✗ test/ directory is missing"
  fail=1
fi

echo
echo "── standalone smoke tests (test-*.js) ──────────────────────────────"
shopt -s nullglob
suite=(test-*.js)
shopt -u nullglob
if [ "${#suite[@]}" -eq 0 ]; then
  echo "✗ no standalone tests found"
  fail=1
fi
for f in "${suite[@]}"; do
  if "$NODE" "$f"; then
    echo "✓ $f"
  else
    echo "✗ $f FAILED"
    fail=1
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ all Cirrus Portal tests passed"
else
  echo "✗ test failures above"
fi
exit "$fail"
