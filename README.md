# Cirrus Portal 🐯

**Mission control for your OpenClaw fleet.** A browser console that talks
**directly to OpenClaw agents** — no Telegram, no channel plugins.

> Product family: **Cirrus** · engine: **Cirrus Core** · console: **Cirrus Portal**.
> Naming rationale and canonical strings live in [`NAMING.md`](NAMING.md) and
> [`branding.json`](branding.json). Public-release plan: [`plan-public-readiness.md`](plan-public-readiness.md). Open it, pick an agent, and you're chatting with that
agent's **main session** (`agent:<agentId>:main`). History is the agent's real
session history; replies stream live.

> **📦 Replicating this on another server?** See [`REPLICATION.md`](REPLICATION.md)
> + `./install.sh` — the professional installer. One command per server, code
> copies, state never does.
>
> **🏢 Deployment model:** Cirrus Portal is **single-tenant, self-hosted** — one
> org per install. Supported platforms and explicit non-goals are in
> [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Professional install (v2.2.0, Sep 2026)

`install.sh` is the polished, production-ready installer for standing the portal
up on any Debian/Ubuntu server that runs an OpenClaw gateway:

> **v2.1.0 (Sep 2026):** fixes the Rooms tab being unclickable — the desktop nav
> now stacks vertically in the sidebar (regression from an Aug CSS edit where
> the nav lost its `flex-direction` and overflowed under the chat pane);
> ≤900px keeps the horizontal scroll strip. Rebuilt from the same code base as
> v2.0.0 otherwise.

```bash
# 1. Get the release onto the server:
scp dist/cirrus-portal-<version>.tar.gz user@server:/tmp/

# 2. Install:
ssh user@server 'cd /tmp && tar xzf cirrus-portal-<version>.tar.gz && cd cirrus-portal-<version> \
  && ./install.sh install --firewall'

# 3. Health-check it:
./install.sh status
```

What it does for you (no manual steps except approving the device, which it
will even do itself when `openclaw` is on PATH):

- **Auto-detects the gateway token** from `~/.openclaw/openclaw.json` — no
  hunting through config files.
- **Generates a strong random admin password** on fresh installs and saves it
  to `portal-credentials.txt` (0600) — no default-credential exposure.
- **Preflight checks**: OS, disk space, Docker + Compose v2, port conflicts,
  gateway reachability — fails fast with clear messages.
- **Harden-permissions pass**: config + state + credentials all chmod 600.
- **TLS by default**: binds `127.0.0.1` and **refuses a public bind without
  TLS**. `--domain` sets up automatic HTTPS (Caddy); see “TLS & public
  exposure” below.
- **Safe network defaults**: `bind` defaults to `127.0.0.1` (loopback); a
  non-loopback bind requires an explicit opt-in (`publicBind:true`,
  `PORTAL_PUBLIC_BIND=1`, or `--public-bind`) and still refuses cleartext.
- **Optional firewall rule** (`--firewall`, ufw) and **device approval**
  (`--approve` is the default; `--no-approve` to skip).
- **Idempotent**: re-running `install` on a healthy box changes nothing.

Full command set:

```
./install.sh install             # detect → configure → build → run
./install.sh upgrade             # rebuild from current code, keep state
./install.sh status              # scriptable health check (exit 0/1)
./install.sh doctor              # deep diagnostics
./install.sh backup              # state+config snapshot → ./backups/
./install.sh restore FILE        # restore a snapshot
./install.sh uninstall [--purge] # stop container (optionally delete files)
./install.sh version
```

`release.sh` builds the versioned, checksummed distribution tarball
(`dist/cirrus-portal-<ver>.tar.gz` + `SHA256SUMS`) that contains only code +
installer + docs — never per-server state. The older `bootstrap.sh` remains
as a legacy path; `install.sh` supersedes it.

## TLS & public exposure (Sep 2026)

The portal is **secure by default**: it binds `127.0.0.1` (loopback) and
**refuses to bind a public interface without TLS** unless you explicitly opt
out. Three supported ways to expose it:

```bash
# 1. Automatic HTTPS with Caddy (recommended) — the installer wires it up:
./install.sh install --domain portal.example.com --email you@example.com
#    → portal on 127.0.0.1:18800; Caddy terminates TLS on 80/443 with
#      automatic Let's Encrypt certs, redirects 80→443, sends HSTS.

# 2. Bring your own certificate (the portal serves HTTPS itself):
./install.sh install --tls-cert /etc/ssl/fullchain.pem --tls-key /etc/ssl/privkey.pem

# 3. Front it with your own TLS-terminating proxy, then trust it:
#    set trustProxy:true (or tlsMode:"auto") in portal-config.json
#    (nginx template: deploy/nginx/cirrus-portal.conf)
```

When TLS is in play — direct or via a trusted proxy — session cookies become
`Secure; HttpOnly; SameSite=Strict` and responses carry
`Strict-Transport-Security` (HSTS). Loopback-only installs need no TLS.

Cleartext on a public interface is refused at boot. The only override is the
explicit, loudly-warned `--insecure-plaintext` / `PORTAL_INSECURE_PLAINTEXT=1`
(a trusted LAN or a tunnel — never the open internet).

**Exposing a non-loopback interface is deliberate, not accidental.** The bind
address still defaults to `127.0.0.1`; to serve off-host you must opt in via
`"publicBind": true` in `portal-config.json` (the installer writes this for
you), `PORTAL_PUBLIC_BIND=1`, or `--public-bind`, *and* satisfy the TLS rule
above. A wildcard bind (`0.0.0.0`) additionally warns loudly at boot because
it listens on **every** interface. Firewall: `--firewall` opens the right port
when ufw is active (`sudo ufw allow 80,443/tcp` with `--domain`, else the
portal port); loopback-only installs need no rule (tunnel in over SSH).

Shipped proxy templates live in `deploy/`: `deploy/Caddyfile` (automatic
certs) and `deploy/nginx/cirrus-portal.conf` — both do HSTS, an 80→443
redirect, and forward `X-Forwarded-Proto` so the portal marks cookies `Secure`.

## Multi-server (Aug 6 2026) — one portal, N gateway servers

The portal can talk to **any number of OpenClaw gateway servers at once** and
merge them into one agent list. This is how it works:

- **Config** (`portal-config.json`): a `gateways` array —
  `[{ id, name, url, enabled }]` (no token; see below). Legacy single
  `gatewayUrl`/`gatewayToken` still works and is auto-synthesized into one
  entry, so single-server deployments don't need to change anything.
- **Secrets** (`portal-secrets.json`, 0600): `{ gatewayTokens: { <id>: token },
  portalPassword }`. Tokens never appear in `portal-config.json`, API responses,
  logs, backups, or release tarballs.
- **Merged agent list:** `/api/agents` fans out `agents.list` to every
  connected gateway and tags each agent with its server (`server`, `serverName`,
  `ref: "gw:agent"`, `key: "agent:gw:agent:main"`). One server down = its
  agents just don't appear; the `servers[]` array reports status and the rest
  keep working.
- **Namespaced sessions:** portal session keys are `agent:<gwId>:<agentId>:main`
  so two servers that both have an agent named the same never collide.
- **Access control:** student assignments accept bare ids (`willow` = any
  server), pinned refs (`lab:labbot`), and server wildcards (`lab:*` = all
  agents on that server). Enforced on every endpoint.
- **Rooms (panel mode):** room agents are refs, so one room can mix agents
  from different servers — each round routes each participant's turn to its
  own server and waits for the reply. Loop-safe as before.
- **Approvals:** approval ids are namespaced `gw:rawId`; resolve routes to the
  owning server.
- **Per-server ops:** each gateway must approve the portal device once
  (`openclaw devices approve`, or bootstrap `--approve`). Tokens live in the
  chmod-600 `portal-secrets.json`, browser never sees them.
- **Dev sandbox:** `portal-multi/` in the workspace has a mock gateway
  (`mock-gateway.js`, speaks the operator protocol) + e2e scripts used to
  prove the whole thing before touching the live portal.

Known limitation: if an agent's session is already busy (queued sends), the
room engine can miss that reply (the ack comes first, content streams under a
later run) and records `[no reply]`. The agent still got the prompt; the next
round includes the conversation. History-fallback polling is a future
refinement.

### Live gateway management (Aug 2026 — Gateways view, admin)

Admins can add/remove/edit gateway servers **from the UI** — no config file
editing, no portal restart:

- **Gateways view** (admin nav): lists every configured gateway with live
  status (connected/offline/disabled + agent count), add form, and per-row
  ✏️ edit / ⏸ enable-toggle / 🗑 delete.
- **API:** `GET/POST /api/gateways` (list/add), `PATCH/DELETE
  /api/gateways/:id` (edit/remove). Admin-only (403 for instructors/
  students). Every change is audited (`gateway_add/update/remove`).
- **Tokens are write-only**: the API returns `hasToken: true/false`, never the
  token itself. The edit modal leaves the field blank to keep the existing
  token.
- **Live effect:** adding a gateway starts connecting immediately; URL/token
  edits tear down and reconnect the client right away; disabling stops the
  client (agents disappear from the list); enabling restarts it. The agent
  list and dashboard refresh automatically.
- **Persistence:** changes are written back to `portal-config.json` (a `.bak`
  is kept before each write), with any token going to `portal-secrets.json`
  (0600). The container mount is read-write now, so the running portal can save
  admin edits.

### Live updates fix (Aug 2026) — no more manual refresh

Previously the chat pane required a manual page refresh to see new messages.
Root cause: gateway chat events carry the **raw** session key
(`agent:<agentId>:main`), but the browser subscribes with the **namespaced**
key (`agent:<gwId>:<agentId>:main`) and drops any event whose `sessionKey`
doesn't match. Tool receipts were namespaced and worked; chat events were
not — so replies only appeared after a reload. The SSE fanout now rewrites
`sessionKey` to the namespaced key before sending, so deltas/finals stream
live exactly like tool receipts do. Verified end-to-end: an SSE subscriber
receives `state=delta/final` with a matching `sessionKey` after `/api/send`.

## Open it

- **On this server:** http://127.0.0.1:18800
- **From anywhere on the LAN:** http://<server-ip>:18800
## CI30 context injection (Phase I, Aug 4 2026)

When a **student** sends a message, the portal prepends a context block so the
agent knows who it's helping and what the course/assignment is:

```
[Portal context · CI30 — Intro to Interactive Systems]
Student: Student (Demo) (@student)
Term: Summer 2026
Assignment: a1 — Help Desk Bot (due 2026-08-15)
...
```

- Context lives in `portal-context.json` (bind-mounted, chmod 600): course
  metadata (code/name/term/syllabus/assignments) + per-user context
  (enabled, profile, assignment, notes).
- **Injection is server-side** on `/api/send` (students only — instructors/admins
  send as-is). The response reports `injected: true` + the block; the send is
  audited with the injected flag.
- **Students see what's injected**: a 🧠 strip above the composer shows the exact
  block sent with their messages (click to expand).
- **Instructors/admins edit it**: "course context" button in Users/Students
  views edits the course + assignments; the per-row "context" button edits a
  student's profile/assignment/notes + injection toggle.
- API: `GET /api/context` (own block for students, all users for staff),
  `POST /api/context/course` (instructor+), `POST /api/users/<u>/context`
  (instructor+; instructors may only edit students).
- POC note: this is lean, portal-side context — no gateway/context-engine
  changes.

## Per-assignment policy (Phase I, Aug 6 2026)

What an agent may **do** while helping a student on a given assignment:

- Each assignment can carry a `policy` in `portal-context.json`:
  `allowedTools`, `blockedTools`, and free-text `rules`.
- **Injection:** the policy is baked into the student's context block, so the
  agent knows the guardrails before answering ("Assignment policy: …" +
  "Policy rules: …" lines).
- **Enforcement (lean):** when a tool fires in a student's session, the portal
  checks it against the student's active-assignment policy. Blocked or
  non-allowed tools get flagged on the live receipt card (`⛔ blocked by a1
  policy`) and written to the audit log as `tool_policy_block`. This is
  flag-and-audit, not hard-block — the gateway still runs the tool; the portal
  surfaces the violation to staff. (Hard enforcement would need gateway-side
  work — later roadmap.)
- **Editing:** the "course context" modal (instructors/admins) gained a
  Policies textarea: one line per assignment,
  `id | blocked:a,b allowed:c,d rules text…` (tools are comma lists, rules are
  any trailing text).
- Seeded demo: assignment `a1` allows `web_search, web_fetch, read, write` and
  blocks `exec, browser` with a "no shell commands for students" rule.

## Tool receipts + confirmations (Phase I, Aug 5 2026)

Two things, both live off the gateway's operator event stream:

**Tool receipts** — when an agent runs a tool during a chat, the chat shows a
live receipt card: `🔧 exec` with a running indicator, live command output as it
streams, then `✓`/`✗` + duration when it finishes. Driven by `agent` events
(`stream: item` + `stream: command_output`), fanned out per-session over the
same SSE stream as chat — keyed strictly off `sessionKey`, so nothing leaks
across sessions. History rows render as `⚙ <tool>` lines (already existed).

**Tool confirmations (approvals)** — when an agent's tool/exec needs approval,
the gateway broadcasts `exec.approval.requested` / `plugin.approval.requested`.
The portal shows a 🛡 card in the chat with the exact command and, for
**instructor/admin**, ✓ Approve / ✗ Deny buttons (resolved via
`exec.approval.resolve` / `plugin.approval.resolve`, audited). **Students see a
read-only "⏳ waiting for staff approval" card** — resolve is staff-only,
enforced server-side (403 for students) + `canResolve` is computed server-side.

- API: `GET /api/approvals` (staff: all; students: only their sessions, read-only),
  `POST /api/approvals/<id>/resolve` (instructor+, `{decision: approve|deny}`).
- Resolved state persists ~30 min in memory for staff review; audit log records
  every resolve attempt (including failures).
- ⚠️ **Requires the `operator.approvals` scope on the portal device.** The
  gateway currently approves the device for read/write only, so the portal
  auto-falls-back to read/write (approvals stay read-only, staff see a banner)
  until the pending scope upgrade is approved on the gateway. Tool receipts
  need no scope change — they work today.

## Accounts & roles (Phase I, Aug 3 2026)

Local accounts with three roles. **Students only see the agents assigned to
them** — enforced server-side on every endpoint (agents/history/send/abort/stream).

| Role | Sees | Can do |
|---|---|---|
| `admin` | all agents | everything + manage accounts, view audit log |
| `instructor` | all agents | chat + student roster view |
| `student` | assigned agents only | chat with those agents |

Accounts live in `portal-users.json` (scrypt-hashed, chmod 600, bind-mounted).

**No default credentials.** A fresh install gets its first admin one of two ways:

- **Installer / headless** — provide the password yourself with
  `PORTAL_PASSWORD=...` (installer/bootstrap). The server mints the `admin`
  account with it on first boot and the installer saves it to
  `portal-credentials.txt` (0600).
- **Bare `node portal-server.js` with nothing configured** — the server starts
  in **setup mode** and serves a first-run wizard at `/setup`. Every other
  route (including login) is refused until the wizard creates the admin with a
  **strong password** (12+ chars, upper/lower/number, not your username), where
  you also pick bind/port, TLS intent, and the first gateway. There is no
  working default at any point.

Change the password after first login via **Users → reset pw**. Passwords must
clear the policy everywhere an account is created or reset: **12+ chars**, with
upper + lower + a number, not the username, not a known default, and not on the
common-password blocklist. No demo accounts are shipped. The server **refuses to
start** if an admin account still uses a known-default password (`admin`,
`password`, `perdue-portal-2026`, …); a dev-only escape hatch is
`PORTAL_ALLOW_INSECURE_DEFAULTS=1`.

### Auth hardening (Sep 2026)

- **Login rate-limit + progressive lockout.** Repeated failures for one
  (IP + username) are counted in a rolling window; once
  `loginMaxAttempts` is hit the account is locked out for
  `loginLockoutSeconds`, doubling on each repeat (capped at 1h). Locked logins
  return `429` with a `Retry-After` header — even with the correct password.
- **CSRF tokens.** Every state-changing request (`POST`/`PATCH`/`DELETE`, and
  `/api/logout-all`) must send the session-bound token from `/api/me`
  (or the login response) in the **`X-CSRF-Token`** header; a non-matching
  `Origin` is refused too. Plain `GET` reads are unaffected.
- **Session rotation on login.** Each login mints a fresh session id and drops
  any session id that arrived with the request (no session fixation).
- **Log out all.** `POST /api/logout-all` revokes every session for the
  account (UI: **log out all** in the sidebar footer).
- **Configurable TTL.** Absolute lifetime is `sessionTtlHours`; optional idle
  expiry is `sessionIdleMinutes` (`0` = off). A password reset also revokes all
  of that user's live sessions.

Every login/send/abort/account change (plus lockouts and CSRF rejects) is
appended to `portal-audit.log` (admins can browse it in the UI).

## How it works

```
Browser ──HTTP/SSE──▶ portal-server.js ──WebSocket (loopback)──▶ OpenClaw Gateway (:18790)
                            │
                            └─ device-signed operator connection (operator.read/write)
```

- The server holds the gateway token — **the browser never sees it**.
- It connects to the gateway over loopback with a persistent Ed25519 device
  identity (`portal-device.json`), so the gateway treats it as a trusted
  operator client.
- `chat.send` / `chat.history` / `chat.abort` do the talking; SSE streams
  `chat` events (delta/final) to the page.

## Files

| File | Purpose |
|---|---|
| `portal-server.js` | Node 22+ server, zero dependencies (built-in `WebSocket` + `http`) |
| `portal.html` | The whole UI — single file, vanilla JS, dark theme |
| `portal-config.json` | Port, bind, gateway URL/ids, session TTL — **TOKEN-FREE** (chmod 600) |
| `portal-secrets.json` | Gateway token(s) + bootstrap admin password — **0600, never committed/backed up/shipped** (see `portal-secrets.example.json`) |
| `portal-device.json` | Persistent device identity (auto-generated, chmod 600) |
| `portal-users.json` | Local accounts + roles (first admin auto-created with a unique password, chmod 600) |
| `portal-audit.log` | Append-only audit trail (logins, sends, account changes) |
| `portal-context.json` | CI30 course + per-user context store (chmod 600) |
| `portal.log` | Runtime log |

## Config (`portal-config.json`) — token-free

```json
{
  "port": 18800,
  "bind": "0.0.0.0",
  "gateways": [
    { "id": "home", "name": "Home", "url": "ws://127.0.0.1:18790", "enabled": true }
  ],
  "sessionTtlHours": 12,
  "sessionIdleMinutes": 0,
  "loginMaxAttempts": 5,
  "loginWindowSeconds": 900,
  "loginLockoutSeconds": 300
}
```

Auth knobs (all optional; shown with defaults): `sessionTtlHours` absolute
session lifetime, `sessionIdleMinutes` idle expiry (`0` = off), and the login
lockout trio `loginMaxAttempts` / `loginWindowSeconds` / `loginLockoutSeconds`.
Each also has an env override (`SESSION_TTL_HOURS`, `PORTAL_SESSION_IDLE_MINUTES`,
`PORTAL_LOGIN_MAX_ATTEMPTS`, `PORTAL_LOGIN_WINDOW_SECONDS`,
`PORTAL_LOGIN_LOCKOUT_SECONDS`).

Gateway tokens and the first-run admin password do **not** live here — they live
in `portal-secrets.json` (chmod 600), which is never committed, backed up, or
shipped in a release tarball:

```json
{
  "gatewayTokens": { "home": "<gateway auth token>" },
  "portalPassword": "<first-run admin password — seeds the admin account once>"
}
```

Token precedence per gateway: `PORTAL_GATEWAY_TOKEN_<ID>` env → `portal-secrets.json`
→ legacy `portal-config.json` `token` (auto-migrated on boot, then stripped) →
`GATEWAY_TOKEN` env. `./secret-scan.sh` (and CI) greps the repo + a built tarball
for leaked tokens/keys/state files; `./install.sh doctor` checks the secrets file
mode and that the config stayed token-free.

Gateways can also be managed live from the UI (admin → Gateways) — see above.
The file is written back on every change (with a `.bak` kept); tokens are written
to the secrets file instead.

## Docker deployment (current)

The portal runs as a Docker container (`cirrus-portal`, host networking,
`restart: unless-stopped` — survives reboots).

```bash
cd portal
docker compose up -d --build     # build + start
docker compose logs -f           # live logs (stdout)
docker compose down              # stop
```

- **Host networking** — the container must reach the OpenClaw gateway on the
  host loopback (`ws://127.0.0.1:18790`).
- **Config + device identity are bind-mounted** — `portal-device.json` MUST
  persist so the gateway keeps recognizing the device.
- **Port/bind come from `portal-config.json`** (the image sets no PORT/BIND
  env — env overrides beat the config file in `loadConfig()`, so hardcoding
  them broke per-server ports; fixed during replication testing).
- Env overrides: `GATEWAY_URL`, `GATEWAY_TOKEN`, `PORTAL_PASSWORD`,
  `SESSION_TTL_HOURS`, `RECONNECT_BASE_MS`, `RECONNECT_MAX_MS` (via
  `docker run -e`; the compose file deliberately sets none).
- **Container hardening (Sep 2026):** the image is pinned by base-image digest
  (`node:22-alpine@sha256:…`) and runs as the unprivileged `portal` user
  (`uid:gid 10001`). Compose adds `read_only: true` (state lives on the bind
  mounts; `/tmp` is a small tmpfs), `cap_drop: ALL`, `no-new-privileges`,
  `mem_limit: 512m`, `cpus: "1.0"`, `pids_limit: 256`, and a container
  `HEALTHCHECK` (`healthcheck.js` → loopback `GET /`).
- **Ownership:** because the runtime is non-root, the bind-mounted state files
  must be owned by `10001:10001` — `install.sh`/`bootstrap.sh` chown them for
  you, and `./install.sh doctor` flags it if they drift.
- The old systemd unit (`agent-portal.service`) is kept but **disabled** as a
  fallback. (Its unit name is legacy and unchanged — renaming a live systemd
  unit is a separate ops step.)

## Service management (old systemd path, fallback)

```bash
systemctl status agent-portal     # check it's running
systemctl restart agent-portal    # restart
journalctl -u agent-portal -f     # live logs
systemctl stop agent-portal       # stop
```

Starts automatically on boot. It will reconnect to the gateway on its own if
the gateway restarts (exponential backoff, 1s → 30s).

## API (for scripts)

All `/api/*` need the `portal_session` cookie from `/api/login`.

```
POST /api/login  {username,password}  → sets cookie + { csrfToken } (429 if locked out)
POST /api/logout                     → clear this session (needs X-CSRF-Token)
POST /api/logout-all                 → revoke every session for the account (needs X-CSRF-Token)
GET  /api/me                         → { authed, user:{username,role,agents}, csrfToken }

# every POST/PATCH/DELETE below needs the header: X-CSRF-Token: <csrfToken>
GET  /api/agents                     → { agents: [{id,name,emoji}], connected, restricted }
GET  /api/history?session=agent:X:main → { messages: [{role,text,time,toolName}] }
POST /api/send    {session,message}   → { runId, injected, context }
POST /api/abort   {session,runId}     → stop a run
GET  /api/stream?session=agent:X:main → SSE: chat events (state: delta|final)

# CI30 context injection
GET  /api/context                     → { course, own:{context,block}, users } (staff see all users)
POST /api/context/course              → edit course context {code,name,term,syllabus,assignments:[{id,title,due,brief}]} (instructor+)
POST /api/users/:u/context            → edit a user's context {enabled,profile,assignment,notes} (instructor+; students for instructors)

# instructor+ (students-only list for instructors)
GET  /api/users                      → { users: [{username,displayName,role,agents}] }

# admin only
POST /api/users                      → create account {username,displayName,role,agents,password}
POST /api/users/:u/agents           → set assigned agents {agents:[...]} (* = all)
POST /api/users/:u/password         → reset password {password}
DELETE /api/users/:u                → delete account
GET  /api/audit?limit=100           → { entries: [{ts,user,role,action,detail}] }

# group chat rooms (instructor+)
GET  /api/rooms                      → list rooms (summaries incl. mode/paused)
POST /api/rooms                      → create {name, agents:[...], mode:'rounds'|'free'}
GET  /api/rooms/:id                  → full room incl. transcript
POST /api/rooms/:id                  → {action:'message',text} | {action:'round',rounds?:1-10} | {action:'stop'} | {action:'pause'} | {action:'resume'} | {action:'agents',agents:[...]}
DELETE /api/rooms/:id                → delete (creator or admin)
GET  /api/rooms/:id/stream           → SSE: {event:'transcript'|'status'}
```

## Group chat (panel mode, Aug 3 2026 · modes + free-flow Aug 4 2026)

Rooms put 2+ agents in a shared conversation. Two modes, chosen at creation:

**Rounds mode** (default, loop-safe by construction): a **round** sends the
full room transcript to each agent in turn, waits for its reply, appends it,
then moves to the next agent. Rounds are human-triggered (drop a message or
press "next round") and every agent speaks exactly once per round. The
`rounds` field (1-10) batches multiple consecutive rounds into one trigger.

**Free-flow mode**: agents reply to each other on their own. Every non-meta
message (user or agent) triggers one reply from each *other* agent that
hasn't already replied to that message, so the conversation cascades without
human input. Loop-safe by design:
- per-message dedupe — an agent never replies twice to the same message;
- no self-replies — the sender is never triggered by its own message;
- burst budget (BURST_MAX = 20) — auto-replies cap per human message, then
the room goes quiet until a human speaks (each human message resets the
budget);
- **Pause/Resume** — pause halts the cascade between turns (in-flight turn
finishes), resume re-triggers it for the latest message; Stop = halt + pause.

Rooms persist across restarts in `portal-rooms.json` (bind-mounted). Agent
replies are watched server-side via chat events (`state: final` + `runId`),
so a round advances without polling. Per-agent busy guard: an agent busy in
another room is skipped with a note. In free mode agents get a free-flow
variant of the turn prompt ("reply as the conversation moves, nobody waits
for a formal turn").

**History-fallback (Aug 18 2026):** when an agent's session is busy/queued,
`chat.send` acks with a runId but the real run lands under a *different*
runId — the event watcher settles empty and the room used to record
`[no reply]` even though the agent answered. Now an empty settle triggers
`historyFallbackReply()`: it polls `chat.history` for the agent's main
session and recovers the newest assistant message that arrived after the
turn prompt was sent (10s clock-skew grace vs the gateway host). Rounds mode
polls up to 90s before declaring timeout/silence; free-flow polls up to 45s
so a genuinely-quiet agent still settles (nothing new in history = stayed
quiet, loop moves on). Recovery is invisible to users — the real reply just
appears in the transcript.

## Notes

- `deliver:false` is used on send, so agent replies go back to the portal
  session and are **not** pushed to Telegram or other channels.
- Each browser tab gets its own live stream; multiple people can watch one
  agent's session at once.
- Portal sessions expire after 12 hours by default (and after
  `sessionIdleMinutes` idle, if set) — just log in again.
- Login is rate-limited with progressive lockout, and every state-changing
  request is CSRF-protected (see **Auth hardening**).

## Phase I roadmap (Dad's list, kickoff Aug 3 2026)

1. ✅ **Roles + permission-aware UI** (student/instructor/admin, local accounts)
2. ✅ **CI30 context injection**
3. ✅ **Tool receipts + confirmations**
4. ✅ **Per-assignment policy** (allowed/blocked tools + rules; flag + audit on receipts)
5. ✅ **Instructor dashboard v1** (Aug 7 — `/api/dashboard` + Dashboard view; stat tiles, assignment breakdown, roster w/ context + last-seen, recent activity, ⛔ policy violations, quick links)
6. ✅ **Audit log** (groundwork Aug 3 + UI polish Aug 18 — icon badges, friendly detail chips, user/action filters, limit selector, live refresh, summary chips; `login_failed` tracked too)
7. ✅ **Panel mode** (rooms of 2+ agents, full-context)
8. ✅ **Mobile pass** (Aug 7 — responsive at ≤900px/≤520px: top-panel layout, horizontal agent strip, stacked dash columns; verified 0px horizontal scroll at 390/1280)

Built by Noah, Aug 1 2026 (v1) · Aug 3 2026 (Phase I roles) · Aug 7 2026 (dashboard v1 + mobile pass — Phase I complete). Dad's ask: "a web chat portal that connects to agent:main for each agent, loads in a browser."
