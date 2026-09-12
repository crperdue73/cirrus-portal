# Cirrus Portal — Threat Model

**Product:** Cirrus Portal (family: Cirrus · engine: Cirrus Core)
**Maintainer:** CRPerdue Technologies, LLC
**Model version:** 1 (v3.0.0 public release)
**Deployment assumed:** single-tenant, self-hosted — one org per install
([`DEPLOYMENT.md`](DEPLOYMENT.md)).

This document describes what Cirrus Portal protects, from whom, and how. It is
written to be **honest about limits**: where a control is partial or a risk is
accepted, it says so. Security reports go to [`SECURITY.md`](SECURITY.md), not a
public issue.

---

## 1. Scope & assumptions

**In scope:** the portal server (`portal-server.js`), the web UI
(`portal.html`, `setup.html`), the setup wizard, the installer, the container
image/Compose config, the shipped TLS templates, and credential/secret handling.

**Out of scope:** the OpenClaw gateway itself, the host OS, third-party
components (Node.js, Alpine/BusyBox, Caddy, nginx), and any environment where the
host is already compromised by the attacker.

**Load-bearing assumptions.** If any of these is false, the model changes:

1. The portal runs on a host the operator controls, and is **single-tenant** —
   all accounts belong to one organization.
2. The OpenClaw gateway runs on the **same host** and is reached over loopback.
3. Public exposure terminates **TLS** (Caddy, operator certs, or a trusted
   TLS proxy) — the portal refuses a public cleartext bind by default.
4. The operator keeps the host patched and the state files private (mode 600).

---

## 2. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Gateway tokens | `portal-secrets.json` (0600) | Full operator control of the agent fleet |
| Portal accounts + password hashes | `portal-users.json` (0600, scrypt) | Access to agents and data |
| Device identity (Ed25519) | `portal-device.json` (0600) | The gateway trusts this device as an operator |
| Session cookies / CSRF secrets | in memory + browser | User impersonation |
| Course/user context | `portal-context.json` (0600) | Student PII, assignment data |
| Rooms + transcripts | `portal-rooms.json` (0600) | Conversation contents |
| Audit trail | `portal-audit.log` | Accountability, incident forensics |
| TLS private key / cert | host (Caddy or operator) | Transport integrity |

The **state files are the crown jewels**: they live on one host and there is one
set per install. Host-level read access to them is game over for that install —
which is why the deployment model rejects shared-login boxes
(see [`DEPLOYMENT.md`](DEPLOYMENT.md) §3).

---

## 3. Trust boundaries

```
                 untrusted                │            trusted host
 ┌───────────────────────────┐           │  ┌──────────────────────────────┐
 │ Internet / browser        │──TLS─────▶│  │ TLS terminator (Caddy/proxy)  │
 │ (attacker-controlled)     │           │  └──────────────┬───────────────┘
 └───────────────────────────┘           │                 │ loopback
                                          │  ┌──────────────▼───────────────┐
                                          │  │ portal-server (uid 10001)    │
                                          │  │  ├ portal-*.json/.log (0600) │
                                          │  │  └ device identity           │
                                          │  └──────────────┬───────────────┘
                                          │                 │ loopback WS
                                          │  ┌──────────────▼───────────────┐
                                          │  │ OpenClaw gateway (:18790)    │
                                          │  └──────────────────────────────┘
                                          └──────────────────────────────────┘
```

Boundaries that matter:

- **Browser ↔ TLS terminator.** Everything the attacker can reach. TLS is
  mandatory for public exposure; the portal refuses cleartext off-loopback.
- **TLS terminator ↔ portal.** Loopback. A reverse proxy is trusted **only** when
  configured (`trustProxy` / `tlsMode`), because the portal derives cookie
  `Secure` from `X-Forwarded-Proto` — trusting that header from an untrusted
  hop would let an attacker strip TLS.
- **Portal ↔ gateway.** Loopback WebSocket, authenticated by the gateway token
  and the approved device identity. The browser never sees the token.
- **Host ↔ state files.** The real security boundary. File mode 600, owned by the
  non-root runtime uid.

---

## 4. Adversaries

| Adversary | Capability | Primary goal |
| --- | --- | --- |
| **Remote unauthenticated** | Network access to the public endpoint | Break auth, find a pre-auth bug, brute-force logins |
| **Authenticated low-privilege user** (e.g. a `student`) | Valid session, own role | Escalate to instructor/admin, read others' data, exceed assigned agents |
| **Malicious/compromised gateway or agent** | Controls agent replies/tool output | Prompt-inject the operator's browser, exfiltrate via tool calls |
| **Local unprivileged host user** | Shell on the host, no root | Read state/secrets, impersonate the portal |
| **Network attacker on-path** | Can modify cleartext traffic | Steal sessions/credentials, downgrade TLS |
| **Compromised dependency / base image** | Code in the runtime | Backdoor the portal |

---

## 5. Threats, controls, and residual risk

Legend: **✅ mitigated** · **⚠️ partial** · **➖ accepted/out of scope**.

### 5.1 Authentication & session (remote unauthenticated)

| Threat | Control | Status |
| --- | --- | --- |
| Default/shared credentials | No shipped defaults; fresh install mints a unique password; startup **refuses to boot** on a known-default admin password | ✅ |
| Brute-force / credential stuffing | Per-(IP+username) rate-limit with **progressive lockout** (`429` + `Retry-After`) | ⚠️ in-memory, single-node |
| Session fixation | Fresh session id **on login**; the request's id is dropped | ✅ |
| Session hijack via theft | `HttpOnly`, `SameSite=Strict`, `Secure` under TLS; configurable absolute + idle TTL | ✅ |
| Weak passwords | Policy on create/reset (12+ chars, complexity, blocklist) | ✅ |
| Stale sessions after compromise | `logout-all`; password reset revokes all sessions | ✅ |

**Residual:** lockout state is **in-memory** — a restart clears counters, and
there is no cross-instance shared state (the product is single-node by design).
Distributed lockout is not attempted.

### 5.2 Authorization (authenticated low-privilege user)

| Threat | Control | Status |
| --- | --- | --- |
| Students reaching unassigned agents | Agent allowlist enforced **server-side on every endpoint** (agents/history/send/abort/stream) | ✅ |
| Privilege escalation to admin | Role checks server-side on every admin/instructor route | ✅ |
| CSRF on state-changing requests | Session-bound `X-CSRF-Token` on all `POST`/`PATCH`/`DELETE`; mismatched `Origin` refused | ✅ |
| Reading the audit log | Admin-only | ✅ |
| Resolving tool approvals | Resolve is **instructor+**, enforced server-side (`canResolve` computed server-side) | ✅ |

**Residual:** roles are **not** tenant boundaries — within one org, instructors
and admins see broadly. That is by design ([`DEPLOYMENT.md`](DEPLOYMENT.md) §1).

### 5.3 Secrets & state at rest

| Threat | Control | Status |
| --- | --- | --- |
| Tokens leaking via API responses | `/api/gateways` returns only `hasToken`; tokens never serialized | ✅ |
| Tokens leaking via config/logs/backups/tarballs | Dedicated `portal-secrets.json` (0600); `saveConfig()` token-free; backups exclude secrets; `secret-scan.sh` + CI grep the repo and a built tarball | ✅ |
| Device identity theft | `portal-device.json` 0600; must persist per install | ⚠️ host access = theft |
| State files readable by other host users | Mode 600; non-root container uid 10001 | ⚠️ root on host is trusted |

**Residual:** a host-level attacker (or root) can read everything — this is
**accepted**, and is exactly why the model forbids shared-login hosts. There is
no per-file encryption at rest; rely on host disk encryption if that is in your
threat model.

### 5.4 Transport

| Threat | Control | Status |
| --- | --- | --- |
| Public cleartext exposure | Boot **refuses** a non-loopback bind without TLS; only an explicit, loudly-warned `--insecure-plaintext` overrides | ✅ |
| TLS downgrade / header spoofing | `trustProxy` only when configured; HSTS emitted in secure contexts; cookies `Secure` | ✅ |
| Session cookie sniffing | `Secure` under TLS + HSTS | ✅ |
| Accidental exposure | Default bind `127.0.0.1`; public needs explicit opt-in (`publicBind`/`PORTAL_PUBLIC_BIND`/`--public-bind`) | ✅ |

**Residual:** `--insecure-plaintext` exists for trusted LANs/tunnels. On the open
internet it is equivalent to no transport security — the warning is real, not
ceremonial.

### 5.5 Browser & content (malicious agent output)

| Threat | Control | Status |
| --- | --- | --- |
| Stored/reflected XSS via agent replies | Chat renders as text through the app's own DOM helpers (no raw HTML injection of model output) | ⚠️ UI code is the trust surface; treated as in-scope for reports |
| Prompt injection driving tool calls | Portal is a console — the **gateway** executes tools. The portal surfaces tool receipts and flags assignment-policy violations (`tool_policy_block`) but does **not** hard-block at the model layer | ⚠️ flag-and-audit |
| CSV/log injection | Audit details are structured, rendered as text | ✅ |

**Residual:** per-assignment tool policy is **flag-and-audit**, not enforcement —
hard enforcement needs gateway-side work and is on the roadmap. Do not rely on
it as a security boundary.

### 5.6 Supply chain & runtime

| Threat | Control | Status |
| --- | --- | --- |
| Vulnerable base image | Digest-pinned `node:22-alpine`; zero bundled third-party code ([`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)) | ✅ |
| Container escape / blast radius | Non-root uid 10001, `read_only` rootfs, `cap_drop: ALL`, `no-new-privileges`, resource limits | ✅ |
| Tampered release artifact | Versioned tarball + `SHA256SUMS`; `secret-scan.sh` runs in CI and blocks the build on findings | ⚠️ checksums not yet signed |

**Residual:** checksum signing and a full SBOM land in the release-engineering
workstream; until then, verify `SHA256SUMS` against a trusted copy.

---

## 6. Out of scope / accepted risks

- **Multi-tenancy / cross-org isolation.** Not a feature; run one install per org.
- **HA / clustering.** Single instance, single local state store.
- **Volumetric DoS.** No CDN/L7 scrubbing is shipped.
- **Compromised host or gateway.** If the gateway is hostile, the portal is a
  console to a hostile fleet — rotate tokens and treat the fleet as breached.
- **Physical access, social engineering.**
- **Anonymous scanner output** with no demonstrated impact (see
  [`SECURITY.md`](SECURITY.md)).

---

## 7. Hardening checklist for operators

- [ ] Terminate TLS (the portal refuses a public cleartext bind by default)
- [ ] Keep the host and container image patched; rebuild on `node:22-alpine` updates
- [ ] Keep state files 600 and the host non-shared
- [ ] Rotate gateway tokens on any suspected exposure
- [ ] Back up state + keep an offline copy of `portal-secrets.json` and `portal-device.json`
- [ ] Use a strong, unique admin password; delete `portal-credentials.txt` after recording
- [ ] Restrict outbound/inbound with a firewall (loopback installs need no inbound rule)
- [ ] Review `portal-audit.log` periodically; watch `login_throttled` / `tool_policy_block`

---

*This threat model is versioned with the release. Change it in the same commit
as any control it describes. Last reviewed 2026-09-12 (public-readiness plan,
item 12).*
