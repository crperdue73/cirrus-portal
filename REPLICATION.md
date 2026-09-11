# Replicating Cirrus Portal — install on N servers

The portal is a **browser chat bridge to OpenClaw agents**. It was built to be
copied: the app code is two self-contained files with zero dependencies, and
everything that makes an install unique lives in small, per-server JSON files.
This doc is the runbook for standing it up on any number of servers.

---

## 1. The model — what gets copied vs. what gets created

```
┌─────────────────────────  SERVER N  ─────────────────────────┐
│                                                              │
│   OpenClaw Gateway  ◄──loopback WS──  Cirrus Portal (Docker)  │
│   :18790 (token auth)            :18800 (browser UI)         │
│        ▲                              │                      │
│        │ approves device              ▼                      │
│   device.pair store            portal-config.json            │
│   (per server)                portal-device.json  (generated)│
│                               portal-users.json   (generated)│
│                               portal-context.json (generated)│
│                               portal-rooms.json    (generated)│
│                               portal-audit.log     (generated)│
└──────────────────────────────────────────────────────────────┘
```

**Copy these (the code — identical everywhere):**

| File | Why it's safe to copy |
|---|---|
| `portal-server.js` | The whole server. Zero npm dependencies (Node 22 built-ins only). |
| `portal.html` | The whole UI. Single file, vanilla JS. |
| `Dockerfile` | Build recipe. |
| `docker-compose.yml` | Runtime recipe (host networking, bind mounts, non-root/read-only hardening). |
| `install.sh` | The professional installer (v2.1.0 — preflight, auto-detect, hardening, backup/restore). |
| `bootstrap.sh` | Legacy installer (still works, superseded by `install.sh`). |
| `reconnect-test.js` | Optional regression test. |

**Never copy these (per-instance state — each server generates its own):**

| File | What it holds | What happens on a fresh server |
|---|---|---|
| `portal-config.json` | Port, bind, gateway URLs/ids (TOKEN-FREE) | Must be written per server — bootstrap.sh does it. |
| `portal-secrets.json` | **Gateway token(s)** + first-run admin password (0600) | Must be written per server — bootstrap.sh does it. Never backed up or shipped. |
| `portal-device.json` | Ed25519 device identity the gateway trusts | **Auto-generated** on first boot. The gateway must approve this *specific* device. Copying one from another box creates a duplicate identity and breaks the trust model. |
| `portal-users.json` | Local accounts + roles | **First run only** (installer): if no admin exists and a bootstrap password is configured, one is minted with it. With *nothing* configured the server serves the setup wizard instead — no account is created until the wizard completes. Never a shipped default. |
| `portal-context.json` | CI30 course + per-user context | **Auto-seeded** with the default course store. |
| `portal-rooms.json` | Group-chat rooms | Starts empty. |
| `portal-audit.log` | Login/send/approval audit trail | Starts empty. |

The server is built so that the **only files you must provide are
`portal-config.json` and `portal-secrets.json`** — everything else self-heals on
first boot.

---

## 2. Prerequisites (per server)

- **Debian/Ubuntu-class host** (the reference box is Debian 13).
- **Docker Engine + Compose plugin** (`docker compose version` works).
- **Node 22+** (only needed for the systemd fallback path; the container has its own).
- **An OpenClaw gateway on the same host**, running with:
  - `gateway.mode: "local"`, `gateway.bind: "loopback"`, port `18790` (defaults);
  - **token auth**: `gateway.auth.mode: "token"` and a `gateway.auth.token`
    value. This token is what the portal presents on connect — it must equal
    `gatewayToken` in the portal's `portal-config.json`.
  - The `openclaw` CLI available to the user who will approve devices
    (`openclaw devices list`).
- **Port 18800 open** in any firewall (UFW: `sudo ufw allow 18800/tcp`) if the
  UI should be reachable off-host.

> Each server gets its **own gateway token and its own portal password**.
> Reusing another server's token is technically possible (the portal only
> reaches the gateway over loopback) but it's bad hygiene and makes a leaked
> token a fleet-wide credential. Generate per box.

---

## 3. Quick start (2 commands)

> **v2.1.0 (Sep 2026):** `install.sh` is the canonical installer
> (auto-detects the gateway token, generates a strong admin password, preflights
> the host, hardens permissions, and can open the firewall). `bootstrap.sh`
> below is the legacy path — it still works, but new installs should use
> `install.sh`. Everything in this doc (what gets copied, approval, upgrade,
> backup) applies to both.

```bash
# 1. Get the release onto the new server:
scp dist/agent-portal-2.1.0.tar.gz user@new-server:/tmp/

# 2. SSH in and install (auto-detects the gateway token, generates a strong
#    admin password, saves credentials to portal-credentials.txt):
ssh user@new-server 'cd /tmp && tar xzf agent-portal-2.1.0.tar.gz \
  && cd agent-portal-2.1.0 && ./install.sh install'

# 3. Check it:
./install.sh status

# 4. Open the UI:
#    https://<domain>/            (when installed with --domain)
#    http://127.0.0.1:18800        (loopback default — tunnel in)
#    admin password is in portal-credentials.txt
```

> **TLS / exposure (Sep 2026):** the installer now binds **127.0.0.1 by
> default** and **refuses a public bind without TLS**. For a public host use
> automatic HTTPS:
>
> ```bash
> ./install.sh install --domain portal.example.com --email you@example.com
> ```
>
> That keeps the portal on loopback and runs **Caddy** in front (automatic
> Let's Encrypt certs, 80→443 redirect, HSTS). Alternatives: `--tls-cert` /
> `--tls-key` to serve your own certificate, or point your own TLS-terminating
> proxy at the loopback port and set `trustProxy:true`. Cleartext public access
> needs the explicit `--insecure-plaintext` (trusted LAN/tunnel only).
> Templates: `deploy/Caddyfile`, `deploy/nginx/cirrus-portal.conf`.
>
> **Safe network defaults (Sep 2026):** `bind` defaults to `127.0.0.1`. A
> non-loopback bind is a deliberate opt-in — set `"publicBind": true` in
> `portal-config.json` (the installer writes it), or `PORTAL_PUBLIC_BIND=1` /
> `--public-bind` — and it still refuses cleartext without TLS. A wildcard bind
> (`0.0.0.0`) warns loudly at boot. Open the firewall with `--firewall`
> (`sudo ufw allow 80,443/tcp` for `--domain`, else the portal port).

That's it. From a cold server to a working portal in ~2 minutes, and the whole
flow is repeatable per machine. To approve the device, `install.sh install`
already does it when `openclaw` is on PATH; otherwise approve manually
(`openclaw devices list` → `openclaw devices approve <requestId>`) — or use
`./bootstrap.sh --approve` for the legacy helper.

Other commands: `./install.sh upgrade|status|doctor|backup|restore FILE|uninstall`
(see `./install.sh --help`).

---

## 4. Full walkthrough (the why behind each step)

### 4.1 Copy the code, not the state

```bash
mkdir -p /opt/agent-portal
scp portal-server.js portal.html Dockerfile docker-compose.yml bootstrap.sh reconnect-test.js \
    user@new-server:/opt/agent-portal/
```

**Never** copy `portal-config.json`, `portal-secrets.json`, `portal-device.json`,
`portal-users.json`, `portal-context.json`, `portal-rooms.json`, or
`portal-audit.log` from an existing install. They are per-server state (see §1).

### 4.2 Point the gateway token at *this* server's gateway

```bash
cd /opt/agent-portal
GATEWAY_TOKEN="$(grep -o '"token": *"[^"]*"' ~/.openclaw/openclaw.json | head -1 | cut -d'"' -f4)" \
    ./bootstrap.sh
```

If you don't know the token, check the gateway config
(`gateway.auth.token` in the gateway's config file, or ask whoever administers
that box). If it's unset, set it first:

```json
{ "gateway": { "auth": { "mode": "token", "token": "<generate-a-long-random-token>" } } }
```

…and restart the gateway. The portal **must** present a token the gateway
accepts, or the connect is rejected.

`bootstrap.sh` writes `portal-config.json` (chmod 600, **token-free**) with the
port, bind and gateway URL, and `portal-secrets.json` (chmod 600) with the
gateway token plus a portal password (generated and printed if you didn't pass
one — **save it**, it's the admin login). It never overwrites an existing
config unless you pass `--force-config`.

It also **pre-creates the state files** (`portal-device.json`, `portal-users.json`,
`portal-context.json`, `portal-rooms.json`, `portal-audit.log`) — without this,
Docker bind-mounts a *missing* host path as a **directory**, and the server's
write-on-boot seeding silently fails. This was found and fixed during
replication testing.

> Port/bind are driven **only** by `portal-config.json` — the Dockerfile and
> compose file deliberately set no `PORT`/`BIND` env, because env overrides
> beat the config file in `loadConfig()` and silently broke per-server ports
> (also found in replication testing). To change a server's port, edit the
> config (or re-run bootstrap with `PORT=`).

### 4.3 Boot — the device identity self-generates

`docker compose up -d --build` builds the zero-dependency container and starts
it. On first boot the server:

1. Generates `portal-device.json` (Ed25519 keypair, chmod 600) if missing;
2. Connects to the gateway over loopback, presenting the token **and** a
   signature from that device keypair;
3. Seeds `portal-users.json` (mints the `admin` account with the generic
   default credential), `portal-context.json` (default course store), empty
   rooms and audit log.

The gateway sees a **new, unapproved device** → creates a pending pairing
request. The portal keeps retrying with exponential backoff (1s → 30s) until
it's approved — no restart needed after approval.

### 4.4 Container hardening (non-root + read-only)

As of the v3 hardening pass (plan item 8) the image:

- runs as the unprivileged `portal` user (`uid:gid 10001`) — never root;
- is built `FROM` a **digest-pinned** base image;
- ships a `HEALTHCHECK` (`healthcheck.js`, loopback `GET /`);
- runs with `read_only: true`, a size-capped `/tmp` tmpfs, `cap_drop: ALL`,
  `no-new-privileges`, and cpu/mem/pid limits (see `docker-compose.yml`).

Because the runtime is non-root, the **bind-mounted state** (`portal-config.json`,
`portal-secrets.json`, `portal-device.json`, `portal-users.json`,
`portal-context.json`, `portal-rooms.json`, `portal-audit.log`) must be owned by
`10001:10001`. `install.sh` and `bootstrap.sh` chown it automatically; if you
built the image with a different `--build-arg PORTAL_UID/PORTAL_GID`, chown to
match. `./install.sh doctor` reports ownership drift.

### 4.5 Approve the device (the only manual step)

```bash
openclaw devices list          # find the pending request
openclaw devices approve <requestId>
```

Or use the helper, which only approves a request whose device id matches this
server's `portal-device.json` (never blindly approves someone else's):

```bash
./bootstrap.sh --approve
```

The portal asked for scopes `operator.read`, `operator.write`,
**`operator.approvals`** (the last one powers the 🛡 tool-confirmation cards).
Approve with those scopes granted. If the device was approved for fewer scopes
(read/write only), the portal falls back gracefully — approvals stay read-only
and staff see a banner in the UI — and a scope-upgrade request appears in
`openclaw devices list` that you can approve the same way.

### 4.6 Verify

```bash
./bootstrap.sh --verify
```

Checks: container up, gateway socket on 127.0.0.1:18790, portal answering HTTP.
Then open `http://<server-ip>:18800` and log in as `admin`.

---

## 5. Upgrading an existing install

The upgrade path is exactly the copy step — state files never change:

```bash
cd /opt/agent-portal
scp portal-server.js portal.html Dockerfile docker-compose.yml user@new-server:/opt/agent-portal/
ssh user@new-server 'cd /opt/agent-portal && docker compose up -d --build'
```

`portal-device.json` persists across rebuilds (bind-mounted), so the gateway
keeps recognizing the device — **no re-approval needed**. Config, users, rooms,
context, and audit all survive untouched.

## 6. Rolling back

The previous image stays in Docker's cache; the old JS/HTML are one `scp`
away. If a bad deploy got in, restore the files and `docker compose up -d
--build` again. Device identity and state are untouched by either direction.

---

## 7. Verification checklist (per new server)

- [ ] `docker compose ps` → `agent-portal` Up
- [ ] `./bootstrap.sh --verify` → all three checks pass
- [ ] `openclaw devices list` → portal device shows **paired**, scopes include
      `operator.read`, `operator.write`, `operator.approvals`
- [ ] Browser → `http://<ip>:18800` → login as `admin` works
- [ ] Agents list is populated (not "no agents" — that means the device isn't
      approved or the gateway token is wrong)
- [ ] Send a message to an agent → reply streams in
- [ ] `portal-audit.log` records the login
- [ ] Reboot the box → portal comes back on its own (`restart: unless-stopped`)
- [ ] Restart the gateway → portal auto-reconnects (≤30s, no container restart)

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| UI loads but "no agents" | Device not approved, or wrong gateway token | `openclaw devices list`; approve with `./bootstrap.sh --approve`; check `gatewayToken` matches `gateway.auth.token` |
| Log shows `NOT_PAIRED` / scope fallback | Device approved with fewer scopes than requested | Approve the pending scope-upgrade request in `openclaw devices list` |
| Portal dark after gateway restart | Old reconnect bug (fixed Aug 4) | Should auto-recover ≤30s; if not, `docker compose restart agent-portal` and check `portal.log` |
| `✗ no gateway on 127.0.0.1:18790` in preflight | Gateway not running / not loopback | Start gateway; confirm `gateway.bind: loopback`, port 18790 |
| Port 18800 unreachable off-host | Firewall | `sudo ufw allow 18800/tcp` |
| Can't approve: "requires operator.pairing" | Your CLI session lacks pairing scope | Run `openclaw devices approve` from a session with `operator.admin` (e.g. the gateway owner's shell) |
| Admin password lost | — | Delete `portal-users.json` and restart — with `portalPassword` set the server re-mints `admin` with it (`portal-first-run.txt`), otherwise it serves the setup wizard at `/setup` to create a fresh admin |
| Changed port ignored / `EADDRINUSE` on 18800 | Env override beat the config | Port comes only from `portal-config.json` now; edit it (or `PORT=... ./bootstrap.sh --force-config`) and `docker compose up -d` |

---

## 9. Fleet notes (multiple servers)

- **Per-server secrets:** unique `gateway.auth.token` and unique portal
  password on every box. `bootstrap.sh --verify` + `portal-audit.log` give you
  per-box health and an audit trail.
- **The portal talks to its own host's gateway only** (loopback + host
  networking). It is not a remote-control plane — each server is an island.
  If you want a *fleet* view, that's the multi-gateway roadmap item (settings
  button → multiple gateways), which is explicitly **not** what this
  replication kit does.
- **Backups:** back up the state files per box (`portal-config.json`,
  `portal-device.json`, `portal-users.json`, `portal-context.json`,
  `portal-rooms.json`, `portal-audit.log`) — restoring those six files onto a
  fresh code copy is a full restore, no re-approval needed as long as the
  gateway's paired-device store is also intact (it lives in the gateway's
  state dir, `~/.openclaw/nodes/paired.json` — back that up too).
  `portal-secrets.json` is **deliberately excluded** from `install.sh backup`:
  secrets never touch backups. Re-provide `GATEWAY_TOKEN=...` (or copy the
  secrets file out-of-band) after a restore.
- **CI/CD:** the whole flow is scriptable — `bootstrap.sh --fresh` +
  `--approve` + `--verify` are the three stages. `--fresh` is destructive by
  design, so gate it behind an explicit environment (staging only).

Built by Noah · Aug 1 2026 (v1) · replication kit Aug 6 2026 — "make sure this
project can be replicated." · professional installer v2.1.0 Sep 4 2026 —
"polished professional install, ready for other servers."
