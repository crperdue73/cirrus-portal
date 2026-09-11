# Cirrus Portal — Deployment Model & Tenancy

**Decision (2026-09-11): Cirrus Portal is a single-tenant, self-hosted
application. One install serves exactly one organization.**

This document is the official public deployment model for the v3.0.0 release. It
sets expectations *before* someone deploys: what the product is, what it is
deliberately **not**, and which platforms are supported. Canonical product
strings live in [`branding.json`](branding.json); naming rationale is in
[`NAMING.md`](NAMING.md). Per-server setup steps live in [`REPLICATION.md`](REPLICATION.md)
and the operator docs in [`README.md`](README.md).

---

## 1. The tenancy decision

| Question | Answer |
| --- | --- |
| Who runs it? | **You.** Self-hosted on your own server. There is no hosted/SaaS Cirrus Portal. |
| How many organizations per install? | **One.** One install = one org/team. |
| Is there a tenant picker / org switcher? | **No.** There is one account realm and one gateway fleet per install. |
| How do I host more than one org? | **Run more than one install** — one server (or one isolated container stack) per org. Do not share one install between orgs. |

### What "single-tenant" means concretely

- **One account realm.** Accounts and roles (`admin` / `instructor` / `student`)
  exist to separate *people inside one org* — they are **not** tenant boundaries.
  Every account in an install belongs to the same organization.
- **One gateway fleet.** The `gateways[]` list may contain several gateway
  servers, but they are all gateways the *same* org operates. The portal merges
  them into one agent list; it does not wall them off from each other.
- **One data store.** `portal-users.json`, `portal-context.json`,
  `portal-rooms.json`, `portal-audit.log` and the secrets file are single files
  on one host (or one bind-mount set). There is no per-tenant partition.
- **One trust boundary.** The host that runs the portal is the security
  boundary. Anything that can read the state files can read every org record —
  because there is only ever one.

### Why single-tenant (and not multi-tenant)

- **Honesty over over-reach.** Multi-tenancy is an isolation guarantee, not a
  checkbox. Claiming it without per-tenant cryptography, storage separation, and
  a hardened tenant boundary would be a promise the code cannot keep. This
  release does not make that promise.
- **The product is a console, not a platform.** Cirrus Portal is *mission
  control for your OpenClaw fleet* — an operator console for infrastructure you
  control. The natural unit of deployment is one org on one box.
- **Isolation by architecture, not by convention.** Because each install is
  fully separate (own state, own secrets, own device identity, own TLS
  cert/domain), hosting N orgs as N installs gives *stronger* isolation than a
  shared multi-tenant process would, at the cost of N containers. That trade is
  the right one here.

> **If you need per-org isolation, scale out — not inward.** One install per org.
> Never point two organizations at one portal, and never reuse another install's
> `portal-secrets.json`, `portal-device.json`, or TLS key.

---

## 2. Supported platforms

### Tier 1 — supported and tested

The reference target is **Debian 13 (x86_64)**. The installer preflights the
host and treats these as first-class:

| Component | Requirement |
| --- | --- |
| **OS** | Debian 12/13 or Ubuntu 22.04/24.04 LTS (**amd64/x86_64**) |
| **Container runtime** | Docker Engine **+ Compose v2 plugin** (`docker compose version` must work) |
| **OpenClaw gateway** | Running **on the same host**, loopback bind, token auth (default port `18790`) |
| **Node.js** | **22+** — only needed for the systemd (non-Docker) fallback path; the container ships its own |
| **Disk** | **> 500 MB free** on the install directory (hard preflight gate) |
| **Compute** | ~1 vCPU / 1 GB RAM is ample (the container is capped at `512m` / `1.0` CPU) |
| **Browser** | Current Chromium, Firefox, or Safari (vanilla JS + SSE, no build step) |

### Tier 2 — best-effort, untested

The installer **warns but continues** here; support is community/best-effort and
fixes are not guaranteed for the public release:

- Other **Debian-derived** distros (e.g. Raspberry Pi OS 64-bit, **arm64**).
  The base image is a multi-arch manifest and the runtime is portable Node, so
  arm64 *should* work — but it is not part of the tested matrix.
- Non-Debian Linux (Fedora/RHEL/Arch/Alpine host). Containers may run; the
  installer's package/preflight assumptions (ufw, apt) will not all apply.

---

## 3. Explicitly unsupported setups

These are **out of scope for the public release**. Do not file them as bugs;
they are known non-goals, not pending features.

| Setup | Why it is unsupported |
| --- | --- |
| **Multi-tenant / SaaS** — many orgs in one install | See §1. Not a tenant boundary; run one install per org. |
| **Public cleartext exposure** (non-loopback bind, no TLS) | **Refused at boot** by design (item 5). Expose via `--domain` (Caddy), your own cert, or a trusted TLS proxy. |
| **Running behind an untrusted/transparent proxy** without `trustProxy` set | Cookie `Secure`/schema detection cannot be trusted; only configured TLS proxies are supported. |
| **Windows (native)** hosts | Not packaged or tested; use a Linux VM/container host. |
| **macOS** hosts | Not packaged or tested. |
| **Kubernetes / Nomad / orchestrators** | No official manifests. The compose stack is the deploy unit. |
| **High availability / multi-node clustering** | A single instance with a single local state store. No leader election, no shared DB, no active-active. |
| **Sharing state or secrets across installs** (shared device identity, copied `portal-secrets.json`, shared users file) | Breaks the per-install trust model; produces duplicate device identities and fleet-wide credentials. |
| **Cross-org gateway federation** (one portal driving orgs' gateways that don't trust each other) | The trust boundary is the install; do not bridge untrusted fleets. |
| **Running the portal host as a multi-user shared login box** | The state files are the crown jewels; anyone with host read access to them has the whole org. |

---

## 4. Requirements checklist (copy/paste)

Before you deploy, confirm all of these are true on the target host:

- [ ] Debian 12/13 or Ubuntu 22.04/24.04, **x86_64**
- [ ] `docker compose version` works and the user can talk to Docker
- [ ] An OpenClaw gateway runs locally on `127.0.0.1:18790` with **token auth**
- [ ] ≥ 500 MB free disk in the install directory
- [ ] A DNS name + reachability for it, **if** you want automatic HTTPS
- [ ] Ports 80/443 open in the firewall **if** using Caddy for TLS (else nothing — loopback installs need no inbound rule)

Then follow [`REPLICATION.md`](REPLICATION.md) § Quick start, or:

```bash
./install.sh install --domain portal.example.com --email you@example.com
```

---

## 5. Scaling the model

| You want… | Do this |
| --- | --- |
| A second team / org | Second install, second host (or second isolated stack), **its own** secrets + device identity + domain. |
| More gateways for the same org | Add entries to `gateways[]` (UI: admin → Gateways). Still one org, one install. |
| More people in the same org | Add accounts (`admin`/`instructor`/`student`) in the one install. |
| HA | Not supported in 3.x. Run a warm standby install + restore from backup if you need uptime beyond a single box (see item 17). |

---

*Model last reviewed 2026-09-11 (public-readiness plan, item 9). This decision —
single-tenant, self-hosted, one org per install — is load-bearing for the threat
model and the public docs; change it here first, then propagate.*
