#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Cirrus Portal — clean-box end-to-end verification (plan item 18)
#
#  Drives the FULL operator journey on a THROWAWAY box and proves each step,
#  exactly the way a brand-new operator would hit it:
#
#     install   a fresh box's install plan is valid (install.sh --dry-run)
#               *and* the real image builds + boots hardened
#     wizard    first boot has NO credentials; /setup mints the admin
#     chat      create a room, post a message, reload it back from disk
#     upgrade   rebuild the image, restart on the SAME state → state survives
#     restore   encrypted backup → simulate total loss → restore → sha256-equal
#
#  Backends:
#     E2E_BACKEND=docker   (default when a Docker daemon is reachable) — a
#                          throwaway container run with the hardened flags
#                          (non-root uid 10001, read-only rootfs, /tmp tmpfs,
#                          cap_drop ALL, no-new-privileges).
#     E2E_BACKEND=process  (fallback) — the real server from a temp dir, i.e.
#                          the "fresh VM" without Docker.
#
#  It NEVER touches the live tree: everything happens under a mktemp workspace
#  and any container it starts is unique-named and removed at the end. The
#  live `agent-portal` container and its state files are never read or written.
#
#  Usage: ./e2e-verify.sh [--backend docker|process] [--keep] [--help]
#  Exit 0 = every step passed.
# ═══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# ── identity (single source of truth) ───────────────────────────────────────
APP_NAME="$(sed -n 's/.*"product"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' branding.json 2>/dev/null | head -1)"
APP_NAME="${APP_NAME:-Cirrus Portal}"
VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]')"
VERSION="${VERSION:-0.0.0}"

# ── flags ───────────────────────────────────────────────────────────────────
BACKEND="${E2E_BACKEND:-auto}"
KEEP=0
PASSWORD="E2e-CleanBox-42x!"
while [ $# -gt 0 ]; do
  case "$1" in
    --backend) BACKEND="${2:-}"; shift ;;
    --backend=*) BACKEND="${1#*=}" ;;
    --keep) KEEP=1 ;;
    -h|--help) awk 'NR>1 { if ($0 !~ /^#/ && $0 !~ /^[[:space:]]*$/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# ── output ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then C_B=$'\033[36m'; C_G=$'\033[32m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_0=$'\033[0m'
else C_B=""; C_G=""; C_R=""; C_Y=""; C_0=""; fi
STEP=0; CHECKS=0
log()  { printf '%s[e2e]%s %s\n' "$C_B" "$C_0" "$*"; }
step() { STEP=$((STEP+1)); printf '\n%s── step %d: %s ──%s\n' "$C_B" "$STEP" "$*" "$C_0"; }
ok()   { CHECKS=$((CHECKS+1)); printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
info() { printf '  %s·%s %s\n' "$C_B" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '\n%s[e2e] FATAL: %s%s\n' "$C_R" "$*" "$C_0" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── workspace ───────────────────────────────────────────────────────────────
WS="$(mktemp -d "${TMPDIR:-/tmp}/cirrus-e2e-XXXXXX")"
BOX="$WS/box"            # the fresh box's state dir (bind-mounted into the box)
APP="$WS/app"            # process-backend code copy / dry-run install copy
LOGS="$WS/logs"
mkdir -p "$BOX" "$APP" "$LOGS"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="cirrus-portal-e2e-$STAMP"
IMG="cirrus-portal-e2e:$STAMP"
JAR="$WS/cookies.txt"; RESP="$WS/resp.json"
START_TS="$(date +%s)"

BOX_PID=""
cleanup() {
  local rc=$?
  # Always tear the box down (even with --keep) so nothing keeps a port.
  [ -n "$BOX_PID" ] && kill "$BOX_PID" 2>/dev/null || true
  if [ "$BACKEND_RESOLVED" = "docker" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker rmi "$IMG" >/dev/null 2>&1 || true
  fi
  if [ "$KEEP" = "1" ]; then
    printf '\n%s[e2e] --keep: workspace left at %s%s\n' "$C_Y" "$WS" "$C_0"
  else
    rm -rf "$WS"
  fi
  if [ "$rc" = "0" ]; then
    printf '\n%s✓ %s — clean-box E2E PASSED (%d checks, %ss)%s\n' "$C_G" "$APP_NAME" "$CHECKS" "$(( $(date +%s) - START_TS ))" "$C_0"
  else
    printf '\n%s✗ %s — clean-box E2E FAILED (exit %d)%s\n' "$C_R" "$APP_NAME" "$rc" "$C_0" >&2
  fi
}
trap cleanup EXIT

# ── helpers ─────────────────────────────────────────────────────────────────
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})'
}
jget() { # jget FILE dotted.key → value (strings unquoted, others JSON)
  python3 -c 'import json,sys,functools
d=json.load(open(sys.argv[1]))
v=functools.reduce(lambda o,k: o[int(k)] if isinstance(o,list) else o[k], sys.argv[2].split("."), d)
print(v if not isinstance(v,(dict,list)) else json.dumps(v))' "$1" "$2"
}

# HTTP: sets HTTP (status code) and writes the body to $RESP.
http_get() { HTTP="$(curl -sS --noproxy '*' -o "$RESP" -w '%{http_code}' --max-time 15 -b "$JAR" -c "$JAR" "http://127.0.0.1:$PORT$1" 2>/dev/null)" || HTTP=000; }
http_post() { # http_post PATH JSON
  local args=(-sS --noproxy '*' -o "$RESP" -w '%{http_code}' --max-time 15 -b "$JAR" -c "$JAR" -H 'Content-Type: application/json')
  [ -n "${CSRF:-}" ] && args+=(-H "X-CSRF-Token: $CSRF")
  HTTP="$(curl "${args[@]}" -d "$2" "http://127.0.0.1:$PORT$1" 2>/dev/null)" || HTTP=000
}

# ── resolve backend ─────────────────────────────────────────────────────────
if [ "$BACKEND" = "auto" ]; then
  if have docker && docker info >/dev/null 2>&1; then BACKEND=docker; else BACKEND=process; fi
fi
case "$BACKEND" in docker|process) ;; *) die "unknown --backend: $BACKEND (docker|process)";; esac
BACKEND_RESOLVED="$BACKEND"

# ═══════════════════════════════════════════════════════════════════════════
#  Box lifecycle — start/stop the fresh portal (docker container or process)
# ═══════════════════════════════════════════════════════════════════════════
write_fresh_config() { # fresh box: no admin, no bootstrap password → SETUP mode
  cat > "$BOX/portal-config.json" <<EOF
{
  "port": $PORT,
  "bind": "127.0.0.1",
  "gateways": [],
  "sessionTtlHours": 12
}
EOF
  chmod 600 "$BOX/portal-config.json"
}

prep_state_files() { # pre-create the bind-mount targets (files, not dirs)
  local f
  for f in portal-device.json portal-secrets.json portal-users.json \
           portal-rooms.json portal-context.json portal-audit.log; do
    [ -e "$BOX/$f" ] || { : > "$BOX/$f"; }
    chmod 600 "$BOX/$f"
  done
  [ -s "$BOX/portal-secrets.json" ] || printf '{}\n' > "$BOX/portal-secrets.json"
  chmod 600 "$BOX/portal-secrets.json"
  # Hand the state to the container's uid (10001) so it can read/write the
  # bind-mounts. docker backend only — the process backend runs node as the
  # *current* user, so its state must stay owned by them. Root can chown
  # directly; an unprivileged host (e.g. a CI runner) may need sudo — and if
  # neither works we open the throwaway state's perms instead. Without this the
  # server can't read its config and silently falls back to defaults (wrong
  # port → misleading "portal never answered").
  if [ "$BACKEND" = "docker" ]; then
    # The container runs as uid 10001 and must read/write the bind-mounted
    # state; the host must also read it back to verify persistence (step 3+).
    # Hand ownership over when we can, and *always* open the perms on this
    # throwaway workspace so both sides can read/write no matter who runs the
    # script — a non-root CI host can't chown, and a 10001-owned 0600 file is
    # then unreadable to the host's verifier (and vice-versa).
    local files=("$BOX"/portal-*.json "$BOX"/portal-audit.log)
    chown 10001:10001 "${files[@]}" 2>/dev/null || true
    chmod 666 "${files[@]}" 2>/dev/null || true
  fi
}

copy_code() { # copy_code TARGET
  local t="$1" f
  for f in portal-server.js portal.html setup.html nexus.html branding.json healthcheck.js; do
    cp -p "$DIR/$f" "$t/$f"
  done
}

box_start() {
  if [ "$BACKEND" = "docker" ]; then
    prep_state_files
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --network host \
      --read-only --tmpfs /tmp:size=16m,mode=1777 \
      --cap-drop ALL --security-opt no-new-privileges:true \
      --memory 512m --pids-limit 256 \
      -v "$BOX/portal-config.json:/app/portal-config.json" \
      -v "$BOX/portal-secrets.json:/app/portal-secrets.json" \
      -v "$BOX/portal-device.json:/app/portal-device.json" \
      -v "$BOX/portal-users.json:/app/portal-users.json" \
      -v "$BOX/portal-rooms.json:/app/portal-rooms.json" \
      -v "$BOX/portal-context.json:/app/portal-context.json" \
      -v "$BOX/portal-audit.log:/app/portal-audit.log" \
      "$IMG" >/dev/null
  else
    # The process backend's "install dir" IS the state dir (fresh VM style).
    prep_state_files
    copy_code "$BOX"
    ( cd "$BOX" && exec node portal-server.js ) >"$LOGS/server.log" 2>&1 &
    BOX_PID=$!
  fi
  wait_http
}

wait_http() {
  local n=0 code
  while [ "$n" -lt 60 ]; do
    code="$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null)" || code=000
    case "$code" in 000|"") : ;; *) info "portal answered HTTP $code"; return 0 ;; esac
    n=$((n+1)); sleep 1
  done
  if [ "$BACKEND" = "docker" ]; then
    diag_docker
    docker logs "$NAME" 2>&1 | tail -20 >&2
  else tail -20 "$LOGS/server.log" >&2 || true; fi
  die "portal never answered on 127.0.0.1:$PORT"
}

diag_docker() { # why can't the host reach the container's loopback port?
  set +e # never let a diagnostic abort the dump (script runs under -Eeuo pipefail)
  {
    echo "── wait_http diagnostics (host cannot reach 127.0.0.1:$PORT) ──"
    echo "docker version: $(docker --version 2>&1)"
    echo "rootless/userns: $(docker info 2>/dev/null | grep -iE 'rootless|userns' | tr '\n' ' ' || true)"
    echo "host network exists: $(docker network ls --format '{{.Name}}' 2>/dev/null | grep -x host || echo NO)"
    echo "host firewall: $(iptables -S 2>/dev/null | head -3 | tr '\n' ' ' || echo '(none/n/a)')"
    echo "curl -v from host:"
    curl -v --noproxy '*' --max-time 5 "http://127.0.0.1:$PORT/" 2>&1 | sed 's/^/  | /' | tail -15
    echo "proxy env: $(env | grep -i proxy | tr '\n' ' ' || true)"
    echo "network mode: $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME" 2>&1)"
    echo "state: $(docker inspect -f '{{.State.Status}} started={{.State.StartedAt}} exit={{.State.ExitCode}}' "$NAME" 2>&1)"
    echo "container IPs: $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$NAME" 2>&1)"
    echo "published ports: $(docker inspect -f '{{json .NetworkSettings.Ports}}' "$NAME" 2>&1)"
    echo "host listeners on :$PORT:"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep ":$PORT " | sed 's/^/  /' || echo "  (none)"
    echo "in-container probe (docker exec):"
    docker exec "$NAME" wget -qO- -T 5 "http://127.0.0.1:$PORT/" 2>&1 | head -3 | sed 's/^/  /' || echo "  (failed)"
    echo "── end diagnostics ──"
  } >&2
}

box_stop() {
  if [ "$BACKEND" = "docker" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  else
    [ -n "$BOX_PID" ] && { kill "$BOX_PID" 2>/dev/null || true; wait "$BOX_PID" 2>/dev/null || true; BOX_PID=""; }
  fi
  # give the port a moment to free
  local n=0; while [ "$n" -lt 10 ] && curl -sS -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; do sleep 0.5; n=$((n+1)); done
}

# ═══════════════════════════════════════════════════════════════════════════
#  Journey
# ═══════════════════════════════════════════════════════════════════════════
log "$APP_NAME v$VERSION — clean-box end-to-end verification (backend: $BACKEND)"

# ── step 1: install plan + build ────────────────────────────────────────────
step "install — fresh-box plan is valid and the image builds"
PORT="$(free_port)"
info "free port chosen: $PORT"

# A truly FRESH copy of the installer (no live state next to it) must be able
# to print its plan without touching anything and without Docker.
cp -p "$DIR/install.sh" "$DIR/branding.json" "$DIR/VERSION" "$APP/" 2>/dev/null || die "could not stage install.sh"
plan="$(GATEWAY_TOKEN=e2e-plan-token BIND=127.0.0.1 PORT="$PORT" bash "$APP/install.sh" install --dry-run 2>&1)" \
  && ok "install --dry-run plan printed (fresh box, no state, Docker-free)" \
  || die "install.sh --dry-run failed:\n$plan"
echo "$plan" | grep -q "install plan" || die "dry-run did not print the install plan"
echo "$plan" | grep -qi "loopback only" || warn "plan did not describe the loopback bind"

if [ "$BACKEND" = "docker" ]; then
  docker build -q -t "$IMG" "$DIR" >/dev/null || die "docker build failed"
  ok "image built: $IMG"
fi

# ── step 2: wizard ──────────────────────────────────────────────────────────
step "wizard — first boot has no credentials; /setup mints the admin"
write_fresh_config
box_start

if [ "$BACKEND" = "docker" ]; then
  cuser="$(docker inspect --format '{{.Config.User}}' "$NAME" 2>/dev/null)"
  cro="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$NAME" 2>/dev/null)"
  ccaps="$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$NAME" 2>/dev/null)"
  ctmp="$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$NAME" 2>/dev/null)"
  [ "$cuser" = "10001:10001" ] && ok "container runs non-root (User=$cuser)" || warn "container User=$cuser (expected 10001:10001)"
  [ "$cro" = "true" ] && ok "container rootfs is read-only" || warn "container rootfs is NOT read-only"
  echo "$ccaps" | grep -q 'ALL' && ok "container dropped ALL capabilities" || warn "cap drop not ALL ($ccaps)"
  echo "$ctmp" | grep -q '/tmp' && ok "container has a /tmp tmpfs (read-only rootfs workable)" || warn "/tmp tmpfs missing"
fi

http_get /api/setup/status
[ "$HTTP" = "200" ] || die "GET /api/setup/status returned $HTTP"
[ "$(jget "$RESP" needed)" = "True" ] || die "fresh box did not report setup required"
ok "fresh box reports setup required (no shipped credential)"

http_get /api/me
[ "$HTTP" = "503" ] && [ "$(jget "$RESP" setupRequired)" = "True" ] \
  && ok "every account API is refused until setup (/api/me → 503 setupRequired)" \
  || die "expected /api/me → 503 setupRequired, got $HTTP: $(cat "$RESP")"

http_get /
# -o /dev/null loses the body; re-check with headers
redir="$(curl -sS -o /dev/null -D - --max-time 10 "http://127.0.0.1:$PORT/" 2>/dev/null | tr -d '\r' | awk 'NR==1{print $2} /^Location:/{print $2}')"
echo "$redir" | grep -q '^302' && ok "GET / serves the 302 → /setup funnel" \
  || warn "GET / did not 302 to /setup (got: $(echo "$redir" | head -1))"

CSRF=""
http_post /api/setup "{\"username\":\"admin\",\"password\":\"$PASSWORD\",\"passwordConfirm\":\"$PASSWORD\",\"bind\":\"127.0.0.1\",\"port\":$PORT,\"tlsMode\":\"off\",\"gateway\":{\"id\":\"home\",\"name\":\"Home\",\"url\":\"ws://127.0.0.1:9\"}}"
[ "$HTTP" = "200" ] || die "POST /api/setup returned $HTTP: $(cat "$RESP")"
CSRF="$(jget "$RESP" csrfToken)"
grep -q 'portal_session' "$JAR" || die "setup did not return a session cookie"
ok "wizard created the admin + first gateway and returned a live session"

http_get /api/setup/status
[ "$(jget "$RESP" needed)" = "False" ] || die "setup did not close after completion"
http_get /api/me
[ "$HTTP" = "200" ] && [ "$(jget "$RESP" authed)" = "True" ] \
  && ok "setup closed; /api/me is authed as $(jget "$RESP" user.username)" \
  || die "expected an authed /api/me after setup, got $HTTP: $(cat "$RESP")"

# ── step 3: chat ────────────────────────────────────────────────────────────
step "chat — create a room, post a message, reload it from disk"
http_post /api/rooms '{"name":"E2E Room","agents":["home:assistant"],"mode":"rounds"}'
[ "$HTTP" = "200" ] || die "POST /api/rooms returned $HTTP: $(cat "$RESP")"
RID="$(jget "$RESP" room.id)"
ok "room created: $RID"

MSG="hello from the clean-box e2e run"
http_post "/api/rooms/$RID" "{\"action\":\"message\",\"text\":\"$MSG\"}"
[ "$HTTP" = "200" ] || die "room message returned $HTTP: $(cat "$RESP")"

http_get "/api/rooms/$RID"
[ "$HTTP" = "200" ] || die "GET room returned $HTTP"
grep -q "$MSG" "$RESP" && ok "message round-tripped through the live API (GET /api/rooms/$RID)" \
  || die "message not present in the room transcript"
grep -q "$MSG" "$BOX/portal-rooms.json" 2>/dev/null && ok "message persisted to portal-rooms.json on disk" \
  || die "message not persisted to the rooms store"

# ── step 4: upgrade ─────────────────────────────────────────────────────────
step "upgrade — rebuild + restart on the SAME state; state survives"
box_stop
if [ "$BACKEND" = "docker" ]; then
  docker build -q -t "$IMG" "$DIR" >/dev/null || die "rebuild failed"
  info "image rebuilt (upgrade = new code, same state)"
fi
# migrate.js must consider an already-fresh 3.x box a no-op (idempotent upgrade).
if [ -f "$DIR/migrate.js" ]; then
  set +e
  mig="$(node "$DIR/migrate.js" --dir "$BOX" --dry-run 2>&1)"; mrc=$?
  set -e
  case "$mrc" in
    2) ok "migrate.js --dry-run: already on the 3.x schema (exit 2, idempotent)" ;;
    0) ok "migrate.js --dry-run: planned 0 destructive changes on the current box" ;;
    *) warn "migrate.js --dry-run exited $mrc: $mig" ;;
  esac
fi
box_start

CSRF=""
http_post /api/login "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}"
[ "$HTTP" = "200" ] || die "admin login after restart returned $HTTP: $(cat "$RESP")"
CSRF="$(jget "$RESP" csrfToken)"
ok "admin still logs in after the restart (accounts survived the upgrade)"

http_get "/api/rooms/$RID"
[ "$HTTP" = "200" ] && grep -q "$MSG" "$RESP" \
  && ok "room transcript survived the upgrade" \
  || die "room transcript lost across the upgrade"

# ── step 5: restore ─────────────────────────────────────────────────────────
step "restore — encrypted backup → total loss → restore → sha256-identical"
PASSPHRASE_FILE="$WS/passphrase"
printf 'e2e-clean-box-passphrase\n' > "$PASSPHRASE_FILE"; chmod 600 "$PASSPHRASE_FILE"
mkdir -p "$BOX/backups"
PORTAL_BACKUP_ROOT="$BOX" bash "$DIR/backup.sh" create --with-secrets --out "$BOX/backups" \
  --passphrase-file "$PASSPHRASE_FILE" >"$LOGS/backup.log" 2>&1 \
  || { cat "$LOGS/backup.log" >&2; die "backup.sh create failed"; }
ARCH="$(ls -t "$BOX"/backups/cirrus-backup-*.* 2>/dev/null | grep -v '\.sha256$' | head -1)"
[ -n "$ARCH" ] && [ -f "$ARCH" ] || die "no backup archive produced"
ok "encrypted backup created: $(basename "$ARCH")"

# record the box's state hashes BEFORE the simulated loss
SUM_BEFORE="$WS/before.sums"; : > "$SUM_BEFORE"
for f in portal-config.json portal-users.json portal-rooms.json portal-secrets.json; do
  [ -f "$BOX/$f" ] && printf '%s  %s\n' "$(sha256sum "$BOX/$f" | awk '{print $1}')" "$f" >> "$SUM_BEFORE"
done

box_stop
info "simulating total loss of the box state"
rm -f "$BOX"/portal-config.json "$BOX"/portal-users.json "$BOX"/portal-rooms.json \
      "$BOX"/portal-secrets.json "$BOX"/portal-device.json "$BOX"/portal-context.json "$BOX"/portal-audit.log

PORTAL_BACKUP_ROOT="$BOX" bash "$DIR/backup.sh" restore "$ARCH" --passphrase-file "$PASSPHRASE_FILE" \
  >"$LOGS/restore.log" 2>&1 || { cat "$LOGS/restore.log" >&2; die "backup.sh restore failed"; }

SUM_AFTER="$WS/after.sums"; : > "$SUM_AFTER"
for f in portal-config.json portal-users.json portal-rooms.json portal-secrets.json; do
  [ -f "$BOX/$f" ] && printf '%s  %s\n' "$(sha256sum "$BOX/$f" | awk '{print $1}')" "$f" >> "$SUM_AFTER"
done
if diff -q "$SUM_BEFORE" "$SUM_AFTER" >/dev/null && [ -s "$SUM_AFTER" ]; then
  ok "restored config + users + rooms + secrets are sha256-identical to the originals"
else
  die "restore did not reproduce the original state:\n$(diff "$SUM_BEFORE" "$SUM_AFTER" || true)"
fi

# The restored files are root-owned; the non-root box needs them handed over.
chown 10001:10001 "$BOX"/portal-*.json "$BOX"/portal-audit.log 2>/dev/null || true
box_start
CSRF=""
http_post /api/login "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}"
[ "$HTTP" = "200" ] || die "login after restore returned $HTTP: $(cat "$RESP")"
ok "restored box boots and the admin logs in again"

http_get "/api/rooms/$RID"
grep -q "$MSG" "$RESP" && ok "restored box still serves the room transcript" \
  || die "room transcript missing after restore"

log "all steps passed. workspace: $WS"
