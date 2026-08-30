#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Agent Portal — release packager
#  ───────────────────────────────────────────────────────────────────────────
#  Builds a clean, versioned, checksummed distribution tarball that can be
#  copied to any number of servers and installed with one command.
#
#    ./release.sh [version]     # e.g. ./release.sh 2.0.0  (default: VERSION)
#
#  Produces:
#    dist/agent-portal-<version>.tar.gz   — the distributable
#    dist/SHA256SUMS                      — checksums for the tarball
#
#  The tarball contains ONLY code + installer + docs — never per-server
#  state (config, device identity, users, rooms, audit, credentials).
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

VERSION="${1:-$(cat VERSION 2>/dev/null || echo 2.0.0)}"
[ -f VERSION ] && [ "$(cat VERSION)" != "$VERSION" ] && echo "$VERSION" > VERSION

PKG="agent-portal-$VERSION"
STAGE="dist/stage/$PKG"
OUT="dist/$PKG.tar.gz"

# Files that ship in the distribution (code + installer + docs).
FILES=(
  install.sh
  portal-server.js
  portal.html
  nexus.html
  Dockerfile
  docker-compose.yml
  .dockerignore
  reconnect-test.js
  README.md
  REPLICATION.md
  VERSION
)

echo "[release] packaging $PKG"

# ── sanity: required files exist ───────────────────────────────────────────
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "[release] ✗ missing file: $f" >&2; exit 1; }
done
[ -x install.sh ] || chmod +x install.sh

# ── stage ──────────────────────────────────────────────────────────────────
rm -rf dist/stage
mkdir -p "$STAGE"
for f in "${FILES[@]}"; do
  cp -a "$f" "$STAGE/"
done
# Installer must be executable in the tarball.
chmod +x "$STAGE/install.sh"

# ── guard: no state files may leak into the package ────────────────────────
LEAKS=("$STAGE/portal-config.json" "$STAGE/portal-device.json" "$STAGE/portal-users.json"
       "$STAGE/portal-context.json" "$STAGE/portal-rooms.json" "$STAGE/portal-audit.log"
       "$STAGE/portal-credentials.txt" "$STAGE/install.log" "$STAGE/portal.log")
for l in "${LEAKS[@]}"; do
  [ -e "$l" ] && { echo "[release] ✗ STATE FILE WOULD LEAK: $l — aborting" >&2; exit 1; }
done

# ── tar + checksums ────────────────────────────────────────────────────────
mkdir -p dist
tar czf "$OUT" -C dist/stage "$PKG"
chmod 644 "$OUT"
( cd dist && sha256sum "$PKG.tar.gz" > SHA256SUMS )

echo "[release] ✓ $OUT ($(du -h "$OUT" | cut -f1))"
echo "[release] ✓ checksums → dist/SHA256SUMS"
rm -rf dist/stage

# ── install instructions ───────────────────────────────────────────────────
cat <<EOF

[release] Install on another server (pick one):

  # via scp/rsync:
  scp $OUT user@server:/tmp/
  ssh user@server 'cd /tmp && tar xzf $PKG.tar.gz && cd $PKG && ./install.sh install'

  # then, on that server:
  ./install.sh status        # health check
  ./install.sh backup        # snapshot state+config

[release] Verify the package:
  cd dist && sha256sum -c SHA256SUMS
EOF
