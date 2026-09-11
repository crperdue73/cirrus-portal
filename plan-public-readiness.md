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

- [ ] **1. Lock the official name + single-source branding.**
  Adopt **Cirrus Portal** as the official product name. Create `branding.json` as
  the single source of truth (name/short/family/tagline/slug), write `NAMING.md`
  (decision + rationale + alternates), replace every "Agent Portal" string in
  code/installer/docs, and fix the version drift (VERSION file `2.2.0` vs
  `install.sh` `2.1.0`).

- [ ] **2. Kill all default and shared credentials.**
  No shipped `admin`/`admin`; no shared `perdue-portal-2026`. Fresh installs must
  generate a unique admin password (or force first-run creation), demo users must
  not ship, and the login screen must never advertise a default. Add a startup
  guard that refuses to run on a known-default credential.

- [ ] **3. Secrets at rest + leak guards.**
  Gateway tokens to a dedicated 0600 secrets file (or env-only), masked in every
  API response, never written to logs/backups/release tarballs. Add a
  `secret-scan.sh` that greps the repo + a built tarball for tokens/keys and runs
  in CI.

- [ ] **4. First-run setup wizard.**
  On a fresh box with no accounts, serve a browser wizard: create the admin
  account (strong-password enforced), pick bind/port, add the first gateway,
  choose TLS mode. No working default exists until the wizard completes.

- [ ] **5. TLS + reverse-proxy by default.**
  Ship a Caddyfile and an nginx template; `--domain` sets it up with automatic
  certs; cookies become `Secure`/`HttpOnly`/`SameSite=Strict`; add HSTS and
  80→443 redirect. Portal **refuses to bind publicly without TLS** unless
  `--insecure-plaintext` is explicitly passed.

- [ ] **6. Auth hardening.**
  Login rate-limit + progressive lockout, CSRF tokens on all state-changing
  requests, session rotation on login, `logout-all`, configurable TTL, and a
  password policy (length + blocklist).

- [ ] **7. Safe network defaults.**
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

- **2026-09-10** — Plan created. Official name chosen: **Cirrus Portal**. Item 1 in progress.
