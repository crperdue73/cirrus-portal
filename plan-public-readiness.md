# Cirrus Portal — Public-Readiness Plan

**Official name:** Cirrus Portal (product family: **Cirrus**; engine: Cirrus Core)
**Target release:** v3.0.0 — first public release
**Owner:** Noah (Cirrus Core)
**Started:** 2026-09-10

> Working rule: **one item per run.** A cron fires every 2 hours and executes the
> first unchecked item below: read the repo, do the work, test it, commit, then
> tick the box and write a one-line status. Never skip ahead; never do public
> actions (announcements, publishing, spending) without Dad's explicit OK.

---

## Action Items

- [x] **1. Lock the official name + single-source branding.** ✅ 2026-09-10
  Adopt **Cirrus Portal** as the official product name. Create `branding.json` as
  the single source of truth (name/short/family/tagline/slug), write `NAMING.md`
  (decision + rationale + alternates), replace every "Agent Portal" string in
  code/installer/docs, and fix the version drift (VERSION file `2.2.0` vs
  `install.sh` `2.1.0`).

- [x] **2. Kill all default and shared credentials.** ✅ 2026-09-11
  No shipped `admin`/`admin`; no shared `perdue-portal-2026`. Fresh installs must
  generate a unique admin password (or force first-run creation), demo users must
  not ship, and the login screen must never advertise a default. Add a startup
  guard that refuses to run on a known-default credential.

- [x] **3. Secrets at rest + leak guards.** ✅ 2026-09-11
  Gateway tokens to a dedicated 0600 secrets file (or env-only), masked in every
  API response, never written to logs/backups/release tarballs. Add a
  `secret-scan.sh` that greps the repo + a built tarball for tokens/keys and runs
  in CI.

- [x] **4. First-run setup wizard.** ✅ 2026-09-11
  On a fresh box with no accounts, serve a browser wizard: create the admin
  account (strong-password enforced), pick bind/port, add the first gateway,
  choose TLS mode. No working default exists until the wizard completes.

- [x] **5. TLS + reverse-proxy by default.** ✅ 2026-09-11
  Ship a Caddyfile and an nginx template; `--domain` sets it up with automatic
  certs; cookies become `Secure`/`HttpOnly`/`SameSite=Strict`; add HSTS and
  80→443 redirect. Portal **refuses to bind publicly without TLS** unless
  `--insecure-plaintext` is explicitly passed.

- [x] **6. Auth hardening.** ✅ 2026-09-11
  Login rate-limit + progressive lockout, CSRF tokens on all state-changing
  requests, session rotation on login, `logout-all`, configurable TTL, and a
  password policy (length + blocklist).

- [x] **7. Safe network defaults.** ✅ 2026-09-11
  Default bind `127.0.0.1`; exposing on `0.0.0.0` requires an explicit flag;
  firewall helper (`ufw`) documented; loud startup warning if public without TLS.

- [x] **8. Container hardening.** ✅ 2026-09-11
  Non-root user in the image, `HEALTHCHECK` directive, read-only root filesystem
  where possible, pinned base-image digest, resource limits, and dropped caps
  (already partially done).

- [x] **9. Deployment model + tenancy decision.** ✅ 2026-09-11
  Document the official public model: **single-tenant, self-hosted** (one org per
  install). Define supported platforms/requirements and explicitly-listed
  unsupported setups so expectations are set before people deploy.

- [x] **10. Public installer v3.** ✅ 2026-09-11
  Extend `install.sh`: `--domain`, `--tls`, `--public`, non-interactive flags,
  rollback on failure, extended preflight (DNS, TLS reachability, firewall, port),
  and a `--dry-run` that prints the exact plan.

- [x] **11. License + legal.** ✅ 2026-09-12 (Apache-2.0 — Dad's call)
  Check the family/Cirrus licensing model first, then add `LICENSE`,
  third-party notices, `SECURITY.md` (disclosure policy), and acceptable-use
  terms for public hosts.

- [x] **12. Public documentation set.** ✅ 2026-09-12
  Rewrite `README.md` as a public quickstart; add `ADMIN.md` (ops runbook),
  `THREAT-MODEL.md`, `UPGRADING.md`, `TROUBLESHOOTING.md`, and a screenshot pass.

- [x] **13. Test suite + CI.** ✅ 2026-09-12
  Node test-runner coverage for auth, RBAC, rooms, config, and route smoke tests;
  GitHub Actions running test + lint + build + release-artifact job on push/tag.

- [x] **14. Release engineering.** ✅ 2026-09-12
  Verified release script: signed checksums, `CHANGELOG.md`, semver tags, an SBOM,
  a reproducible tarball, and a written publish checklist.

- [x] **15. Migration + upgrade path.** ✅ 2026-09-12
  A 2.x → 3.x migrator (credential rotation, config-schema migration, role model)
  with `--dry-run` and backup-first, tested against a copy of real state.

- [x] **16. Observability.** ✅ 2026-09-12
  `/healthz` + `/readyz`, structured JSON logs, request IDs, and basic metrics;
  wire them into `install.sh status` / `doctor`.

- [ ] **17. Backup / restore / DR verified.**
  Encrypted backups, a scheduled-backup helper, and a documented restore drill on
  a clean VM with stated RPO/RTO.

- [ ] **18. Clean-VM end-to-end verification.**
  Fresh Debian VM (or throwaway container): full install → wizard → chat → upgrade
  → restore, captured as a repeatable script. Fix everything it surfaces.

- [ ] **19. Compliance + abuse pass.**
  User data export/delete, audit-log retention policy, a plain-language privacy
  note, and abuse/rate controls for publicly exposed instances.

- [ ] **20. Public release.**
  Tag `v3.0.0`, publish docs/repo, announce, and stand up post-release monitoring
  + issue triage. (Requires Dad's explicit go-ahead.)

---

## Progress log

- **2026-09-10** — Plan created. Official name chosen: **Cirrus Portal**.
- **2026-09-10** — ✅ **Item 1 done.** `branding.json` + `NAMING.md` added; name propagated
  through `portal.html`, `portal-server.js` (reads branding.json at boot), `install.sh`,
  `README.md`, `REPLICATION.md`, `bootstrap.sh`, `release.sh`, `Dockerfile`; version drift
  fixed (installer now reads `VERSION` = 2.2.0). Commit `64c5996`; live container rebuilt
  and verified: title `Cirrus Portal`, `/` 200, both gateways connected, `install.sh status`
  all-checks-passed. Left for later items: container/compose/service name still `agent-portal`
  (rename belongs with installer v3, item 10, to keep it a coordinated deploy).
- **2026-09-11** — ✅ **Item 2 done.** Removed the shipped `admin`/`admin` bootstrap:
  `loadUsers()` now mints the first admin with a unique password from
  `PORTAL_ADMIN_PASSWORD`/`PORTAL_PASSWORD`/`portal-config.json`, else generates one →
  `portal-first-run.txt` (0600); added `assertNoDefaultCreds()` that **refuses to boot**
  when an admin uses a known-default password (`admin`, `password`, `perdue-portal-2026`,
  demo creds…), overridable only by `PORTAL_ALLOW_INSECURE_DEFAULTS=1` (dev). Login screen
  no longer advertises a default; `install.sh`/`bootstrap.sh` seed+save a unique password
  to `portal-credentials.txt` (0600) and assert no demo users ship; README/REPLICATION/example
  config updated. Evidence: `node --check` + `bash -n` clean; new `test-credentials.js`
  **3/3 passed** (fresh-mint unique ≠ admin; guard refuses on admin/admin; override boots).
  Commit `f562469` (plan record for item 1: `e145f5d`).
  **FOLLOW-UP (needs a quiet window + Dad's awareness before the next rebuild):** the LIVE
  box still runs the legacy `admin`/`admin` login and its `portal-config.json` still carries the
  shared `portalPassword: "perdue-portal-2026"`; demo `instructor`/`student` accounts are also
  still in the live `portal-users.json` (untracked). With the new guard, a rebuild/restart of
  the live container would now FAIL to boot until that admin password is rotated. Left untouched
  this run (no live deploy mid-day; rotating locks/alters real logins without Dad's OK).
- **2026-09-11** — ✅ **Item 3 done.** Gateway tokens (and the bootstrap admin password) now live in a
  dedicated **`portal-secrets.json` (0600)**, never in `portal-config.json`. Token precedence:
  `PORTAL_GATEWAY_TOKEN_<ID>` env → secrets file → legacy config `token` (**auto-migrated on boot,
  then stripped**) → `GATEWAY_TOKEN` env. `saveConfig()` is token-free; `/api/gateways` (GET/POST/PATCH)
  returns only `hasToken`. Added **`secret-scan.sh`** (scans tracked repo files / a staged dir / a built
  tarball for tokens, keys, device seeds, legacy shared secrets, and forbidden state files), wired into
  `release.sh` (aborts the build on any finding) **and CI** (`.github/workflows/secret-scan.yml`;
  full test/lint CI still lands in item 13). `install.sh`/`bootstrap.sh` now write token-free config +
  the 0600 secrets file; **backups explicitly EXCLUDE secrets**; `doctor` checks the secrets mode and
  that the config stayed token-free. Evidence: `node --check` + `bash -n` clean; new **`test-secrets.js`
  3/3** (legacy token migrated+stripped; API masks tokens; API-set token → secrets; scanner flags a
  planted token / repo clean); `test-credentials.js` still 3/3; `./secret-scan.sh` clean on the repo AND
  on a freshly built `dist/agent-portal-2.2.0.tar.gz`. Commit `be4ccd8`.
  **FOLLOW-UP (quiet window):** the LIVE box has no `portal-secrets.json` yet and `docker-compose.yml`
  now bind-mounts it — before the next rebuild, create it (`printf '{}\n' > portal-secrets.json; chmod 600
  portal-secrets.json`, which `install.sh` also does) or Docker will bind a directory; the live token
  auto-migrates on first boot of the new code. No live deploy this run.

- **2026-09-11** — ✅ **Item 4 done.** Fresh, unconfigured boxes now serve a **first-run
  setup wizard** instead of minting a default admin. `loadUsers()` mints only when an
  explicit bootstrap password exists (installer/headless — item 2 behavior preserved);
  otherwise the portal enters **SETUP mode**: `/` 302→`/setup`, `GET /setup` serves the new
  dependency-free **`setup.html`** (create admin, bind/port, TLS intent, first gateway), and
  every other API — login included — returns `503 {setupRequired:true}`. New `POST /api/setup`
  enforces a **strong password** (new `passwordPolicyError`, ≥12 chars + upper/lower/number,
  no known-defaults, not the username), validates bind/port/TLS/gateway up front (nothing
  half-applies), mints the admin, persists `tlsMode` to config, writes the gateway token to
  `portal-secrets.json` (0600), returns a live session, and refuses re-runs (403). Extracted a
  shared `createGateway()` used by both the wizard and `POST /api/gateways`. Docs updated
  (README/REPLICATION/portal.html login hint); `setup.html` added to `release.sh` FILES +
  `Dockerfile`. Evidence: `node --check` on server+test, `bash -n` on 4 scripts; new
  **`test-setup.js` 3/3** (fresh→setup mode + all routes refused; weak pw rejected then valid
  wizard mints + session works + setup closes; headless box skips wizard); regressions green:
  `test-credentials.js` 3/3, `test-secrets.js` 3/3, `secret-scan.sh` clean (repo + freshly
  built `dist/agent-portal-2.2.0.tar.gz`, which now contains `setup.html`). Commit `f2a6acf`.
  **Follow-up:** bind/port chosen in the wizard persist to config but only apply on the next
  restart (`restartRequired:true` is returned); real TLS termination still lands in item 5;
  the wizard is not yet surfaced by `install.sh` messaging (item 10).
- **2026-09-11** — ✅ **Item 5 done.** TLS + reverse-proxy by default. The server now **refuses to
  bind a public interface without TLS** (`assertTlsPolicy`): loopback is always fine, a public
  bind must terminate TLS itself (`tlsCert`+`tlsKey` → `https.createServer`), sit behind a
  trusted proxy (`trustProxy` / `tlsMode auto|manual`, reads `X-Forwarded-Proto`), or pass the
  explicit, loudly-warned `--insecure-plaintext` / `PORTAL_INSECURE_PLAINTEXT=1`. Session cookies
  are always `HttpOnly`+`SameSite=Strict` and gain `Secure` whenever TLS is in play; HSTS is emitted
  in secure contexts. Shipped **`deploy/Caddyfile`** (automatic Let's Encrypt, 80→443 + HSTS) and
  **`deploy/nginx/cirrus-portal.conf`** (HSTS + 301 redirect + `X-Forwarded-Proto`). `install.sh`
  gained `--domain`/`--email` (wires Caddy, portal stays on loopback — updates an existing config),
  `--tls-cert`/`--tls-key`, and `--insecure-plaintext`; it now **defaults to bind 127.0.0.1** and the
  setup wizard rejects a public bind with TLS off. Evidence: `node --check` + `bash -n` clean; new
  **`test-tls.js` 6/6** (loopback boots · public+TLS-off refused before listen · override boots with a
  warning · TLS-proxy → Secure/HttpOnly/SameSite cookie + HSTS · direct HTTPS → same · templates do
  HSTS+80→443); regressions green: `test-credentials.js` 3/3, `test-secrets.js` 3/3,
  `test-setup.js` 3/3, `secret-scan.sh` clean (repo + freshly built `dist/agent-portal-2.2.0.tar.gz`,
  which now carries `deploy/`). Commit `eed7aa2`.
  **Note:** the installer's loopback-by-default pre-empts part of item 7; item 7 still owns the
  server-side `DEFAULTS.bind`, the documented ufw helper, and the explicit public-exposure flag.
  **FOLLOW-UP (quiet window + Dad's OK):** the LIVE box still binds `0.0.0.0` with `tlsMode:"off"` and
  no insecure flag — with the new gate, a rebuild/restart would now **FAIL TO BOOT** until it gets
  TLS (`./install.sh install --domain …`, recommended) or an explicit `--insecure-plaintext`. No live
  deploy this run. (`reconnect-test.js` was already broken — stale marker — before this item; left for
  item 13.)
- **2026-09-11** — ✅ **Item 6 done.** Auth hardening. Sessions now carry a 256-bit id **plus a
  per-session CSRF secret**; absolute TTL is `sessionTtlHours`, optional idle expiry is the new
  `sessionIdleMinutes`; **rotation on login** drops any session id that arrived with the request;
  `destroyUserSessions()` backs **`POST /api/logout-all`** (new UI button) and runs on password
  change/delete. **CSRF:** every state-changing request (`POST`/`PATCH`/`DELETE`) must send
  `X-CSRF-Token` bound to the session, and a mismatched `Origin` is refused (`GET` reads unaffected;
  login/setup exempt as they have no session). **Login:** progressive lockout per (IP|username) →
  `429` + `Retry-After`, doubling per repeat (≤1h); new audit actions `login_throttled`/`csrf_reject`.
  **Password policy** (12+ chars, upper/lower/number, not the username, not a known default, not on a
  new common-password blocklist) is now enforced on user **create + reset**, not just the wizard.
  Client `api()` attaches the CSRF header and captures the token; README/config example updated.
  Evidence: `node --check` (+ `bash -n` on 4 scripts) clean; new **`test-auth.js` 5/5** (CSRF required
  on writes, reads exempt, logout-all revokes + cross-origin refused · re-login rotates + kills the
  old id · 5 bad logins → 429 w/ Retry-After and correct pw refused while locked · weak/short/
  blocklisted pw rejected + reset revokes sessions · `sessionIdleMinutes` expires an idle session);
  regressions green: `test-credentials.js` 3/3, `test-secrets.js` 3/3 (updated to send CSRF),
  `test-setup.js` 3/3, `test-tls.js` 6/6, `secret-scan.sh` clean on the repo AND a freshly built
  `dist/agent-portal-2.2.0.tar.gz`. Commit `bdc3053`.
  **Note:** lockout state is in-memory (a restart clears it) and keyed per IP+username; durable/
  shared-state lockout and the `ufw` helper remain for items 7/13. No live deploy this run.
- **2026-09-11** — ✅ **Item 7 done.** Safe network defaults. The server's `DEFAULTS.bind` is now
  **`127.0.0.1`** (was `0.0.0.0`) and a new **`assertNetworkPolicy()`** (runs before the TLS gate)
  **refuses any non-loopback bind without an explicit opt-in**: `"publicBind": true` in
  `portal-config.json`, `PORTAL_PUBLIC_BIND=1`, or `--public-bind`. A wildcard bind (`0.0.0.0`/`::`)
  additionally logs a loud **`⚠ PUBLIC BIND … listens on ALL interfaces`** warning; the boot banner
  now prints the real listen surface plus `net: loopback only` / `net: ⚠ PUBLIC` (with a ufw
  reminder). `install.sh` and `bootstrap.sh` now write `publicBind` into the config (so a deliberate
  public bind still boots), **bootstrap.sh defaults `BIND` to `127.0.0.1`** (was `0.0.0.0`), gains an
  `is_loopback_bind` helper, a **`--firewall`** flag + best-effort **`ufw` helper** (`open_firewall`),
  and a public-bind warning; `install.sh` help gained a **Firewall (ufw)** section and
  README/REPLICATION document the safe defaults + ufw. Evidence: `node --check` + `bash -n` clean; new
  **`test-network.js` 6/6** (default bind is loopback · public bind without opt-in refused · opt-in alone
  still hits the TLS gate · `PORTAL_PUBLIC_BIND=1`+insecure boots loudly · `--public-bind` argv opt-in ·
  bootstrap/install/docs carry the defaults+ufw); regressions green: `test-tls.js` 6/6 (public-bind
  cases now declare `publicBind:true`), `test-credentials.js` 3/3, `test-secrets.js` 3/3,
  `test-setup.js` 3/3, `test-auth.js` 5/5, `secret-scan.sh` clean on the repo AND a freshly built
  `dist/agent-portal-2.2.0.tar.gz`. Commit `c1e69e6`.
  **Note:** the installer's loopback default (item 5) and the server's new opt-in gate together close the
  accidental-exposure hole; a public bind still requires TLS (`--domain`/`--tls-cert`) or
  `--insecure-plaintext`. **FOLLOW-UP (quiet window + Dad's OK):** the LIVE box's `portal-config.json`
  still binds `0.0.0.0` with no `publicBind` and `tlsMode:"off"` — a rebuild/restart would now fail BOTH
  gates; fix it with `./install.sh install --domain …` (recommended) or add `"publicBind": true` +
  TLS/insecure. No live deploy this run.
- **2026-09-11** — ✅ **Item 8 done.** Container hardening. The image is now **digest-pinned**
  (`FROM node:22-alpine@sha256:c610fcdf…`) and runs as a dedicated **unprivileged `portal` user
  (uid:gid 10001)** — never root; a `HEALTHCHECK` probes loopback `GET /` via the new **`healthcheck.js`**
  (any HTTP response = healthy, incl. 302/503 in first-run SETUP mode). `docker-compose.yml` gained
  **`read_only: true`** (+ a size-capped `/tmp` tmpfs so the rootfs can stay immutable), **`mem_limit: 512m`**
  / **`cpus: "1.0"`** / **`pids_limit: 256`**, keeping `cap_drop: ALL` + `no-new-privileges`. Because the
  runtime is non-root, `install.sh`/`bootstrap.sh` now **chown the bind-mounted state to `10001:10001`**
  (and `doctor` flags ownership drift); the secrets write learned a **read-only-rootfs-safe fallback**
  (write the bind-mounted target directly when the temp-stage/rename can't). `healthcheck.js` added to
  `release.sh` FILES + Dockerfile COPY; README/REPLICATION document the model. Evidence: `node --check`
  (server+healthcheck+test) + `bash -n` (install/bootstrap/release/secret-scan) clean; new
  **`test-container.js` 6/6** (Dockerfile digest+non-root+healthcheck · compose read-only/tmpfs/caps/limits ·
  healthcheck 0-up/1-down · ships · installer chown+doctor · secrets survive an unavailable temp stage);
  regressions green: `test-credentials.js` 3/3, `test-secrets.js` 3/3, `test-setup.js` 3/3, `test-tls.js`
  6/6, `test-network.js` 6/6, `test-auth.js` 5/5, `secret-scan.sh` clean (repo + freshly built
  `dist/agent-portal-2.2.0.tar.gz`, now carrying `healthcheck.js`); **`docker build` succeeded** and a live
  throwaway container ran **non-root + read-only + tmpfs**, wrote its bind-mounted state, and reached
  **`health = healthy`**. Commit `222048d`.
  **Note:** the container/service names (`agent-portal`) and the compose `image:` rename still belong to
  item 10. **FOLLOW-UP (quiet window + Dad's awareness):** the LIVE box still runs the old root image with
  no read-only rootfs and its state files are root-owned — before the next `docker compose up -d --build`,
  the new image will run as uid 10001 and needs the state chown'd to `10001:10001` (`./install.sh install`
  now does this) or the server can't read its config/secrets. No live deploy this run.

- **2026-09-11** — ✅ **Item 9 done.** Deployment model + tenancy decision documented in a new
  **`DEPLOYMENT.md`**: Cirrus Portal is **single-tenant, self-hosted — one org per install**. The doc
  states the decision (one account realm, one gateway fleet, one state store, one trust boundary; roles
  are *not* tenant boundaries), the rationale (isolate by architecture — one install per org — rather than
  promise multi-tenancy the code can't back), a **Tier-1 supported matrix** that mirrors the real
  installer preflight (Debian 12/13 & Ubuntu 22.04/24.04 **amd64**, Docker Engine + **Compose v2**, Node
  **22+**, **>500 MB** free disk, same-host loopback gateway `:18790`, current browsers), Tier-2
  best-effort (other Debian-derivatives/arm64, non-Debian Linux), and an **explicitly-listed unsupported
  table** (multi-tenant/SaaS, public cleartext, untrusted proxy without `trustProxy`, Windows/macOS
  native, k8s/orchestrators, HA/clustering, shared state/secrets across installs, shared-login hosts) plus
  scale-out guidance. New **`test-docs.js`** (5 checks: canonical name from `branding.json`, tenancy
  decision, supported claims asserted against `install.sh` preflight regex/disk gate/port, unsupported
  list, ships + README link). README header now links `DEPLOYMENT.md`; `release.sh` ships it. Evidence:
  `node --check` (test-docs) + `bash -n` (release/install) clean; **`test-docs.js` 5/5**; `./release.sh`
  built `dist/agent-portal-2.2.0.tar.gz` (now contains `DEPLOYMENT.md`); `./secret-scan.sh` clean on the
  repo **and** the built tarball (`--tar`). Commit `485beee`.
  **Note:** docs-only item — no code/runtime change, no live deploy, nothing to do in a quiet window. The
  item-10 installer rename and item-12 public docs set will build on this model.
- **2026-09-11** — ✅ **Item 10 done.** Public installer v3. `install.sh` gained **`--tls`** (require TLS),
  **`--public`** (wildcard `0.0.0.0` bind — still bound by the TLS gate: needs `--domain`/certs or, for a
  trusted LAN only, `--insecure-plaintext`), and **`--non-interactive`** (alias of `-y`; sets `YES=1`);
  **`--dry-run` is now Docker-free** and prints an exact numbered install plan (config/secrets/tls/state/
  ownership/build/checks/admin/caddy/approve/firewall). Added **rollback-on-failure**: before any
  mutation the installer snapshots config+secrets+state (`snapshot_state`), arms an `ERR` trap, and on
  failure restores the exact pre-install files + removes a freshly-built container (`rollback_now` /
  `on_install_error`); success disarms it (`rollback_done`). Added **`set -E`** so the `ERR` trap reaches
  nested functions (without it the trap silently never fired — caught by the new test). **Extended
  preflight:** DNS resolution for `--domain` (`preflight_dns`, `PORTAL_SKIP_DNS_CHECK=1` escape hatch),
  TLS:443 reachability (`preflight_tls_reachable`), firewall posture (`preflight_firewall`), on top of the
  existing OS/disk/port/token checks. **Slug rename** `agent-portal` → **`cirrus-portal`** across
  `install.sh` (`CONTAINER_NAME`), `docker-compose.yml` (service + `container_name` + project `name:`),
  `release.sh` (`PKG` → `cirrus-portal-<ver>`), `bootstrap.sh` (`--verify` lists both), `portal-server.js`
  (userAgent), README/REPLICATION — with the legacy `agent-portal` container still detected
  (`LEGACY_CONTAINER_NAME`) so `status`/`doctor` keep working on un-migrated boxes. **Two real bugs fixed
  en route:** (1) `publicBind` was emitted by a broken `[ is_loopback_bind "$BIND" ]` test that always
  wrote `true` — now correct in `install.sh` **and** `bootstrap.sh`; (2) the `--help` heredoc executed a
  backticked `--insecure-plaintext` as a command (stderr noise) — backticks removed. Evidence: `bash -n`
  (install/bootstrap/release/secret-scan) + `node --check` clean; new **`test-installer.js` 8/8** (flags ·
  rollback wiring · preflight fns · slug+legacy detection · dry-run prints plan + exits 0 **with no Docker**
  + leaves config byte-identical · `--public` w/o TLS refused · `--tls` w/o cert refused · clean `--help` ·
  **fake-docker rollback** restores the exact pre-install config); regressions green: `test-credentials` 3/3,
  `test-secrets` 3/3, `test-setup` 3/3, `test-tls` 6/6, `test-network` 6/6 (F assertion updated to the
  corrected `publicBind` form), `test-auth` 5/5, `test-container` 6/6, `test-docs` 5/5; `secret-scan.sh`
  clean on the repo **and** the freshly built `dist/cirrus-portal-2.2.0.tar.gz`; live `./install.sh status`
  on this box still reports the legacy `agent-portal` container via the new legacy detection (all checks
  passed). Commit `d574b55`.
  **FOLLOW-UP (quiet window + Dad's OK):** the LIVE box still runs the container named `agent-portal`. The
  rename takes effect on the next `compose up -d --build`, which would otherwise create a SECOND container
  (`cirrus-portal`) that clashes on host port 18800 — so before that rebuild, stop the old one:
  `docker rm -f agent-portal`, then `./install.sh upgrade`. (The installer now warns about this in preflight
  and in `upgrade`.) No live deploy this run. The legacy systemd unit `agent-portal.service` is intentionally
  left as-is (renaming a live unit is a separate ops step).
- **2026-09-11** — ⛔ **BLOCKED: Item 11 (License + legal) — needs Dad's decision.** Ran the item's first
  step ("check the family/Cirrus licensing model"): **no model exists** anywhere in the family work I can see
  (`MEMORY.md`, `cirrus/core-aurora-contract-v1.md`, `cirrus/grant-readiness/*`, the Cirrus strategy doc /
  developer brief in vivi's workspace, `todo.md`) — and there is no `LICENSE`/copyright/SPDX text in the repo at
  all. The family's "License Platform" domain is a *product feature* (annual tokens/entitlements), not a software
  license for the portal. Choosing the public license and approving legal terms for **CRPerdue Technologies, LLC**
  is a company decision, so **no `LICENSE`/terms were authored this run** and the box is **not ticked**.
  **Decision needed from Dad:** (1) which license for the v3.0.0 public release — proprietary /
  all-rights-reserved (fits a commercial product whose forked-OSS parts are branded as native modules) vs. an
  OSS license (MIT / Apache-2.0 / AGPL); (2) the copyright-holder line (`© 2026 CRPerdue Technologies, LLC`?);
  (3) approval to publish `SECURITY.md` (disclosure policy), third-party notices, and acceptable-use terms for
  public hosts. Once decided, this item is a small, mostly-mechanical change set.
- **2026-09-11 (run 18:41)** — ⛔ **Item 11 re-checked: still BLOCKED, no change.** First unchecked item is
  again #11; re-verified that no software-license model exists in the family work and no decision has arrived
  from Dad. Per the plan's own rule the box stays unticked and nothing was authored (no `LICENSE`/terms).
  **Standing block — subsequent runs will NOT add duplicate BLOCKED entries until Dad decides;** refer to the
  2026-09-11 16:42 note above for the exact decisions needed. Item 12+ remain intentionally gated behind this.
- **2026-09-12** — ✅ **Item 11 done (unblocked by Dad).** Dad's decisions: **Apache-2.0**,
  copyright holder **`Copyright 2026 CRPerdue Technologies, LLC`**, and authorization to
  publish `SECURITY.md` once I judged it complete. **Blocker check first:** I ran the item's
  first step and confirmed there is **no obstacle to Apache-2.0** — the shipped tree has
  **zero third-party code** (no `package.json`, no `node_modules/`, no vendored/forked source;
  every `require()` in `portal-server.js` is a Node builtin: crypto/fs/http/https/path). The
  only external input is the pinned `node:22-alpine` base image (Node MIT · musl MIT · BusyBox
  GPL-2.0 as an *aggregate*, pulled not redistributed, no linking) — no copyleft conflict.
  Authored: **`LICENSE`** (verbatim Apache-2.0 + appendix filled with the LLC), **`NOTICE`**
  (attribution + Cirrus trademark reservation, Apache-2.0 §6 grants no marks — the one real
  trade-off vs proprietary), **`THIRD-PARTY-NOTICES.md`** (SBOM-style dependency inventory:
  zero bundled third-party code), **`SECURITY.md`** (supported versions, private channel
  `security@crperdue.com`, 3/5-day ack/triage targets + 90-day coordinated disclosure,
  in/out-of-scope, safe harbor), **`ACCEPTABLE-USE.md`** (public-host operator baseline +
  prohibited uses + enforcement). Wired: `release.sh FILES` now ships all five; README gains a
  **License & legal** section. New **`test-legal.js`** (6 checks — Apache text + holder + no
  placeholders · NOTICE/trademark · **verifies the zero-dep claim against reality** (no
  manifest, no node_modules, builtins-only requires) · SECURITY.md completeness · AUP baseline ·
  ships + README links). Evidence: `node --check` + `bash -n` clean; **`test-legal.js` 6/6**;
  regressions green (credentials 3/3, secrets 3/3, setup 3/3, tls 6/6, network 6/6, auth 5/5,
  container 6/6, docs 5/5); `secret-scan.sh` clean on the repo **and** the freshly built
  `dist/cirrus-portal-2.2.0.tar.gz` (which now carries all five legal files). Contact-address
  deliverability probed: SMTP RCPT for `security@crperdue.com` → **250 Accepted**. Docs-only —
  no code/runtime change, no live deploy. Commit `9715928`.
  **Caveat for Dad:** the RCPT probe proves the mail server accepts that address, not that a
  human reads the inbox (it could be a catch-all). If there's no real `security@` mailbox yet,
  tell me and I'll point the policy at one that exists.
- **2026-09-12** — ✅ **Item 12 done.** Public documentation set. **Rewrote `README.md`** from an
  internal dev-log into a public **quickstart**: what it is, feature list, quickstart (scp → `./install.sh
  install`), no-default-credentials statement, TLS/public-exposure, ops command table, config +
  secrets, roles, architecture, a docs index, and the (kept) License & legal section — all internal
  content (Dad's roadmap, CI30, Phase-I log) removed. Added four operator docs: **`ADMIN.md`**
  (day-2 runbook — command surface, install, health, backup/restore, secrets, users, gateways, TLS,
  routine ops, incident basics), **`THREAT-MODEL.md`** (assets · trust boundaries · adversaries ·
  threats/controls/residual risk per area · out-of-scope/accepted · hardening checklist), plain-text ASCII
  diagram, **`UPGRADING.md`** (version scheme, standard upgrade, the three 3.x defaults that can stop a
  2.x box booting, an ordered live 2.x→3.x drill, rollback, an automated-migrator note for item 15),
  **`TROUBLESHOOTING.md`** (symptom→cause→fix tables: install/boot, intentional boot gates, login/accounts,
  agents/chat, TLS, container/storage, backups, escalation). **Screenshot pass:** captured **8 real PNGs**
  (login · agents/chat · dashboard · rooms · users · gateways · audit · student view) from a throwaway
  loopback demo instance (mock gateway `labbot`/`grader`) — *not* the live box, which still runs legacy code
  whose login still advertises `admin/admin`. Shipped a **reproducible** `docs/screenshots/{capture.js,seed-demo.js,README.md}`
  (dependency-free: Node 22 built-in WebSocket drives headless Chromium over CDP; idempotent seeder).
  Wired all new docs + screenshots into `release.sh FILES`; README embeds the chat screenshot and indexes
  every doc. Evidence: `node --check` (test + capture + seed + server) and `bash -n` (4 scripts) clean; new
  **`test-public-docs.js` 8/8** (README-is-a-quickstart · ADMIN sections · THREAT-MODEL coverage · UPGRADING
  backup-first+2.x→3.x · TROUBLESHOOTING topics · 8 valid non-blank PNGs + scripts · ships in tarball ·
  **no internal/personal strings leak into the public docs**); regressions green: docs 5/5, legal 6/6,
  credentials 3/3, secrets 3/3, setup 3/3, tls 6/6, network 6/6, auth 5/5, container 6/6; `secret-scan.sh`
  clean on the repo **and** the freshly built `dist/cirrus-portal-2.2.0.tar.gz` (640K, now carrying the four
  docs + 8 PNGs + scripts). Commit `d0384ba`; docs-only — no code/runtime change, no live deploy.
  **Note:** the dashboard renders “1 students” (pluralization bug) — a small UI nit left for a later item;
  not in scope here. (`REPLICATION.md` still carries an old systemd/`agent-portal` fallback section and the
  `agent-portal.service` unit name is unchanged — out of scope for this docs item.)
- **2026-09-12** — ✅ **Item 13 done.** Test suite + CI. Added a **`node:test`-runner
  suite** under `test/` with a zero-dependency harness (`test/helpers.js`) that boots the *real*
  `portal-server.js`
  in a throwaway temp dir (temp state + seeded users + free port) and drives it over HTTP with
  cookie+CSRF awareness: **auth** (bad login → 401 · CSRF required on writes, reads exempt · session
  id rotates on login so a planted cookie dies · `logout-all` revokes both sessions · 3 failures →
  429 + `Retry-After`, correct pw refused while locked · password policy enforced on user create),
  **RBAC** (student denied users/rooms/audit/gateways/dashboard but allowed agents · instructor sees
  only students + dashboard/rooms but not create/audit/gateways · admin sees all · anon → 401),
  **rooms** (create→list→get→message→delete lifecycle · validation: missing name/agents, >12 agents,
  free-mode <2 agents · only creator/admin may delete · 404 on missing), **config** (`PORT` env
  overrides the file port and the file port is NOT bound · `sessionTtlHours` → cookie
  `Max-Age=10800` · gateway config → offline server, no invented agents · example config is valid
  JSON with known keys only), and **route smoke** (`/`, `/setup`, `/nexus`, JSON 404, `/api/me`
  public, protected → 401, `OPTIONS` → 204, and the first-run SETUP funnel: `/` → 302 `/setup`,
  login/me → 503 `setupRequired`, `/api/setup/status` reports the wizard). Added **`run-tests.sh`**
  (runs `node --test test/*.test.js` **plus** every standalone `test-*.js`) and **`lint.sh`**
  (`node --check` on 22 JS files · `bash -n` on 6 scripts · JSON validity · CRLF guard). Added
  **`.github/workflows/ci.yml`** — one pipeline: **lint → test → secret-scan → build-release-artifact**
  (`release.sh` + `sha256sum -c` + `upload-artifact`), running on every push (branches + `v*` tags)
  and PR; it **replaces** `.github/workflows/secret-scan.yml` (folded in, as that file's own note
  said item 13 would). README gained a **Development** section documenting the four dev commands.
  Evidence: `./lint.sh` clean; **`node --test test/*.test.js` → 19/19**; **`./run-tests.sh` → all
  green** (19 node:test + the 11 standalone suites: credentials 3/3, secrets 3/3, setup 3/3, tls
  6/6, network 6/6, auth 5/5, container 6/6, installer 8/8, docs 5/5, legal 6/6, public-docs 8/8);
  `./secret-scan.sh` clean on the repo AND on the freshly built `dist/cirrus-portal-2.2.0.tar.gz`
  (confirmed the tarball still ships **no** `test/`, `run-tests.sh`, `lint.sh`, or `.github/` — tests
  are dev-only). Commit `cc0fd86`.
  **Note:** tests are not shipped in the release tarball (dev-only, by design); the CI artifact job
  runs on GitHub-hosted runners and will exercise the workflow on the next push. No live deploy this
  run — nothing here touches the running box.
- **2026-09-12** — ✅ **Item 14 done.** Release engineering. `release.sh` now builds a
  **reproducible** distribution and the surrounding release machinery is written down.
  **Reproducible tarball:** staged tree is mode-normalized, then tarred with
  `--sort=name --mtime=<SOURCE_DATE_EPOCH> --owner=0 --group=0 --numeric-owner` piped into
  `gzip -n -9`; the build clock prefers `SOURCE_DATE_EPOCH`, else the last commit time — never
  "now". **SBOM:** a CycloneDX 1.5 `dist/cirrus-portal-<ver>.sbom.json` generated per build
  (product + Apache-2.0 license + the digest-pinned `node:22-alpine` base image read from the
  Dockerfile + the Node runtime; declares zero bundled third-party code). **Signed checksums:**
  `SHA256SUMS` covers the tarball + SBOM; `RELEASE_GPG_KEY` produces a detached-armor
  `SHA256SUMS.asc`, and `REQUIRE_SIGN=1` makes an unsigned build **fail** (the default unsigned
  build warns). **Semver tags:** `--tag` creates a local annotated `v<version>` tag (idempotent);
  `--no-sign`, `--help` added. **`CHANGELOG.md`** (Keep a Changelog: `[Unreleased]`, `3.0.0`,
  `2.2.0`, `2.1.0`) and **`RELEASING.md`** (the written publish checklist, steps 1–8 local/safe,
  step 9 publish/announce explicitly gated on Dad's go-ahead) authored and added to `release.sh
  FILES`; README gains the docs-index/Development entries. **Real bug found + fixed while testing:**
  the reproducible flags were selected with `tar --help 2>/dev/null | grep -q -- '--sort='` — under
  `set -o pipefail`, `grep -q` exits early, `tar` takes SIGPIPE (141), the pipeline reports failure,
  and the flags were **silently dropped**, so roughly every first build produced an *unsorted*,
  non-reproducible tarball. Replaced with a pipe-free captured-string `case` match. Evidence:
  `node --check` (server+23 JS) + `bash -n` (6 scripts) clean via `./lint.sh`; new **`test-release.js`
  8/8** (changelog shape · checklist completeness+approval gate · release.sh wiring + the pipefail
  regression guard · **two builds hash-identical** + ships CHANGELOG/RELEASING and excludes
  test/lint/run-tests/.github/state · SBOM valid CycloneDX 1.5 matching the pinned digest · REQUIRE_SIGN
  refuses without a key **and** a throwaway ed25519 key yields a verifying `Good signature` · `--tag`
  creates an annotated tag in a throwaway repo, idempotent · docs ship + README links); `./run-tests.sh`
  **all green** (19 node:test + 12 standalone suites incl. release 8/8); `./secret-scan.sh` clean on the
  repo AND the freshly built `dist/cirrus-portal-2.2.0.tar.gz` (which now carries `CHANGELOG.md` +
  `RELEASING.md`). Commit `890f8b7`.
  **Note:** this run only *builds* releases locally — no tag was pushed (there is no remote) and
  nothing was published; signing keys are per-machine (`RELEASE_GPG_KEY`) and the publish step stays
  gated on Dad (item 20). No live deploy this run.
- **2026-09-12** — ✅ **Item 15 done.** Migration + upgrade path. Added **`migrate.js`**
  (zero-dep, Node 22 builtins) — the **2.x → 3.x migrator** — wrapped by **`./install.sh migrate`**.
  It does the whole transformation in one backup-first pass: **(config schema)** moves legacy
  plaintext gateway tokens + the legacy `portalPassword` out of `portal-config.json` into
  `portal-secrets.json` (0600), synthesizes a `gateways` entry from legacy `gatewayUrl` if needed,
  adds the 3.x keys (`publicBind`/`tlsMode`/`trustProxy`/`sessionIdleMinutes`/login-limit trio),
  and **stamps `schemaVersion: 3`**; **(credentials)** rotates any account still on a known-default
  password to a fresh strong one written to `portal-credentials.txt` (0600) — verified by re-hashing
  old vs new; **(role model)** maps legacy aliases (`teacher`/`owner`/`ta`/`grader`/…) to
  `student|instructor|admin`, lowers usernames, and normalizes `agents`/`assignments`; **(safe
  network)** a 2.x cleartext public bind **fails closed to loopback** unless re-exposed deliberately
  via `--domain` (auto TLS) / `--tls-cert`+`--tls-key` / `--allow-insecure-plaintext`. `--dry-run`
  reads + plans but writes nothing. **Backup-first:** a full reversible snapshot
  (`backups/migrate-<stamp>/`, 0700, *includes secrets*) is written before any change; exit 2 =
  already on schema 3 (idempotent). `portal-server.js` now persists the `schemaVersion` stamp
  (`DEFAULTS` + `saveConfig`), and `release.sh` ships `migrate.js`. Docs: UPGRADING.md §6 rewritten
  around the real migrator; README/ADMIN/CHANGELOG updated. Evidence: `node --check` + `bash -n` clean
  via `./lint.sh` (25 JS · 6 sh); new **`test-migrate.js` 8/8** (dry-run is byte-identical/no-secrets/
  no-snapshot · live run → schema 3 + tokens→secrets + role map + rotation + 0700 snapshot ·
  idempotent second run exit 2 · `--domain`/`--tls-cert` safe re-expose · `--allow-insecure-plaintext`
  keeps a deliberate public bind · default-password list matches `portal-server.js` · **the migrated
  state actually boots the real `portal-server.js`** (HTTP 200, no boot-guard FATAL) ·
  **migrates a COPY of the real repo state**); `./run-tests.sh` all green (19 node:test + 13 standalone
  suites, **91 checks** incl. migrate 8/8); `./secret-scan.sh` clean on the repo AND on the freshly
  built `dist/cirrus-portal-2.2.0.tar.gz` (which now carries `migrate.js`). Commit `e7ac206`.
  **Note:** docs/code/test only — no live deploy. **FOLLOW-UP (quiet window + Dad's OK):** the LIVE box
  still runs the legacy 2.x state (bind `0.0.0.0`, cleartext, `portalPassword: perdue-portal-2026` in
  config, `admin`/`admin`). A `--dry-run` against the real state plans **12 changes** and rotates 3
  accounts; running it for real + `./install.sh upgrade` is a deliberate live migration to schedule,
  not something to do mid-day. Nothing was changed on the live box this run.
- **2026-09-12** — ✅ **Item 16 done.** Observability. Added an open **`GET /healthz`**
  (liveness: `200 {status:"ok",product,version,uptimeSeconds}`, answers even in first-run SETUP
  mode) and **`GET /readyz`** (readiness: `200 ready` once out of SETUP, `503 setup_required`
  before; reports gateway/user counts and never gates on gateway connectivity). Added a
  dependency-free **`GET /metrics`** in Prometheus text format — `cirrus_portal_up`,
  `build_info{version,product}`, `uptime_seconds`, `setup_required`, `http_requests_total{method,status}`,
  `http_in_flight`, `http_request_duration_seconds_{sum,count}`, `sessions_active`,
  `gateways_{connected,configured}`, `users{role}`, `logins_total`, `login_failures_total`,
  `csrf_rejects_total`, `audit_entries` — served **loopback-only by default** (remote needs an admin
  session, or `metricsPublic:true`). Every request now carries an **`X-Request-Id`** (echoed from the
  caller else minted) and emits **one structured JSON access-log line** on finish (method · path ·
  status · durationMs · requestId · client IP); new config keys **`logFormat`** (`json` default,
  `text` opt), **`logRequests`**, **`metricsPublic`** (+ `PORTAL_LOG_FORMAT`/`PORTAL_LOG_QUIET` env).
  Counters wired into login success/failure/throttle **and every CSRF-reject path**; boot banner
  advertises the endpoints + log format. **`healthcheck.js`** now probes `/healthz` (2xx/3xx =
  healthy). **`install.sh`** `status` probes `/healthz`+`/readyz` (parses version/uptime) and `doctor`
  checks `logFormat` plus the three endpoints. Docs: README (Observability section + feature bullet +
  config keys), ADMIN §3 (endpoint table + log notes), THREAT-MODEL §5.7 (metrics/log disclosure, JSON
  log-injection safety, volume), CHANGELOG, config example. Evidence: `./lint.sh` clean (26 JS · 6 sh);
  **`node --test` 24/24** (new **`test/observability.test.js` 5/5**: healthz open + readyz ready/setup ·
  metrics text + counter movement incl. csrf-reject · request-id echo+mint + parseable JSON logs ·
  install/docs wiring); `./run-tests.sh` **all green** incl. every standalone suite; `secret-scan.sh`
  clean on the repo **and** on the freshly built `dist/cirrus-portal-2.2.0.tar.gz`. Commit `ad49339`.
  **FOLLOW-UP (quiet window + Dad's OK):** the LIVE box still runs the legacy 2.x container
  (`agent-portal`), which has no `/healthz`/`/readyz`/`/metrics`; `./install.sh status` now logs
  `/healthz did not report ok` + `/readyz 404` there (2 checks fail) until the next
  `./install.sh upgrade`/rebuild picks up this code. Read-only inspection only — nothing was changed
  on the live box this run.
