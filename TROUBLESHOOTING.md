# Troubleshooting Cirrus Portal

**Audience:** operators. Start with the symptom, find the row, run the fix.
Deep diagnostics: `./install.sh doctor`; live logs: `docker compose logs -f`.

> Before anything: `./install.sh status` (exit 0 = healthy). If it is red, the
> output names the failing check.

---

## 1. Install & boot

| Symptom | Cause | Fix |
| --- | --- | --- |
| `docker compose version` fails / "compose plugin (v2) is required" | Docker Compose v2 plugin missing | Install the `docker-compose-plugin`; the standalone v1 `docker-compose` binary is not supported. |
| Preflight: `os` / "unsupported OS" | Not Debian/Ubuntu | Use Debian 12/13 or Ubuntu 22.04/24.04 (x86_64). See [`DEPLOYMENT.md`](DEPLOYMENT.md). |
| Preflight: "needs > 500 MB free disk" | Install dir nearly full | Free space, or move the install dir to a larger volume. |
| Preflight: `✗ no gateway on 127.0.0.1:18790` | OpenClaw gateway not running / not loopback | Start the gateway; confirm it binds loopback on port `18790`. |
| Preflight: DNS failure for `--domain` | Domain does not resolve | Point an A/AAAA record at the host first, or `PORTAL_SKIP_DNS_CHECK=1` for an offline/CI test. |
| Preflight: "TLS:443 not reachable" | Firewall/NAT blocks 443 | Open 443 inbound (needed for ACME HTTP-01 only if using TLS-ALPN/HTTP challenge). |
| Install aborted and state was restored | A step failed; rollback fired | Read the failing step in the output, fix it, re-run. The exact pre-install files were restored. |
| `EADDRINUSE` on 18800 | Another process (often the legacy `agent-portal` container) holds the port | `docker rm -f agent-portal`, or change `port` in `portal-config.json`. |

---

## 2. Refuses to boot (by design)

These are **safety gates**, not bugs — the portal will not start until the
condition is resolved.

| Message | Meaning | Fix |
| --- | --- | --- |
| "public bind without TLS" / TLS gate | Non-loopback bind with no TLS | Install with `--domain` or `--tls-cert/--tls-key`, set `trustProxy`, or pass `--insecure-plaintext` (trusted LAN/tunnel only). |
| "public bind requires an explicit opt-in" | Bind is non-loopback but not opted in | Set `"publicBind": true`, `PORTAL_PUBLIC_BIND=1`, or `--public-bind`. |
| "refusing to start: admin uses a known-default password" | An admin account still has `admin`/`password`/etc. | Rotate the admin password (restore a good `portal-users.json`, or reset via a backup), or set the dev-only `PORTAL_ALLOW_INSECURE_DEFAULTS=1`. |
| "⚠ PUBLIC BIND … listens on ALL interfaces" | `0.0.0.0` bind | Expected for `--public`. Confirm it is intentional and that TLS + firewall are in place. |
| "⚠ PORTAL_ALLOW_INSECURE_DEFAULTS=1" | Dev escape hatch active | Unset it in production. |

---

## 3. Login & accounts

| Symptom | Cause | Fix |
| --- | --- | --- |
| `429` + `Retry-After` on login | Progressive lockout after repeated failures | Wait out `loginLockoutSeconds`, then retry with the correct password. |
| Correct password rejected while locked | Lockout applies even to correct passwords | Wait, or restart to clear in-memory counters (single-node only). |
| `503 {setupRequired:true}` on every route | Fresh box with no admin — **setup mode** | Open `/setup` and complete the wizard (creates the admin, picks bind/port/TLS, first gateway). |
| Weak-password rejection | Policy: 12+ chars, upper+lower+number, not the username, not a known default, not blocklisted | Choose a compliant password. |
| Admin password lost | No recovery by design | Restore `portal-users.json` from backup; or, if the account was never personalized, re-run setup on a `--fresh` install. |
| Sessions end sooner than expected | `sessionTtlHours` (absolute) or `sessionIdleMinutes` (idle) | Adjust in `portal-config.json` and restart. |
| Every write gets `403` / CSRF error | Missing/incorrect `X-CSRF-Token` (scripts only) | Fetch the token from `/api/login` or `/api/me` and send it in the header. The UI does this automatically. |

---

## 4. Agents & chat

| Symptom | Cause | Fix |
| --- | --- | --- |
| UI loads but "no agents" | Device not approved, or wrong gateway token | `openclaw devices list`; approve the portal device; confirm `portal-secrets.json` has the right token. |
| `NOT_PAIRED` / scope fallback banner | Device approved with fewer scopes than requested | Approve the pending scope-upgrade in `openclaw devices list` (needs `operator.read`, `operator.write`, `operator.approvals`). |
| Replies only appear after a refresh | SSE `sessionKey` mismatch (fixed Aug 2026) | Upgrade to a current build; verify it is the new code. |
| "⛔ blocked by <assignment> policy" on a tool | Per-assignment tool policy flagged the call | Review the assignment policy; this is **flag-and-audit**, the gateway still ran the tool. |
| Approvals show read-only "waiting for staff approval" | Portal device lacks `operator.approvals` | Approve the scope upgrade on the gateway. |
| One server's agents missing, others fine | That gateway is offline or disabled | Check **Gateways** status; re-enable or fix the URL/token. |
| Room shows `[no reply]` | Agent session was busy; the run landed under a different runId | History-fallback should recover it; if not, the agent was silent or the gateway stalled — check `docker compose logs`. |

---

## 5. TLS & connectivity

| Symptom | Cause | Fix |
| --- | --- | --- |
| Port 18800 unreachable off-host | Firewall, or loopback-only bind (default) | Loopback installs need no inbound rule — tunnel over SSH. To serve off-host: `--domain` + `sudo ufw allow 80,443/tcp`, or `--public` with TLS. |
| Caddy cannot get a certificate | DNS not pointed at the host, or 80/443 blocked | Fix DNS; open 80/443; check Caddy logs. |
| Cookies not marked `Secure` behind a proxy | `X-Forwarded-Proto` not forwarded, or `trustProxy` off | Set `trustProxy: true` / `tlsMode: "auto"` and forward the header from your proxy. |
| HSTS not present | Not in a secure context | Confirm TLS termination and `trustProxy`. |
| Portal dark after a gateway restart | Legacy reconnect bug (fixed Aug 2026) | Should auto-recover ≤ 30 s; else `docker compose restart` and check logs. |

---

## 6. Container & storage

| Symptom | Cause | Fix |
| --- | --- | --- |
| Container restarts / unhealthy | Server crash on boot | `docker compose logs --tail 300`; the `HEALTHCHECK` probes loopback `GET /`. |
| "permission denied" reading/writing state | Bind-mounted files not owned by the runtime uid | `./install.sh doctor` flags it; chown state to `10001:10001` (installer does this). |
| Container won't start with `read_only: true` | Writes outside bind mounts / `/tmp` | State must live on bind mounts; `/tmp` is a small tmpfs. Move stray writes. |
| Disk filling up | `portal-audit.log` growth | Archive + truncate the audit log (append-only). |
| `portal-secrets.json` is a directory | Docker bind-mounted a missing file | `docker compose down`, remove the dir, recreate the file: `printf '{}\n' > portal-secrets.json && chmod 600 portal-secrets.json`, then start. |

---

## 7. Backups & restore

| Symptom | Cause | Fix |
| --- | --- | --- |
| After restore, gateways have no token | Backups **exclude secrets** by design | Re-provide `GATEWAY_TOKEN=…` or restore your copy of `portal-secrets.json`. |
| Restored install can't reach the gateway | Device identity differs | Restore `portal-device.json` too, or re-approve the device on each gateway. |
| `./install.sh backup` writes nowhere | Wrong working directory | Run it from the release directory; snapshots land in `./backups/`. |

---

## 8. Escalation

1. Re-run `./install.sh doctor` and capture its output.
2. Capture `docker compose logs --tail 300`.
3. Check [`ADMIN.md`](ADMIN.md) §10 (incident basics) for compromise/lockout steps.
4. Security issue? Follow [`SECURITY.md`](SECURITY.md) — **do not** open a public
   issue.

---

*Troubleshooting tracks the v3.0.0 public release. If a documented fix no longer
matches `./install.sh --help`, the installer is authoritative — file a docs bug.*
