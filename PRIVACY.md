# Cirrus Portal — Privacy Note

**Plain language. Short version first.**

Cirrus Portal is **self-hosted software you run yourself**. It has **no cloud
service, no telemetry, and no phone-home**. We (the people who make Cirrus
Portal) never receive your data, because there is nowhere for it to go. Whoever
deploys a portal — your school, your team, your company — is the one who holds
the data, and they are the ones you should ask about it.

This note explains, in ordinary words, what a portal stores, where it lives,
how long it is kept, and how to get it out or delete it.

---

## What the portal stores

Everything below lives in a few files **on the machine the operator installed
it on**. Nothing is sent anywhere else.

| What | Why | Where |
| --- | --- | --- |
| Account records — username, display name, role, password **hash** (never the password itself), created date | So people can sign in and have the right access | `portal-users.json` (0600) |
| Per-person context — the profile/assignment notes an instructor sets for a learner | So the assistant can be given relevant background for that person | `portal-context.json` (0600) |
| Chat messages you send to agents/rooms and the agents' replies | So conversations and shared rooms survive a reload | in memory + `portal-rooms.json` (0600) |
| Gateway connection details | So the portal can reach the agent fleet | `portal-config.json` |
| Gateway tokens and the one-time bootstrap password | So the portal can authenticate to gateways | `portal-secrets.json` (0600, never included in config, logs, or backups unless you ask) |
| An **audit log** of security-relevant actions (sign-ins, sign-ins that failed, account/gateway/room changes, messages sent) | So an operator can investigate incidents and meet compliance duties | `portal-audit.log` (0600) |
| Operational logs + metrics — request method, path, status, duration, request id, client IP | So the operator can see if the service is healthy | stdout / `/metrics` |

**Passwords are never stored in the clear.** They are salted and hashed
(scrypt), and the portal refuses to start if an admin account still uses a
known-default password.

## Cookies and sessions

Signing in sets one cookie, `portal_session`. It is `HttpOnly`, `SameSite=Strict`,
and `Secure` whenever the site is served over HTTPS. It holds a random session
id — not your password, not your name. Signing out (or an admin resetting your
password) invalidates it immediately.

## How long data is kept

- **Accounts, context, and rooms:** kept until someone deletes them. The
  operator controls this; there is no automatic expiry.
- **Audit log:** bounded by an operator-set policy. The default is **90 days**
  (`auditRetentionDays`), after which older entries are pruned automatically;
  a size cap (`auditMaxBytes`, default 1 MB) trims the oldest entries sooner if
  the log grows fast. Set `auditRetentionDays` to `0` to keep audit entries
  until the size cap is reached.
- **Operational logs:** whatever the host/container log system retains — that is
  the operator's choice, not the portal's.

## Getting your data out (export)

The portal can produce a portable JSON copy of a person's data:

- **You export yourself:** `GET /api/users/<your-username>/export` from a signed-in
  browser session (the file downloads as `cirrus-portal-<user>-export.json`).
- **An admin exports anyone:** `GET /api/users/<username>/export`.

The export contains the account record, that person's context, rooms they
created, and the audit entries that mention them. Exports are themselves logged.

## Deleting data (erasure)

- **An admin deletes an account:** `DELETE /api/users/<username>`. This removes
  the account, personal context, and every active session for that user.
- The account's password hash and profile go with it. **Shared room transcripts
  are left intact** so that other people's messages and conversations are not
  altered or destroyed. If a deployment needs a transcript fully purged, the
  admin removes the room (`DELETE /api/rooms/<id>`) — that is a deliberate,
  documented op, not a side effect of one person leaving.
- Audit entries about the account are kept under the retention policy above.
  This is intentional: an audit trail that the subject can erase is not an audit
  trail. If your law or policy requires the audit trail itself to be reduced,
  the operator shortens `auditRetentionDays`.

## Abuse controls for public instances

When a portal is reachable from the internet, it applies a few brakes so a
single source cannot overwhelm it:

- **Per-IP rate limit** on every non-probe route (default 300 requests/minute,
  +60 burst). Health/readiness/metrics probes are exempt so monitoring still
  works. Over-budget requests get `429` and a `Retry-After`.
- **Login lockout** per IP + username (default 5 failures, then a progressive
  lockout).
- **Request-body cap** (default 1 MB) so an oversized upload is rejected with
  `413` before it is buffered.

All three are configurable (`rateLimitPerMinute`, `rateLimitBurst`,
`maxBodyBytes`, `loginMaxAttempts`, …).

## What the portal does **not** do

- No analytics, tracking pixels, or advertising.
- No crash/usage reporting to the authors.
- No third-party services are contacted by the portal itself. *If an operator
  chooses to put it behind a reverse proxy that obtains TLS certificates (for
  example Caddy with Let's Encrypt), that proxy — not the portal — talks to the
  certificate authority.*

## Who to contact

Cirrus Portal is software. **For anything about the data in a specific portal
you use, contact the person or organization that runs it** — they hold it and
they are the responsible party.

For security issues **in the software**, see [`SECURITY.md`](SECURITY.md). For
what a public host must not do with it, see [`ACCEPTABLE-USE.md`](ACCEPTABLE-USE.md).
