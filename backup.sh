#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Cirrus Portal — encrypted backup, restore & disaster-recovery helper
#  ───────────────────────────────────────────────────────────────────────────
#  Plan item 17: encrypted backups, a scheduled-backup helper, and a
#  documented restore drill with stated RPO/RTO.
#
#  Dependency-light: tar/gzip + gpg (preferred, authenticated AES-256) or
#  openssl (universally present). No Node, no Docker, no network.
#
#  Commands:
#    ./backup.sh create [--with-secrets] [--out DIR] [--keep N]
#                       [--init-passphrase] [--passphrase-file F]
#        Snapshot config + state and encrypt →
#        backups/cirrus-backup-<stamp>.tar.gz.{gpg,enc}  (+ .sha256 sidecar)
#        --with-secrets also captures portal-secrets.json + portal-device.json
#        (+ portal-credentials.txt). Safe *because* the archive is encrypted —
#        that is what makes this a complete disaster-recovery artifact.
#
#    ./backup.sh verify  FILE [--passphrase-file F]
#        Decrypt + integrity-check an archive (cipher hash → SHA256SUMS →
#        manifest) without touching any live state. Exit 0 = restorable.
#
#    ./backup.sh restore FILE [--passphrase-file F] [--build]
#        Verify, snapshot the CURRENT state (backups/pre-restore-<stamp>/),
#        then restore atomically, file by file. Rebuilds the container only
#        with --build; otherwise prints the next step (`./install.sh upgrade`).
#
#    ./backup.sh drill [--source DIR] [--passphrase-file F]
#        Clean-VM restore drill in a throwaway dir: fixture → create →
#        (simulated) total loss → restore → sha256-compare every file. Prints
#        PASS/FAIL and the *measured* restore wall-clock (the local RTO
#        evidence). Never touches the live tree.
#
#    ./backup.sh schedule [--install|--remove] [--interval 15min]
#                         [--keep N] [--passphrase-file F]
#        Print (default) or install a systemd timer + cron fallback that runs
#        `create --with-secrets --keep N` on a schedule. Installing/removing
#        needs root and is always explicit.
#
#  Passphrase resolution (never on the command line):
#    --passphrase-file F  →  $PORTAL_BACKUP_PASSPHRASE_FILE  →
#    $PORTAL_BACKUP_PASSPHRASE  →  $ROOT/portal-backup-passphrase (0600)  →
#    interactive prompt (TTY only). Run `create --init-passphrase` to generate
#    a strong one into ./portal-backup-passphrase.
#
#  Cipher: gpg --symmetric (AES-256, authenticated) when available, else
#    openssl enc -aes-256-cbc -pbkdf2. Force with PORTAL_BACKUP_CIPHER=gpg|openssl.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── identity (from the single source of truth) ──────────────────────────────
PRODUCT="$(sed -n 's/.*"product"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DIR/branding.json" 2>/dev/null | head -1)"
PRODUCT="${PRODUCT:-Cirrus Portal}"
VERSION="$(cat "$DIR/VERSION" 2>/dev/null || echo 0.0.0)"
PREFIX="cirrus-backup"
PASSPHRASE_BASENAME="portal-backup-passphrase"

# ── state layout (mirrors install.sh) ───────────────────────────────────────
CONFIG_FILE="portal-config.json"
SECRETS_FILE="portal-secrets.json"
DEVICE_FILE="portal-device.json"
USERS_FILE="portal-users.json"
CONTEXT_FILE="portal-context.json"
ROOMS_FILE="portal-rooms.json"
AUDIT_FILE="portal-audit.log"
CRED_FILE="portal-credentials.txt"
# STATE_FILES mirror install.sh (config + state incl. device identity).
# SECRET_FILES are the *additional* secret material only pulled in with
# --with-secrets, because the archive is encrypted.
STATE_FILES=("$CONFIG_FILE" "$DEVICE_FILE" "$USERS_FILE" "$CONTEXT_FILE" "$ROOMS_FILE" "$AUDIT_FILE")
SECRET_FILES=("$SECRETS_FILE" "$CRED_FILE")

# ROOT is where the deploy lives (state is read from / written to here).
# The drill overrides it to point at its throwaway fixture / clean VM.
ROOT="${PORTAL_BACKUP_ROOT:-$DIR}"
LAST_BACKUP=""

# ── colors + log helpers ────────────────────────────────────────────────────
if [ -t 1 ]; then C_BLU=$'\033[36m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_RST=$'\033[0m'
else C_BLU=""; C_GRN=""; C_YEL=""; C_RED=""; C_RST=""; fi
log()  { printf '%s[%s]%s %s\n' "$C_BLU" "$PRODUCT" "$C_RST" "$*"; }
ok()   { printf '%s[✓]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
info() { printf '%s[·]%s %s\n' "$C_BLU" "$C_RST" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_YEL" "$C_RST" "$*" >&2; }
die()  { printf '%s[✗]%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

usage() { awk 'NR>1 { if ($0 !~ /^#/ && $0 !~ /^[[:space:]]*$/) exit; sub(/^# ?/, ""); print }' "$0"; }

# ── argument parsing ────────────────────────────────────────────────────────
CMD=""
WITH_SECRETS=0
OUT_DIR=""
KEEP=0
INIT_PASSPHRASE=0
PASSPHRASE_FILE_OPT=""
SRC_DIR=""
DO_BUILD=0
SCHED_ACTION="print"
INTERVAL="15min"
FILE_ARG=""

CMD="${1:-}"
case "$CMD" in
  create|verify|restore|drill|schedule) shift ;;
  -h|--help|help|"") usage; exit 0 ;;
  *) die "unknown command: $CMD (try --help)" ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --with-secrets)    WITH_SECRETS=1 ;;
    --out)             OUT_DIR="${2:-}"; shift ;;
    --keep)            KEEP="${2:-0}"; shift ;;
    --init-passphrase) INIT_PASSPHRASE=1 ;;
    --passphrase-file) PASSPHRASE_FILE_OPT="${2:-}"; shift ;;
    --source)          SRC_DIR="${2:-}"; shift ;;
    --build)           DO_BUILD=1 ;;
    --interval)        INTERVAL="${2:-15min}"; shift ;;
    --install)         SCHED_ACTION="install" ;;
    --remove)          SCHED_ACTION="remove" ;;
    -h|--help)         usage; exit 0 ;;
    --)                shift; [ $# -gt 0 ] && FILE_ARG="$1" ;;
    -*)                die "unknown option: $1" ;;
    *)                 FILE_ARG="$1" ;;
  esac
  shift || true
done

# ── sha256 helper (sha256sum, else openssl) ─────────────────────────────────
sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'; fi
}

verify_sums() { # dir-with-SHA256SUMS
  if have sha256sum; then
    ( cd "$1" && sha256sum -c SHA256SUMS >/dev/null 2>&1 )
  else
    ( cd "$1" && while read -r h p; do [ -n "${p:-}" ] || continue; \
        [ "$(sha256_of "$p")" = "$h" ] || exit 1; done <SHA256SUMS )
  fi
}

# ── cipher selection ────────────────────────────────────────────────────────
CIPHER="${PORTAL_BACKUP_CIPHER:-}"
[ -z "$CIPHER" ] && { if have gpg; then CIPHER=gpg; else CIPHER=openssl; fi; }
case "$CIPHER" in gpg|openssl) : ;; *) die "PORTAL_BACKUP_CIPHER must be gpg or openssl" ;; esac
EXT="$([ "$CIPHER" = gpg ] && echo gpg || echo enc)"
have "$CIPHER" || die "$CIPHER is required (install it, or set PORTAL_BACKUP_CIPHER=openssl)"

cipher_for_file() { # file → sets CIPHER/EXT
  case "$1" in
    *.gpg) CIPHER=gpg; EXT=gpg ;;
    *.enc) CIPHER=openssl; EXT=enc ;;
    *) die "cannot tell the cipher from '$1' (expected .gpg or .enc)" ;;
  esac
  have "$CIPHER" || die "$CIPHER is required to open $1"
}

# ── passphrase ──────────────────────────────────────────────────────────────
WORK=""
PF_TMP=""
cleanup() {
  if [ -n "${PF_TMP:-}" ]; then rm -f "$PF_TMP"; fi
  if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi
  return 0
}
trap cleanup EXIT

resolve_passphrase() {
  local pf=""
  [ -n "$PASSPHRASE_FILE_OPT" ] && pf="$PASSPHRASE_FILE_OPT"
  [ -z "$pf" ] && [ -n "${PORTAL_BACKUP_PASSPHRASE_FILE:-}" ] && pf="$PORTAL_BACKUP_PASSPHRASE_FILE"
  if [ -z "$pf" ] && [ -f "$ROOT/$PASSPHRASE_BASENAME" ]; then pf="$ROOT/$PASSPHRASE_BASENAME"; fi

  [ -n "$WORK" ] || { WORK="$(mktemp -d)"; chmod 700 "$WORK"; }
  mkdir -p "$WORK/gnupg"; chmod 700 "$WORK/gnupg"
  PF_TMP="$WORK/passphrase"

  if [ -n "$pf" ]; then
    [ -f "$pf" ] || die "passphrase file not found: $pf"
    cat "$pf" >"$PF_TMP"
  elif [ -n "${PORTAL_BACKUP_PASSPHRASE:-}" ]; then
    printf '%s' "$PORTAL_BACKUP_PASSPHRASE" >"$PF_TMP"
  elif [ -t 0 ]; then
    local pw; printf 'Backup passphrase: ' >&2; IFS= read -rs pw; printf '\n' >&2
    printf '%s' "$pw" >"$PF_TMP"
  else
    die "no backup passphrase. Set PORTAL_BACKUP_PASSPHRASE, write $ROOT/$PASSPHRASE_BASENAME, or run: ./backup.sh create --init-passphrase"
  fi
  chmod 600 "$PF_TMP"
  [ -s "$PF_TMP" ] || die "empty backup passphrase refused"
}

init_passphrase() {
  local f="$ROOT/$PASSPHRASE_BASENAME"
  [ -f "$f" ] && { info "passphrase file already exists: $f"; return 0; }
  local pw
  if have openssl; then pw="$(openssl rand -base64 32 | tr -d '\n')"; else pw="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"; fi
  ( umask 077; printf '%s\n' "$pw" >"$f" )
  chmod 600 "$f"
  ok "generated a backup passphrase → $f (0600)"
  warn "STORE IT OFF-BOX — without this passphrase, encrypted backups are unrecoverable."
}

# ── encrypt / decrypt ───────────────────────────────────────────────────────
encrypt_file() { # in out
  local in="$1" out="$2"
  if [ "$CIPHER" = gpg ]; then
    GNUPGHOME="$WORK/gnupg" gpg --batch --yes --quiet --no-tty \
      --passphrase-file "$PF_TMP" --symmetric --cipher-algo AES256 \
      --s2k-mode 3 --s2k-count 65011712 --compress-algo none \
      --output "$out" "$in"
  else
    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -md sha256 \
      -pass file:"$PF_TMP" -in "$in" -out "$out"
  fi
  chmod 600 "$out"
}

decrypt_file() { # in out
  local in="$1" out="$2"
  if [ "$CIPHER" = gpg ]; then
    GNUPGHOME="$WORK/gnupg" gpg --batch --yes --quiet --no-tty \
      --passphrase-file "$PF_TMP" --decrypt --output "$out" "$in" 2>/dev/null \
      || die "decryption failed (wrong passphrase, or the archive is corrupt)"
  else
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
      -pass file:"$PF_TMP" -in "$in" -out "$out" 2>/dev/null \
      || die "decryption failed (wrong passphrase, or the archive is corrupt)"
  fi
}

# ── create ──────────────────────────────────────────────────────────────────
do_create() {
  [ "$INIT_PASSPHRASE" = 1 ] && init_passphrase
  resolve_passphrase
  local bdir="${OUT_DIR:-$ROOT/backups}"
  mkdir -p "$bdir"; chmod 700 "$bdir" 2>/dev/null || true

  local stage="$WORK/stage"; mkdir -p "$stage/state"
  local present=0
  : >"$stage/SHA256SUMS"
  for f in "${STATE_FILES[@]}"; do
    if [ -e "$ROOT/$f" ]; then
      cp -a "$ROOT/$f" "$stage/state/$f"; present=$((present+1))
      printf '%s  %s\n' "$(sha256_of "$stage/state/$f")" "state/$f" >>"$stage/SHA256SUMS"
    fi
  done
  [ "$present" -gt 0 ] || die "nothing to back up — no state found in $ROOT"

  local secret_count=0
  if [ "$WITH_SECRETS" = 1 ]; then
    mkdir -p "$stage/secrets"
    for f in "${SECRET_FILES[@]}"; do
      if [ -e "$ROOT/$f" ]; then
        cp -a "$ROOT/$f" "$stage/secrets/$f"; secret_count=$((secret_count+1))
        printf '%s  %s\n' "$(sha256_of "$stage/secrets/$f")" "secrets/$f" >>"$stage/SHA256SUMS"
      fi
    done
  fi

  cat >"$stage/MANIFEST.json" <<EOF
{
  "product": "$PRODUCT",
  "version": "$VERSION",
  "format": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname 2>/dev/null || echo unknown)",
  "cipher": "$CIPHER",
  "includesSecrets": $([ "$WITH_SECRETS" = 1 ] && echo true || echo false),
  "stateFiles": $present,
  "secretFiles": $secret_count
}
EOF
  printf '%s  %s\n' "$(sha256_of "$stage/MANIFEST.json")" "MANIFEST.json" >>"$stage/SHA256SUMS"

  local stamp enc tarball
  stamp="$(date +%Y%m%d-%H%M%S)"
  enc="$bdir/$PREFIX-$stamp.tar.gz.$EXT"
  tarball="$WORK/plain.tar.gz"
  ( cd "$stage" && tar czf "$tarball" . ) || die "tar failed"
  encrypt_file "$tarball" "$enc"
  sha256_of "$enc" >"$enc.sha256"; chmod 600 "$enc.sha256"
  LAST_BACKUP="$enc"

  ok "backup written: $enc ($(du -h "$enc" | cut -f1))"
  info "cipher: $CIPHER · state files: $present · secret files: $secret_count"
  if [ "$secret_count" -gt 0 ]; then
    warn "this backup CONTAINS SECRET MATERIAL — the archive is encrypted; guard the passphrase like a root key."
  else
    info "gateway tokens / device identity are NOT in this backup (add --with-secrets for a full DR image)."
  fi
  info "verify anytime with:  ./backup.sh verify $enc"

  if [ "${KEEP:-0}" -gt 0 ] 2>/dev/null; then
    local old
    old="$(ls -1t "$bdir"/$PREFIX-*.tar.gz."$EXT" 2>/dev/null | tail -n +$((KEEP+1)) || true)"
    if [ -n "$old" ]; then
      while IFS= read -r o; do [ -n "$o" ] || continue; info "prune: $(basename "$o")"; rm -f "$o" "$o.sha256"; done <<<"$old"
    fi
  fi
}

# ── verify (internal: assumes CIPHER/PF_TMP/WORK set) ───────────────────────
_verify_archive() { # enc
  local enc="$1"
  if [ -f "$enc.sha256" ]; then
    local want got; want="$(cat "$enc.sha256")"; got="$(sha256_of "$enc")"
    [ "$want" = "$got" ] || die "ciphertext hash mismatch — the archive is corrupt or was tampered with"
    info "ciphertext sha256 ok"
  else
    warn "no .sha256 sidecar next to $(basename "$enc") — skipping the ciphertext-corruption check"
  fi

  local tarball="$WORK/verify.tar.gz" vdir="$WORK/verify"
  rm -rf "$vdir"; mkdir -p "$vdir"
  decrypt_file "$enc" "$tarball"
  tar xzf "$tarball" -C "$vdir" || die "archive is not a valid tar.gz after decryption"
  [ -f "$vdir/SHA256SUMS" ] || die "archive is missing SHA256SUMS — refusing to trust it"
  verify_sums "$vdir" || die "file hashes do not match SHA256SUMS — archive failed integrity check"
  [ -f "$vdir/MANIFEST.json" ] || die "archive is missing MANIFEST.json"

  local n; n="$(grep -c '  ' "$vdir/SHA256SUMS" || true)"
  ok "verified: $n file(s) intact (cipher $CIPHER)"
  sed -n 's/.*"createdAt":[[:space:]]*"\([^"]*\)".*/· created: \1/p' "$vdir/MANIFEST.json" || true
}

do_verify() {
  local enc="$1"
  [ -f "$enc" ] || die "archive not found: $enc"
  cipher_for_file "$enc"
  resolve_passphrase
  _verify_archive "$enc"
}

# ── restore ─────────────────────────────────────────────────────────────────
do_restore() {
  local enc="$1"
  [ -f "$enc" ] || die "archive not found: $enc"
  cipher_for_file "$enc"
  resolve_passphrase
  _verify_archive "$enc"
  local vdir="$WORK/verify"

  local pre="$ROOT/backups/pre-restore-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$pre"; chmod 700 "$pre"
  local saved=0
  for f in "${STATE_FILES[@]}" "${SECRET_FILES[@]}"; do
    if [ -e "$ROOT/$f" ]; then cp -p "$ROOT/$f" "$pre/$f"; saved=$((saved+1)); fi
  done
  info "pre-restore snapshot: $pre ($saved file(s))"

  local restored=0
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in MANIFEST.json|SHA256SUMS) continue ;; esac
    local base="${rel#state/}"; base="${base#secrets/}"
    local src="$vdir/$rel" dst="$ROOT/$base"
    [ -f "$src" ] || continue
    local mode; mode="$(stat -c '%a' "$src" 2>/dev/null || echo 600)"
    cp -p "$src" "$dst.tmp.$$" && mv -f "$dst.tmp.$$" "$dst"
    chmod "$mode" "$dst" 2>/dev/null || chmod 600 "$dst"
    restored=$((restored+1))
  done < <(awk '{print $2}' "$vdir/SHA256SUMS")

  ok "restored $restored file(s) into $ROOT"
  if grep -q '"includesSecrets": false' "$vdir/MANIFEST.json"; then
    warn "this archive had NO secrets — re-provide gateway tokens (GATEWAY_TOKEN=…) or restore portal-secrets.json separately."
  fi
  if [ "$DO_BUILD" = 1 ]; then
    info "rebuilding container…"
    ( cd "$ROOT" && ./install.sh upgrade )
  else
    info "next: rebuild when ready →  ./install.sh upgrade"
  fi
}

# ── drill ───────────────────────────────────────────────────────────────────
make_fixture() { # destdir → echoes file count
  local d="$1" src="${SRC_DIR:-$ROOT}" n=0
  mkdir -p "$d"
  for f in "${STATE_FILES[@]}" "${SECRET_FILES[@]}"; do
    if [ -e "$src/$f" ]; then cp -p "$src/$f" "$d/$f"; n=$((n+1)); fi
  done
  if [ "$n" -eq 0 ]; then
    # No live state (e.g. a CI checkout) — synthesize a minimal fixture so the
    # drill still exercises the real snapshot → wipe → restore path.
    printf '{\n  "port": 18800,\n  "bind": "127.0.0.1",\n  "schemaVersion": 3,\n  "gateways": []\n}\n' >"$d/$CONFIG_FILE"
    printf '{\n  "users": [\n    { "username": "drill-admin", "role": "admin", "passwordHash": "scrypt$EXAMPLE" }\n  ]\n}\n' >"$d/$USERS_FILE"
    printf '{\n  "rooms": []\n}\n' >"$d/$ROOMS_FILE"
    printf '{"gateways":{"home":{"token":"EXAMPLE-gateway-token-0000"}}}\n' >"$d/$SECRETS_FILE"
    n=4
  fi
  echo "$n"
}

do_drill() {
  local ws fix vm; ws="$(mktemp -d)"; fix="$ws/fixture"; vm="$ws/clean-vm"; mkdir -p "$fix" "$vm"
  info "drill workspace: $ws (throwaway — the live tree is untouched)"

  local src_count; src_count="$(make_fixture "$fix")"
  info "fixture: $src_count file(s) from ${SRC_DIR:-$ROOT}"
  printf 'drill-EXAMPLE-passphrase\n' >"$fix/$PASSPHRASE_BASENAME"
  chmod 600 "$fix/$PASSPHRASE_BASENAME"

  # 1. snapshot + encrypt (from the fixture)
  ROOT="$fix"; OUT_DIR="$fix/backups"; WITH_SECRETS=1; PASSPHRASE_FILE_OPT="$fix/$PASSPHRASE_BASENAME"
  do_create
  local enc="$LAST_BACKUP"
  info "backup: $(basename "$enc") ($(du -h "$enc" | cut -f1))"

  # 1b. record the originals' hashes (they are about to be lost)
  local orig="$ws/orig.sums"; : >"$orig"
  local f
  for f in "${STATE_FILES[@]}" "${SECRET_FILES[@]}"; do
    [ -f "$fix/$f" ] && printf '%s  %s\n' "$(sha256_of "$fix/$f")" "$f" >>"$orig"
  done

  # 2. simulate total loss — the fixture state is gone, only the archive survives
  rm -f "$fix"/$CONFIG_FILE "$fix"/$USERS_FILE "$fix"/$ROOMS_FILE "$fix"/$CONTEXT_FILE \
        "$fix"/$AUDIT_FILE "$fix"/$DEVICE_FILE "$fix"/$SECRETS_FILE "$fix"/$CRED_FILE
  info "simulated loss: fixture state wiped"

  # 3. restore into a clean dir (the "fresh VM") and time it (RTO evidence)
  ROOT="$vm"; DO_BUILD=0
  local t0 t1; t0="$(date +%s.%N 2>/dev/null || date +%s)"
  do_restore "$enc"
  t1="$(date +%s.%N 2>/dev/null || date +%s)"

  # 4. compare every restored file against the recorded originals
  local files=0 bad=0 h p
  while read -r h p; do
    [ -n "${p:-}" ] || continue
    files=$((files+1))
    [ "$(sha256_of "$vm/$p" 2>/dev/null)" = "$h" ] || bad=$((bad+1))
  done <"$orig"
  local elapsed; elapsed="$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}' 2>/dev/null || echo '?')"
  if [ "$files" -gt 0 ] && [ "$bad" -eq 0 ]; then
    ok "drill PASS — $files file(s) restored sha256-identical; measured restore = ${elapsed}s"
  else
    die "drill FAIL — $bad/$files file(s) differ after restore"
  fi
  rm -rf "$ws"
}

# ── schedule ────────────────────────────────────────────────────────────────
on_calendar() {
  case "$INTERVAL" in
    15min|15m)           echo '*:0/15' ;;
    30min|30m)           echo '*:0/30' ;;
    hourly|60min|1h|60m) echo 'hourly' ;;
    daily|24h|day)       echo 'daily' ;;
    */*|*|weekly)        echo "$INTERVAL" ;;   # already a systemd calendar expr
    *) die "unsupported --interval: $INTERVAL (15min|30min|hourly|daily|<systemd calendar>)" ;;
  esac
}

cron_expr() {
  case "$INTERVAL" in
    15min|15m)           echo '*/15 * * * *' ;;
    30min|30m)           echo '*/30 * * * *' ;;
    hourly|60min|1h|60m) echo '0 * * * *' ;;
    daily|24h|day)       echo '17 3 * * *' ;;
    *)                   echo '*/15 * * * *' ;;
  esac
}

do_schedule() {
  local unit_dir="/etc/systemd/system"
  local svc="$unit_dir/cirrus-portal-backup.service"
  local tmr="$unit_dir/cirrus-portal-backup.timer"
  local cal; cal="$(on_calendar)"
  local keep="${KEEP:-14}"; [ "$keep" -gt 0 ] 2>/dev/null || keep=14

  local svc_body tmr_body
  svc_body="[Unit]
Description=Cirrus Portal encrypted backup
Documentation=file:$DIR/ADMIN.md
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
Environment=PORTAL_BACKUP_PASSPHRASE_FILE=$DIR/$PASSPHRASE_BASENAME
ExecStart=$DIR/backup.sh create --with-secrets --keep $keep
Nice=10
IOSchedulingClass=best-effort
"
  tmr_body="[Unit]
Description=Run Cirrus Portal backup ($INTERVAL)

[Timer]
OnCalendar=$cal
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
"
  local cron_line="$(cron_expr) root cd $DIR && PORTAL_BACKUP_PASSPHRASE_FILE=$DIR/$PASSPHRASE_BASENAME $DIR/backup.sh create --with-secrets --keep $keep >> $DIR/backup.log 2>&1 # cirrus-portal-backup"

  case "$SCHED_ACTION" in
    print)
      log "systemd timer (recommended) — write these two units and enable the timer:"
      printf -- '--- %s ---\n%s\n--- %s ---\n%s\n' "$svc" "$svc_body" "$tmr" "$tmr_body"
      log "cron fallback (/etc/cron.d/cirrus-portal-backup):"
      printf '%s\n' "$cron_line"
      log "or install automatically (needs root):  sudo ./backup.sh schedule --install --interval $INTERVAL"
      log "RPO with this schedule = one interval ($INTERVAL)." ;;
    install)
      [ "$(id -u)" = 0 ] || die "installing the schedule needs root (use sudo)"
      command -v systemctl >/dev/null 2>&1 || die "systemd not found — use the cron line printed by './backup.sh schedule'"
      printf '%s' "$svc_body" >"$svc"; printf '%s' "$tmr_body" >"$tmr"; chmod 644 "$svc" "$tmr"
      systemctl daemon-reload
      systemctl enable --now cirrus-portal-backup.timer
      ok "installed + started cirrus-portal-backup.timer (OnCalendar=$cal)"
      info "RPO = one interval ($INTERVAL). Check: systemctl list-timers cirrus-portal-backup.timer" ;;
    remove)
      [ "$(id -u)" = 0 ] || die "removing the schedule needs root (use sudo)"
      systemctl disable --now cirrus-portal-backup.timer 2>/dev/null || true
      rm -f "$svc" "$tmr"
      systemctl daemon-reload 2>/dev/null || true
      ok "removed cirrus-portal-backup.{service,timer}" ;;
  esac
}

# ── dispatch ────────────────────────────────────────────────────────────────
case "$CMD" in
  create)  do_create ;;
  verify)  [ -n "$FILE_ARG" ] || die "usage: ./backup.sh verify FILE"; do_verify "$FILE_ARG" ;;
  restore) [ -n "$FILE_ARG" ] || die "usage: ./backup.sh restore FILE"; do_restore "$FILE_ARG" ;;
  drill)   do_drill ;;
  schedule) do_schedule ;;
esac
