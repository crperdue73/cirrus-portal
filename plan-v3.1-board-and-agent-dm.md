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
- [x] **2d. Board tab UI** — board picker, live transcript, composer (posts as the signed-in account, e.g. *Admin · portal*), author/server filter, unread badge. ✅ 2026-09-26 (`f630254`)
- [x] **2e. Notify** — unread cursor + heartbeat pull; `@agent` mention-wake (opt-in). ✅ 2026-09-26 (`4514d06`)
- [x] **2f. Tests** — post/read/pagination, per-board ACL, retention, live stream. ✅ 2026-09-26 (`fc650bd`)

## Phase 3 — Phone book
- [x] **3a. `GET /api/agent/roster`** — every agent on every gateway: id, name, emoji, gateway, cross-server ref, reachability status. ✅ 2026-09-26 (`9862450`)
- [x] **3b. Tests** — merges gateways, marks offline servers, token-scoped. ✅ 2026-09-26 (`72fcc60`)

## Phase 4 — Cross-server agent DM
- [x] **4a. Mailbox store** — `portal-agent-dm.json` (0600): id, from, to, text, ts, state, reply, hops, awaitReply. ✅ 2026-09-26 (`eb93baf`)
- [x] **4b. Routing** — resolve target gateway → `chat.send` into `agent:<id>:main`. Same code path for local and remote. ✅ 2026-09-26 (`8ea894d`)
- [x] **4c. Sync reply** — `awaitReply:true` returns the recipient's next assistant message (reuse `state:final` + `runId` watcher). ✅ 2026-09-26 (`b4c898e`)
- [x] **4d. Loop safety** — hop counter (max 3), per-pair rate limit, burst budget, no-relay flag, circuit breaker. ✅ 2026-09-26 (`793299b`)
- [x] **4e. Privacy** — content hidden from admin by default, server-side; `agentDmVisibility` switch; **agents are told** the current visibility and the flip is audited. ✅ 2026-09-26 (`ba4f065`)
- [x] **4f. Agent DM tab UI** — live traffic, per-pair threads, delivery/reply state. ✅ 2026-09-26 (`59f58bf`)
- [x] **4g. Tests** — cross-gateway delivery, awaitReply, **loop regression**, privacy on/off. ✅ 2026-09-26 (`285e6bf`)

## Phase 5 — Ship to the running server (Dad can see it)
- [x] **5a. Version + docs** — VERSION 3.1.0, CHANGELOG, README/ADMIN updates. ✅ 2026-09-26 (`fb77c59`)
- [x] **5b. Gates green** — `run-tests.sh`, `lint.sh`, `e2e-verify.sh`, `secret-scan.sh`. ✅ 2026-09-26 (all green; evidence in Progress log).
- [x] **5c. Release artifact** — `release.sh 3.1.0` (local only). ✅ 2026-09-26 (signed; sha256 `89c04d4d…`)
- [x] **5d. Preview instance on the live box** — LAN bind + TLS, separate port/container/state. Production container untouched. ✅ 2026-09-26 (`df207bc`)
- [x] **5e. Live E2E proof** — agent posts to the board; Dad's own post lands; agent on one server DMs an agent on another; roster returns the full fleet. ✅ 2026-09-26 (`86e4817`)
- [x] **5f. Tell Dad it's live** — hand over URL + credentials, ask for QA. **Loop stops here until Dad rules.** ✅ 2026-09-26 (handover delivered in the 21:16 run report)

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
  posts through `/api/board/post` (a human posts as their account's display name; identity is resolved server-side), author +
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
  admin display name was the operator's real name so the board showed "<name> · portal". Credentials: `admin` + the value in
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
- **2026-09-26 09:05** — 🩹 **Board composer identity de-hardcoded.** Dad: the composer landed as
  *<name> · portal* (a hard-coded personal name); it must land as the **signed-in user**, and **no personal
  name may be baked into anything that can ship to GitHub**. The resolution logic was already correct
  (`boardIdentFromUser` = `user.displayName || user.username`); the *seeded preview account* was the culprit —
  the setup set the admin's `displayName` to a real name. Fixes: (1) preview `portal-users.json` →
  `displayName:"Admin"`; (2) rewrote the two demo posts' stored `author` (they persist at post time) →
  `Admin · portal`; (3) scrubbed the two code comments in `portal-server.js` / `portal.html` that documented
  the personal-name assumption → generic signed-in-account wording; (4) `test-setup.js` fixture renamed to
  `admin`/`Admin`. Verified live: `/api/board?board=general` returns both posts as **Admin · portal**.
  `node --check` · test-board-ui 6/6 · test-setup 3/3. Guard added: `secret-scan.sh` now fails on a personal
  name in any tracked file, so the build loop can't reintroduce it. (A real per-person account is created in
  the admin UI — no code change needed.)
- **2026-09-26 09:16** — ✅ **3b done** (`72fcc60`). Phase-3 acceptance gate: `test-roster-gate.js` (6/6) —
  the missing regression gate that proves the 3a phone book **together** against the REAL server with live +
  dying fake gateways (the phase-3 twin of `test-agent-api.js` / `test-board-gate.js`). Drives the integration
  edges 3a's focused test doesn't: **A** token-scoped access (Bearer required · human cookie inert on
  `/api/agent/*` · agent token inert on the human `/api/agents`); **B** two-gateway merge, deterministically
  ordered config-then-name, with the cross-server `ref`/`key` shape; **C** a never-connected gateway listed
  `connected:false` non-fatally; **D** the **live→down reachability flip** — `ROSTER_CACHE` replays a dropped
  gateway's last-known agents as `reachable:false` with `lastSeenAt` retained and `agentCount` kept, so the
  phone book survives a server outage instead of losing it (the edge 3a could not exercise); **E** per-token
  identity (`you` tracks the calling token) + revocation (401 only that token, sibling untouched); **F** audit
  (`agent_call` + `agent_roster` counts) with no token in the log or response. Test-only; no `portal-server.js`
  change. Evidence: `node --check` · `test-roster-gate.js` 6/6 · test-agent-roster 7/7 · node:test **24/24** ·
  `run-tests.sh` all green · lint + secret-scan clean. **Phase 3 complete** — next is Phase 4 (cross-server
  agent DM, 4a).
- **2026-09-26 10:16** — ✅ **4a done** (`eb93baf`). Agent DM **mailbox store**: the durable
  `portal-agent-dm.json` (0600, bind-mounted) holds every cross-server DM and its delivery state —
  `{id, from, to, toGateway, toAgent, text, ts, state:queued|delivered|replied|failed, reply, replyTs,
  deliveredTs, hops, awaitReply, error}`. Bounded on disk exactly like the board + audit log
  (`agentDmRetentionDays` / `agentDmMaxMessages` / `agentDmMaxBytes` + `DM_KEEP_MIN` floor), but with an
  **in-flight safety** rule the board doesn't need: age-pruning drops only **terminal** DMs (replied/failed),
  and the hard caps drop the oldest **terminal** DMs before any in-flight (queued/delivered) one — so a busy
  fleet can never silently lose a message that is still being delivered. Normalization is defensive:
  a DM missing `from`/`to`/text is dropped, `state` is validated against the enum (bogus → queued), and
  `hops` is clamped `0..DM_HOPS_MAX` (**3** — the 4d loop bound) so a corrupt file or hostile caller can't
  wedge the loop counter. Wired the three keys into DEFAULTS + `PORTAL_AGENT_DM_*` env + the example config
  (+ `test/config.test.js` drift guard), and added `.gitignore` entries + `secret-scan.sh` guards for
  `portal-agent-dm.json` — and, as a small drive-by correctness fix, the previously-unlisted
  `portal-board.json`. No HTTP surface yet — the router lands in 4b. Evidence: `test-agent-dm-store.js`
  **6/6** (first-boot 0600 empty · normalize/clamp · age-prune spares in-flight · cap drops terminal
  first · maxBytes trims to floor · env override) · `node --check` · test/config 4/4 · lint + secret-scan
  clean · `run-tests.sh` all green. Next: 4b (routing → cross-server `chat.send`).
- **2026-09-26 11:16** — ✅ **4b done** (`8ea894d`). Cross-server DM **router** — the one code path that
  serves local AND remote. `dmRoute()` resolves the target ref via `resolveAgentRef` to its owning gateway
  client and `chat.send`s into `agent:<id>:main`, exactly like the human `/api/send` and the board @mention
  wake, so "cross-server" is just "which client owns this ref" (no second transport). It persists the DM
  BEFORE delivery (`queued` → `delivered` | `failed`) so a crash mid-send still leaves a trace, and emits the
  body to the recipient's session ONLY. Surfaces (Bearer-authed, `/api/agent/*` only): **`POST /api/agent/dm
  {to,text}`** → `202 {dm}` (async; `awaitReply` is **refused 501** rather than silently downgraded — the sync
  hold is 4c) and **`GET /api/agent/dm?since=&limit=`** → the caller's own sent+received DMs with a `since`
  cursor + `limit` clamp (caller-scoped by construction: a DM is visible only to a ref that is its `from`/`to`;
  admin/global visibility is 4e). Loop safety is 4d. Added the `cirrus_portal_agent_dm{s,_failed,_unrouted}_total`
  metrics and audits `agent_dm`/`agent_dm_unrouted`/`agent_dm_rejected`/`agent_dm_read` — **ids + state only,
  never a body or a token** (privacy by construction). Evidence: `test-agent-dm-route.js` **10/10** (Bearer
  required + cookie inert · cross-server delivery into `agent:bob:main` on `lab` · same-server into
  `agent:cara:main` on `home` · unreachable target 404 + no write + `agent_dm_unrouted` · caller-scoped mailbox
  + since cursor + limit · delivery failure → `state:failed` · no body/token in the audit log · awaitReply 501 ·
  empty body 400 · 0600 persist) · `node --check` · node:test **24/24** · `run-tests.sh` all green · lint +
  secret-scan clean. No config keys added (no drift). Preview `portal-preview` untouched — 4b has no user-visible
  UI surface (the Agent DM tab is 4f), so no restart was needed this run. Next: 4c (sync `awaitReply`).
- **2026-09-26 12:16** — ✅ **4c done** (`b4c898e`). Cross-server DM **sync reply**. `awaitReply:true`
  now holds the HTTP response (200 `{dm,timedOut}`) and returns the recipient's next assistant
  message on `dm.reply` (state:replied`), replacing the 4b 501 stub. The hold reuses the room
  engine's `state:final` + `runId` watcher — `awaitAgentReply` matched across ALL sessions so a
  channel-bound agent's reply still lands — plus `historyFallbackReply` for a busy/queued session
  that acks a runId which isn't the one that answers; both run inside ONE bounded budget
  (`agentDmAwaitReplyMs`, default 120s, clamped 5s–300s). A no-reply hold returns
  `{timedOut:true}` and leaves the DM `state:delivered` rather than failing the call. Added a coarse
  concurrent-hold cap (`agentDmSyncMaxConcurrent`, default 20) that refuses extra sync holds
  **429 + Retry-After** so a fleet of blocking callers can't exhaust the portal (the fine-grained
  per-pair rate/burst/circuit breaker is 4d). Privacy preserved: bodies never reach the audit log
  (only ids/state/flags: `sync`/`replied`/`timedOut`); added the `cirrus_portal_agent_dm_replies_total`
  metric + both config keys (DEFAULTS + `PORTAL_AGENT_DM_*` env + example + `test/config.test.js`
  drift guard). Updated the 4b test's obsolete "awaitReply → 501" case to the now-live timedOut path.
  Evidence: `test-agent-dm-sync.js` **9/9** (Bearer-only · reply lands 200 replied · no-reply
  `timedOut` → stays delivered (waited ~6s ≈ budget) · concurrent-hold cap 429+Retry-After+no write ·
  history-fallback recovery · async 202 regression · no body/token in audit · 0600 persist w/ reply +
  awaitReply · replies metric) · test-agent-dm-route **10/10** · test-agent-dm-store 6/6 · test/config
  4/4 · `node --check` · node:test **24/24** · lint + secret-scan clean · `run-tests.sh` all green.
  No `portal.html` change (the Agent DM tab is 4f) — preview `portal-preview` untouched, no restart
  needed. Next: 4d (loop safety — hop counter, per-pair rate, burst budget, no-relay, circuit breaker).
- **2026-09-26 13:16** — ✅ **4d done** (`793299b`). Cross-server DM **loop safety** — four deterministic,
  in-memory, bounded layers on the 4b router (a restart clears them, like the rate limiters):
  **hops** — a send that answers a RECENT reverse DM (`agentDmHopWindowMs`, default 600s) carries `hops+1`;
  past `DM_HOPS_MAX` (3) it is refused **429** and stored nowhere, and a fresh (non-reply) send starts at 0
  so a new thread resets the chain (`dmRecentReverse`); **per-pair** — a direction-insensitive rate + burst
  budget (`agentDmPairRatePerMinute`+`agentDmPairBurst`, key = sorted lowercased refs) → **429 + Retry-After**
  (`dmPairCheck`); **no-relay** — a DM flagged `noRelay` lets the recipient reply to the sender but refuses a
  relay to a third party **403** (`dmRecentInbound`); **circuit** — a fleet-wide budget
  (`agentDmCircuitMaxPerMinute`) that on overflow OPENS for `agentDmCircuitCooldownMs`, refusing every pair
  **503 + Retry-After** until it half-opens (`dmCircuitCheck`). **Human involvement breaks the loop state**
  (`dmBreakLoops`: pair buckets cleared + breaker closed) — wired to a signed-in board post, so a human can
  always unstick a runaway fleet. Every refusal audited (`agent_dm_loop_blocked`/`_rate_limited`/`_circuit_open`/
  `_relay_blocked`/`_loops_broken`) with ids only — never a body or a token — and each has a metric
  (`…_dm_loop_blocked_total`/`_rate_limited`/`_circuit_open`/`_relay_blocked`); the `agent_dm` send audit now
  also carries `hops`+`noRelay`. Added the five keys (DEFAULTS + `PORTAL_AGENT_DM_*` env + example config +
  `test/config.test.js` drift guard). Evidence: `test-agent-dm-loop.js` **7/7** (hop chain 0→3 + 4th refused
  no-write · fresh pair resets to 0 · no-relay blocks a 3rd-party relay 403 but allows the reply · no
  body/token in audit + 0600 store with hops/noRelay · per-pair 429+Retry-After direction-insensitive ·
  human board post resets the budget · fleet circuit 503+Retry-After, refuses all pairs, recovers after
  cooldown) · `node --check` · test-agent-dm-{route,store,sync} 10/10·6/6·9/9 · node:test **24/24** ·
  `run-tests.sh` all green · lint + secret-scan clean. No `portal.html` change (Agent DM tab is 4f) — preview
  `portal-preview` untouched. Next: 4e (privacy — admin visibility switch, agents told the policy).
- **2026-09-26 14:16** — ✅ **4e done** (`ba4f065`). Agent DM **privacy**. Cross-server DMs are now
  **private by default**: the mailbox keeps the bodies, but only the two parties may read them. A new
  admin-only feed `GET /api/agent-dms` returns metadata for every DM (`from`/`to`/`ts`/`state`/`hops`)
  but **strips `text`/`reply` server-side** in private mode (`redacted:true` + a `textLength` size hint
  only) — the body never leaves the server, so no client bug or admin read can leak it. The single
  switch is `agentDmVisibility` (`private` | `visible`; aliases normalized), **persisted in the DM
  store** (0600) so an admin flip survives a restart, seeded from config on a fresh store. Flipping it
  is `POST /api/agent-dms/visibility` (admin-only + CSRF) → audited `agent_dm_visibility {from,to}`
  (never any content) with the new `cirrus_portal_agent_dm_visibility_changes_total` counter + a
  `cirrus_portal_agent_dm_bodies_visible` gauge. **Agents are told the policy** three ways: `/api/agent/whoami`
  now carries `dmVisibility` + a plain note, and both DM send and read replies echo the policy — so an
  agent knows before it sends. An admin read is audited (`agent_dm_admin_read` with `redacted`) and
  PRIVACY.md documents the default + the switch. Added the config key (DEFAULTS + `PORTAL_AGENT_DM_VISIBILITY`
  env + example + `test/config.test.js` drift guard). No `portal.html` change (the Agent DM tab is 4f) —
  preview `portal-preview` untouched. Evidence: `test-agent-dm-privacy.js` **6/6** (private default →
  metadata-only admin read, body absent from the JSON + audit · flip audited/counted + agents told +
  bodies surface · flip back restores redaction · non-admin 403 / Bearer inert 401 / no-CSRF 403 /
  unknown value 400 no-change · 0600 store + policy survives restart) · test-agent-dm-{store,route,sync,loop}
  6/6·10/10·9/9·7/7 · test/config 4/4 · `node --check` · lint + secret-scan clean · `run-tests.sh` all green.
  Next: 4f (Agent DM tab UI).
- **2026-09-26 15:16** — ✅ **4f done** (`59f58bf`). The **Agent DM tab** — the observable face of the
  cross-server DM feature. New **Agent DM** nav item for admins only (the whole feed is admin-only), a
  two-pane view: a **per-pair picker** (each conversation pair + message count + last state, agent filter)
  and a **live transcript** (from → to, state chip, `sync`/`hop N`/`no-relay` chips, per-message delivery/
  reply state). Live traffic arrives on a NEW admin-only SSE surface
  **`GET /api/agent-dms/stream`** — the SSE twin of the board stream — which broadcasts every DM state
  change (queued → delivered → replied|failed) plus a **`policy`** frame when the visibility flips, and a
  `hello` frame carrying the current policy so the banner is right on first paint. **Privacy is enforced on
  the wire**: every frame is a `dmAdminView`, so in private mode a body never reaches the SSE stream (the UI
  renders the `redacted` flag + a `textLength` size hint, and only reads `dm.text` when the server sends it).
  The tab also exposes the 4e switch (`POST /api/agent-dms/visibility`, confirm-gated) so Dad can flip
  bodies visible↔private from the UI. Server wiring: `dmBroadcast(dm)` into the 4b router (all three save
  points) + `dmBroadcastPolicy()` into the 4e flip. **The tab deliberately shows only what the server
  hands it — it can never reveal more than the policy allows.** No config keys added (no drift). Preview
  `portal-preview` untouched: it runs its OWN 2d-era copy of `portal-server.js`/`portal.html` (a snapshot
  under `portal-preview/`, NOT the branch bind-mounted), so the new `/api/agent-dms/stream` endpoint + tab
  will appear there only when the preview is refreshed — a later ship step, not this item. Production
  `agent-portal` untouched. Evidence:
  `test-agent-dm-ui.js` **6/6** (static wiring incl. the exact DM fields the bubble reads · inline script
  compiles · stream is admin-only 401 anon/403 non-admin · live `dm` frame carries from/to/ts/state AND the
  private body stays OFF the wire · an answered `awaitReply` DM emits a `replied` frame carrying the reply ·
  privacy across a private↔visible flip: body hidden → `policy` frame → body revealed) · test-agent-dm-{route,
  store,sync,loop,privacy} 10/10·6/6·9/9·7/7·6/6 · `node --check` · node:test **24/24** ·
  `run-tests.sh` **all green** (36 standalone suites) · lint + secret-scan clean. Next: 4g (Phase-4 DM gate —
  cross-gateway delivery, awaitReply, loop regression, privacy on/off).
- **2026-09-26 16:16** — ✅ **4g done** (`285e6bf`). Phase-4 acceptance gate: `test-agent-dm-gate.js` (**7/7**)
  — the missing regression gate that proves 4a–4f **together** against the REAL server with live + dying fake
  gateways (the phase-4 twin of `test-agent-api.js`/`test-board-gate.js`/`test-roster-gate.js`). It drives the
  INTEGRATION seams the per-item suites don't: **A** one portal fans out to two servers with NO cross-leak
  (alice→lab:bob lands only on LAB in `agent:bob:main`, alice→home:cara only on HOME; the sender ref rides the
  prompt) and a target on a dead server is refused 404 with no write (`agent_dm_unrouted`); **B** the sender
  **discovers the peer from `GET /api/agent/roster`** (no hardcoded ref) and DMs it, the `awaitReply` returns the
  peer's assistant message, and the peer's reply DM **routes back across the servers** into `agent:alice:main`
  (hop 1) — so the phone book and the router agree on addressing end-to-end; **C** the reply chain still chains
  **0→1→2→3 across servers** and refuses the 4th (429, no write, `agent_dm_loop_blocked` hops:4), and an unrelated
  pair resets to hop 0; **D** `awaitReply` lands (200 replied), a no-reply hold times out and **stays delivered**,
  the async path stays 202; **E** privacy holds on **feed + SSE stream + audit at once** — private body absent from
  all three while both parties read their own copy, the flip raises a `policy` frame + reveals the body on feed and
  stream + tells the agents, flipping back re-redacts; **F** feed + stream are admin-only (403 non-admin, 401 anon,
  Bearer inert on the human feed), no agent token in the log, store 0600; **G** the loop release is **human-only** —
  an AGENT board post leaves the pair budget spent (`agent_dm_loops_broken` NOT audited) while a signed-in HUMAN
  board post clears it. Test-only; no `portal-server.js` change. Evidence: `node --check` · `test-agent-dm-gate.js`
  7/7 · test-agent-dm-{store,route,sync,loop,privacy,ui} 6/6·10/10·9/9·7/7·6/6·6/6 · node:test **24/24** ·
  `run-tests.sh` all green · lint + secret-scan clean. **Phase 4 complete** — next is Phase 5 (5a: VERSION 3.1.0
  + CHANGELOG/README/ADMIN docs).
- **2026-09-26 17:16** — ✅ **5a done** (`fb77c59`). Version + docs. `VERSION` → **3.1.0**; new
  **CHANGELOG `[3.1.0] — 2026-09-26`** section (Added: agent API + bearer tokens, bulletin board + notify,
  phone book, cross-server agent DM + loop safety + private-by-default privacy, Board/Agent DM tabs; Security:
  hashed agent creds + no body in any admin/SSE/audit surface, LAN-bind + TLS reachability) with the link refs
  moved to `v3.1.0`. `README.md` gains three feature bullets, a **"Bulletin board & cross-server agent DM"**
  section, the v3.1 config keys in the sample, and a doc-index tweak; `ADMIN.md` gains **§12 Agent API**,
  **§13 Bulletin board**, **§14 Cross-server agent DM** (leaving **§11 Compliance & abuse** in place —
  `test-compliance` pins it) and its footer now tracks v3.1.0. Added the drift guard **`test-docs-v31.js` (6/6)**:
  VERSION == newest CHANGELOG release, 3.1.0 records the four features, README advertises them + links the log,
  ADMIN documents the new operator surface (and keeps §11), example config carries all 18 v3.1 keys, and no
  personal-name/internal-string leak in README/ADMIN/CHANGELOG. Evidence: `node --check` · `test-docs-v31` 6/6 ·
  test-docs 5/5 · test-public-docs 8/8 · test-compliance 6/6 · test-legal 6/6 · test-release **8/8** (reproducible
  build @ 3.1.0, SBOM matches, local annotated `v3.1.0` tag) · test-network-decision 5/5 · lint + secret-scan
  clean · **`run-tests.sh` all green**. Docs/version only — no `portal-server.js`/`portal.html` change; preview
  `portal-preview` untouched. Next: 5b (all gates green).
- **2026-09-26 18:16** — ✅ **5b done**. Gate checkpoint before ship — no code change, all four gates run
  green on the v3.1.0 tree. `lint.sh` clean (51 JS `node --check` · 8 shell `bash -n` · 3 JSON well-formed ·
  no CRLF) · `secret-scan.sh` clean (0 findings; tracked-file forbidden-state check included) ·
  **`run-tests.sh` all green** (node:test **24/24** + **37** standalone suites) ·
  **`e2e-verify.sh --backend docker` PASSED — 21 checks in 7s** (fresh-box `install --dry-run` + hardened image
  build · no-credential wizard mints admin · room round-trip + disk persist · upgrade/rebuild on SAME state
  survives · encrypted backup → total loss → restore sha256-identical, boots + logs in). CI
  (`.github/workflows/ci.yml`) already wires all four (lint · test[run-tests + e2e] · secret-scan[repo + tar] ·
  build), so a push is gated on them. Production `agent-portal` + preview `portal-preview` untouched.
  Next: 5c (local-only release artifact `release.sh 3.1.0`).
- **2026-09-26 19:16** — ✅ **5c done** (artifact `dist/cirrus-portal-3.1.0.tar.gz` sha256 `89c04d4d…`;
  local annotated tag `v3.1.0`). Cut the release artifact **locally**, clock pinned to the release-content commit
  `2071f2a` so the bytes don't move with doc-only ticks: `SOURCE_DATE_EPOCH=1790461195
  RELEASE_GPG_KEY=release@crperdue.com ./release.sh 3.1.0` (i.e. `2026-09-26T22:19:55Z`; anyone can reproduce with
  that same `SOURCE_DATE_EPOCH`). Under `dist/` (gitignored — never committed): the tarball
  (52 entries, **code + installer + docs only**, no state/test/dev files), the CycloneDX 1.5 SBOM (base-image digest
  matches the Dockerfile), and `SHA256SUMS` **detached-signed** with the real Cirrus release key (`0A12…417D`; public
  half `cirrus-portal-release-key.asc`). Evidence: `sha256sum -c SHA256SUMS` OK · `gpg --verify` = **Good signature** ·
  `secret-scan.sh --tar` clean · **reproducible** (rebuild → byte-identical `89c04d4d…`) · tarball smoke-install
  (`tar xzf` → `bash -n install.sh` → `./install.sh install --dry-run` exit 0). Created the **local** annotated tag
  `v3.1.0` (RELEASING.md §7) — **no remote, nothing pushed**; it moves if 5e surfaces a fix. Production `agent-portal`
  + preview `portal-preview` untouched. Next: 5d (formal preview instance on the live box), then 5e/5f.

  > Tag note: `v3.1.0` is local-only and will be re-cut (`git tag -d` + re-tag) if the live E2E (5e) forces a code fix.
- **2026-09-26 20:16** — ✅ **5d done** (`df207bc`). The **formal preview instance** — refreshed `portal-preview`
  (host-net, bind `0.0.0.0:18810`, TLS `manual`) from the **stale 2d-era snapshot** (`portal-server.js` 196 KB,
  VERSION 3.0.0) to the **v3.1.0** tree (`portal-server.js` 254 KB, VERSION 3.1.0): its bind-mounted `/app` copy was
  replaced file-by-file (server/html/setup/nexus/branding/healthcheck/VERSION; old copy kept in
  `portal-preview-backup-<ts>/`), ownership preserved `10001:10001`, `node --check` gate passed, container
  restarted. Regenerated the self-signed cert to cover **both** reachable LAN IPs (SANs `192.168.1.110`,
  `192.168.1.188`, `localhost`; 90-day). **State stays separate** (`portal-preview/`, 0600 — config, users,
  board, plus the newly-created empty `portal-agent-dm.json` + `portal-secrets.json`). **Production
  `agent-portal` untouched** (still `Up 4 days`, `0.0.0.0:18800`). Verified live: `/metrics` →
  `cirrus_portal_build_info{version="3.1.0"}` · root **200** on `127.0.0.1`/`.110`/`.188` · login **200** ·
  board read **2 posts** · every `/api/agent/*` demands auth (anon **401** *and* human-cookie **401** — scope
  isolation) · admin-only `/api/agent-dms/stream` opens with a `hello` frame carrying `visibility:"private"`
  (privacy default live) · minted a smoke token → `/api/agent/whoami` + `/api/agent/board` **200** → **revoked**,
  and the token never appears in the audit log. Added the durable recipe **`docs/PREVIEW.md`** (shape · refresh
  steps · the 4-point reachability checklist that caught the old firewall gap · v3.1 surface checks).
  Docs/deploy only — no `portal-server.js`/`portal.html` change; secret-scan clean. Next: 5e (live E2E proof).
- **2026-09-26 21:16** — ✅ **5e + 5f done** (`86e4817`). Live E2E proof on the preview against the **real fleet**, then the
  hand-over. Wired `portal-preview` to all three gateways (home · lab · ct-test). Two reachability gotchas found and fixed:
  (1) a **remote gateway only accepts an operator WS from a device it has paired** — `lab`/`ct-test` answered
  `pairing required` for the preview's fresh device, so the preview now reuses the **production operator device**
  (`portal-device.json` copied into `portal-preview/`, 0600, **never committed**); gateways tolerate two clients on one
  device, and production kept its **3** gateway connections (container still `Up 4 days`, untouched). (2) the
  **`publicBind` footgun**: `saveConfig()` drops it, so the next boot refused `0.0.0.0` (`FATAL: refusing to bind
  non-loopback interface`) — re-set and documented. Both lessons + the live-proof table are now in `docs/PREVIEW.md`.
  Verified LIVE (not the harness): roster `GET /api/agents` → **44 agents across 3 servers**, all `reachable:true`;
  **agent board post** via Bearer token (authorRef `agent:home:<id>`, server `home`); **human composer post** as the
  signed-in account (`user:<name> · portal`); **cross-server DM** home→lab → `202 {toGateway:lab, state:delivered}`,
  admin feed metadata-only `redacted:true` (private default), **no body/token in any output**. Evidence: `run-tests.sh`
  all green · `lint.sh` + `secret-scan.sh` clean · `node --check` (repo + preview server). DM bodies were kept out of the
  log/audit/report. Production `agent-portal` untouched. **Build complete — 5f hand-over delivered in the run report
  (URL + creds + QA ask); awaiting Dad's QA and his go/no-go on GitHub (6a stays GATED).**
- **2026-09-27 05:16** — ⛔ **6a BLOCKED — needs Dad's go/no-go (no code change; nothing ticked).** 6a is the
  first unchecked item and is **GATED by design**: it bundles a **public action** (push `feat/board-and-agent-dm`
  to GitHub + cut the public 3.1.0 release) with a **destructive repo edit** (scrub the leaked
  `plan-public-readiness.md` from the public tree/history — rewrite + force-push *vs.* unpublish — and redact the
  `CHANGELOG.md` prose leak of the legacy default credential). All are outside the loop's authority (local
  commits only · never push/publish · never delete state). Re-confirmed present this run: `VERSION` **3.1.0**,
  tree clean at `12baece`, `plan-public-readiness.md` still **tracked** at the repo root, `CHANGELOG.md:148`
  still carries `perdue-portal-2026`. **Exact decisions needed from Dad:** (1) go/no-go on the GitHub push +
  public release; (2) how to scrub `plan-public-readiness.md` (history rewrite + force-push **vs.** unpublish)
  and whether to redact the `CHANGELOG.md` line in the same pass (which re-cuts v3.1.0); (3) rotate the
  now-public legacy credential. The build is COMPLETE and the loop is at its stop point (5f, 2026-09-26 21:16).
  **BLOCKED — awaiting Dad.**
