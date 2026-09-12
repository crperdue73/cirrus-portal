# Upgrading Cirrus Portal

**Audience:** operators running an existing install who want to move to a newer
release, or from the **2.x** line to the **3.x** public line.

> **Golden rule: back up first, verify, then upgrade.** Every upgrade path below
> keeps your state; the safest one you will actually run is the boring one.

---

## 1. Version scheme

`VERSION` holds the release the tree is on (currently `2.2.0`). The next public
release is **v3.0.0**. Releases are semver tags; the release tarball is
`cirrus-portal-<version>.tar.gz` with `SHA256SUMS`.

What survives an upgrade:

| Survives (untouched) | Replaced by the upgrade |
| --- | --- |
| `portal-config.json` | `portal-server.js`, `portal.html`, `setup.html`, `nexus.html` |
| `portal-secrets.json` | `install.sh`, `release.sh`, `secret-scan.sh`, `healthcheck.js` |
| `portal-users.json` | `Dockerfile`, `docker-compose.yml`, `.dockerignore` |
| `portal-device.json` | `deploy/` templates, docs |
| `portal-rooms.json`, `portal-context.json`, `portal-audit.log` | |

`portal-device.json` persists (bind-mounted), so the gateway keeps recognizing
the device — **no re-approval needed**.

---

## 2. Standard upgrade (2.x → 2.x, or 3.x → 3.x)

```bash
cd /opt/cirrus-portal

# 1. Back up first (state + config snapshot):
./install.sh backup

# 2. Stage the new release over the code (never over the state):
#    unpack the new tarball and copy the code/installer files in, or
#    git pull / rsync the release directory.
#    State files are git-ignored and never part of the tarball — nothing to merge.

# 3. Rebuild and restart:
./install.sh upgrade

# 4. Verify:
./install.sh status
./install.sh doctor
```

`upgrade` rebuilds the container from the current code while keeping all state.
`status`/`doctor` give you the health signal; a failed build leaves the previous
image in Docker's cache (see [§5 Rollback](#5-rollback)).

---

## 3. Upgrading to 3.x — what changed and what you must check

The 3.x line hardens defaults. Most changes are automatic, but **three defaults
changed in a way that can stop a 2.x box from booting** until you reconcile them.
Read this section before upgrading a long-running 2.x install.

### 3.1 New mandatory-ish defaults

| Setting | 2.x behavior | 3.x behavior | What you must do |
| --- | --- | --- | --- |
| **Bind** | `0.0.0.0` | **`127.0.0.1`** | To serve off-host you must opt in: `"publicBind": true`, `PORTAL_PUBLIC_BIND=1`, or `--public-bind`. |
| **Public bind + TLS** | Cleartext allowed | **Refused without TLS** | Expose with `--domain` (Caddy), `--tls-cert/--tls-key`, or a trusted proxy; or pass `--insecure-plaintext` on a trusted LAN only. |
| **Credentials** | shared defaults possible | **Refused** on a known-default admin password | Rotate the admin password (Users → reset pw) *before* upgrading if it is a known default. |
| **Gateway tokens** | inside `portal-config.json` | in **`portal-secrets.json`** (0600) | The token **auto-migrates on first boot** and is stripped from the config. Creates the secrets file — see §4. |
| **Container name** | `agent-portal` | `cirrus-portal` | The old container must be removed before the rebuild, or it clashes on the host port — see §4. |

The **fastest safe path** for a public 2.x box is to re-run the installer with
your domain, which wires all of the above at once:

```bash
./install.sh backup
./install.sh install --domain portal.example.com --email you@example.com
./install.sh doctor
```

### 3.2 Other 3.x changes (automatic)

- Sessions gained **CSRF tokens**, **rotation on login**, `logout-all`, and
  configurable TTL / idle expiry.
- The first-run surface is now a **setup wizard** at `/setup` when nothing is
  configured (no default admin is ever minted).
- Container runs **non-root (uid 10001)**, **read-only**, with dropped caps and
  resource limits; state must be owned by `10001:10001` (the installer chowns it).
- New proxy templates ship in `deploy/` (Caddy + nginx) with HSTS and 80→443.
- `secret-scan.sh` guards the repo and release tarball.

---

## 4. Migrating a live 2.x box to 3.x (ordered drill)

Do this in a quiet window. Each step is reversible up to the rebuild.

```bash
# 0. Snapshot, in case anything goes sideways:
./install.sh backup
cp portal-config.json portal-config.json.pre3     # keep a copy

# 1. Create the secrets file if it does not exist yet (0600).
#    The legacy token in portal-config.json auto-migrates into it on first boot.
[ -f portal-secrets.json ] || { printf '{}\n' > portal-secrets.json; chmod 600 portal-secrets.json; }

# 2. Decide your exposure and reconcile the new defaults:
#    - Public + HTTPS (recommended):  ./install.sh install --domain <host> --email <addr>
#    - Public, trusted LAN only:      add "publicBind": true and pass --insecure-plaintext
#    - Loopback only:                 nothing to do (new default)

# 3. Rotate away from any known-default admin password (if not already done).

# 4. If the old container is still named agent-portal, remove it so the rename
#    does not collide on the host port:
docker rm -f agent-portal || true

# 5. Rebuild + start under the new name:
./install.sh upgrade

# 6. Verify:
./install.sh status
./install.sh doctor
```

> The installer now warns about the container-name clash in preflight and in
> `upgrade`. If you skip step 4, you can end up with two containers fighting over
> host port 18800.

---

## 5. Rollback

The previous image stays in Docker's cache and the old JS/HTML are one copy
away. To roll back:

```bash
# Restore code from your previous release, then:
docker compose up -d --build

# Or restore a full state+config snapshot:
./install.sh restore backups/portal-backup-<timestamp>.tar.gz
```

Device identity and state are untouched by either direction. Because backups
**exclude secrets**, re-provide `GATEWAY_TOKEN=…` or restore your copy of
`portal-secrets.json` after a full restore.

---

## 6. An automated migrator

A first-class **2.x → 3.x migrator** ships as **`migrate.js`** (wrapped by
`./install.sh migrate`). It performs the transformation in §3–§4 automatically:

```bash
./install.sh migrate --dry-run      # preview every change; writes nothing
./install.sh migrate                # backup-first, then apply
./install.sh upgrade                # rebuild the container on the new schema
```

What it does, in one pass:

- **Config schema** — moves legacy plaintext gateway tokens + the legacy
  `portalPassword` out of `portal-config.json` into `portal-secrets.json`
  (0600), adds the 3.x keys (`publicBind`, `tlsMode`, `trustProxy`,
  `sessionIdleMinutes`, the login-limit trio) with 2.x-preserving defaults, and
  stamps `schemaVersion: 3`.
- **Safe defaults** — a box that bound a public interface in cleartext is moved
  back to **loopback** (fail closed). Re-expose deliberately with
  `--domain HOST` (recommended), `--tls-cert/--tls-key`, or
  `--allow-insecure-plaintext` (trusted LAN only).
- **Credentials** — any account still on a known-default password (the old
  shipped `admin`/`admin`, the shared bootstrap password, `*-demo`, …) is
  rotated to a fresh strong password written to `portal-credentials.txt` (0600).
- **Role model** — legacy/alias roles (`teacher`, `owner`, `ta`, …) map to
  `student | instructor | admin`; user records are normalized (lowercase
  username, `agents` array, `assignments`).

**Backup-first:** before writing anything it copies config + secrets + all state
into `backups/migrate-<stamp>/` (0700, includes secrets) so a run is fully
reversible. Delete that directory once you have verified the upgrade.

> `--dry-run` is always safe to run — it reads state and prints the plan, but
> changes nothing.

---

## 7. Verify after any upgrade

- [ ] `./install.sh status` exits 0
- [ ] `./install.sh doctor` reports clean (secrets mode 600, config token-free, ownership correct)
- [ ] Login works; **Users → reset pw** succeeded if you rotated
- [ ] Agents list is populated; send a message → reply streams
- [ ] `portal-audit.log` records the login
- [ ] Reboot the host → the portal returns on its own
- [ ] Restart the gateway → the portal reconnects (≤ 30 s, no restart)

If something regressed, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

---

*Docs track the v3.0.0 public release. If this file and `./install.sh --help`
disagree, the installer wins — file a docs bug.*
