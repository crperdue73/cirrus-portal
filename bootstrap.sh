#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Cirrus Portal — per-server bootstrap installer
# ═══════════════════════════════════════════════════════════════════════════
# One command to stand up a fresh portal instance on a new server.
#
#   ./bootstrap.sh                       # install (config from env or prompts)
#   GATEWAY_TOKEN=... PORTAL_PASSWORD=... ./bootstrap.sh --fresh
#   ./bootstrap.sh --approve             # approve this portal's device on the gateway
#   ./bootstrap.sh --verify              # health-check an existing install
#
# Design rules (see REPLICATION.md):
#   • Code files are copied; state files are NEVER copied between servers.
#   • portal-config.json is written once per server (0600) and is TOKEN-FREE.
#     The gateway token + bootstrap admin password live in portal-secrets.json
#     (0600) — never in config, backups, or release tarballs.
#   • portal-device.json is generated fresh per server by the app on first
#     boot. --fresh deletes it so the gateway gets a clean device identity.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# ── defaults ────────────────────────────────────────────────────────────────
PORT="${PORT:-18800}"
BIND="${BIND:-127.0.0.1}"   # safe default (plan item 7): loopback only
GATEWAY_URL="${GATEWAY_URL:-ws://127.0.0.1:18790}"
SESSION_TTL_HOURS="${SESSION_TTL_HOURS:-12}"
CONFIG_FILE="portal-config.json"
DEVICE_FILE="portal-device.json"
FORCE_CONFIG=0
FRESH=0
APPROVE=0
VERIFY=0
DO_FIREWALL=0

usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [options]

Install / manage a Cirrus Portal instance on THIS server.

Options:
  --fresh          Wipe local state (device identity, users, rooms, audit,
                   context) before install. Use on a NEW server, or to
                   factory-reset. NEVER run against a production box you
                   want to keep.
  --force-config   Overwrite portal-config.json with env values even if it
                   exists.
  --approve        Approve this portal's pending device request on the local
                   OpenClaw gateway (grants the scopes the portal asked for).
                   Safe: only approves if the pending device id matches this
                   server's portal-device.json.
  --verify         Health-check an existing install (container, gateway
                   reachability, HTTP response).
  --firewall       Open the portal port in ufw (when ufw is active).
  -h, --help       Show this help.

Env (for non-interactive installs):
  GATEWAY_TOKEN      The target server's OpenClaw gateway token (required on
                     first install; MUST match gateway.auth.token).
  PORTAL_PASSWORD    Browser login password for the admin account. If unset on
                     first install, a strong UNIQUE one is generated and saved
                     to portal-credentials.txt (0600) on the server — there is
                     no shipped default login.
  PORT / BIND / GATEWAY_URL / SESSION_TTL_HOURS  (optional overrides)

  Safe defaults (plan item 7): the portal binds 127.0.0.1 (loopback) so a
  fresh install is never exposed by accident. To expose a non-loopback
  interface, set BIND explicitly (e.g. BIND=0.0.0.0) — the server then also
  requires PORTAL_PUBLIC_BIND=1 and refuses cleartext unless you add TLS or
  --insecure-plaintext.

Examples:
  GATEWAY_TOKEN=abc123 ./bootstrap.sh
  GATEWAY_TOKEN=abc123 PORTAL_PASSWORD='hunter2!' ./bootstrap.sh --fresh
  GATEWAY_TOKEN=abc123 ./bootstrap.sh --firewall
  ./bootstrap.sh --approve
  ./bootstrap.sh --verify
EOF
}

for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    --approve) APPROVE=1 ;;
    --verify) VERIFY=1 ;;
    --firewall) DO_FIREWALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m[portal]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[portal!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[portal!]\033[0m %s\n' "$*" >&2; exit 1; }

# Strong, unique password for first-run admin seeding (no shipped default).
gen_password() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 24 | tr -d '/+=' | head -c 24
  elif [ -r /dev/urandom ]; then head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 24
  else echo "CHANGE-ME-$(date +%s)"; fi
}

# is_loopback_bind ADDR → 0 when the address is host-local only (plan item 7).
is_loopback_bind() {
  case "$(printf '%s' "${1:-}" | tr -d '[]' | tr 'A-Z' 'a-z')" in
    127.*|::1|localhost) return 0 ;;
    *) return 1 ;;
  esac
}

# open_firewall — best-effort ufw helper. Only acts when ufw is active; never
# fails the install over a missing/blocked firewall (plan item 7).
open_firewall() {
  local port="$PORT"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    if sudo ufw allow "$port/tcp" >/dev/null 2>&1; then
      log "ufw: allowed $port/tcp"
    else
      warn "ufw rule failed — add manually: sudo ufw allow $port/tcp"
    fi
  else
    warn "--firewall given but ufw is not active/installed — add the rule manually: sudo ufw allow $port/tcp"
  fi
}

# ── mode: --approve ─────────────────────────────────────────────────────────
if [ "$APPROVE" = "1" ]; then
  [ -f "$DEVICE_FILE" ] || die "no $DEVICE_FILE — start the portal first (./bootstrap.sh)"
  DEVICE_ID="$(python3 -c "import json;print(json.load(open('$DEVICE_FILE'))['deviceId'])" 2>/dev/null \
    || node -e "console.log(require('./$DEVICE_FILE').deviceId)" 2>/dev/null)" \
    || die "cannot read deviceId from $DEVICE_FILE"
  log "this portal's device id: $DEVICE_ID"
  command -v openclaw >/dev/null 2>&1 || die "'openclaw' CLI not found on this server — run approval from the gateway host"

  log "listing pending device requests…"
  openclaw devices list || true

  # Match our device id to a pending request (safe approval, never --latest blindly).
  REQ_ID="$(openclaw devices list --json 2>/dev/null \
    | python3 -c "
import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    sys.exit(1)
dev='$DEVICE_ID'
def walk(o):
    if isinstance(o,dict):
        if o.get('deviceId')==dev or o.get('device',{}).get('id')==dev or o.get('id')==dev:
            rid=o.get('requestId') or o.get('request') or o.get('pairingId')
            if rid: return rid
        for v in o.values():
            r=walk(v)
            if r: return r
    elif isinstance(o,list):
        for v in o:
            r=walk(v)
            if r: return r
    return None
print(walk(data) or '')
" 2>/dev/null || true)"

  if [ -z "$REQ_ID" ]; then
    warn "no pending request matching device $DEVICE_ID"
    warn "if the gateway approved it already, the portal should connect on its next retry"
    warn "manual:  openclaw devices list   →   openclaw devices approve <requestId>"
    exit 1
  fi
  log "approving request $REQ_ID for device $DEVICE_ID (grants the scopes the portal requested)"
  openclaw devices approve "$REQ_ID"
  log "approved. The portal reconnects automatically (exponential backoff, ≤30s)."
  exit 0
fi

# ── mode: --verify ──────────────────────────────────────────────────────────
if [ "$VERIFY" = "1" ]; then
  log "container:"
  docker ps --format '  {{.Names}}  {{.Status}}  {{.Ports}}' | grep -E 'cirrus-portal|agent-portal' || true
  log "gateway reachability (127.0.0.1:18790):"
  if timeout 2 bash -c "</dev/tcp/127.0.0.1/18790" 2>/dev/null; then
    log "  ✓ gateway socket open"
  else
    warn "  ✗ gateway socket NOT reachable — is the OpenClaw gateway running?"
  fi
  PORT_CFG="$(python3 -c "import json;print(json.load(open('$CONFIG_FILE')).get('port',18800))" 2>/dev/null || echo 18800)"
  log "portal HTTP (port $PORT_CFG):"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT_CFG/" || true)"
  case "$code" in
    200|302|401) log "  ✓ HTTP $code — portal is up" ;;
    *) warn "  ✗ no HTTP response on :$PORT_CFG (got '$code') — check 'docker compose logs'" ;;
  esac
  log "hint: if the UI shows no agents, approve the device → ./bootstrap.sh --approve"
  exit 0
fi

# ── fresh reset ─────────────────────────────────────────────────────────────
if [ "$FRESH" = "1" ]; then
  warn "wiping local state: device, users, rooms, audit, context, logs, credentials, secrets"
  rm -f portal-device.json portal-users.json portal-rooms.json portal-context.json portal-audit.log portal.log portal-first-run.txt portal-credentials.txt portal-secrets.json
fi

# ── config ──────────────────────────────────────────────────────────────────
NEED_TOKEN=0
if [ ! -f "$CONFIG_FILE" ] || [ "$FORCE_CONFIG" = "1" ]; then
  NEED_TOKEN=1
fi

if [ "$NEED_TOKEN" = "1" ] && [ -z "${GATEWAY_TOKEN:-}" ]; then
  die "GATEWAY_TOKEN is required for first install.
  Set it to THIS server's OpenClaw gateway token (gateway.auth.token in the
  gateway config — NOT another server's token)."
fi

# Keep existing values when not forcing, fill from env otherwise.
if [ ! -f "$CONFIG_FILE" ] || [ "$FORCE_CONFIG" = "1" ]; then
  PORTAL_PASSWORD="${PORTAL_PASSWORD:-}"
  GENERATED_PW=0
  if [ -z "$PORTAL_PASSWORD" ]; then
    # No shipped default: mint a strong, unique admin password. The server
    # seeds the admin account with this value on first boot — never admin/admin.
    PORTAL_PASSWORD="$(gen_password)"
    GENERATED_PW=1
    log "no PORTAL_PASSWORD given — generated a strong unique admin password"
  fi
  umask 177
  cat > "$CONFIG_FILE" <<EOF
{
  "port": $PORT,
  "bind": "$BIND",
  "publicBind": $(is_loopback_bind "$BIND" && echo false || echo true),
  "gatewayUrl": "$GATEWAY_URL",
  "sessionTtlHours": $SESSION_TTL_HOURS
}
EOF
  chmod 600 "$CONFIG_FILE"
  log "wrote $CONFIG_FILE (0600 — token-free)"
  # Gateway token + bootstrap admin password → dedicated 0600 secrets file
  # (never in config/backups/tarballs). Legacy single-gateway id is "gw1".
  cat > portal-secrets.json <<EOF
{
  "gatewayTokens": {
    "gw1": "$GATEWAY_TOKEN"
  },
  "portalPassword": "$PORTAL_PASSWORD"
}
EOF
  chmod 600 portal-secrets.json
  log "wrote portal-secrets.json (0600) — gateway token + bootstrap admin password"
  # Save first-run credentials so the deployer can log in (0600).
  cat > portal-credentials.txt <<EOF
# $APP_NAME — install credentials  ($(date -Is))
url:      http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT/
user:     admin
password: $PORTAL_PASSWORD
EOF
  chmod 600 portal-credentials.txt
  [ "$GENERATED_PW" = "1" ] && warn "admin password generated → saved to portal-credentials.txt (0600) — CHANGE IT after first login"
else
  log "$CONFIG_FILE exists — keeping it (use --force-config to rewrite)"
fi

# ── state files ─────────────────────────────────────────────────────────────
# Pre-create the bind-mounted state files so Docker mounts them as FILES.
# A missing host path makes Docker create a DIRECTORY at that path, which
# silently breaks the server's write-on-boot seeding (device/users/context).
for f in portal-device.json portal-users.json portal-context.json portal-rooms.json portal-audit.log portal-secrets.json; do
  if [ ! -f "$f" ]; then
    if [ "$f" = "portal-secrets.json" ]; then printf '{}\n' > "$f"; else : > "$f"; fi
    chmod 600 "$f"
    log "pre-created $f"
  fi
done

# ── container ownership (plan item 8) ───────────────────────────────────────
# The image runs as the unprivileged portal user (uid:gid 10001). Bind-mounted
# state must be owned by that id or the non-root server can't read/write it.
if [ "$(id -u)" = "0" ]; then
  if chown 10001:10001 "$CONFIG_FILE" portal-secrets.json portal-device.json \
       portal-users.json portal-context.json portal-rooms.json portal-audit.log 2>/dev/null; then
    log "state files owned by container user 10001:10001"
  else
    warn "could not chown state files to 10001:10001"
  fi
else
  warn "not running as root — the non-root container may not be able to read the state files"
  warn "  fix: sudo chown 10001:10001 $(printf '%s ' "$CONFIG_FILE" portal-secrets.json portal-device.json portal-users.json portal-context.json portal-rooms.json portal-audit.log)"
fi

# ── preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found — install Docker + compose plugin first"
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"
log "gateway reachability preflight…"
if timeout 2 bash -c "</dev/tcp/127.0.0.1/18790" 2>/dev/null; then
  log "  ✓ gateway socket open on 127.0.0.1:18790"
else
  warn "  ✗ no gateway on 127.0.0.1:18790 — the portal will retry, but approve/verify the"
  warn "    OpenClaw gateway first (it must run with token auth + loopback bind)."
fi

# ── build + start ───────────────────────────────────────────────────────────
if ! is_loopback_bind "$BIND"; then
  warn "public bind requested: BIND=$BIND — this exposes the portal off-host."
  warn "  the server will also refuse cleartext: add TLS (--domain/--tls-cert) or PORTAL_INSECURE_PLAINTEXT=1 (LAN/tunnel only)."
fi
if [ "$DO_FIREWALL" = "1" ]; then open_firewall; fi
log "building and starting the portal container…"
docker compose up -d --build

# ── report ──────────────────────────────────────────────────────────────────
log "portal started."
if [ -f "$DEVICE_FILE" ]; then
  DEVICE_ID="$(python3 -c "import json;print(json.load(open('$DEVICE_FILE'))['deviceId'])" 2>/dev/null \
    || node -e "console.log(require('./$DEVICE_FILE').deviceId)" 2>/dev/null || echo '?')"
  log "device identity: $DEVICE_ID"
fi
log "next steps:"
log "  1. Approve the portal's device on the gateway:   ./bootstrap.sh --approve"
log "     (or manually: openclaw devices list && openclaw devices approve <requestId>)"
log "  2. Open the portal:  http://$(hostname -I 2>/dev/null | awk '{print $1}')$([ "$PORT" = "80" ] && echo "/" || echo ":$PORT/")"
if [ -n "${PORTAL_PASSWORD:-}" ]; then
  log "     admin login: admin / $PORTAL_PASSWORD   (also in portal-credentials.txt)"
  [ "${GENERATED_PW:-0}" = "1" ] && log "     ⚠ generated password — change it after first login (Users → reset pw)"
else
  log "     admin login: existing admin account (credentials unchanged)"
fi
log "  3. Sanity check:      ./bootstrap.sh --verify"
