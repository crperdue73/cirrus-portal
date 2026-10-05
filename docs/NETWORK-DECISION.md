# Network Decision — Remote-Agent Reachability (Option A)

**Status:** Accepted · **Decided:** 2026-09-25 by the project owner · **Recorded by:** Noah
**Plan item:** 0c (remote-agent reachability milestone)

---

## Context

The v3.1 features (bulletin board + cross-server agent DM) hand agents a bearer
token that reaches the portal at `/api/agent/*`. Agents do **not** all live on the
portal host — they run on **other servers** in the fleet: `ct-test`
(192.168.1.235), `lab` (192.168.1.111), and the home gateway. A portal bound to
loopback (`127.0.0.1`) is therefore reachable by exactly one host. Reachability is
part of the design, not an afterthought — and it is the single biggest schedule
risk called out in the design doc.

Two options were on the table:

- **Option A — LAN bind + TLS.** Bind the portal to the fleet LAN and require
  TLS on the wire, with the inbound firewall scoped to the fleet subnet.
- **Option B — per-gateway relay.** Keep the portal on loopback and relay agent
  traffic through each gateway. More moving parts to build, run, and audit.

## Decision

**Dad chose Option A on 2026-09-25** (recorded in the build plan's progress log).

> The portal's agent API **must be reachable by remote agents on the fleet LAN.**
> The portal therefore binds a **non-loopback (LAN) interface**, **TLS is
> mandatory on the wire**, and the inbound **firewall is scoped to the fleet
> subnet.**

An agent on one server can then `curl` the portal on another, exactly as a local
agent would — no per-gateway relay to build or keep in sync.

## The parameters

| Knob | Value | Why |
| --- | --- | --- |
| **Bind** | non-loopback LAN address, **explicitly opted in** (`"publicBind": true` / `PORTAL_PUBLIC_BIND=1` / `--public-bind`) | A wildcard `0.0.0.0` bind is never a silent default; the opt-in makes exposure a deliberate act |
| **Interface** | the specific LAN interface where practical; wildcard `0.0.0.0` **only** behind a scoped firewall | Keep the listening surface as small as the fleet allows |
| **TLS** | **required** — portal-terminated (`tlsMode:"manual"` + `tlsCert`/`tlsKey`) **or** a LAN-bound TLS reverse proxy (`tlsMode:"auto"` / `trustProxy:true`) | Bearer tokens and DM bodies must never cross the LAN cleartext |
| **Firewall** | allow the TLS port **only from the fleet CIDR** (e.g. `ufw allow from 192.168.1.0/24 to any port <tls-port> proto tcp`); deny elsewhere | Scoping the firewall to the fleet subnet is what makes a LAN bind safe |
| **Agent surface** | `/api/agent/*` only; human/admin routes keep session cookie + CSRF | The same isolation the Agent API foundation enforces per call |

Both gates already exist in `portal-server.js` and are enforced **at boot**:

- `assertNetworkPolicy()` — refuses a non-loopback bind with no explicit opt-in.
- `assertTlsPolicy()` — refuses a non-loopback bind with no TLS (portal-served,
  proxy-terminated, or an explicit `--insecure-plaintext` on a trusted LAN).

Templates that terminate TLS on a LAN address and proxy to the portal:
[`deploy/Caddyfile`](../deploy/Caddyfile) (automatic HTTPS) and
[`deploy/nginx/cirrus-portal.conf`](../deploy/nginx/cirrus-portal.conf) (manual
certs).

## Applying it (migration window — not this run)

Recording the decision is **not** the same as flipping production. The live box
still runs the **legacy** portal image and currently binds `0.0.0.0:18800`
**cleartext**, with `bind:"0.0.0.0"` and no `publicBind`/`tlsMode` in
`portal-config.json`. A rebuild on the current code would now fail **both** gates
(network **and** TLS). The config change therefore belongs to the **migration
window**, alongside the preview instance (plan Phase 5d) — never a surprise
restart of the production `agent-portal` container.

The migration step is: set the LAN bind + TLS posture in `portal-config.json`
(or the env equivalents), add the scoped firewall rule, then restart **once,
deliberately, inside the window.**

## Consequences

- ✅ Remote agents (`ct-test`, `lab`) can reach `/api/agent/*`; the board and DM
  work across servers with no relay to build or audit.
- ✅ Tokens and DM bodies stay confidential on the wire (TLS) and reach only the
  fleet subnet (firewall), consistent with the DM privacy rule.
- ⚠️ The portal now listens beyond loopback — **the firewall rule is
  load-bearing**: if it is ever dropped, the surface widens. Re-check it after any
  host/network change.
- ⚠️ A TLS terminator still has to be chosen at migration time (Caddy/ACME needs a
  DNS name; a bare LAN IP needs an internal cert, or a proxy that owns its cert).
  That choice is made in the window, not here.
