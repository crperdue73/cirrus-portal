#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Agent Portal — professional installer v2
#  ───────────────────────────────────────────────────────────────────────────
#  One command to stand up a polished, hardened Agent Portal instance on any
#  Debian/Ubuntu-class server that already runs an OpenClaw gateway.
#
#    ./install.sh install             # detect → configure → build → run
#    ./install.sh status              # health check (scriptable)
#    ./install.sh doctor              # deep diagnostics
#    ./install.sh upgrade             # pull new code, rebuild, keep state
#    ./install.sh backup              # state + config snapshot tarball
#    ./install.sh restore FILE        # restore a snapshot
#    ./install.sh uninstall           # stop + remove container (keeps files)
#
#  Design rules (see REPLICATION.md):
#    • Code files are copied between servers; state files NEVER are.
#    • portal-config.json is written once per server (0600). Never clobbered
#      unless --force-config is passed.
#    • portal-device.json is generated fresh per server by the app on first
#      boot, and must be approved on THAT server's gateway.
#    • The gateway token in portal-config.json MUST equal the target server's
#      own gateway token (gateway.auth.token) — auto-detected when possible.
#    • Idempotent: re-running install on a healthy box changes nothing
#      except (optionally) rebuilding the image.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── version ─────────────────────────────────────────────────────────────────
VERSION="2.0.0"
APP_NAME="Agent Portal"

# ── paths ───────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
CONFIG_FILE="portal-config.json"
DEVICE_FILE="portal-device.json"
USERS_FILE="portal-users.json"
CONTEXT_FILE="portal-context.json"
ROOMS_FILE="portal-rooms.json"
AUDIT_FILE="portal-audit.log"
LOG_FILE="install.log"
CRED_FILE="portal-credentials.txt"
STATE_FILES=("$DEVICE_FILE" "$USERS_FILE" "$CONTEXT_FILE" "$ROOMS_FILE" "$AUDIT_FILE")
CONTAINER_NAME="agent-portal"
GATEWAY_HOST="127.0.0.1"
GATEWAY_PORT="18790"

# ── flags / env ─────────────────────────────────────────────────────────────
PORT="${PORT:-18800}"
BIND="${BIND:-0.0.0.0}"
GATEWAY_URL="${GATEWAY_URL:-ws://$GATEWAY_HOST:$GATEWAY_PORT}"
SESSION_TTL_HOURS="${SESSION_TTL_HOURS:-12}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"
PORTAL_PASSWORD="${PORTAL_PASSWORD:-}"
GATEWAY_ID="${GATEWAY_ID:-home}"
GATEWAY_NAME="${GATEWAY_NAME:-Home}"

CMD=""
FRESH=0
FORCE_CONFIG=0
DO_APPROVE=1
DO_FIREWALL=0
YES=0
DRY_RUN=0
PURGE=0

# ── colors / logging ────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_BLU=$'\033[1;34m'; C_GRN=$'\033[1;32m'; C_YEL=$'\033[1;33m'
  C_RED=$'\033[1;31m'; C_CYN=$'\033[1;36m'; C_RST=$'\033[0m'
else
  C_BLU=""; C_GRN=""; C_YEL=""; C_RED=""; C_CYN=""; C_RST=""
fi

log()  { printf '%s[%s]%s %s\n' "$C_BLU" "$APP_NAME" "$C_RST" "$*" | tee -a "$LOG_FILE"; }
ok()   { printf '%s[✓]%s %s\n' "$C_GRN" "$C_RST" "$*" | tee -a "$LOG_FILE"; }
info() { printf '%s[·]%s %s\n' "$C_CYN" "$C_RST" "$*" | tee -a "$LOG_FILE"; }
warn() { printf '%s[!]%s %s\n' "$C_YEL" "$C_RST" "$*" | tee -a "$LOG_FILE"; }
die()  { printf '%s[✗]%s %s\n' "$C_RED" "$C_RST" "$*" >&2 | tee -a "$LOG_FILE" >&2; exit 1; }

# ── usage ───────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
$C_BLU$APP_NAME installer v$VERSION$C_RST — professional install for OpenClaw agent portals

$C_CYN Usage:$C_RST
  ./install.sh <command> [options]

$C_CYN Commands:$C_RST
  install     Detect, configure, build and run the portal (default).
              Safe to re-run — existing state and config are kept.
  upgrade     Rebuild the container from current code, keep all state.
  status      Health check. Exit 0 = healthy, 1 = problems. Scriptable.
  doctor      Deep diagnostics (status + config, device, logs, disk).
  backup      Create a state+config snapshot tarball in ./backups/.
  restore F   Restore state+config from a backup tarball.
  uninstall   Stop and remove the container (files kept unless --purge).
  version     Print version and exit.

$C_CYN Options:$C_RST
  --fresh           Wipe local state (device, users, rooms, audit, context)
                    before install. For NEW servers / factory reset.
  --force-config    Rewrite portal-config.json from env even if it exists.
  --no-approve      Skip the device-approval step on the gateway.
  --firewall        Open the portal port in ufw (if ufw is active).
  --purge           With uninstall: also delete config, state, credentials.
  --dry-run         Print what install would do, change nothing.
  -y, --yes         Assume yes for all prompts.
  -h, --help        Show this help.

$C_CYN Env:$C_RST
  GATEWAY_TOKEN      This server's OpenClaw gateway token. Auto-detected
                     from ~/.openclaw/openclaw.json when not set.
  PORTAL_PASSWORD    Admin login password. On a FRESH install a strong
                     random one is generated and saved to portal-credentials.txt
                     if you don't provide one.
  PORT / BIND / GATEWAY_URL / SESSION_TTL_HOURS
  GATEWAY_ID / GATEWAY_NAME   (gateway list entry; defaults home/Home)

$C_CYN Examples:$C_RST
  ./install.sh install --fresh
  GATEWAY_TOKEN=abc123 PORTAL_PASSWORD='hunter2!' ./install.sh install --fresh --firewall
  ./install.sh status
  ./install.sh backup
EOF
}

# ── helpers ─────────────────────────────────────────────────────────────────
have()  { command -v "$1" >/dev/null 2>&1; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }

gen_password() {
  if have openssl; then openssl rand -base64 24 | tr -d '/+=' | head -c 32
  elif [ -r /dev/urandom ]; then head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32
  else echo "CHANGE-ME-$(date +%s)"; fi
}

# Detect the docker invocation we can use (docker group, or sudo).
detect_docker() {
  SUDO_CMD=()
  if docker info >/dev/null 2>&1; then
    DOCKER="docker"
  elif sudo -n docker info >/dev/null 2>&1; then
    SUDO_CMD=(sudo -n); DOCKER="docker"
  elif sudo docker info >/dev/null 2>&1; then
    SUDO_CMD=(sudo); DOCKER="docker"
  else
    die "docker is not usable by this user (tried directly and via sudo)."
  fi
  "${SUDO_CMD[@]}" docker compose version >/dev/null 2>&1 \
    || die "docker compose plugin (v2) is required: ${SUDO_CMD[*]:-}docker compose version"
}

docker_ps()  { "${SUDO_CMD[@]}" docker ps --filter "name=$CONTAINER_NAME" "$@"; }
compose()    { "${SUDO_CMD[@]}" docker compose "$@"; }

# Read a JSON value portably (python3 → node → grep fallback).
json_get() { # json_get FILE key
  local f="$1" k="$2"
  if have python3; then
    python3 -c "import json,sys;print(json.load(open('$f')).get('$k',''))" 2>/dev/null || true
  elif have node; then
    node -e "console.log(require('$f').$k ?? '')" 2>/dev/null || true
  fi
}

# ── argument parsing ────────────────────────────────────────────────────────
ARGS=("$@")
for arg in "$@"; do
  case "$arg" in
    install|upgrade|status|doctor|backup|restore|uninstall|version) CMD="$arg" ;;
    --fresh) FRESH=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    --no-approve) DO_APPROVE=0 ;;
    --firewall) DO_FIREWALL=1 ;;
    --purge) PURGE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    --*) die "unknown option: $arg (see --help)" ;;
    *) if [ "$CMD" = "restore" ] && [ -z "${RESTORE_FILE:-}" ]; then RESTORE_FILE="$arg";
       else die "unknown argument: $arg (see --help)"; fi ;;
  esac
done
[ -z "$CMD" ] && CMD="install"
if [ "$CMD" = "restore" ] && [ -z "${RESTORE_FILE:-}" ]; then
  die "restore requires a backup file:  ./install.sh restore ./backups/portal-backup-XXXX.tar.gz"
fi

# Every command logs to install.log.
: > "$LOG_FILE" 2>/dev/null || true
chmod 600 "$LOG_FILE" 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════════════════
#  version
# ═══════════════════════════════════════════════════════════════════════════
if [ "$CMD" = "version" ]; then
  echo "$VERSION"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
#  status / doctor — read-only health
# ═══════════════════════════════════════════════════════════════════════════
run_status() {
  local fails=0
  local port_cfg
  port_cfg="$(json_get "$CONFIG_FILE" port)"; [ -n "$port_cfg" ] || port_cfg="$PORT"

  log "── $APP_NAME status ─────────────────────────────"
  # container
  if docker_ps --format '{{.Names}} {{.Status}}' | grep -q "$CONTAINER_NAME"; then
    ok "container $CONTAINER_NAME is up ($(docker_ps --format '{{.Status}}' | head -1))"
  else
    warn "container $CONTAINER_NAME is NOT running"; fails=$((fails+1))
  fi
  # gateway socket
  if timeout 2 bash -c "</dev/tcp/$GATEWAY_HOST/$GATEWAY_PORT" 2>/dev/null; then
    ok "gateway socket open on $GATEWAY_HOST:$GATEWAY_PORT"
  else
    warn "gateway socket NOT reachable on $GATEWAY_HOST:$GATEWAY_PORT"; fails=$((fails+1))
  fi
  # http
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port_cfg/" || true)"
  case "$code" in
    200|302|401) ok "portal answering HTTP on :$port_cfg (code $code)" ;;
    *) warn "no HTTP response on :$port_cfg (got '$code')"; fails=$((fails+1)) ;;
  esac
  # device identity
  if [ -s "$DEVICE_FILE" ]; then
    ok "device identity present ($(json_get "$DEVICE_FILE" deviceId | head -c 12)…)"
  else
    warn "no device identity yet — portal may not have booted once"; fails=$((fails+1))
  fi
  # admin account
  if [ -s "$USERS_FILE" ] && grep -q '"role"[[:space:]]*:[[:space:]]*"admin"' "$USERS_FILE" 2>/dev/null; then
    ok "admin account present in $USERS_FILE"
  else
    warn "no admin account found (fresh install seeds it on first boot)"; fails=$((fails+1))
  fi
  # approval (best effort — only if openclaw CLI exists)
  if have openclaw && [ -s "$DEVICE_FILE" ]; then
    local dev
    dev="$(json_get "$DEVICE_FILE" deviceId)"
    if openclaw devices list --json 2>/dev/null | grep -q "$dev"; then
      ok "device is known to the gateway (pairing flow in progress or approved)"
    else
      warn "device $dev not found in gateway pairing list — run: ./install.sh install --approve"
    fi
  fi
  log "─────────────────────────────────────────────────"
  if [ "$fails" -gt 0 ]; then
    warn "$fails check(s) failed — run ./install.sh doctor for details"
    return 1
  fi
  ok "all checks passed."
  return 0
}

run_doctor() {
  local fails=0
  log "── $APP_NAME doctor ─────────────────────────────"
  # host
  if [ "$(id -u)" = "0" ]; then warn "running as root (works, but a dedicated user is cleaner)"; fi
  if have python3; then ok "python3 present"; else warn "python3 missing (harmless, node fallback used)"; fi
  # docker
  if docker_ps --format '{{.Names}}' >/dev/null 2>&1; then ok "docker usable"; else warn "docker NOT usable"; fails=$((fails+1)); fi
  # disk
  local free_mb
  free_mb="$(df -Pm . | awk 'NR==2{print $4}')"
  if [ "${free_mb:-0}" -gt 500 ]; then ok "disk: ${free_mb} MB free"; else warn "low disk: ${free_mb} MB free"; fi
  # config
  if [ -f "$CONFIG_FILE" ]; then
    local mode; mode="$(stat -c %a "$CONFIG_FILE" 2>/dev/null || echo '?')"
    ok "config present (mode $mode)"
    [ "$mode" = "600" ] || warn "config mode is $mode — expected 600"
    if grep -q "REPLACE_WITH_GATEWAY_TOKEN\|REPLACE_ME" "$CONFIG_FILE" 2>/dev/null; then
      warn "config still contains placeholder tokens"; fails=$((fails+1))
    fi
    if grep -q '"gatewayToken": ""' "$CONFIG_FILE" 2>/dev/null; then
      warn "config gateway token is EMPTY — agents will not connect"; fails=$((fails+1))
    fi
  else
    warn "no config — run ./install.sh install"; fails=$((fails+1))
  fi
  # state files
  for f in "${STATE_FILES[@]}"; do
    [ -e "$f" ] || warn "state file missing: $f"
  done
  # container + logs
  if docker_ps --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
    ok "container running"
    local crash
    crash="$(compose logs --tail 300 2>/dev/null | grep -E 'uncaught|FATAL|EADDRINUSE|TypeError|ReferenceError|Cannot find module|throw new' || true)"
    if [ -n "$crash" ]; then
      warn "crash signature(s) found in the last 300 log lines:"
      echo "$crash" | tail -3 | sed 's/^/      /'
    else
      ok "no crash signatures in the last 300 log lines (retry/reconnect noise is normal)"
    fi
  else
    warn "container not running — run ./install.sh install"; fails=$((fails+1))
  fi
  # gateway
  if timeout 2 bash -c "</dev/tcp/$GATEWAY_HOST/$GATEWAY_PORT" 2>/dev/null; then
    ok "gateway socket open"
  else
    warn "gateway socket closed — start the OpenClaw gateway first"; fails=$((fails+1))
  fi
  # port
  if port_in_use "$(json_get "$CONFIG_FILE" port || echo "$PORT")"; then
    ok "portal port is bound"
  else
    warn "portal port not bound (container down?)"
  fi
  # audit trail
  [ -s "$AUDIT_FILE" ] && ok "audit log has $(wc -l < "$AUDIT_FILE") entries" || info "audit log empty (no logins yet)"
  log "─────────────────────────────────────────────────"
  if [ "$fails" -gt 0 ]; then warn "$fails problem(s) found"; return 1; fi
  ok "no problems found."
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════
#  backup / restore
# ═══════════════════════════════════════════════════════════════════════════
run_backup() {
  mkdir -p backups
  local stamp out
  stamp="$(date +%Y%m%d-%H%M%S)"
  out="backups/portal-backup-$stamp.tar.gz"
  local files=("$CONFIG_FILE" "${STATE_FILES[@]}" "$CRED_FILE")
  local existing=()
  for f in "${files[@]}"; do [ -e "$f" ] && existing+=("$f"); done
  if [ "${#existing[@]}" -eq 0 ]; then die "nothing to back up"; fi
  tar czf "$out" "${existing[@]}"
  chmod 600 "$out"
  ok "backup written: $out ($(du -h "$out" | cut -f1))"
  log "restore with: ./install.sh restore $out"
}

run_restore() {
  local f="$RESTORE_FILE"
  [ -f "$f" ] || die "backup file not found: $f"
  [ "$YES" = "1" ] || {
    read -r -p "Restore will OVERWRITE current config + state. Continue? [y/N] " ans
    case "$ans" in y|Y) ;; *) die "aborted." ;; esac
  }
  tar xzf "$f"
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  for s in "${STATE_FILES[@]}"; do chmod 600 "$s" 2>/dev/null || true; done
  ok "restored from $f"
  log "rebuilding container with restored config…"
  detect_docker
  compose up -d --build
  ok "done. Run ./install.sh status to confirm."
}

# ═══════════════════════════════════════════════════════════════════════════
#  uninstall
# ═══════════════════════════════════════════════════════════════════════════
run_uninstall() {
  detect_docker
  if docker_ps --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
    [ "$YES" = "1" ] || {
      read -r -p "Stop and remove the $CONTAINER_NAME container? (state files kept) [y/N] " ans
      case "$ans" in y|Y) ;; *) die "aborted." ;; esac
    }
    compose down --remove-orphans
    ok "container stopped and removed"
  else
    info "no running container to remove"
  fi
  if [ "$PURGE" = "1" ]; then
    [ "$YES" = "1" ] || {
      read -r -p "DELETE all config, state and credentials in $DIR? This cannot be undone. [y/N] " ans
      case "$ans" in y|Y) ;; *) warn "purge aborted — files kept."; exit 0 ;; esac
    }
    rm -f "$CONFIG_FILE" "${STATE_FILES[@]}" "$CRED_FILE" "$LOG_FILE"
    ok "purged local files (code left in place)"
  else
    info "files kept. To also delete them: ./install.sh uninstall --purge -y"
  fi
  ok "uninstall complete."
}

# ═══════════════════════════════════════════════════════════════════════════
#  install / upgrade
# ═══════════════════════════════════════════════════════════════════════════

# Auto-detect the gateway token from the local OpenClaw install.
detect_gateway_token() {
  local candidates=("$HOME/.openclaw/openclaw.json" "/etc/openclaw/openclaw.json" "/root/.openclaw/openclaw.json")
  for p in "${candidates[@]}"; do
    [ -r "$p" ] || continue
    local t
    if have python3; then
      t="$(python3 -c "
import json,sys
try:
    d=json.load(open('$p'))
    print((d.get('gateway') or {}).get('auth') or {}).get('token') or ''
except Exception:
    print('')
" 2>/dev/null || true)"
    else
      t="$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$p" | head -1 | cut -d'"' -f4 || true)"
    fi
    if [ -n "$t" ]; then GATEWAY_TOKEN="$t"; log "gateway token auto-detected from $p"; return 0; fi
  done
  return 1
}

# Does the users file already contain an admin? (protects existing installs)
users_have_admin() {
  [ -s "$USERS_FILE" ] || return 1
  grep -q '"role"[[:space:]]*:[[:space:]]*"admin"' "$USERS_FILE" 2>/dev/null
}

# Set the admin password through the real API (login → reset).
set_admin_password() {
  local old="$1" new="$2" tries=0
  local jar; jar="$(mktemp)"
  local port_cfg; port_cfg="$(json_get "$CONFIG_FILE" port)"; port_cfg="${port_cfg:-$PORT}"
  while [ "$tries" -lt 10 ]; do
    tries=$((tries+1))
    if curl -s --max-time 5 -c "$jar" -H 'Content-Type: application/json' \
        -d "{\"username\":\"admin\",\"password\":\"$old\"}" \
        "http://127.0.0.1:$port_cfg/api/login" | grep -q '"authed":true\|"role"'; then
      break
    fi
    sleep 3
  done
  if curl -s --max-time 5 -b "$jar" -H 'Content-Type: application/json' \
      -d "{\"password\":\"$new\"}" \
      "http://127.0.0.1:$port_cfg/api/users/admin/password" | grep -q '"ok":true\|"reset"'; then
    rm -f "$jar"; return 0
  fi
  rm -f "$jar"; return 1
}

run_install() {
  detect_docker

  # ── dry-run gate (BEFORE any destructive step) ─────────────────────────
  if [ "$DRY_RUN" = "1" ]; then
    local cur_port="$PORT"
    [ -f "$CONFIG_FILE" ] && cur_port="$(json_get "$CONFIG_FILE" port)" && [ -n "$cur_port" ] || cur_port="$PORT"
    info "dry-run — no changes will be made."
    log "config:   port $cur_port, bind $BIND, gateway $GATEWAY_URL"
    log "token:    ${GATEWAY_TOKEN:+provided / auto-detected}${GATEWAY_TOKEN:-<will auto-detect from gateway config>}"
    log "actions:  write config ($([ "$FORCE_CONFIG" = "1" ] || [ ! -f "$CONFIG_FILE" ] && echo yes || echo no)) · wipe state ($([ "$FRESH" = "1" ] && echo yes || echo no))"
    log "          build+start container · set admin password (fresh only) · approve device ($([ "$DO_APPROVE" = "1" ] && echo yes || echo no)) · firewall ($([ "$DO_FIREWALL" = "1" ] && echo yes || echo no))"
    return 0
  fi

  # ── fresh reset ─────────────────────────────────────────────────────────
  if [ "$FRESH" = "1" ]; then
    warn "wiping local state: device, users, rooms, audit, context, credentials"
    rm -f "$DEVICE_FILE" "$USERS_FILE" "$CONTEXT_FILE" "$ROOMS_FILE" "$AUDIT_FILE" "$CRED_FILE"
  fi

  # ── preflight ───────────────────────────────────────────────────────────
  log "── preflight ────────────────────────────────────"
  if grep -qiE 'debian|ubuntu' /etc/os-release 2>/dev/null; then
    ok "host OS: $(. /etc/os-release && echo "$PRETTY_NAME")"
  else
    warn "host is not Debian/Ubuntu — install may still work, but it's untested"
  fi
  local free_mb; free_mb="$(df -Pm . | awk 'NR==2{print $4}')"
  if [ "${free_mb:-0}" -gt 500 ]; then ok "disk: ${free_mb} MB free"; else die "need >500 MB free disk (have ${free_mb:-?} MB)"; fi
  if [ "$FRESH" = "0" ] && [ -f "$CONFIG_FILE" ] && [ "$FORCE_CONFIG" = "0" ]; then
    ok "existing config found — will keep it (--force-config to rewrite)"
  fi

  # gateway token
  if [ -z "$GATEWAY_TOKEN" ]; then
    if detect_gateway_token; then
      :
    else
      die "GATEWAY_TOKEN not set and could not auto-detect it.
  Set it to THIS server's gateway token:  GATEWAY_TOKEN=... ./install.sh install
  (it must equal gateway.auth.token in the OpenClaw gateway config)"
    fi
  fi
  [ "$GATEWAY_TOKEN" = "REPLACE_WITH_GATEWAY_TOKEN" ] && die "GATEWAY_TOKEN is still the placeholder — set the real token."

  # port conflict
  if [ -f "$CONFIG_FILE" ] && [ "$FORCE_CONFIG" = "0" ]; then
    local cur_port; cur_port="$(json_get "$CONFIG_FILE" port)"; [ -n "$cur_port" ] && PORT="$cur_port"
  fi
  if port_in_use "$PORT" && ! docker_ps --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
    die "port $PORT is already in use by another process (set PORT=... to change)"
  fi

  # ── config ──────────────────────────────────────────────────────────────
  local needs_config=0
  if [ ! -f "$CONFIG_FILE" ] || [ "$FORCE_CONFIG" = "1" ]; then needs_config=1; fi
  if [ "$needs_config" = "1" ]; then
    umask 177
    cat > "$CONFIG_FILE" <<EOF
{
  "port": $PORT,
  "bind": "$BIND",
  "gateways": [
    {
      "id": "$GATEWAY_ID",
      "name": "$GATEWAY_NAME",
      "url": "$GATEWAY_URL",
      "token": "$GATEWAY_TOKEN",
      "enabled": true
    }
  ],
  "portalPassword": "",
  "sessionTtlHours": $SESSION_TTL_HOURS
}
EOF
    chmod 600 "$CONFIG_FILE"
    ok "wrote $CONFIG_FILE (0600, port $PORT)"
  else
    info "$CONFIG_FILE exists — keeping it"
  fi

  # ── state files (pre-create so Docker binds FILES, not dirs) ────────────
  for f in "${STATE_FILES[@]}"; do
    if [ ! -e "$f" ]; then : > "$f"; chmod 600 "$f"; info "pre-created $f"; fi
  done
  # ── harden permissions (idempotent; keeps secrets root-only) ────────────
  chmod 600 "$CONFIG_FILE" "${STATE_FILES[@]}" 2>/dev/null || true
  chmod 600 "$CRED_FILE" "$LOG_FILE" 2>/dev/null || true

  # ── build + start ───────────────────────────────────────────────────────
  log "building and starting the container…"
  compose up -d --build
  ok "container started"

  # ── wait for HTTP ───────────────────────────────────────────────────────
  local port_cfg; port_cfg="$(json_get "$CONFIG_FILE" port)"; port_cfg="${port_cfg:-$PORT}"
  info "waiting for the portal to answer on :$port_cfg…"
  local waited=0 up=0
  while [ "$waited" -lt 90 ]; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port_cfg/" || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then up=1; break; fi
    sleep 2; waited=$((waited+2))
  done
  [ "$up" = "1" ] && ok "portal is up (HTTP $code)" || warn "portal not answering yet — check: docker compose logs"

  # ── admin password (fresh installs only) ────────────────────────────────
  local admin_pw=""
  if ! users_have_admin; then
    admin_pw="$PORTAL_PASSWORD"
    if [ -z "$admin_pw" ]; then
      admin_pw="$(gen_password)"
      info "generated a strong random admin password"
    fi
    if set_admin_password "admin" "$admin_pw"; then
      ok "admin password set (fresh install)"
    else
      warn "could not set admin password via API — the seed default (admin / admin) may still be active. CHANGE IT."
      warn "  manual: log in as admin/admin → Users → reset pw, or PORTAL_PASSWORD=... ./install.sh install --fresh --force-config"
    fi
    umask 177
    cat > "$CRED_FILE" <<EOF
# $APP_NAME — install credentials  ($(date -Is))
url:      http://$(hostname -I 2>/dev/null | awk '{print $1}'):$port_cfg/
user:     admin
password: $admin_pw
gateway:  $GATEWAY_URL
EOF
    chmod 600 "$CRED_FILE"
    info "credentials saved to $CRED_FILE (0600)"
  else
    info "admin account already exists — leaving credentials untouched"
  fi

  # ── device approval ─────────────────────────────────────────────────────
  if [ "$DO_APPROVE" = "1" ]; then
    if have openclaw && [ -s "$DEVICE_FILE" ]; then
      local dev req
      dev="$(json_get "$DEVICE_FILE" deviceId)"
      req="$(openclaw devices list --json 2>/dev/null | python3 -c "
import json,sys
try: data=json.load(sys.stdin)
except Exception: sys.exit(0)
dev='$dev'
def walk(o):
    if isinstance(o,dict):
        if o.get('deviceId')==dev or o.get('device',{}).get('id')==dev or o.get('id')==dev:
            r=o.get('requestId') or o.get('request') or o.get('pairingId')
            if r: return r
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
      if [ -n "$req" ]; then
        openclaw devices approve "$req"
        ok "approved device $dev on the gateway (request $req)"
      else
        info "no pending approval for device $dev — it may already be paired, or the gateway hasn't seen it yet"
        info "  if agents don't appear:  openclaw devices list   →   openclaw devices approve <requestId>"
      fi
    else
      warn "openclaw CLI not available here — approve the device manually on the gateway host:"
      warn "  openclaw devices list && openclaw devices approve <requestId>"
    fi
  fi

  # ── firewall ────────────────────────────────────────────────────────────
  if [ "$DO_FIREWALL" = "1" ]; then
    if have ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
      "${SUDO_CMD[@]}" ufw allow "$port_cfg/tcp" >/dev/null 2>&1 \
        && ok "ufw: allowed $port_cfg/tcp" || warn "ufw rule failed — add manually: sudo ufw allow $port_cfg/tcp"
    else
      warn "--firewall given but ufw is not active — add the rule manually: sudo ufw allow $port_cfg/tcp"
    fi
  fi

  # ── receipt ─────────────────────────────────────────────────────────────
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "" | tee -a "$LOG_FILE"
  log "══════════════════════════════════════════════════════════"
  log "  $APP_NAME v$VERSION — install complete"
  log "  URL:      http://${ip:-<server-ip>}:$port_cfg/"
  if [ -n "$admin_pw" ]; then
    log "  login:    admin / $admin_pw"
    log "            (also saved in $CRED_FILE — keep it safe)"
  else
    log "  login:    existing admin account (credentials unchanged)"
  fi
  log "  next:     ./install.sh status   ·   ./install.sh backup"
  log "══════════════════════════════════════════════════════════"
}

# ═══════════════════════════════════════════════════════════════════════════
#  dispatch
# ═══════════════════════════════════════════════════════════════════════════
case "$CMD" in
  install)   run_install ;;
  upgrade)   detect_docker; log "rebuilding container from current code (state kept)…"; compose up -d --build; ok "upgrade complete — ./install.sh status" ;;
  status)    detect_docker; run_status ;;
  doctor)    detect_docker; run_doctor ;;
  backup)    run_backup ;;
  restore)   run_restore ;;
  uninstall) run_uninstall ;;
  *) die "unknown command: $CMD (see --help)" ;;
esac
