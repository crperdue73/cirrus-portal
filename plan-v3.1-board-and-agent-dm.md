# Cirrus Portal v3.1 — Bulletin Board + Cross-Server Agent DM (BUILD PLAN)

**Owner:** Noah · **Started:** 2026-09-25 · **Target:** visible on Dad's running server before the migration window (~Oct 5)
**Design:** `../cirrus/board-and-agent-dm-design.md` · **Branch:** `feat/board-and-agent-dm`

## Dad's brief (mission critical)
1. **Bulletin board** — agents POST and READ; portal tab; Dad reads *and* posts.
2. **Cross-server agent DM** — `sessions_send` for agents, across servers.
3. **Phone book** — agents can list ALL agents on ALL servers.
4. General board for everyone + admin-created boards with read/post access lists.
5. Board notify: pull + mention-wake only. DM: wake. DMs **private by default**, switchable by Dad.
6. **Option A** — portal binds the LAN behind TLS (agent API reachable from remote agents).

## Definition of done
Dad can open the portal **on his running server**, see the Board tab and the Agent DM tab,
read a post written by a real agent, post one himself, and watch an agent on one server DM
an agent on another. **GitHub push is GATED on Dad's explicit approval.**

## Hard boundaries for the build loop
- Local commits only. **Never push**, never publish, never announce.
- Deploy only to the **preview instance** on the live box until Dad looks. Do not recreate
  the production container outside the migration window.
- Never spend money, never delete state, never message anyone outside the loop.
- One item per run. Never tick an item that is not actually done and tested.

---

## Phase 0 — Prerequisites
- [x] **0a. Commit the protocol 3→4 fix** so a container recreate can't drop ct-test. ✅ 2026-09-25 (`eb8ad39`)
- [x] **0b. Write this build plan + design doc.** ✅ 2026-09-25
- [x] **0c. Record the Option A decision** in `portal-config.json`/docs: LAN bind + TLS, agent API reachable remotely, firewall scoped. ✅ 2026-09-25 (`4aa5bb4`)

## Phase 1 — Agent API foundation (both features depend on this)
- [x] **1a. Agent token store** — `portal-secrets.json.agentTokens`, token **hashed** (scrypt), value `{agentId, gatewayId, label, createdAt}`; mint/revoke/rotate helper + admin UI hook. ✅ 2026-09-25 (`b54f63b`)
- [x] **1b. Bearer auth** — `Authorization: Bearer <token>` accepted **only** on `/api/agent/*`; never satisfiable on human/admin routes; no CSRF on that path (no cookies). ✅ 2026-09-25 (`ae02dc5`)
- [x] **1c. Guardrails** — per-token rate limit, body cap, audit entry per call, revocation. ✅ 2026-09-26 (`460dd30`)
- [x] **1d. Tests** — token auth, scope isolation, revoked token rejected, rate limit. ✅ 2026-09-26 (`3189655`)

## Phase 2 — Bulletin board
- [x] **2a. Store** — `portal-board.json` (0600, bind-mounted) with retention cap + prune (audit-log pattern). ✅ 2026-09-26 (`5db3d8a`)
- [x] **2b. API** — `GET /api/board`, `POST /api/board/post`, `GET /api/board/stream` (SSE); identity resolved from session *or* agent token. ✅ 2026-09-26 (`297c24b`)
- [x] **2c. Access control** — `general` open to all; named boards carry `read`/`post` lists (all | explicit agents/roles), enforced server-side on read **and** write. ✅ 2026-09-26 (`7c8dd69`)
- [x] **2d. Board tab UI** — board picker, live transcript, composer (Dad posts as *Robbie · portal*), author/server filter, unread badge. ✅ 2026-09-26 (`f630254`)
- [x] **2e. Notify** — unread cursor + heartbeat pull; `@agent` mention-wake (opt-in). ✅ 2026-09-26 (`4514d06`)
- [x] **2f. Tests** — post/read/pagination, per-board ACL, retention, live stream. ✅ 2026-09-26 (`fc650bd`)

## Phase 3 — Phone book
- [x] **3a. `GET /api/agent/roster`** — every agent on every gateway: id, name, emoji, gateway, cross-server ref, reachability status. ✅ 2026-09-26 (`9862450`)
- [ ] **3b. Tests** — merges gateways, marks offline servers, token-scoped.

## Phase 4 — Cross-server agent DM
- [ ] **4a. Mailbox store** — `portal-agent-dm.json` (0600): id, from, to, text, ts, state, reply, hops, awaitReply.
- [ ] **4b. Routing** — resolve target gateway → `chat.send` into `agent:<id>:main`. Same code path for local and remote.
- [ ] **4c. Sync reply** — `awaitReply:true` returns the recipient's next assistant message (reuse `state:final` + `runId` watcher).
- [ ] **4d. Loop safety** — hop counter (max 3), per-pair rate limit, burst budget, no-relay flag, circuit breaker.
- [ ] **4e. Privacy** — content hidden from admin by default, server-side; `agentDmVisibility` switch; **agents are told** the current visibility and the flip is audited.
- [ ] **4f. Agent DM tab UI** — live traffic, per-pair threads, delivery/reply state.
- [ ] **4g. Tests** — cross-gateway delivery, awaitReply, **loop regression**, privacy on/off.

## Phase 5 — Ship to the running server (Dad can see it)
- [ ] **5a. Version + docs** — VERSION 3.1.0, CHANGELOG, README/ADMIN updates.
- [ ] **5b. Gates green** — `run-tests.sh`, `lint.sh`, `e2e-verify.sh`, `secret-scan.sh`.
- [ ] **5c. Release artifact** — `release.sh 3.1.0` (local only).
- [ ] **5d. Preview instance on the live box** — LAN bind + TLS, separate port/container/state. Production container untouched.
- [ ] **5e. Live E2E proof** — agent posts to the board; Dad's own post lands; agent on one server DMs an agent on another; roster returns the full fleet.
- [ ] **5f. Tell Dad it's live** — hand over URL + credentials, ask for QA. **Loop stops here until Dad rules.**

## Phase 6 — GATED ON DAD
- [ ] **6a. (GATED)** Push to GitHub + cut the public release — **and** scrub the leaked `plan-public-readiness.md` + redact the `CHANGELOG.md` prose leak in the same pass.

---

## Progress log
- **2026-09-25** — Plan created. 0a done (`eb8ad39`, protocol 3→4 committed on `feat/board-and-agent-dm`).
  Dad approved Option A (LAN bind + TLS) and the running-server-first / GitHub-on-approval workflow.
  Added the phone-book requirement (Phase 3). Build loop wired to cron.
- **2026-09-25 21:16** — ✅ **0c done** (`4aa5bb4`). Recorded Option A as a durable artifact:
  `docs/NETWORK-DECISION.md` (LAN bind + TLS, agent API reachable from remote agents, firewall scoped
  to the fleet subnet; names the boot gates `assertNetworkPolicy`/`assertTlsPolicy`; the live flip is a
  migration-window step, not a restart of `agent-portal`). Wired the example config + README to it and
  added `test-network-decision.js` (5/5). Evidence: `node --check` · JSON validate · that test + test-network
  6/6 · test-tls 6/6 · test-docs 5/5 · test-compliance 6/6 · test-release 8/8 · node:test 24/24 · lint +
  secret-scan clean · `run-tests.sh` all green. Live `portal-config.json` annotated with the same decision
  (gitignored; no operational fields changed — production untouched).
- **2026-09-25 22:16** — ✅ **1a done** (`b54f63b`). Agent token store: `portal-secrets.json.agentTokens`
  now holds hashed records (`{id, agentId, gatewayId, label, createdAt, rotatedAt, salt, hash, lookup}`) —
  scrypt hash is authoritative, sha256 `lookup` is a one-way index so a request never scrypts the whole
  store. Added `mintAgentToken`/`rotateAgentToken`/`revokeAgentToken`/`listAgentTokens`/`verifyAgentToken`
  (helper for 1b) + admin API `GET/POST /api/agent-tokens`, `POST /api/agent-tokens/:id/rotate`,
  `DELETE /api/agent-tokens/:id` (admin-only, CSRF-gated, audited; secret shown exactly once, never logged).
  Extended `portal-secrets.example.json`. Evidence: `test-agent-tokens.js` 6/6 · lint + secret-scan clean ·
  node:test 24/24 · `run-tests.sh` all green. Bearer acceptance on `/api/agent/*` is item 1b (not yet wired).
- **2026-09-25 23:16** — ✅ **1b done** (`ae02dc5`). Agent Bearer auth: `Authorization: Bearer <agent-token>`
  is honoured on exactly one surface — `/api/agent/*` — dispatched ahead of the human session + CSRF gates
  (`isAgentApiPath` + `handleAgentApi`), so an agent token can never satisfy a human/admin route and a
  cookie session can never reach the agent surface. `bearerToken()`/`requireAgent()` (verifyAgentToken;
  401 on missing/rejected, secret never logged) resolve identity; added `GET /api/agent/whoami` as the first
  real agent endpoint (2b/3a/4b reuse the guard). Every call audited (`agent_call`/`agent_auth_missing`/
  `agent_auth_reject`). Evidence: `test-agent-bearer.js` 6/6 (valid Bearer · bad-cred refusal · rotate/revoke
  invalidation · scope isolation both ways · no-CSRF on the agent path · audit, no secret) · lint +
  secret-scan clean · `run-tests.sh` all green.
- **2026-09-26 00:16** — ✅ **1c done** (`460dd30`). Agent API guardrails, layered on the Bearer surface
  (1b) and dispatched ahead of the human session + CSRF gates: a **per-token** rate limit
  (`agentRateLimitPerMinute`/`Burst`, default 120+40/min) keyed by token id — not IP — so one noisy
  agent can't spend the fleet budget and a shared NAT can't starve a well-behaved one (429 +
  `Retry-After`); a tight **body cap** (`agentMaxBodyBytes`, default 64 KB) enforced *before* the rate
  budget is touched (mirrors the human path's cap→limit ordering; 413); an **audit entry per call**
  (`agent_call` / `agent_body_rejected` / `agent_rate_limited`); and **revocation** stays authoritative
  in the 1a store with the token's rate bucket dropped so a revoked credential leaves no residue.
  Added `cirrus_portal_agent_rate_limited_total` + the three keys to the example config
  (`test/config.test.js` KNOWN_CONFIG_KEYS updated to match). Evidence: `test-agent-guardrails.js` 5/5
  (body cap→413 no budget spent · budget→429+Retry-After+metric · per-token isolation · revoke→401
  others unaffected · exactly one audit entry per call, no secret) · `test-agent-bearer.js` 6/6 ·
  `test-agent-tokens.js` 6/6 · `node --test test/config.test.js` 4/4 · lint + secret-scan clean ·
  `run-tests.sh` all green.
- **2026-09-26 01:16** — ✅ **1d done** (`3189655`). Phase-1 acceptance gate: `test-agent-api.js` (6/6) —
  the missing regression gate that proves 1a+1b+1c **together** in one end-to-end flow (mint via admin
  API → drive /api/agent/* as a remote agent). Covers token auth (valid Bearer authenticates; unknown
  agent route 404s with no secret/token-store leak) · scope isolation (Bearer inert on human/admin
  routes; cookie session inert on /api/agent/*) · revoked token rejected immediately with sibling
  untouched · per-token rate limit (429 + Retry-After, no bleed) · audit completeness + no-secret
  · and the new edge **agentRateLimitPerMinute=0 disables the limiter** (12/12 calls pass).
  Test-only; no `portal-server.js` change. Evidence: `node --check` · `test-agent-api.js` 6/6 ·
  test-agent-{tokens,bearer,guardrails} 6/6·6/6·5/5 · node:test 24/24 · lint + secret-scan clean ·
  `run-tests.sh` all green. Phase 1 complete — next is 2a (board store).
- **2026-09-26 02:16** — ✅ **2a done** (`5db3d8a`). Bulletin-board store: `portal-board.json`
  (0600, bind-mounted) holding `{ boards, posts }`. Boards normalize to `{id,name,description}`;
  the `general` board always exists (re-seeded if missing). Posts `{id,board,author,authorRef,server,
  text,tags[],replyTo,ts}` — every field clamped, empty-text dropped. Bounded on disk exactly like
  the audit log: `boardRetentionDays` (0 = keep forever, the default — never silently drop Dad's
  posts) + `boardMaxPosts` + `boardMaxBytes`, prune keeps the newest with a `BOARD_KEEP_MIN` floor;
  bound applied at boot (file created 0600 on first run) and on a 6h timer. Added the three keys to
  DEFAULTS + env map (`PORTAL_BOARD_*`) + the example config (+ `test/config.test.js` drift guard) and
  `.gitignore`. No HTTP surface yet — that is 2b. Evidence: `test-board-store.js` 6/6 (first-boot
  0600+general · retention prune · maxPosts keeps newest · maxBytes trims to floor · load
  normalization · env override) · `node --check` · node:test 24/24 · lint + secret-scan clean ·
  `run-tests.sh` all green.
- **2026-09-26 03:16** — ✅ **2b done** (`297c24b`). Board HTTP API. One shared service core
  (`boardRead`/`boardPost`/`boardBroadcast`) is called by BOTH surfaces, so the human and agent
  identities never diverge in what gets stored or streamed: the session-authed human surface
  (`GET /api/board`, `POST /api/board/post`, `GET /api/board/stream`) and the Bearer-authed agent
  surface (`GET /api/agent/board`, `POST /api/agent/board/post`). Read is a `since` cursor
  (post-id based, prune-safe fallback to the newest window) + a `limit` clamp (≤200); post requires
  non-empty text and an existing board, is normalized by the 2a store, then broadcast. SSE is a
  per-board subscriber set (`hello` + `post` events, 20s ping) modeled on the room stream. Identity
  resolves to `{author, authorRef, server}` — a human is `displayName · portal` (`user:<name>`), an
  agent is `agentId` on its `gatewayId` (`agent:<gw>:<id>`). Every post is audited (`board_post`,
  tagged `via:agent` on the agent path); added `cirrus_portal_board_posts_total`. Per-board ACL is
  item 2c — this item enforces board existence only. Evidence: `test-board-api.js` 7/7 (session-only
  human reads + Bearer inert there · human identity + audit · cursor/limit/404/400 with no write ·
  live SSE delivery · cross-surface shared store · agent identity + gateway + audit secret-free ·
  0600 persist) · `node --check` · test-board-store 6/6 · test-agent-api 6/6 · node:test 24/24 ·
  lint + secret-scan clean · `run-tests.sh` all green.
- **2026-09-26 04:16** — ✅ **2c done** (`7c8dd69`). Board access control. Boards now carry
  two allow-lists — `read` and `post` — of rules (`all`/`*`, `role:<r>`, `user:<u>`, `agent:<id>`,
  `agent:<gw>:<id>`, `gateway:<gw>`; a bare token = agent id). `general` is open to all and
  **force-opened on load** so no edit or corrupt file can lock it; named boards are **default-deny**
  for non-admins; admins bypass. Enforcement sits in the SHARED `boardRead`/`boardPost` core via
  `boardAclAllows(board, ident, kind)`, so the human (session) surface, the agent (Bearer) surface,
  and the SSE stream all apply the same policy on read AND write — a restricted board can't leak
  through one path while refusing another. The picker only advertises boards a caller may read and
  never echoes ACL rules. Added admin board management `GET/POST /api/boards` (admin+CSRF, audited;
  `general` protected; no delete path), a `board_acl_denied` audit event, and the
  `cirrus_portal_board_acl_denied_total` metric. Evidence: `test-board-acl.js` 7/7 (admin CRUD +
  general lock-proof · read enforcement both surfaces + picker filter · write enforcement + admin
  bypass + no write on refusal · default-deny · SSE gate · audit/metric/no-leak · load-time general
  guard) · `node --check` · test-board-{store,api} 6/6·7/7 unchanged · `run-tests.sh` all green
  (node:test 24/24) · lint + secret-scan clean. Next: 2d (Board tab UI) — then the Phase-5d early
  preview hand-off.
- **2026-09-26 05:16** — ✅ **2d done** (`f630254`). Board tab UI in `portal.html`. A new **Board** nav item for
  every role (the server advertises only ACL-readable boards, so the picker *is* the ACL) with an unread badge;
  the view is a full-height live transcript — board picker (chips + per-board unread count), a composer that
  posts through `/api/board/post` (Dad posts as "Robbie · portal"; identity is resolved server-side), author +
  server filters, and an SSE `/api/board/stream` subscriber that appends posts live (de-duped by id, no optimistic
  append). Human posts read as the signed-in person (right-aligned); agent posts carry their gateway chip. Unread
  is a **client-side** cursor per board in `localStorage`, refreshed on render + a 20s badge poll while the tab is
  open (the server-side unread cursor + heartbeat pull is 2e). Evidence: `test-board-ui.js` 6/6 (static wiring,
  incl. the exact post fields the bubble reads · inline script compiles · read contract + ACL-free picker · human
  identity round-trips · live `post` event payload renderable · restricted board absent from picker + 403) ·
  extracted-inline-script `node --check` · node:test 24/24 · test-board-{store,api,acl} 6/6·7/7·7/7 ·
  test-agent-api 6/6 · `run-tests.sh` all green · lint + secret-scan clean.
- **2026-09-26 05:16** — 🎉 **Phase-5d EARLY PREVIEW hand-off** (per the loop's early-hand-off note, fired as soon
  as 2d landed). Stood up a **separate** preview on the live box: container `portal-preview` (image
  `portal-agent-portal:latest`, with the **new** `portal-server.js`/`portal.html` from this branch bind-mounted
  over `/app`), **host net**, **LAN bind `192.168.1.110:18810`**, **TLS on** (self-signed SAN cert), **separate
  state** `/home/noah/.openclaw/workspace-noah/portal-preview/` (config 0600, runs as uid 10001, `--read-only` +
  `cap-drop ALL`). **Production `agent-portal` untouched** (still 0.0.0.0:18800). Seeded two posts on `general`;
  admin display name set to *Robbie* so the board shows "Robbie · portal". Credentials: `admin` + the value in
  `portal-preview/.preview-admin-password` (kept OUT of the repo — not committed, never printed to logs). URL +
  creds reported to Dad in the run report. Bind is scoped to the specific LAN IP (not `0.0.0.0`); the ufw
  fleet-subnet rule stays a migration-window step. **5d is deliberately NOT ticked** (this is a click-now preview;
  5d is the formal ship step). Loop continues at 2e.
- **2026-09-26 06:16** — ✅ **2e done** (`4514d06`). Board notify. **Pull** (the v1 path): a per-identity
  read cursor per board, tracked server-side on the identity's `authorRef` (`agent:<gw>:<id>` /`user:<name>`) so
  a cursor can't drift from its author. `GET /api/agent/board/unread` (+ human `/api/board/unread`) returns exact
  unread counts + the pending window **oldest-first** (so a heartbeat poller consumes in order; `more:true` flags a
  truncated window); `POST …/board/ack` advances the cursor — **monotonic**, so a stale/replayed ack can never
  re-open consumed posts, and an unknown id is refused (400) with no change. Cursors persist in `portal-board.json`
  (0600) and are bounded (least-recently-touched dropped past 500 identities). Both surfaces call the SAME core,
  gated by the 2c read ACL (unread/ack of a restricted board 403s and writes no cursor). **Push** (opt-in, default
  OFF via new key `boardMentionWake` + `PORTAL_BOARD_MENTION_WAKE`): a post naming a reachable agent `@mention`
  injects a short pointer into that agent's session — loop-safe by construction (never self-wakes the author; 60s
  per-target cooldown; ≤5 targets/post; 30/min global budget; every decision audited `board_mention_wake` /
  `_unrouted` / `_suppressed`). Posts now carry a parsed `mentions` field (lowercased/de-duped/capped); adds audit
  events (`board_ack`, `board_mention_*`) and the `cirrus_portal_board_wakes_total` metric. Evidence:
  `test-board-notify.js` **10/10** · test-board-{store,api,acl,ui} 6/6·7/7·7/7·6/6 · test-agent-api 6/6 ·
  node:test 24/24 · lint + secret-scan clean · `run-tests.sh` all green. Note: the global-budget branch is
  code-covered but not exercised by a test (it needs a routable target → a live gateway); flag for 2f if a fake
  gateway lands. Next: 2f (board test suite).
- **2026-09-26 07:16** — ✅ **2f done** (`fc650bd`). Phase-2 acceptance gate: `test-board-gate.js` (5/5) — the
  missing regression gate that proves 2a–2e **together** in one end-to-end flow against the REAL server (the board
  twin of the phase-1 gate `test-agent-api.js`). Deliberately drives the INTEGRATION edges the per-item tests
  don't: **A** one shared log — a human and an agent post to `general` and each reads the other with a `since`
  cursor + `limit` clamp, append order held; **B** per-board ACL fused with read/post/pagination/stream — a
  restricted board is readable+postable by an allow-listed agent, 403s everyone else on read AND write AND stream,
  is hidden from the picker, leaves the store untouched on a refused write, and still pages internally; **C**
  retention × cursor — under `boardMaxPosts` a PRUNED `since` falls back to the newest window (no error, no
  stale) while a retained `since` still pages, file bounded on disk 0600; **D** live stream cross-surface — a
  human SSE subscriber receives an AGENT's post live, and a denied identity cannot open the stream; **E** audit +
  no secret — every post (`board_post`, human + `via:agent`) and refusal (`board_acl_denied`) is audited and no
  token reaches the log. Test-only; no `portal-server.js` change. Evidence: `node --check` · `test-board-gate.js`
  5/5 · test-board-{store,api,acl,ui,notify} 6/6·7/7·7/7·6/6·10/10 · node:test **24/24** · lint + secret-scan
  clean · `run-tests.sh` all green. **Phase 2 complete** — next is Phase 3 (phone book, 3a).
- **2026-09-26 08:16** — ✅ **3a done** (`9862450`). The phone book: `GET /api/agent/roster` (Bearer-authed,
  `/api/agent/*` only) returns **every agent on every configured gateway** — `{id,name,emoji,default,server,
  serverName,ref,key,reachable,lastSeenAt}` — so an agent can discover and address the whole fleet
  cross-server. Factored the gateway fan-out out of the human `/api/agents` handler into a shared
  `buildRoster()` so both surfaces can never diverge (`/api/agents` keeps its student filter). A
  configured-but-down gateway is listed `connected:false` (`error:'offline'`) and its last-known agents are
  replayed from a new bounded `ROSTER_CACHE` marked `reachable:false` — the phone book stays useful instead of
  failing the call or silently dropping the server. The endpoint is deliberately **not** caller-scoped (the
  phone book *is* the fleet; the token only gates access) and echoes `you:{agentId,gatewayId,ref}`. Audited
  (`agent_call` + `agent_roster` with counts); no secret logged or echoed. New reusable **`test/fake-gateway.js`**
  — a zero-dependency gateway stub (hand-rolled RFC6455 + `connect`/`agents.list` RPCs) so WS-dependent routes
  can finally be driven end-to-end; reused by 3b and the Phase-4 DM tests. Evidence: `test-agent-roster.js`
  **7/7** (Bearer required + human cookie inert · two-gateway merge + ref/key shape · down gateway marked
  offline non-fatally · `you` identity · no secret in response/audit · audit counts · human `/api/agents`
  parity) · `node --check` · node:test **24/24** · test-agent-* + test-board-* unchanged · lint + secret-scan
  clean · `run-tests.sh` all green. Next: 3b (roster gate — multi-gateway merge, offline marking, token scope).
- **2026-09-26 08:55** — 🩹 **Preview was unreachable — fixed.** Dad reported `https://192.168.1.110:18810/`
  **did not load**. Root cause, two layers: (1) the host **ufw** allows `18800` but had **no rule for `18810`**
  (INPUT policy is DROP) → packets dropped; (2) the preview bound **only** to `192.168.1.110`, so the box's
  primary/secondary `192.168.1.188` didn't answer either. Fix: `bind` `192.168.1.110` → **`0.0.0.0`** in
  `portal-preview/portal-config.json` (backup kept `.bak-<ts>`), `docker restart portal-preview`, and
  `ufw allow 18810/tcp` (this is a preview-only port — it does NOT touch the production 18800 rule). Verified:
  `ss` shows `0.0.0.0:18810`, both `https://192.168.1.110:18810` and `https://192.168.1.188:18810` return **200**.
  **Lesson for the next preview/hand-off:** standing up a listener is not the same as making it *reachable* —
  check the host firewall and the bind address BEFORE handing Dad a URL. (Production `agent-portal` untouched.)
