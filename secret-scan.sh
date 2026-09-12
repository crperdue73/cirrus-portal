#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Cirrus Portal — secret scanner (plan item 3)
#  ───────────────────────────────────────────────────────────────────────────
#  Greps the repo and/or a built distribution for things that must never ship:
#  gateway tokens, admin passwords, the device seed, private keys, and
#  forbidden runtime-state files. Exit 0 = clean, 1 = findings.
#
#  Usage:
#    ./secret-scan.sh                 # scan git-tracked source files (default)
#    ./secret-scan.sh --all           # scan every file in the working tree
#    ./secret-scan.sh --dir DIR       # scan a staged directory
#    ./secret-scan.sh --tar FILE      # extract + scan a release tarball
#
#  Runs in CI via .github/workflows/ci.yml (the secret-scan job).
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="repo"; TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tar) MODE="tar"; TARGET="${2:-}"; shift 2 ;;
    --dir) MODE="dir"; TARGET="${2:-}"; shift 2 ;;
    --all) MODE="all"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "secret-scan: unknown arg: $1" >&2; exit 2 ;;
  esac
done

FINDINGS="$(mktemp)"
WORKDIR=""
cleanup() { rm -f "$FINDINGS"; [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"; }
trap cleanup EXIT

# ── patterns ────────────────────────────────────────────────────────────────
# Assigned, quoted, 16+ char secret values (JSON/env/YAML style).
PAT_ASSIGN='"[a-z0-9_.-]*(token|password|passwd|secret|api_?key|access_?key|private_?key|client_?secret|seed)"[[:space:]]*:[[:space:]]*"[A-Za-z0-9][A-Za-z0-9+/=_.:-]{15,}"'
# Values that are obviously placeholders, not real secrets.
PAT_PLACEHOLDER='REPLACE|replace|EXAMPLE|example|PLACEHOLDER|placeholder|CHANGEME|change[-_]me|YOUR[_-]|your[_-]|XXXX|xxxx|<|>|\{\{|\}\}|\.\.\.'
# Historically shared/legacy secrets (only flagged in data/config files).
PAT_LEGACY='perdue-portal-2026|pocket-aegis-root-2026'
PAT_PEM='BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY'
# Runtime-state files that must never be tracked or shipped.
PAT_FORBIDDEN='^(portal-config\.json|portal-config\.json\.bak.*|portal-secrets\.json|portal-device\.json|portal-users\.json|portal-rooms\.json|portal-context\.json|portal-audit\.log|portal\.log|install\.log|portal-credentials\.txt|portal-first-run\.txt)$'

count=0
flag() { printf '  ✗ %s\n' "$1" >&2; printf '%s\n' "$1" >>"$FINDINGS"; count=$((count+1)); }

scan_file() {
  local f="$1" rel="$2"
  [ -f "$f" ] || return 0
  case "$f" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.pdf|*.ico|*.woff|*.woff2|*.ttf) return 0 ;;
  esac

  # 1) private key material
  if grep -nIE "$PAT_PEM" "$f" >/dev/null 2>&1; then
    flag "$rel: private key material"
    grep -nIE "$PAT_PEM" "$f" | sed "s|^|      $rel:|" >&2
  fi

  # 2) assigned secrets (skip placeholders)
  local hits
  hits="$(grep -nEi "$PAT_ASSIGN" "$f" 2>/dev/null | grep -viE "$PAT_PLACEHOLDER" || true)"
  if [ -n "$hits" ]; then
    flag "$rel: hard-coded secret value"
    printf '%s\n' "$hits" | sed "s|^|      $rel:|" >&2
  fi

  # 3) legacy shared secrets — data/config files only (docs + the server's
  #    denylist legitimately mention them by name)
  case "$f" in
    *.json|*.env|*.yml|*.yaml|*.conf|*.ini|*.cfg|*.properties|*.txt|*.log)
      hits="$(grep -nEi "$PAT_LEGACY" "$f" 2>/dev/null || true)"
      if [ -n "$hits" ]; then
        flag "$rel: legacy shared secret"
        printf '%s\n' "$hits" | sed "s|^|      $rel:|" >&2
      fi
      ;;
  esac
}

scan_tree() {
  local base="$1" label="$2"
  # forbidden state files anywhere in the tree
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    flag "${p#"$base"/}: forbidden state/secret file present in $label"
  done < <(find "$base" -type f \( -name 'portal-config.json' -o -name 'portal-config.json.bak*' \
      -o -name 'portal-secrets.json' -o -name 'portal-device.json' -o -name 'portal-users.json' \
      -o -name 'portal-rooms.json' -o -name 'portal-context.json' -o -name 'portal-audit.log' \
      -o -name 'portal.log' -o -name 'install.log' -o -name 'portal-credentials.txt' \
      -o -name 'portal-first-run.txt' \) 2>/dev/null)

  # content scan
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    scan_file "$f" "${f#"$base"/}"
  done < <(find "$base" -type f -not -path "$base/.git/*" 2>/dev/null)
}

echo "[secret-scan] Cirrus Portal — scanning for secrets…"

case "$MODE" in
  repo)
    if ! command -v git >/dev/null 2>&1 || [ ! -d "$ROOT/.git" ]; then
      echo "[secret-scan] not a git checkout; use --all" >&2; exit 2
    fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      base="${f##*/}"
      printf '%s\n' "$base" | grep -qE "$PAT_FORBIDDEN" && flag "$f: forbidden state file is TRACKED in git"
      scan_file "$ROOT/$f" "$f"
    done < <(cd "$ROOT" && git ls-files)
    ;;
  all)
    scan_tree "$ROOT" "working tree"
    ;;
  dir)
    [ -d "$TARGET" ] || { echo "[secret-scan] not a directory: $TARGET" >&2; exit 2; }
    scan_tree "$(cd "$TARGET" && pwd)" "staged dir"
    ;;
  tar)
    [ -f "$TARGET" ] || { echo "[secret-scan] not a file: $TARGET" >&2; exit 2; }
    WORKDIR="$(mktemp -d)"
    echo "[secret-scan] extracting $TARGET…"
    tar xzf "$TARGET" -C "$WORKDIR" || { echo "[secret-scan] cannot extract $TARGET" >&2; exit 2; }
    scan_tree "$WORKDIR" "tarball $(basename "$TARGET")"
    ;;
esac

echo "[secret-scan] ─────────────────────────────────────────────"
if [ "$count" -eq 0 ]; then
  echo "[secret-scan] ✓ clean — no secrets or state files found"
  exit 0
fi
echo "[secret-scan] ✗ $count finding(s) — DO NOT SHIP"
exit 1
