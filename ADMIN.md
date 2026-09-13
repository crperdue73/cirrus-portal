# Cirrus Portal — Administrator & Operations Runbook

**Audience:** whoever operates a Cirrus Portal install (the *operator*).
**Scope:** day-2 operations — install, upgrade, backup, restore, secrets,
users, gateways, TLS, logs, and recovery.

> New to the product? Start with [`README.md`](README.md) (quickstart).
> Choosing a host / deployment model? [`DEPLOYMENT.md`](DEPLOYMENT.md).
> First install on a new server? [`REPLICATION.md`](REPLICATION.md).
> Something broken? [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

All commands below assume you are in the release directory (the folder that
contains `install.sh` and `portal-server.js`).

---

## 1. Command surface

```
./install.sh install             # detect → configure → build → run
./install.sh upgrade             # rebuild from current code, keep all state
./install.sh migrate [--dry-run] # 2.x → 3.x schema migration (backup-first, no Docker)
./install.sh status              # scriptable health check (exit 0 = healthy, 1 = problems)
./install.sh doctor              # deep diagnostics (status + config, device, logs, disk)
./install.sh backup              # state + config snapshot → ./backups/
./install.sh restore FILE        # restore a snapshot tarball
./install.sh uninstall           # stop + remove the container (files kept)
./install.sh uninstall --purge   # …and delete config/state/credentials
./install.sh version             # print the version
```

Common flags (see `./install.sh --help` for the full list):

| Flag | Effect |
| --- | --- |
| `--domain HOST --email ADDR` | Public HTTPS via Caddy (automatic Let's Encrypt). Portal stays on loopback. |
| `--tls-cert PATH --tls-key PATH` | Serve HTTPS directly from the portal. |
| `--tls` | Require TLS (must pair with `--domain` or certs). |
| `--public` | Bind `0.0.0.0` instead of loopback (still needs TLS, or `--insecure-plaintext` on a trusted LAN). |
| `--insecure-plaintext` | Allow a public bind without TLS. Cleartext — LAN/tunnel only. |
| `--fresh` | Wipe local state before install (new server / factory reset). |
| `--firewall` | Open the right port(s) in `ufw` when it is active. |
| `--non-interactive` / `-y` | Never prompt. |
| `--dry-run` | Print the exact install plan; change nothing (needs no Docker). |

---

## 2. Install

```bash
# On the target server, from the unpacked release directory:
./install.sh install --domain portal.example.com --email ops@example.com
./install.sh status
```

The installer:

1. **Preflights** the host — OS (Debian/Ubuntu), > 500 MB free disk, the portal
   port, DNS for `--domain`, TLS:443 reachability, and firewall posture.
2. **Configures** `portal-config.json` (token-free) and `portal-secrets.json` (0600).
3. **Builds and starts** the container (`cirrus-portal`).
4. **Owns the state** — chowns bind-mounted files to `10001:10001` (the
   unprivileged runtime uid).
5. **Approves the device** on the gateway (skipped with `--no-approve`).
6. **Saves credentials** — a strong random admin password to
   `portal-credentials.txt` (0600) on a fresh install, unless you set
   `PORTAL_PASSWORD`.

> On any failure the installer **rolls back**: it snapshots config/secrets/state
> up front and restores the exact pre-install files, removing a freshly-built
> container. A failed install never leaves you half-configured.

### First login

- `http://127.0.0.1:18800` (loopback default — tunnel in over SSH), or
  `https://<domain>/` when installed with `--domain`.
- Username `admin`, password from `portal-credentials.txt`.
- A bare `node portal-server.js` with nothing configured starts in **setup
  mode** and serves a first-run wizard at `/setup` instead — you create the
  admin there with a strong password. There is no working default credential at
  any point.

**Change the admin password after first login** (Users → reset pw) and delete
`portal-credentials.txt` once it has been recorded in your password manager.

---

## 3. Health & diagnostics

```bash
./install.sh status        # exit code is the signal — safe in cron/monitoring
./install.sh doctor        # status + config, secrets mode, device identity, logs, disk
docker compose logs -f     # live container logs
```

`status`/`doctor` also detect a legacy `agent-portal` container from an earlier
release, so they keep working on un-migrated boxes (see
[`UPGRADING.md`](UPGRADING.md)).

What to watch:

- **Container health** — the image has a `HEALTHCHECK` that probes loopback
  `GET /healthz` (any 2xx/3xx is healthy; `200` even in setup mode).
- **Secrets file mode** — must be `0600`; `doctor` checks it.
- **State ownership** — bind-mounted files must be owned by `10001:10001`.

### Observability endpoints

| Endpoint | Meaning | Access |
| --- | --- | --- |
| `GET /healthz` | Liveness: `200 {"status":"ok"}` while the process serves (incl. setup mode). | open |
| `GET /readyz` | Readiness: `200` when serving; `503` (`setup_required`) until the wizard completes. Reports gateway/user counts. | open |
| `GET /metrics` | Prometheus text metrics. | loopback, or admin while `metricsPublic:false` |

```bash
curl -s http://127.0.0.1:18800/healthz
curl -s http://127.0.0.1:18800/readyz
curl -s http://127.0.0.1:18800/metrics | grep cirrus_portal_
```

**Logs.** The server emits one structured **JSON log line per request** (method,
path, status, `durationMs`, `requestId`, client IP) plus JSON event lines for
gateway/approval activity. Every response carries `X-Request-Id` (echo an
inbound `X-Request-Id` to correlate a client trace). Set `"logFormat": "text"`
for human-readable lines, or `"logRequests": false` to drop access logs; both
`PORTAL_LOG_FORMAT` and `PORTAL_LOG_QUIET=1` override per-container. `./install.sh
status`/`doctor` check the format and probe the three endpoints. Only the
counters in `/metrics` are in-process (reset on restart) — the durable record is
`portal-audit.log`.

### Verifying an install end-to-end

Before you trust a box (a new host, a new release, or after a big change), run
the clean-box verifier from the **source/release tree**:

```bash
./e2e-verify.sh --backend docker    # a throwaway hardened container
./e2e-verify.sh --backend process   # Docker-free: the "fresh VM" path
```

It installs a fresh instance in a throwaway workspace, completes the first-run
**wizard**, exercises **chat** (create a room + post a message + reload it from
disk), **upgrades** (rebuild + restart on the same state) and **restores** an
encrypted backup after a simulated total loss — then exits non-zero if any step
fails. It never touches a live install and removes everything it created
(`--keep` leaves the workspace for inspection). The same checks run in CI.

---

## 4. Backup & restore

Two layers, both shipped:

```bash
# Encrypted backups + disaster recovery (recommended) — ./backup.sh
./backup.sh create --init-passphrase      # one-time: generate the passphrase (0600)
./backup.sh create --with-secrets         # → backups/cirrus-backup-<stamp>.tar.gz.gpg
./backup.sh verify FILE                   # integrity-check, no live effect
./backup.sh restore FILE                  # verify → snapshot current → restore
./backup.sh drill                         # prove a clean-VM restore (RTO evidence)
sudo ./backup.sh schedule --install       # systemd timer (cron fallback printed)

# Quick state+config snapshot — ./install.sh backup
./install.sh backup                       # encrypted automatically when a passphrase is set
./install.sh restore FILE                 # accepts plain .tar.gz and encrypted .gpg/.enc
```

- **`./backup.sh` is the DR path.** `create --with-secrets` produces an
  **AES-256 encrypted** archive (`gpg`, or `openssl` where `gpg` is absent) that
  includes config, state, **gateway tokens and the device identity** — safe
  *because* the archive is encrypted. A plaintext snapshot never carries
  secrets.
- The passphrase resolves from `PORTAL_BACKUP_PASSPHRASE`, a passphrase file
  (`./portal-backup-passphrase`, 0600), or an interactive prompt — never the
  command line. **Store it off-box:** without it, backups are unrecoverable.
- `restore` verifies the archive first, snapshots the *current* state to
  `backups/pre-restore-<stamp>/`, then writes file-by-file. Rebuild your
  container with `./install.sh upgrade` afterward.
- **Back up before every upgrade and before any risky change.**
- Retention: `--keep N` keeps the newest N archives (the schedule uses 14).
  Keep one copy off-box; a same-disk backup does not survive disk loss.

See [`docs/DR-DRILL.md`](docs/DR-DRILL.md) for the RPO/RTO targets and the
clean-VM restore drill; [`UPGRADING.md`](UPGRADING.md) for the backup-first
upgrade drill.

---

## 5. Secrets

| File | Contents | Mode | Notes |
| --- | --- | --- | --- |
| `portal-config.json` | port, bind, gateways (no tokens), auth knobs | 600 | **TOKEN-FREE by design** |
| `portal-secrets.json` | gateway tokens + first-run admin password | 600 | Never committed, backed up, or shipped |
| `portal-device.json` | persistent Ed25519 device identity | 600 | Must persist; re-approve if lost |
| `portal-users.json` | local accounts + roles (scrypt-hashed) | 600 | |
| `portal-credentials.txt` | one-time generated admin password | 600 | Delete after recording |

Rules:

- **Rotate a gateway token** by updating `portal-secrets.json` (or
  `PORTAL_GATEWAY_TOKEN_<ID>` in the environment) and restarting. Token
  precedence: env → secrets file → legacy config `token` (auto-migrated on boot,
  then stripped) → `GATEWAY_TOKEN`.
- **Never** copy one install's `portal-secrets.json` / `portal-device.json` to
  another — that breaks the per-install trust model (see
  [`DEPLOYMENT.md`](DEPLOYMENT.md)).
- Run `./secret-scan.sh` before publishing anything from the tree; it greps the
  repo and a built tarball for tokens, keys, device seeds, and forbidden state
  files.

---

## 6. Users & roles

Three roles, enforced server-side on every endpoint:

| Role | Sees | Can do |
| --- | --- | --- |
| `admin` | all agents | everything + manage accounts + view the audit log |
| `instructor` | all agents | chat + student roster view |
| `student` | assigned agents only | chat with those agents |

- Manage accounts in the UI (**Users**) — create, set assigned agents (`*` = all),
  reset password, delete.
- Passwords must clear the policy everywhere: **12+ chars**, upper + lower + a
  number, not the username, not a known default, not on the common-password
  blocklist.
- A password reset revokes all of that user's live sessions. `log out all`
  (sidebar footer) revokes every session for the current account.
- Every account/agent/context change is appended to `portal-audit.log`.

---

## 7. Gateways

Add, edit, enable/disable, and remove gateway servers from the UI
(**Gateways**, admin) — no config editing, no restart.

- Tokens are **write-only** in the API: it returns `hasToken`, never the token.
- Adding a gateway connects immediately; URL/token edits reconnect; disabling
  stops it (its agents disappear); enabling restarts it.
- Changes persist to `portal-config.json` (`.bak` kept) with any token going to
  `portal-secrets.json`.
- Each gateway must approve the portal device once (`openclaw devices approve`).

---

## 8. TLS & public exposure

Three supported ways to expose the portal publicly:

```bash
# 1. Automatic HTTPS (recommended) — Caddy, automatic Let's Encrypt:
./install.sh install --domain portal.example.com --email you@example.com

# 2. Bring your own certificate — the portal serves HTTPS itself:
./install.sh install --tls-cert /etc/ssl/fullchain.pem --tls-key /etc/ssl/privkey.pem

# 3. Your own TLS-terminating proxy + trustProxy:true
#    (nginx template: deploy/nginx/cirrus-portal.conf)
```

- **The portal refuses a public bind without TLS** unless `--insecure-plaintext`
  is passed explicitly (loudly warned; LAN/tunnel only).
- When TLS is in play, session cookies are `Secure; HttpOnly; SameSite=Strict`
  and responses carry HSTS.
- Caddy renews certificates automatically. If you front the portal with your own
  proxy, wire renewal yourself and make sure `X-Forwarded-Proto` is forwarded.
- Firewall: `--firewall` opens 80/443 with `--domain`, else the portal port;
  loopback-only installs need no inbound rule.

---

## 9. Routine operations

| Task | Do this |
| --- | --- |
| Restart | `docker compose restart` |
| Rebuild after a code change | `./install.sh upgrade` |
| Tail logs | `docker compose logs -f` |
| Back up now | `./install.sh backup` |
| Rotate a gateway token | edit `portal-secrets.json` → restart |
| Reset a forgotten admin password | `./install.sh restore` a known-good backup, or restore `portal-users.json` from backup |
| Free disk / audit growth | archive + truncate `portal-audit.log` (it is append-only) |
| Change bind/port/TLS | edit `portal-config.json` (or re-run the installer) → restart |
| Remove the install | `./install.sh uninstall` (keeps files) or `--purge` |

The container runs **non-root** (`10001:10001`), **read-only** root filesystem,
with dropped capabilities, memory/CPU/PID limits, and `restart: unless-stopped`
(survives reboots).

---

## 10. Incident basics

1. **Suspect a compromise** — stop the container (`docker compose down`), rotate
   the gateway token(s) and the admin password, review `portal-audit.log`, and
   re-approve the device only after rotation.
2. **Lost device identity** — the gateway no longer recognizes the portal;
   re-approve the device (`openclaw devices approve`) on each gateway.
3. **Locked out** — logins are rate-limited with progressive lockout. Wait out
   `loginLockoutSeconds`, or restore a known-good `portal-users.json`.
4. **Reporting a vulnerability** — see [`SECURITY.md`](SECURITY.md). Do not open
   a public issue.

---

*This runbook tracks the v3.0.0 public release. If a command here disagrees with
`./install.sh --help`, the installer is authoritative — file a docs bug.*
