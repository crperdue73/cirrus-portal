#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Cirrus Portal — release packager
#  ───────────────────────────────────────────────────────────────────────────
#  Builds a clean, versioned, reproducible, checksummed distribution tarball
#  that can be copied to any number of servers and installed with one command.
#
#    ./release.sh [version] [--tag] [--no-sign]
#
#    version     semver to build (default: VERSION file)
#    --tag       also create a local annotated git tag v<version>
#    --no-sign   skip GPG even when a signing key is configured
#
#  Produces (under dist/):
#    cirrus-portal-<version>.tar.gz            the distributable
#    cirrus-portal-<version>.sbom.json         CycloneDX SBOM
#    SHA256SUMS                                checksums (tarball + SBOM)
#    SHA256SUMS.asc                            GPG signature (when signed)
#
#  Reproducible: with SOURCE_DATE_EPOCH pinned, two builds of the same tree
#  produce a byte-identical tarball. Set it (see RELEASING.md):
#    export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
#
#  Signed checksums: set RELEASE_GPG_KEY=<key-id|email> and checksums are
#  detached-signed. Set REQUIRE_SIGN=1 to make an unsigned build fail.
#
#  The tarball contains ONLY code + installer + docs — never per-server
#  state (config, device identity, users, rooms, audit, credentials).
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

DO_TAG=0
DO_SIGN=1
ARGS=()
for a in "$@"; do
  case "$a" in
    --tag)     DO_TAG=1 ;;
    --no-sign) DO_SIGN=0 ;;
    -h|--help)
      awk 'NR>1 { if ($0 !~ /^#/ && $0 !~ /^[[:space:]]*$/) exit; sub(/^# ?/, ""); print }' "$0"
      exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done

VERSION="${ARGS[0]:-$(cat VERSION 2>/dev/null || echo 0.0.0)}"
[ -f VERSION ] && [ "$(cat VERSION)" != "$VERSION" ] && echo "$VERSION" > VERSION

PKG="cirrus-portal-$VERSION"
SBOM="$PKG.sbom.json"
STAGE="dist/stage/$PKG"
OUT="dist/$PKG.tar.gz"

# ── reproducible-build clock ───────────────────────────────────────────────
# Prefer an explicit SOURCE_DATE_EPOCH; otherwise fall back to the last commit
# time so ordinary local builds are stable too. Never "now".
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
  if git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
    SOURCE_DATE_EPOCH="$(git -C "$DIR" log -1 --format=%ct 2>/dev/null || date +%s)"
  else
    SOURCE_DATE_EPOCH="$(date +%s)"
  fi
fi
export SOURCE_DATE_EPOCH
MTIME="@$SOURCE_DATE_EPOCH"
BUILD_DATE="$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || echo "$SOURCE_DATE_EPOCH")"

# Files that ship in the distribution (code + installer + docs).
FILES=(
  install.sh
  migrate.js
  portal-server.js
  portal.html
  setup.html
  nexus.html
  healthcheck.js
  Dockerfile
  docker-compose.yml
  .dockerignore
  reconnect-test.js
  branding.json
  NAMING.md
  CHANGELOG.md
  RELEASING.md
  portal-config.example.json
  portal-secrets.example.json
  secret-scan.sh
  deploy/Caddyfile
  deploy/nginx/cirrus-portal.conf
  README.md
  ADMIN.md
  REPLICATION.md
  DEPLOYMENT.md
  UPGRADING.md
  TROUBLESHOOTING.md
  THREAT-MODEL.md
  docs/screenshots/README.md
  docs/screenshots/01-login.png
  docs/screenshots/02-agents-chat.png
  docs/screenshots/03-dashboard.png
  docs/screenshots/04-rooms.png
  docs/screenshots/05-users.png
  docs/screenshots/06-gateways.png
  docs/screenshots/07-audit.png
  docs/screenshots/08-student-view.png
  docs/screenshots/capture.js
  docs/screenshots/seed-demo.js
  LICENSE
  NOTICE
  THIRD-PARTY-NOTICES.md
  SECURITY.md
  ACCEPTABLE-USE.md
  VERSION
)

echo "[release] packaging $PKG (reproducible @ $BUILD_DATE)"

# ── sanity: required files exist ───────────────────────────────────────────
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "[release] ✗ missing file: $f" >&2; exit 1; }
done
[ -x install.sh ] || chmod +x install.sh

# ── stage ──────────────────────────────────────────────────────────────────
rm -rf dist/stage
mkdir -p "$STAGE"
for f in "${FILES[@]}"; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp -a "$f" "$STAGE/$f"
done
# Installer must be executable in the tarball.
chmod +x "$STAGE/install.sh"
# Deterministic modes for the shipped tree (cp -a can carry odd umasks).
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/install.sh" "$STAGE/secret-scan.sh"

# ── guard: no state files may leak into the package ────────────────────────
LEAKS=("$STAGE/portal-config.json" "$STAGE/portal-secrets.json" "$STAGE/portal-secrets.json.tmp"
       "$STAGE/portal-device.json" "$STAGE/portal-users.json"
       "$STAGE/portal-context.json" "$STAGE/portal-rooms.json" "$STAGE/portal-audit.log"
       "$STAGE/portal-credentials.txt" "$STAGE/portal-first-run.txt" "$STAGE/install.log" "$STAGE/portal.log")
for l in "${LEAKS[@]}"; do
  [ -e "$l" ] && { echo "[release] ✗ STATE FILE WOULD LEAK: $l — aborting" >&2; exit 1; }
done

# ── guard: no secret VALUES in the staged payload (plan item 3) ────────────
if [ -x "secret-scan.sh" ] || [ -f "secret-scan.sh" ]; then
  if ! ./secret-scan.sh --dir "$STAGE"; then
    echo "[release] ✗ secret-scan found secrets in the package — aborting" >&2
    exit 1
  fi
fi

# ── tar: reproducible (sorted, fixed mtime/owner, no gzip timestamp) ───────
mkdir -p dist
TAR_OPTS=()
# NOTE: do NOT pipe `tar --help` into `grep -q` here — with `set -o pipefail`
# grep exits early on a match, tar takes SIGPIPE (141), and the whole pipeline
# reports failure, silently dropping the reproducible flags. Match on a captured
# string instead (this bug made builds intermittently unsorted/non-reproducible).
TAR_HELP="$(tar --help 2>/dev/null || true)"
case "$TAR_HELP" in *--sort=*)   TAR_OPTS+=(--sort=name) ;; esac
case "$TAR_HELP" in *--mtime=*)  TAR_OPTS+=(--mtime="$MTIME" --owner=0 --group=0 --numeric-owner) ;; esac
tar "${TAR_OPTS[@]}" -C dist/stage -cf - "$PKG" | gzip -n -9 > "$OUT"
chmod 644 "$OUT"
rm -rf dist/stage

# ── SBOM: CycloneDX 1.5 (plan item 14) ─────────────────────────────────────
# Cirrus Portal bundles ZERO third-party source; the only external inputs are
# the pinned container base image and the Node.js runtime. Say exactly that.
BASE_IMAGE="$(awk '/^FROM /{print $2; exit}' Dockerfile)"
BASE_REF="${BASE_IMAGE%@*}"        # node:22-alpine
BASE_DIGEST="${BASE_IMAGE##*@}"    # sha256:...
BASE_NAME="${BASE_REF%%:*}"
BASE_TAG="${BASE_REF#*:}"
[ "$BASE_TAG" = "$BASE_REF" ] && BASE_TAG="latest"
NODE_MAJOR="$(printf '%s' "$BASE_TAG" | grep -oE '^[0-9]+' || echo 22)"

cat > "dist/$SBOM" <<EOF
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": {
    "timestamp": "$BUILD_DATE",
    "component": {
      "type": "application",
      "bom-ref": "pkg:generic/$PKG@$VERSION",
      "name": "Cirrus Portal",
      "version": "$VERSION",
      "supplier": { "name": "CRPerdue Technologies, LLC" },
      "licenses": [ { "license": { "id": "Apache-2.0" } } ]
    },
    "properties": [
      { "name": "cirrus:bundledThirdPartyCode", "value": "none" }
    ]
  },
  "components": [
    {
      "type": "container",
      "bom-ref": "pkg:docker/$BASE_NAME@$BASE_TAG?repository_url=docker.io",
      "name": "$BASE_NAME",
      "version": "$BASE_TAG",
      "purl": "pkg:docker/$BASE_NAME@$BASE_TAG",
      "hashes": [ { "alg": "SHA-256", "content": "${BASE_DIGEST#sha256:}" } ],
      "properties": [
        { "name": "cirrus:pinnedByDigest", "value": "$BASE_DIGEST" },
        { "name": "cirrus:redistributed", "value": "false" }
      ]
    },
    {
      "type": "platform",
      "bom-ref": "pkg:generic/node@$NODE_MAJOR",
      "name": "Node.js",
      "version": "${NODE_MAJOR}.x",
      "purl": "pkg:generic/node@$NODE_MAJOR",
      "properties": [
        { "name": "cirrus:bundled", "value": "false (provided by base image)" }
      ]
    }
  ],
  "dependencies": [
    { "ref": "pkg:generic/$PKG@$VERSION", "dependsOn": [ "pkg:docker/$BASE_NAME@$BASE_TAG?repository_url=docker.io" ] }
  ]
}
EOF
chmod 644 "dist/$SBOM"

# ── checksums + signature ──────────────────────────────────────────────────
( cd dist && sha256sum "$PKG.tar.gz" "$SBOM" > SHA256SUMS )
chmod 644 dist/SHA256SUMS

SIGNED=0
if [ "$DO_SIGN" = 1 ] && [ -n "${RELEASE_GPG_KEY:-}" ]; then
  if command -v gpg >/dev/null 2>&1; then
    rm -f dist/SHA256SUMS.asc
    gpg --batch --yes --armor --local-user "$RELEASE_GPG_KEY" \
        --detach-sign --output dist/SHA256SUMS.asc dist/SHA256SUMS
    SIGNED=1
    echo "[release] ✓ signed checksums → dist/SHA256SUMS.asc (key: $RELEASE_GPG_KEY)"
  else
    echo "[release] ⚠ RELEASE_GPG_KEY set but gpg not found — checksums UNSIGNED" >&2
  fi
fi
if [ "$SIGNED" = 0 ]; then
  if [ "${REQUIRE_SIGN:-0}" = 1 ]; then
    echo "[release] ✗ signing required (REQUIRE_SIGN=1) but no key/ gpg — aborting" >&2
    exit 1
  fi
  echo "[release] ⚠ checksums UNSIGNED — set RELEASE_GPG_KEY to sign (see RELEASING.md)" >&2
fi

# ── optional local semver tag ──────────────────────────────────────────────
if [ "$DO_TAG" = 1 ]; then
  if ! git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
    echo "[release] ⚠ --tag requested but not a git repo — skipped" >&2
  elif git -C "$DIR" rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    echo "[release] ⚠ tag v$VERSION already exists — skipped" >&2
  else
    git -C "$DIR" tag -a "v$VERSION" -m "Cirrus Portal v$VERSION"
    echo "[release] ✓ tagged v$VERSION (local only — no remote)"
  fi
fi

echo "[release] ✓ $OUT ($(du -h "$OUT" | cut -f1))"
echo "[release] ✓ SBOM → dist/$SBOM"
echo "[release] ✓ checksums → dist/SHA256SUMS"

# ── install / verify instructions ──────────────────────────────────────────
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
  gpg --verify SHA256SUMS.asc SHA256SUMS      # signed builds only
EOF
