# Releasing Cirrus Portal

The written checklist for cutting a release. Follow it top to bottom; every
step is either verifiable or explicitly marked as needing approval.

> **Publishing is gated.** Steps 1–8 are local and safe to run any time.
> Step 9 (publish/announce) is a **public action** and needs Dad's explicit
> go-ahead — see `plan-public-readiness.md` item 20.

---

## 0. One-time setup (per release machine)

- **Signing key.** Checksums are signed with GPG when a key is available:

  ```bash
  gpg --list-secret-keys            # is there a release key?
  export RELEASE_GPG_KEY=<key-id>   # e.g. noah@crperdue.com or a fingerprint
  ```

  Generate a dedicated key if none exists (do this once, keep it offline):

  ```bash
  gpg --quick-generate-key "Cirrus Portal Release <release@crperdue.com>" \
      rsa4096 sign 2y
  ```

  Publish the public half so users can verify downloads:

  ```bash
  gpg --armor --export release@crperdue.com > cirrus-portal-release-key.asc
  ```

  No key? Builds still work — they produce **unsigned** checksums and say so.
  A release to the public **must** be signed: use `REQUIRE_SIGN=1` to make an
  unsigned build fail.

## 1. Confirm the tree is clean and green

```bash
git status --short          # expect: nothing (or only intended changes)
./lint.sh                   # JS/shell syntax, JSON validity, line endings
./run-tests.sh              # node:test suite + every standalone smoke test
./secret-scan.sh            # repo must be clean
```

Do not proceed until all four are clean.

## 2. Decide the version (semver)

- `MAJOR` — breaking changes (boot gates, config schema, removed endpoints).
- `MINOR` — backwards-compatible features.
- `PATCH` — backwards-compatible fixes.

The version lives in the **`VERSION`** file. For the first public release it is
`3.0.0`.

## 3. Write the changelog

Move the `[Unreleased]` entries in **`CHANGELOG.md`** under a new
`## [x.y.z] — YYYY-MM-DD` heading, following
[Keep a Changelog](https://keepachangelog.com/). Add the `git` compare link if
the repo is hosted. The changelog ships inside the tarball.

## 4. Build the distribution

```bash
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"   # pin the build clock
RELEASE_GPG_KEY="$RELEASE_GPG_KEY" ./release.sh 3.0.0
```

`release.sh` produces, under `dist/`:

| Artifact | What it is |
| --- | --- |
| `cirrus-portal-<ver>.tar.gz` | the distributable (code + installer + docs, **no state/secrets**) |
| `SHA256SUMS` | checksums for the tarball + SBOM |
| `SHA256SUMS.asc` | GPG signature over `SHA256SUMS` (when a key is set) |
| `cirrus-portal-<ver>.sbom.json` | CycloneDX SBOM for the release |

The build is **reproducible**: with `SOURCE_DATE_EPOCH` pinned, two builds of
the same tree produce a byte-identical tarball. Verify that claim before you
publish:

```bash
sha256sum dist/cirrus-portal-3.0.0.tar.gz
./release.sh 3.0.0 >/dev/null && sha256sum dist/cirrus-portal-3.0.0.tar.gz   # same hash
```

## 5. Verify the artifacts

```bash
cd dist
sha256sum -c SHA256SUMS                      # tarball + SBOM match the manifest
gpg --verify SHA256SUMS.asc SHA256SUMS       # signature is valid (if signed)
tar tzf cirrus-portal-3.0.0.tar.gz | head    # sane contents
../secret-scan.sh --tar cirrus-portal-3.0.0.tar.gz   # no secrets in the payload
```

Also confirm the tarball contains **no** runtime state — `portal-config.json`,
`portal-secrets.json`, `portal-users.json`, `portal-audit.log`, `backups/`, and
**no** `test/`, `run-tests.sh`, `lint.sh`, or `.github/` (dev-only).

## 6. Smoke-install the tarball

On a throwaway box or container (see `plan-public-readiness.md` item 18):

```bash
tar xzf cirrus-portal-3.0.0.tar.gz && cd cirrus-portal-3.0.0
./install.sh install --dry-run    # prints the exact plan, mutates nothing
./install.sh install              # real install into setup mode / first-run
./install.sh status               # healthy
```

## 7. Tag the release (local)

```bash
git add -A && git commit -m "release: v3.0.0"
./release.sh --tag 3.0.0                 # annotated tag v3.0.0 at HEAD
git tag -n99                             # confirm the tag + message
```

There is **no remote** in this repo; the tag stays local until publishing is
approved. Never push tags without the go-ahead.

## 8. Assemble the release bundle to hand over

```
dist/cirrus-portal-3.0.0.tar.gz
dist/SHA256SUMS
dist/SHA256SUMS.asc            (signed builds)
dist/cirrus-portal-3.0.0.sbom.json
CHANGELOG.md                   (the matching section)
```

## 9. Publish + announce — ⛔ REQUIRES DAD'S EXPLICIT GO-AHEAD

Nothing here happens on a scheduled run. When approved:

- [ ] Dad approves the version, the changelog text, and the announcement copy.
- [ ] Upload the artifacts to the chosen host and publish the public key.
- [ ] Publish docs (`README.md` quickstart is the front page).
- [ ] Announce to the intended audience.
- [ ] Stand up post-release monitoring + issue triage (item 20).

---

## Rollback

A release is just files in `dist/` and a local tag — nothing is destructive:

```bash
git tag -d v3.0.0          # drop a bad tag
rm dist/cirrus-portal-3.0.0.*  dist/SHA256SUMS*   # discard bad artifacts
```

If a published release is found to be bad, yank the download, publish the
reason in `CHANGELOG.md`, cut a `PATCH` release, and (if security-related)
follow `SECURITY.md`.
