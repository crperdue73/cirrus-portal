# Disaster recovery — backup, restore & the clean-VM drill

**Cirrus Portal** · product family **Cirrus** · engine **Cirrus Core**

This document defines how a Cirrus Portal install is backed up, how it is
restored, and how that restore is *proven* on a clean box. It is the operator
counterpart to `./backup.sh` (the encrypted backup/DR helper).

---

## 1. Objectives (RPO / RTO)

| Objective | Target | How it is met |
| --- | --- | --- |
| **RPO** (max data loss) | **≤ 15 min** with the shipped schedule | `./backup.sh schedule --install --interval 15min` runs `create --with-secrets` every 15 minutes; worst case you lose one interval. Use `--interval hourly`/`daily` if a longer RPO is acceptable. |
| **RTO** (time to restore) | **≤ 15 min** on a clean Debian 12/13 VM | Restore is `decrypt → verify → write`; the drill on this repo measures **~0.2–1 s** for the state itself, dominated by the container rebuild (`./install.sh upgrade`, typically 1–3 min). |
| **Verifiability** | every backup is provably restorable | `./backup.sh verify FILE` (cipher hash → `SHA256SUMS` → manifest) and `./backup.sh drill` (full wipe-and-restore, sha256-compared). |

Set the schedule to your own tolerance. The **RPO is exactly one schedule
interval** — nothing longer is possible without losing data between runs.

---

## 2. What is protected

An **encrypted** backup (`create --with-secrets`) captures the entire local
trust boundary:

| Item | File | In a plain snapshot | In `--with-secrets` |
| --- | --- | --- | --- |
| Config (port, bind, gateways, auth knobs) | `portal-config.json` | ✅ | ✅ |
| Device identity (Ed25519) | `portal-device.json` | ✅ | ✅ |
| Accounts + roles | `portal-users.json` | ✅ | ✅ |
| Course context / assignments | `portal-context.json` | ✅ | ✅ |
| Rooms + messages | `portal-rooms.json` | ✅ | ✅ |
| Audit log | `portal-audit.log` | ✅ | ✅ |
| **Gateway tokens + bootstrap password** | `portal-secrets.json` | ❌ | ✅ |
| **One-time generated admin password** | `portal-credentials.txt` | ❌ | ✅ |

Secrets are included **only** because the archive is encrypted — that is what
makes an encrypted backup a complete disaster-recovery image. The archive is
AES-256 encrypted and never stored in plaintext.

> ⚠️ **The passphrase is the whole game.** Without it the backup is
> unrecoverable. Store `portal-backup-passphrase` (0600) **off the box** — in
> your password manager or a sealed copy — before you rely on any backup.

---

## 3. Everyday use

```bash
# one-time: generate a strong passphrase into ./portal-backup-passphrase (0600)
./backup.sh create --init-passphrase

# encrypted snapshot incl. secrets → ./backups/cirrus-backup-<stamp>.tar.gz.gpg
./backup.sh create --with-secrets

# prove a snapshot is restorable, without touching live state
./backup.sh verify backups/cirrus-backup-<stamp>.tar.gz.gpg

# restore (verifies first, snapshots the current state, then writes)
./backup.sh restore backups/cirrus-backup-<stamp>.tar.gz.gpg
```

`./install.sh backup` is **encrypted automatically** when a passphrase is
available (env `PORTAL_BACKUP_PASSPHRASE`, `PORTAL_BACKUP_PASSPHRASE_FILE`, or
`./portal-backup-passphrase`); otherwise it falls back to a plaintext
state+config snapshot and warns. `./install.sh restore` accepts both plain
`.tar.gz` and encrypted `.gpg`/`.enc` archives.

**Retention:** pass `--keep N` to keep the newest N archives and prune older
ones (the schedule uses `--keep 14`). Off-box copies are still strongly
recommended — a backup on the same disk does not survive disk loss.

### Scheduled backups

```bash
./backup.sh schedule                        # print the units (no changes)
sudo ./backup.sh schedule --install --interval 15min   # systemd timer
sudo ./backup.sh schedule --remove                      # stop + remove
```

The printer emits both a `systemd` timer (`cirrus-portal-backup.{service,timer}`,
`RandomizedDelaySec=120`, `Persistent=true`) and an `/etc/cron.d` fallback, in
case the host has no systemd.

---

## 4. The clean-VM restore drill (documented)

**Goal:** prove that an encrypted backup from one box restores onto a *fresh*
box and yields a working portal. Run this on a throwaway VM/container — never
on the live host.

### 4a. Automated (fast, local)

```bash
./backup.sh drill                 # uses real state when present, else a fixture
./backup.sh drill --source /path/to/state
```

The drill builds a fixture from the source state, encrypts a snapshot, **wipes
the fixture** (simulated total loss), restores into a throwaway "clean VM"
directory, and **sha256-compares every restored file**. It prints `PASS` and the
measured restore wall-clock. It never reads or writes the live tree.

```
[✓] drill PASS — 6 file(s) restored sha256-identical; measured restore = 0.42s
```

### 4b. Manual (full end-to-end on a clean VM)

Do this before a public release, after any schema change, and at least once a
quarter.

1. **Take a backup on the source box** (with secrets) and copy it *and* the
   passphrase off-box:
   ```bash
   ./backup.sh create --with-secrets --keep 14
   scp backups/cirrus-backup-*.tar.gz.gpg  portal-backup-passphrase  user@clean-vm:/tmp/
   ```
2. **On the clean VM**, install a fresh Cirrus Portal release:
   ```bash
   ./install.sh install --dry-run          # sanity-check the plan
   ./install.sh install --domain portal.example.com --email you@example.com
   ```
   (Any install method is fine — the point is a *fresh* box, not the source.)
3. **Restore the backup** onto the fresh install:
   ```bash
   ./backup.sh restore /tmp/cirrus-backup-<stamp>.tar.gz.gpg
   ```
   `restore` verifies the archive, snapshots the fresh box's own state to
   `backups/pre-restore-<stamp>/`, then writes config + state + secrets.
4. **Rebuild and verify:**
   ```bash
   ./install.sh upgrade
   ./install.sh doctor                       # all checks should pass
   curl -sk https://127.0.0.1/healthz        # {"status":"ok",...}
   ```
5. **Acceptance checks** — the fresh box must now match the source:
   - log in with a source account (or reset from `portal-users.json`);
   - the gateway list matches, and each gateway reconnects with its token;
   - rooms and messages are present;
   - `portal-audit.log` continues from the restored history.
6. **Record the result** in the change/ops log: date, archive name, restore
   duration (RTO evidence), and anything that failed.

### 4c. Failure modes to check

| Sign | Meaning | Fix |
| --- | --- | --- |
| `decryption failed` | wrong passphrase, or corrupt archive | use the recorded passphrase; check the `.sha256` sidecar against the file |
| `ciphertext hash mismatch` | the archive was altered/corrupted | do not restore; use an older archive |
| `file hashes do not match SHA256SUMS` | archive tampering / partial copy | re-copy the archive intact |
| gateways offline after restore | device identity or tokens missing | restore a `--with-secrets` archive, or re-approve the device on each gateway |
| container can't read state after restore | restored file ownership ≠ uid 10001 | `./install.sh install` re-chowns state to `10001:10001` |

---

## 5. Retention & off-box policy (recommended baseline)

- Keep **≥ 14** local archives (`--keep 14`, the schedule default).
- Keep **≥ 1** weekly copy in a separate location (object storage, NAS, or a
  sealed offline device). Local-only backups do not survive host loss.
- Keep the passphrase **separate** from the archives, so a single stolen backup
  is useless on its own and a single lost passphrase is recoverable.
- Re-run `./backup.sh drill` (and, quarterly, the manual drill in §4b) after
  any upgrade, and always before a public release.

---

## 6. Evidence (this repo)

- `./backup.sh drill` — PASS, all files restored sha256-identical (exercised by
  `test-backup.js` on every `./run-tests.sh`).
- `./backup.sh verify` — ciphertext hash, `SHA256SUMS`, and manifest all check
  out; wrong passphrase and a flipped ciphertext byte are both refused.
- `./backup.sh create --with-secrets` — secrets are captured **and** remain
  unreadable without the passphrase (AES-256 via `gpg` or `openssl`).
