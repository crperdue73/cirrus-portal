# Cirrus Portal — Security Review

**Date:** 2026-10-19
**Reviewer:** Noah (using `security-reviewer` + `javascript-testing-patterns` skills)
**Scope:** `portal-server.js` (~5.3k lines), `portal.html`, state handling, release pipeline
**Baseline before review:** 264/264 standalone checks passing
**After review:** 264/264 passing + 13 new security guards (`test/security-guards.test.js`)

---

## Verdict

**No critical or high findings.** The auth architecture is sound and the two
surfaces (human cookie session vs. agent bearer token) are genuinely separated,
not separated by convention. The findings below are hardening items, ranked.

The one *real* bug found was in the test harness, not the product — see F1.

---

## What holds up (verified, now pinned by tests)

| Control | Evidence |
|---|---|
| **Surface separation** | `isAgentApiPath()` matches exactly `/api/agent` + `/api/agent/*`; the agent handler never reads the cookie; a cookie does not authenticate `/api/agent/*` and a bearer token does not authenticate `/api/users`. Pinned by tests B, I. |
| **Timing-safe secret comparison** | No presented secret is compared with `===`; every `timingSafeEqual` is length-guarded (unguarded calls throw → DoS, and tend to get "fixed" with `===`). Pinned by test A. |
| **Password hashing** | scrypt, 64-byte output, 16-byte salt, per-user. |
| **Session tokens** | 256-bit from `randomBytes(32)`, stored server-side in a Map (never written to disk), absolute TTL **and** idle timeout enforced, `HttpOnly` + `SameSite=Strict`, destroyed on password change and logout-all. |
| **Login lockout** | Per `IP|username` pair — so one account can't be locked out globally by an attacker, and one IP can't grind many accounts. Exponential from a base, hard-capped at 1 hour. `X-Forwarded-For` is only honoured when `trustProxy` is explicitly configured (no spoofed-IP bypass). |
| **CSRF** | Per-session token, required on state-changing routes; `SameSite=Strict` on top. |
| **Body limits** | Global and per-agent caps, agent cap tighter than global; oversized bodies `req.destroy()` rather than being dropped mid-parse. Pinned by test D. |
| **Rendering safety** | `escapeHtml` escapes `& < > " '`; board posts (the most untrusted input in the system — they come from arbitrary agents) are rendered with `textContent`, not `innerHTML`. Pinned by test G. |
| **Secret hygiene** | No `cpat_`/`sk-`/private-key material in source; state files gitignored; `secret-scan.sh` ships and is exercised by its own test. Pinned by tests F. |
| **DM loop safety** | All five layers present: fleet circuit breaker, per-pair rate limit, hop bound, no-relay honouring, sync concurrency cap. DM **bodies never reach the audit log** — only ids and state. Pinned by test H. |
| **State file perms** | `0600` on every state file, `0644` only on the `.example` files. |

---

## Findings

### F1 — MEDIUM (fixed): release test only passed when run as root
`test-release.js` tarballs the working tree into a temp dir. The state files are
`0600` and three of them (`portal-secrets.json`, `portal-board.json`,
`portal-agent-dm.json`) are owned by `root:root`, so a non-root run hit
`tar: Cannot open: Permission denied` and the test aborted.

It passed for months because it was always run as root. That's the worst kind of
green: it wasn't testing releases, it was testing root.

**Fix:** the test now excludes state files explicitly, which is also *more*
correct — `release.sh` already refuses to package state, so the test shouldn't be
reading it either. `test-release.js` is now 8/8 as `noah`.

**Follow-up for Dad (not changed by me):** those three state files being
`root:root` while the rest are `noah:noah` is an inconsistency worth cleaning up
— it means the portal process and the operator can't both read state. Either the
container should stay root and everything be root-owned, or everything should be
`noah`-owned with the container running as that uid.

### F2 — MEDIUM: default admin password is 11 characters and documented
`Perdue3333` is below the 12-character policy minimum and it's written down in
`TOOLS.md`. The policy exists; the deployment doesn't meet it. Not exploitable on
its own (LAN-only, lockout active), but it's the difference between "they'd need
a foothold" and "they'd need to read one file."

**Recommendation:** rotate to a 16+ character passphrase and update `TOOLS.md`.
I'm not doing this unilaterally — it locks out anyone holding the old one.

### F3 — LOW: agent tokens never expire, only revoke
`cpat_` tokens have no TTL. A leaked token is valid until someone notices and
revokes it. The audit log gives you the "notices" path, but nothing bounds the
blast radius automatically.

**Recommendation:** optional `expiresAt` per token in `portal-secrets.json`,
surfaced in the Admin → Agent tokens view with an "expires in N days" chip.
~30 lines. Not urgent while the fleet is small and local.

### F4 — LOW: SSRF surface is deliberate but undocumented in the UI
Gateways are admin-configured URLs the portal dials. That's the product working
as designed (the control plane must reach the gateways), and it is correctly
restricted to config rather than request bodies. But an admin can point a gateway
at `http://169.254.169.254/` or any internal host and the portal will connect.

**Recommendation:** a one-line warning in the Gateways admin view — "the portal
will connect to whatever address you enter here." Cheap, and it makes an implicit
trust boundary explicit. Pinned by test C so nobody widens it accidentally.

### F5 — LOW: no `Content-Security-Policy`
`portal.html` is a single large inline-script page. Every dynamic string is
escaped correctly today (test G), but there's no second line of defence: one
future `innerHTML` with an unescaped variable is a full XSS.

**Recommendation:** add `Content-Security-Policy: default-src 'self';
script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'` — the `'unsafe-inline'` weakens it, but `object-src`,
`base-uri`, and `frame-ancestors` still kill clickjacking and plugin injection
for free. Real fix is moving the script to an external file, which is a bigger job.

### F6 — INFO: password policy not enforced on the built-in admin
The 12-character minimum applies to users created through the UI; the bootstrap
admin password comes from env/config at boot, bypassing the check. Consistent
with F2 — same root cause: bootstrap path is trusted, post-bootstrap path is
validated.

---

## Changes made

1. **Added** `test/security-guards.test.js` — 13 tests, ~380 lines, zero
   dependencies, `node:test`. Runs against the source tree plus one live
   throwaway portal on an ephemeral port. Picked up automatically by
   `run-tests.sh`'s existing `test/*.test.js` glob.
2. **Fixed** `test-release.js` — exclude state files from its temp-dir tarball
   (F1). Now passes as a non-root user, which it never did before.

Nothing in `portal-server.js` or `portal.html` was changed. The review found no
product bugs worth touching without Dad's say-so — the fixes above are the
test-side ones I'm confident about.

## Verification

```
su noah -c './run-tests.sh'  →  exit 0, 264 ✓, 0 ✗
node --test test/security-guards.test.js  →  13/13 pass
node test-release.js  →  8/8 pass (as non-root; previously root-only)
```

Backup of the pre-review tree: `/tmp/portal-pretest-*.tgz`
