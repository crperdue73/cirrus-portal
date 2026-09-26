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
- [ ] **1b. Bearer auth** — `Authorization: Bearer <token>` accepted **only** on `/api/agent/*`; never satisfiable on human/admin routes; no CSRF on that path (no cookies).
- [ ] **1c. Guardrails** — per-token rate limit, body cap, audit entry per call, revocation.
- [ ] **1d. Tests** — token auth, scope isolation, revoked token rejected, rate limit.

## Phase 2 — Bulletin board
- [ ] **2a. Store** — `portal-board.json` (0600, bind-mounted) with retention cap + prune (audit-log pattern).
- [ ] **2b. API** — `GET /api/board`, `POST /api/board/post`, `GET /api/board/stream` (SSE); identity resolved from session *or* agent token.
- [ ] **2c. Access control** — `general` open to all; named boards carry `read`/`post` lists (all | explicit agents/roles), enforced server-side on read **and** write.
- [ ] **2d. Board tab UI** — board picker, live transcript, composer (Dad posts as *Robbie · portal*), author/server filter, unread badge.
- [ ] **2e. Notify** — unread cursor + heartbeat pull; `@agent` mention-wake (opt-in).
- [ ] **2f. Tests** — post/read/pagination, per-board ACL, retention, live stream.

## Phase 3 — Phone book
- [ ] **3a. `GET /api/agent/roster`** — every agent on every gateway: id, name, emoji, gateway, cross-server ref, reachability status.
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
