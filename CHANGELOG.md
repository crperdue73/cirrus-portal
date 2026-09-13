# Changelog

All notable changes to **Cirrus Portal** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version lines: `2.x` (internal/pre-release) and `3.x` (first public release line).

## [Unreleased]

## [3.0.0] — unreleased

The first public release. Everything below is the hardening pass that turns the
internal 2.x console into a self-hosted product people can install on their own
box without shooting themselves in the foot.

### Added
- **First-run setup wizard** (`/setup`) — a fresh box with no accounts serves a
  browser wizard to create the admin, choose bind/port, pick TLS intent, and add
  the first gateway. Until it completes, every other route returns `503`.
- **`portal-secrets.json` (0600)** — a dedicated secrets store for gateway
  tokens and bootstrap credentials; config files are now token-free.
- **`secret-scan.sh`** — greps the repo, a staged dir, or a built tarball for
  leaked tokens/keys/state files; wired into `release.sh` and CI.
- **TLS + reverse-proxy by default** — shipped `deploy/Caddyfile` and
  `deploy/nginx/cirrus-portal.conf`; automatic HTTPS via `--domain`; HSTS and
  80→443 redirect.
- **Auth hardening** — CSRF tokens on all state-changing requests, session
  rotation on login, `logout-all`, configurable TTL/idle expiry, login
  rate-limit + progressive lockout, and a password policy enforced everywhere.
- **Safe network defaults** — default bind `127.0.0.1`; a public bind needs an
  explicit opt-in flag *and* TLS; `ufw` helper (`--firewall`).
- **Container hardening** — digest-pinned base image, non-root user (uid 10001),
  `HEALTHCHECK`, read-only root filesystem, dropped capabilities, resource
  limits.
- **Observability** — `/healthz` + `/readyz` probes, `/metrics` (Prometheus
text), per-request `X-Request-Id`, and structured JSON request logs
(`logFormat`, `logRequests`, `metricsPublic`); wired into `install.sh status` /
`doctor`.
- **Encrypted backups & disaster recovery** — a `backup.sh` helper:
  `create --with-secrets` (AES-256 archive incl. gateway tokens + device
  identity), `verify` (cipher hash → `SHA256SUMS` → manifest), `restore`
  (verify → snapshot current → atomic write), `drill` (proves a clean-VM
  restore and reports the measured RTO), and `schedule` (systemd timer + cron
  fallback). `./install.sh backup` encrypts automatically when a backup
  passphrase is set; RPO/RTO targets and the drill live in
  [`docs/DR-DRILL.md`](docs/DR-DRILL.md).
- **Public installer v3** — `--domain`, `--tls`, `--public`, `--non-interactive`,
  `--dry-run`, rollback-on-failure, and extended preflight (DNS/TLS/firewall).
- **Public documentation set** — README quickstart plus `ADMIN.md`,
  `DEPLOYMENT.md`, `THREAT-MODEL.md`, `UPGRADING.md`, `TROUBLESHOOTING.md`,
  `REPLICATION.md`, and a reproducible screenshot pass.
- **Test suite + CI** — `node:test` suites (auth, RBAC, rooms, config, route
  smoke) plus standalone smoke tests, `run-tests.sh`, `lint.sh`, and a GitHub
  Actions pipeline (lint → test → secret-scan → release artifact).
- **Release engineering (this item)** — reproducible tarball build, an SBOM,
  optional GPG-signed checksums, a `CHANGELOG.md`, semver tagging, and a written
  publish checklist (`RELEASING.md`).
- **2.x → 3.x migrator** (`migrate.js` / `./install.sh migrate`) — backup-first,
  `--dry-run`-able config-schema migration (legacy tokens + `portalPassword`
  into `portal-secrets.json`, 3.x keys, `schemaVersion` stamp), known-default
  credential rotation, legacy-role mapping, and fail-closed re-exposure of a
  previously-cleartext public bind.

### Changed
- **Official name: `Cirrus Portal`** (was "Agent Portal"). Slug/container
  renamed `agent-portal` → `cirrus-portal`; legacy container names are still
  detected for un-migrated boxes.
- Installer now defaults to a **loopback bind**, generates a **unique admin
  password**, and refuses to run on known-default credentials.

### Security
- Removed all shipped default/shared credentials (`admin`/`admin`, the shared
  `perdue-portal-2026` bootstrap). The server refuses to boot when an admin
  still uses a known-default password.
- Gateway tokens are masked in every API response, excluded from backups and
  release tarballs, and auto-migrated out of legacy configs on boot.
- Cookies are `HttpOnly` + `SameSite=Strict` (and `Secure` under TLS); HSTS is
  emitted in secure contexts.
- Added `LICENSE` (Apache-2.0), `NOTICE`, `THIRD-PARTY-NOTICES.md`,
  `SECURITY.md`, and `ACCEPTABLE-USE.md`.

### Notes
- Cirrus Portal is **single-tenant, self-hosted** — one organization per
  install. See `DEPLOYMENT.md`.
- 2.x → 3.x upgrades: run `./install.sh migrate` (backup-first; `--dry-run` to
  preview) before `./install.sh upgrade`. Three new defaults (no default creds,
  loopback bind, TLS-gated public exposure) can stop a legacy box from booting
  until it is reconciled. See `UPGRADING.md`.

## [2.2.0] — 2026-08-11

Internal pre-release. Last of the internal 2.x line before the public-readiness
pass.

### Added
- Multi-gateway support with namespaced sessions.
- Group chat (rooms) in rounds or free-flow mode.
- Course context injection + per-assignment tool policy (flag + audit).
- Dashboard and audit log.

## [2.1.0] — 2026-08-03

Internal pre-release.

### Added
- Accounts and roles (`admin` / `instructor` / `student`) with server-side
  agent-access enforcement.
- Tool receipts and staff approval of tool runs from chat.
- Device-signed operator connection (Ed25519 `portal-device.json`).
