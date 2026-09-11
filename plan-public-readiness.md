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

- [ ] **8. Container hardening.**
  Non-root user in the image, `HEALTHCHECK` directive, read-only root filesystem
  where possible, pinned base-image digest, resource limits, and dropped caps
  (already partially done).

- [ ] **9. Deployment model + tenancy decision.**
  Document the official public model: **single-tenant, self-hosted** (one org per
  install). Define supported platforms/requirements and explicitly-listed
  unsupported setups so expectations are set before people deploy.

- [ ] **10. Public installer v3.**
  Extend `install.sh`: `--domain`, `--tls`, `--public`, non-interactive flags,
  rollback on failure, extended preflight (DNS, TLS reachability, firewall, port),
  and a `--dry-run` that prints the exact plan.

- [ ] **11. License + legal.**
  Check the family/Cirrus licensing model first, then add `LICENSE`,
  third-party notices, `SECURITY.md` (disclosure policy), and acceptable-use
  terms for public hosts.

- [ ] **12. Public documentation set.**
  Rewrite `README.md` as a public quickstart; add `ADMIN.md` (ops runbook),
  `THREAT-MODEL.md`, `UPGRADING.md`, `TROUBLESHOOTING.md`, and a screenshot pass.

- [ ] **13. Test suite + CI.**
  Node test-runner coverage for auth, RBAC, rooms, config, and route smoke tests;
  GitHub Actions running test + lint + build + release-artifact job on push/tag.

- [ ] **14. Release engineering.**
  Verified release script: signed checksums, `CHANGELOG.md`, semver tags, an SBOM,
  a reproducible tarball, and a written publish checklist.

- [ ] **15. Migration + upgrade path.**
  A 2.x → 3.x migrator (credential rotation, config-schema migration, role model)
  with `--dry-run` and backup-first, tested against a copy of real state.

- [ ] **16. Observability.**
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
