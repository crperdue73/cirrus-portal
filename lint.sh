#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Cirrus Portal — dependency-free lint (plan item 13)
#  ───────────────────────────────────────────────────────────────────────────
#  There is no third-party toolchain to install (the shipped tree has zero
#  runtime dependencies), so "lint" here means the checks that catch real
#  breakage before CI/tests run:
#
#    • every tracked *.js parses            → node --check
#    • every shell script parses            → bash -n
#    • shipped JSON files are well-formed
#    • no CRLF line endings sneaked in
#
#  Usage: ./lint.sh
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
NODE="${NODE:-node}"
fail=0

echo "── JavaScript syntax (node --check) ────────────────────────────────"
js_count=0
while IFS= read -r f; do
  js_count=$((js_count + 1))
  if ! "$NODE" --check "$f" >/dev/null 2>&1; then
    echo "✗ syntax error: $f"
    "$NODE" --check "$f" || true
    fail=1
  fi
done < <(find . -name '*.js' -not -path './.git/*' -not -path './dist/*' -not -path './node_modules/*' | sort)
echo "   checked $js_count JS file(s)"

echo "── Shell syntax (bash -n) ──────────────────────────────────────────"
sh_count=0
while IFS= read -r f; do
  sh_count=$((sh_count + 1))
  if ! bash -n "$f"; then
    echo "✗ shell syntax error: $f"
    fail=1
  fi
done < <(find . -name '*.sh' -not -path './.git/*' -not -path './dist/*' | sort)
echo "   checked $sh_count shell script(s)"

echo "── JSON validity ───────────────────────────────────────────────────"
for f in branding.json portal-config.example.json portal-secrets.example.json; do
  [ -f "$f" ] || continue
  if ! "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" >/dev/null 2>&1; then
    echo "✗ invalid JSON: $f"
    fail=1
  else
    echo "   ok: $f"
  fi
done

echo "── Line endings (no CRLF) ──────────────────────────────────────────"
crlf=0
while IFS= read -r f; do
  if grep -Iq $'\r' "$f" 2>/dev/null; then
    echo "✗ CRLF line endings: $f"
    crlf=1
    fail=1
  fi
done < <(git ls-files 2>/dev/null | grep -Ev '\.(png|jpg|jpeg|gif|webp|ico|tar|gz|zip)$' || find . -type f -not -path './.git/*' -not -path './dist/*')
[ "$crlf" -eq 0 ] && echo "   ok: no CRLF line endings"

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ lint clean"
else
  echo "✗ lint failures above"
fi
exit "$fail"
