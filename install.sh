#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Cirrus Portal — professional installer v2
#  ───────────────────────────────────────────────────────────────────────────
#  One command to stand up a polished, hardened Cirrus Portal instance on any
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
#    • portal-config.json is written once per server (0600) and is TOKEN-FREE.
#      Gateway token(s) + the bootstrap admin password live in
#      portal-secrets.json (0600) — never in config, backups, or tarballs.
#    • portal-device.json is generated fresh per server by the app on first
#      boot, and must be approved on THAT server's gateway.
#    • The gateway token in portal-secrets.json MUST equal the target server's
#      own gateway token (gateway.auth.token) — auto-detected when possible.
#    • Idempotent: re-running install on a healthy box changes nothing
#      except (optionally) rebuilding the image.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── identity (single source of truth: branding.json / VERSION) ─────────────
VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]')"
VERSION="${VERSION:-2.2.0}"
APP_NAME="$(sed -n 's/.*"product"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' branding.json 2>/dev/null | head -1)"
APP_NAME="${APP_NAME:-Cirrus Portal}"
TAGLINE="$(sed -n 's/.*"tagline"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' branding.json 2>/dev/null | head -1)"
TAGLINE="${TAGLINE:-Mission control for your OpenClaw fleet.}"

# ── paths ───────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
CONFIG_FILE="portal-config.json"
SECRETS_FILE="portal-secrets.json"
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
# Loopback by default (plan item 5): a public bind requires TLS or --insecure-plaintext.
BIND="${BIND:-127.0.0.1}"
GATEWAY_URL="${GATEWAY_URL:-ws://$GATEWAY_HOST:$GATEWAY_PORT}"
SESSION_TTL_HOURS="${SESSION_TTL_HOURS:-12}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"
PORTAL_PASSWORD="${PORTAL_PASSWORD:-}"
GATEWAY_ID="${GATEWAY_ID:-home}"
GATEWAY_NAME="${GATEWAY_NAME:-Home}"

# TLS / exposure (plan item 5)
DOMAIN=""
ACME_EMAIL=""
TLS_CERT=""
TLS_KEY=""
INSECURE_PLAINTEXT=0

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
$C_BLU$APP_NAME installer v$VERSION$C_RST — professional install for OpenClaw agent fleets

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
  --domain HOST     Serve the public site at HOST over automatic HTTPS
                    (installs a Caddy reverse proxy; portal stays on loopback).
  --email ADDR      ACME account email for --domain (Let's Encrypt).
  --tls-cert PATH   Serve HTTPS directly with this certificate (with --tls-key).
  --tls-key PATH    Private key for --tls-cert.
  --insecure-plaintext
                    Allow a PUBLIC bind WITHOUT TLS. Cleartext — never for the
                    open internet; for trusted LAN/tunnels only.
  --fresh           Wipe local state (device, users, rooms, audit, context)
                    before install. For NEW servers / factory reset.
  --force-config    Rewrite portal-config.json from env even if it exists.
  --no-approve      Skip the device-approval step on the gateway.
  --firewall        Open the portal port in ufw (80/443 when --domain is used).
  --purge           With uninstall: also delete config, state, credentials.
  --dry-run         Print what install would do, change nothing.
  -y, --yes         Assume yes for all prompts.
  -h, --help        Show this help.

$C_CYN TLS / exposure:$C_RST
  Default bind is 127.0.0.1 (loopback). A public bind requires TLS unless you
  pass --insecure-plaintext. Three ways to go public safely:
    ./install.sh install --domain portal.example.com --email you@example.com
    ./install.sh install --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem
    (or front it with your own TLS-terminating proxy + trustProxy:true)

$C_CYN Env:$C_RST
  GATEWAY_TOKEN      This server's OpenClaw gateway token. Auto-detected
                     from ~/.openclaw/openclaw.json when not set.
  PORTAL_PASSWORD    Admin login password. On a FRESH install a strong
                     random one is generated and saved to portal-credentials.txt
                     if you don't provide one.
  PORT / BIND / GATEWAY_URL / SESSION_TTL_HOURS / PORTAL_TLS_MODE
  GATEWAY_ID / GATEWAY_NAME   (gateway list entry; defaults home/Home)

$C_CYN Examples:$C_RST
  ./install.sh install --fresh
  ./install.sh install --fresh --domain portal.example.com --email me@example.com
  GATEWAY_TOKEN=abc123 PORTAL_PASSWORD='hunter2!' ./install.sh install --fresh --firewall
  BIND=0.0.0.0 ./install.sh install --insecure-plaintext   # trusted LAN only
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

# is_loopback_bind ADDR → 0 when the address is host-local only.
is_loopback_bind() {
  case "${1:-}" in
    127.0.0.1|::1|localhost|127.*|\[::1\]) return 0 ;;
    *) return 1 ;;
  esac
}

# Merge key=value pairs into portal-config.json (JSON-safe, keeps it 0600).
# An empty value deletes the key. Booleans are written as true/false.
config_patch() { # config_patch key=value [key=value ...]
  local f="$CONFIG_FILE"
  [ -f "$f" ] || return 0
  if have python3; then
    python3 - "$f" "$@" <<'PY'
import json,sys
f=sys.argv[1]
d=json.load(open(f))
for pair in sys.argv[2:]:
    k,v=pair.split('=',1)
    if v=='': d.pop(k,None)
    elif v=='true': d[k]=True
    elif v=='false': d[k]=False
    else:
        try: d[k]=int(v)
        except ValueError: d[k]=v
json.dump(d,open(f,'w'),indent=2)
PY
  elif have node; then
    node -e '
      const fs=require("fs"),f=process.argv[1];
      const d=JSON.parse(fs.readFileSync(f,"utf8"));
      for(const pair of process.argv.slice(2)){
        const i=pair.indexOf("="),k=pair.slice(0,i),v=pair.slice(i+1);
        if(v==="")delete d[k];
        else if(v==="true")d[k]=true;
        else if(v==="false")d[k]=false;
        else if(/^-?\d+$/.test(v))d[k]=parseInt(v,10);
        else d[k]=v;
      }
      fs.writeFileSync(f,JSON.stringify(d,null,2));
    ' "$f" "$@"
  fi
  chmod 600 "$f" 2>/dev/null || true
}

# ── argument parsing ────────────────────────────────────────────────────────
ARGS=("$@")
_i=0
while [ "$_i" -lt "${#ARGS[@]}" ]; do
  arg="${ARGS[$_i]}"
  case "$arg" in
    install|upgrade|status|doctor|backup|restore|uninstall|version) CMD="$arg" ;;
    --fresh) FRESH=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    --no-approve) DO_APPROVE=0 ;;
    --firewall) DO_FIREWALL=1 ;;
    --purge) PURGE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --insecure-plaintext) INSECURE_PLAINTEXT=1 ;;
    --domain) _i=$((_i+1)); DOMAIN="${ARGS[$_i]:-}"; [ -n "$DOMAIN" ] || die "--domain needs a hostname (e.g. --domain portal.example.com)" ;;
    --email) _i=$((_i+1)); ACME_EMAIL="${ARGS[$_i]:-}" ;;
    --tls-cert) _i=$((_i+1)); TLS_CERT="${ARGS[$_i]:-}"; [ -n "$TLS_CERT" ] || die "--tls-cert needs a certificate path" ;;
    --tls-key) _i=$((_i+1)); TLS_KEY="${ARGS[$_i]:-}"; [ -n "$TLS_KEY" ] || die "--tls-key needs a key path" ;;
    -y|--yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    --*) die "unknown option: $arg (see --help)" ;;
    *) if [ "$CMD" = "restore" ] && [ -z "${RESTORE_FILE:-}" ]; then RESTORE_FILE="$arg";
       else die "unknown argument: $arg (see --help)"; fi ;;
  esac
  _i=$((_i+1))
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
  # http (direct-TLS installs need https)
  local code _tls
  _tls="$(json_get "$CONFIG_FILE" tlsMode 2>/dev/null)"; _tls="${_tls:-off}"
  local _scheme="http"; [ "$_tls" = "manual" ] && _scheme="https"
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$_scheme://127.0.0.1:$port_cfg/" || true)"
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
    if grep -q '"token"[[:space:]]*:[[:space:]]*"[^"]' "$CONFIG_FILE" 2>/dev/null; then
      warn "config carries a plaintext token — expected token-free (use $SECRETS_FILE)"; fails=$((fails+1))
    fi
  else
    warn "no config — run ./install.sh install"; fails=$((fails+1))
  fi
  # secrets at rest (plan item 3) — gateway tokens never live in config
  if [ -f "$SECRETS_FILE" ]; then
    local smode; smode="$(stat -c %a "$SECRETS_FILE" 2>/dev/null || echo '?')"
    if [ "$smode" = "600" ]; then ok "secrets present ($SECRETS_FILE, mode 600)"; else warn "secrets mode is $smode — expected 600"; fails=$((fails+1)); fi
    if grep -q 'REPLACE_WITH_GATEWAY_TOKEN\|REPLACE_ME' "$SECRETS_FILE" 2>/dev/null; then
      warn "secrets still contain placeholder tokens"; fails=$((fails+1))
    fi
  elif grep -q '"token"[[:space:]]*:[[:space:]]*"[^"]' "$CONFIG_FILE" 2>/dev/null; then
    info "no secrets file yet — token still in config (server migrates it to $SECRETS_FILE on next boot)"
  else
    warn "no $SECRETS_FILE and no config token — gateway token missing"; fails=$((fails+1))
  fi
  # TLS / exposure (plan item 5)
  {
    local _tls _bind
    _tls="$(json_get "$CONFIG_FILE" tlsMode 2>/dev/null)"; _tls="${_tls:-off}"
    _bind="$(json_get "$CONFIG_FILE" bind 2>/dev/null)"; _bind="${_bind:-?}"
    case "$_tls" in
      auto)   ok "TLS: automatic (reverse proxy / Caddy terminates) — bind $_bind" ;;
      manual) ok "TLS: manual (own certs or operator proxy) — bind $_bind" ;;
      *)      if is_loopback_bind "$_bind"; then ok "TLS: off (loopback $_bind only)";
              else warn "TLS: off with public bind $_bind — cleartext (needs --insecure-plaintext or TLS)"; fi ;;
    esac
  }
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
  info "note: gateway tokens are NOT in this backup — secrets never touch backups."
  info "      After a restore, re-provide GATEWAY_TOKEN=... or copy $SECRETS_FILE separately."
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
    rm -f "$CONFIG_FILE" "$SECRETS_FILE" "${STATE_FILES[@]}" "$CRED_FILE" "$LOG_FILE"
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

# Verify an admin login works (fresh installs: the server seeds the password
# at first boot from portal-config.json — there is no admin/admin anymore).
verify_admin_login() {
  local pw="$1" tries=0
  local jar; jar="$(mktemp)"
  local port_cfg; port_cfg="$(json_get "$CONFIG_FILE" port)"; port_cfg="${port_cfg:-$PORT}"
  local rc=1
  while [ "$tries" -lt 10 ]; do
    tries=$((tries+1))
    if curl -s --max-time 5 -c "$jar" -H 'Content-Type: application/json' \
        -d "{\"username\":\"admin\",\"password\":\"$pw\"}" \
        "http://127.0.0.1:$port_cfg/api/login" | grep -q '"ok":true'; then
      rc=0; break
    fi
    sleep 3
  done
  rm -f "$jar"; return "$rc"
}

# ── Caddy reverse proxy (plan item 5) ───────────────────────────────────────
# Wires automatic Let's Encrypt HTTPS in front of the loopback portal. Writes a
# Caddyfile next to the installer and starts it as a systemd service when we can.
# Never fatal: if caddy isn't installed we print the exact next steps instead.
setup_caddy() { # setup_caddy DOMAIN PORT
  local domain="$1" port="$2"
  local src="$DIR/deploy/Caddyfile"
  local conf="$DIR/Caddyfile"
  local envf="$DIR/deploy/caddy.env"

  if [ ! -f "$src" ]; then
    warn "deploy/Caddyfile not found — skipping reverse-proxy setup (portal stays on loopback)"
    info "point your own TLS proxy at 127.0.0.1:$port and set trustProxy:true"
    return 0
  fi
  cp -f "$src" "$conf"
  {
    echo "PORTAL_DOMAIN=$domain"
    echo "PORTAL_PORT=$port"
    [ -n "$ACME_EMAIL" ] && echo "ACME_EMAIL=$ACME_EMAIL"
  } > "$envf"
  chmod 600 "$envf" 2>/dev/null || true
  ok "Caddyfile written: $conf (domain $domain → 127.0.0.1:$port)"

  if ! have caddy; then
    warn "caddy is not installed — HTTPS is NOT live yet. Install it, then run:"
    info "  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    info "  sudo apt install caddy   # or: https://caddyserver.com/docs/install"
    info "  sudo caddy run --config $conf --envfile $envf"
    return 0
  fi

  info "validating Caddyfile…"
  if ! PORTAL_DOMAIN="$domain" PORTAL_PORT="$port" ACME_EMAIL="$ACME_EMAIL" caddy validate --config "$conf" >/dev/null 2>&1; then
    warn "Caddyfile validation failed — check $conf (DNS for $domain must point here)"
    return 0
  fi
  ok "Caddyfile is valid"

  if have systemctl && [ "$(id -u)" = "0" ]; then
    cat > /etc/systemd/system/cirrus-portal-caddy.service <<EOF
[Unit]
Description=Cirrus Portal reverse proxy (Caddy)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$envf
ExecStart=$(command -v caddy) run --config $conf
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    if systemctl enable --now cirrus-portal-caddy >/dev/null 2>&1; then
      ok "Caddy started (systemd: cirrus-portal-caddy) — HTTPS for https://$domain"
    else
      warn "could not start the Caddy service — run: sudo systemctl start cirrus-portal-caddy"
    fi
  else
    info "start Caddy manually (or as a service):"
    info "  sudo caddy run --config $conf --envfile $envf"
  fi
}

run_install() {
  detect_docker

  # ── TLS / exposure policy (plan item 5) ─────────────────────────────────
  # Decide how the portal is exposed before we touch anything. A public bind
  # without TLS is refused unless --insecure-plaintext is explicitly given.
  local tls_mode="off" trust_proxy="false"
  if [ -n "$DOMAIN" ]; then
    tls_mode="auto"; trust_proxy="true"; BIND="127.0.0.1"
    ok "TLS: automatic HTTPS for $DOMAIN via Caddy (portal stays on loopback)"
  elif [ -n "$TLS_CERT" ] || [ -n "$TLS_KEY" ]; then
    [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ] || die "--tls-cert and --tls-key must be given together"
    [ -r "$TLS_CERT" ] || die "certificate not readable: $TLS_CERT"
    [ -r "$TLS_KEY" ]  || die "private key not readable: $TLS_KEY"
    tls_mode="manual"
    ok "TLS: serving HTTPS directly (${TLS_CERT})"
  fi
  if [ "$tls_mode" = "off" ] && ! is_loopback_bind "$BIND"; then
    if [ "$INSECURE_PLAINTEXT" = "1" ]; then
      warn "INSECURE-PLAINTEXT: binding $BIND in cleartext. NEVER expose this to the public internet."
    else
      die "refusing to bind $BIND without TLS.
  Choose one:
    ./install.sh install --domain portal.example.com     # automatic HTTPS (recommended)
    ./install.sh install --tls-cert C --tls-key K        # bring your own certificate
    BIND=127.0.0.1 ./install.sh install                  # loopback only (default)
    ./install.sh install --insecure-plaintext            # cleartext — NOT for public hosts"
    fi
  fi

  # ── dry-run gate (BEFORE any destructive step) ─────────────────────────
  if [ "$DRY_RUN" = "1" ]; then
    local cur_port="$PORT"
    [ -f "$CONFIG_FILE" ] && cur_port="$(json_get "$CONFIG_FILE" port)" && [ -n "$cur_port" ] || cur_port="$PORT"
    info "dry-run — no changes will be made."
    log "config:   port $cur_port, bind $BIND, gateway $GATEWAY_URL"
    local tls_desc="mode $tls_mode"
    [ "$trust_proxy" = "true" ] && tls_desc="$tls_desc (proxy terminates TLS)"
    [ -n "$DOMAIN" ] && tls_desc="$tls_desc — https://$DOMAIN via Caddy"
    [ -n "$TLS_CERT" ] && tls_desc="$tls_desc — direct HTTPS ($TLS_CERT)"
    if [ "$tls_mode" = "off" ]; then
      if is_loopback_bind "$BIND"; then tls_desc="$tls_desc — loopback only"; else tls_desc="$tls_desc — INSECURE PLAINTEXT"; fi
    fi
    log "tls:      $tls_desc"
    log "token:    ${GATEWAY_TOKEN:+provided / auto-detected}${GATEWAY_TOKEN:-<will auto-detect from gateway config>}"
    log "actions:  write config ($([ "$FORCE_CONFIG" = "1" ] || [ ! -f "$CONFIG_FILE" ] && echo yes || echo no)) · wipe state ($([ "$FRESH" = "1" ] && echo yes || echo no))"
    log "          build+start container · seed unique admin password (fresh only) · approve device ($([ "$DO_APPROVE" = "1" ] && echo yes || echo no)) · firewall ($([ "$DO_FIREWALL" = "1" ] && echo yes || echo no))"
    [ -n "$DOMAIN" ] && log "          configure Caddy (automatic certs) → https://$DOMAIN"
    return 0
  fi

  # ── fresh reset ─────────────────────────────────────────────────────────
  if [ "$FRESH" = "1" ]; then
    warn "wiping local state: device, users, rooms, audit, context, credentials"
    rm -f "$DEVICE_FILE" "$USERS_FILE" "$CONTEXT_FILE" "$ROOMS_FILE" "$AUDIT_FILE" "$CRED_FILE" "$SECRETS_FILE"
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
    # No shipped default: mint a strong, unique admin password if none was
    # given. The server seeds the admin account with this value on first boot.
    if [ -z "$PORTAL_PASSWORD" ]; then
      PORTAL_PASSWORD="$(gen_password)"
      info "generated a strong unique admin password for first-run seeding"
    fi
    # Optional TLS/proxy lines (empty when unused — JSON tolerates the blank lines).
    local tl_cert_line="" tl_key_line="" tl_trust_line="" tl_insec_line=""
    [ -n "$TLS_CERT" ] && tl_cert_line="  \"tlsCert\": \"$TLS_CERT\","
    [ -n "$TLS_KEY" ] && tl_key_line="  \"tlsKey\": \"$TLS_KEY\","
    [ "$trust_proxy" = "true" ] && tl_trust_line="  \"trustProxy\": true,"
    [ "$INSECURE_PLAINTEXT" = "1" ] && tl_insec_line="  \"insecurePlaintext\": true,"
    cat > "$CONFIG_FILE" <<EOF
{
  "port": $PORT,
  "bind": "$BIND",
  "gateways": [
    {
      "id": "$GATEWAY_ID",
      "name": "$GATEWAY_NAME",
      "url": "$GATEWAY_URL",
      "enabled": true
    }
  ],
  "tlsMode": "$tls_mode",
$tl_cert_line
$tl_key_line
$tl_trust_line
$tl_insec_line
  "sessionTtlHours": $SESSION_TTL_HOURS
}
EOF
    chmod 600 "$CONFIG_FILE"
    ok "wrote $CONFIG_FILE (0600, port $PORT — token-free, tlsMode $tls_mode)"
    # Gateway token(s) + bootstrap admin password → dedicated 0600 secrets file.
    # These never appear in config, backups, or release tarballs (plan item 3).
    cat > "$SECRETS_FILE" <<EOF
{
  "gatewayTokens": {
    "$GATEWAY_ID": "$GATEWAY_TOKEN"
  },
  "portalPassword": "$PORTAL_PASSWORD"
}
EOF
    chmod 600 "$SECRETS_FILE"
    ok "wrote $SECRETS_FILE (0600) — gateway token(s) + bootstrap admin password"
  else
    info "$CONFIG_FILE exists — keeping it"
    # Apply TLS/exposure flags to an existing config so they work without
    # --force-config (plan item 5).
    if [ -n "$DOMAIN" ] || [ -n "$TLS_CERT" ] || [ "$INSECURE_PLAINTEXT" = "1" ]; then
      config_patch "bind=$BIND" "tlsMode=$tls_mode" "trustProxy=$trust_proxy" \
        "tlsCert=$TLS_CERT" "tlsKey=$TLS_KEY" \
        "insecurePlaintext=$([ "$INSECURE_PLAINTEXT" = "1" ] && echo true || echo '')"
      ok "updated $CONFIG_FILE: tlsMode=$tls_mode, bind=$BIND${DOMAIN:+ (https://$DOMAIN)}"
    fi
  fi

  # ── state files (pre-create so Docker binds FILES, not dirs) ────────────
  for f in "${STATE_FILES[@]}"; do
    if [ ! -e "$f" ]; then : > "$f"; chmod 600 "$f"; info "pre-created $f"; fi
  done
  # Secrets file must exist as a FILE too (Docker would otherwise mount a dir).
  if [ ! -e "$SECRETS_FILE" ]; then printf '{}\n' > "$SECRETS_FILE"; chmod 600 "$SECRETS_FILE"; info "pre-created $SECRETS_FILE"; fi
  # ── harden permissions (idempotent; keeps secrets root-only) ────────────
  chmod 600 "$CONFIG_FILE" "$SECRETS_FILE" "${STATE_FILES[@]}" 2>/dev/null || true
  chmod 600 "$CRED_FILE" "$LOG_FILE" 2>/dev/null || true

  # ── build + start ───────────────────────────────────────────────────────
  # Remember whether an admin already existed; a fresh boot seeds one from
  # portal-config.json's portalPassword (unique) instead of a shipped default.
  local had_admin_before=0
  users_have_admin && had_admin_before=1
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

  # ── admin password (fresh installs) ─────────────────────────────────────
  # The server seeds the admin account on first boot using portalPassword from
  # portal-config.json (a unique value we generated above). No admin/admin.
  local admin_pw=""
  if [ "$had_admin_before" = "0" ]; then
    admin_pw="$(json_get "$SECRETS_FILE" portalPassword 2>/dev/null)"
    [ -z "$admin_pw" ] && admin_pw="$(json_get "$CONFIG_FILE" portalPassword 2>/dev/null)"
    [ -z "$admin_pw" ] && admin_pw="$PORTAL_PASSWORD"
    if [ -n "$admin_pw" ] && verify_admin_login "$admin_pw"; then
      ok "admin login verified (fresh install — seeded from config)"
    else
      # Server may have generated a random one (config lacked a password).
      if [ -f portal-first-run.txt ]; then
        admin_pw="$(grep -m1 '^password:' portal-first-run.txt | awk '{print $2}')"
        ok "admin password read from portal-first-run.txt"
      else
        admin_pw=""
        warn "could not verify the admin login — check 'docker compose logs'; reset via Users → reset pw once you're in."
      fi
    fi
    if [ -n "$admin_pw" ]; then
      umask 177
      cat > "$CRED_FILE" <<EOF
# $APP_NAME — install credentials  ($(date -Is))
url:      $([ -n "$DOMAIN" ] && echo "https://$DOMAIN/" || echo "http://$(hostname -I 2>/dev/null | awk '{print $1}'):$port_cfg/")
user:     admin
password: $admin_pw
gateway:  $GATEWAY_URL
EOF
      chmod 600 "$CRED_FILE"
      info "credentials saved to $CRED_FILE (0600) — change the password after first login"
    fi
  else
    info "admin account already exists — leaving credentials untouched"
  fi

  # ── TLS reverse proxy (plan item 5) ─────────────────────────────────────
  # --domain wires Caddy for automatic certs in front of the loopback portal.
  if [ -n "$DOMAIN" ]; then
    setup_caddy "$DOMAIN" "$port_cfg"
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
      if [ -n "$DOMAIN" ]; then
        "${SUDO_CMD[@]}" ufw allow 80/tcp  >/dev/null 2>&1 && "${SUDO_CMD[@]}" ufw allow 443/tcp >/dev/null 2>&1 \
          && ok "ufw: allowed 80,443/tcp (TLS)" || warn "ufw rules failed — add manually: sudo ufw allow 80,443/tcp"
      else
        "${SUDO_CMD[@]}" ufw allow "$port_cfg/tcp" >/dev/null 2>&1 \
          && ok "ufw: allowed $port_cfg/tcp" || warn "ufw rule failed — add manually: sudo ufw allow $port_cfg/tcp"
      fi
    else
      warn "--firewall given but ufw is not active — add the rule manually: sudo ufw allow ${port_cfg}${DOMAIN:+,80,443}/tcp"
    fi
  fi

  # ── receipt ─────────────────────────────────────────────────────────────
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "" | tee -a "$LOG_FILE"
  log "══════════════════════════════════════════════════════════"
  log "  $APP_NAME v$VERSION — install complete"
  log "  URL:      $([ -n "$DOMAIN" ] && echo "https://$DOMAIN/" || echo "http://${ip:-<server-ip>}:$port_cfg/")"
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
