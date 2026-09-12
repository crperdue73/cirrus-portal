#!/usr/bin/env node
'use strict';
/**
 * test-release.js — smoke test for plan item 14 (release engineering).
 *
 * Guards the release machinery against drift and does NOT trust the docs:
 *   A. CHANGELOG.md is a real Keep-a-Changelog with 3.0.0 + 2.2.0 sections
 *   B. RELEASING.md is a usable publish checklist (build → sign → verify → tag,
 *      with the public-publish step gated on Dad's approval)
 *   C. release.sh is wired for reproducibility, SBOM, signing, and tagging —
 *      and does not carry the `tar --help | grep -q` pipefail race
 *   D. the build is REPRODUCIBLE: two builds of the same tree hash identically,
 *      and the tarball ships CHANGELOG/RELEASING while excluding dev/test files
 *   E. the SBOM is valid CycloneDX that matches the real pinned base image
 *   F. signed checksums: REQUIRE_SIGN=1 without a key fails; with a key it
 *      produces a verifiable SHA256SUMS.asc
 *   G. --tag creates a local annotated semver tag (and does not duplicate it)
 *   H. the new docs ship in the tarball and are linked from README
 *
 * Zero dependencies (GPG is optional; its absence only skips the positive
 * signing check). Run: node test-release.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const VERSION = read('VERSION').trim();

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: SRC, encoding: 'utf8', ...opts });

let pass = 0;

// ── A. CHANGELOG.md is a real Keep-a-Changelog ───────────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'CHANGELOG.md')), 'A: CHANGELOG.md is missing');
  const cl = read('CHANGELOG.md');
  assert(/keepachangelog\.com/i.test(cl), 'A: must reference Keep a Changelog');
  assert(/semver\.org|Semantic Versioning/i.test(cl), 'A: must reference Semantic Versioning');
  assert(/^## \[Unreleased\]/m.test(cl), 'A: must have an [Unreleased] section');
  assert(/^## \[3\.0\.0\]/m.test(cl), 'A: must have a 3.0.0 section (first public release)');
  assert(/^## \[2\.2\.0\] — 2026-08-11/m.test(cl), 'A: must have a dated 2.2.0 section');
  assert(/### (Added|Changed|Fixed|Security)/.test(cl), 'A: sections must use Keep-a-Changelog headings');
  console.log('✓ A: CHANGELOG.md is a Keep-a-Changelog with 3.0.0 + 2.2.0 sections');
  pass++;
}

// ── B. RELEASING.md is a usable publish checklist ────────────────────────────
{
  assert(fs.existsSync(path.join(SRC, 'RELEASING.md')), 'B: RELEASING.md is missing');
  const r = read('RELEASING.md');
  assert(/- \[ \]|- \[x\]/.test(r), 'B: must be an actual checklist');
  for (const step of [/run-tests\.sh/, /secret-scan\.sh/, /release\.sh/, /CHANGELOG\.md/,
                      /SHA256SUMS/, /sbom/i, /--tag/, /SOURCE_DATE_EPOCH/, /RELEASE_GPG_KEY|REQUIRE_SIGN/]) {
    assert(step.test(r), `B: checklist is missing a step matching ${step}`);
  }
  assert(/go-ahead|go ahead|approval|approve/i.test(r) && /Dad/i.test(r),
    'B: the public publish/announce step must be gated on Dad\'s approval');
  assert(/no remote/i.test(r), 'B: must state there is no remote (tags stay local)');
  console.log('✓ B: RELEASING.md is a complete, approval-gated publish checklist');
  pass++;
}

// ── C. release.sh wiring + the pipefail race is gone ─────────────────────────
{
  const rel = read('release.sh');
  assert(/RELEASE_GPG_KEY/.test(rel) && /REQUIRE_SIGN/.test(rel), 'C: signing knobs missing');
  assert(/detach-sign/.test(rel) && /SHA256SUMS\.asc/.test(rel), 'C: detached signature wiring missing');
  assert(/CycloneDX/.test(rel) && /specVersion/.test(rel), 'C: SBOM wiring missing');
  assert(/--tag/.test(rel) && /tag -a/.test(rel), 'C: semver tag wiring missing');
  assert(/SOURCE_DATE_EPOCH/.test(rel), 'C: reproducible-build clock missing');
  assert(/--sort=name/.test(rel) && /--mtime=/.test(rel) && /gzip -n/.test(rel),
    'C: reproducible tar/gzip flags missing');
  assert(/CHANGELOG\.md/.test(rel) && /RELEASING\.md/.test(rel), 'C: new docs not in FILES');
  // The bug: `tar --help | grep -q` under `set -o pipefail` silently drops flags.
  assert(!/tar --help[^\n]*\|[^\n]*grep/.test(rel),
    'C: `tar --help | grep -q` race is back — use a captured string (pipefail SIGPIPE)');
  console.log('✓ C: release.sh wired for reproducible + signed + SBOM + tagged releases');
  pass++;
}

// ── D. reproducible build + tarball contents ─────────────────────────────────
{
  const env = { ...process.env, SOURCE_DATE_EPOCH: '1700000000' };
  const sha = () => run('sha256sum', [`dist/cirrus-portal-${VERSION}.tar.gz`], { env }).split(' ')[0];

  run('./release.sh', [VERSION], { env });
  const h1 = sha();
  run('./release.sh', [VERSION], { env });
  const h2 = sha();
  assert(h1 === h2, `D: build is NOT reproducible (${h1} != ${h2})`);

  const listing = run('tar', ['tzf', `dist/cirrus-portal-${VERSION}.tar.gz`]);
  for (const f of ['CHANGELOG.md', 'RELEASING.md']) {
    assert(listing.includes(f), `D: tarball must ship ${f}`);
  }
  for (const bad of ['/test/', 'run-tests.sh', 'lint.sh', '.github/', 'portal-config.json',
                     'portal-secrets.json', 'portal-users.json']) {
    assert(!listing.includes(bad), `D: tarball must NOT contain ${bad}`);
  }
  console.log(`✓ D: reproducible build (${h1.slice(0, 12)} twice) with correct contents`);
  pass++;
}

// ── E. SBOM is valid CycloneDX matching the pinned base image ────────────────
{
  const sbomPath = path.join(SRC, 'dist', `cirrus-portal-${VERSION}.sbom.json`);
  assert(fs.existsSync(sbomPath), 'E: SBOM was not produced');
  const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
  assert(sbom.bomFormat === 'CycloneDX', 'E: bomFormat must be CycloneDX');
  assert(sbom.specVersion === '1.5', 'E: specVersion must be 1.5');
  assert(sbom.metadata.component.name === 'Cirrus Portal', 'E: component name must be Cirrus Portal');
  assert(sbom.metadata.component.version === VERSION, 'E: SBOM version must match VERSION');

  const dockerfile = read('Dockerfile');
  const digest = (dockerfile.match(/@sha256:([0-9a-f]{64})/) || [])[1];
  assert(digest, 'E: Dockerfile base image is not digest-pinned');
  const img = sbom.components.find((c) => c.type === 'container');
  assert(img, 'E: SBOM must list the container base image');
  assert(JSON.stringify(img).includes(digest), 'E: SBOM base-image digest must match the Dockerfile');
  assert(/none/.test(JSON.stringify(sbom.metadata.properties)),
    'E: SBOM must declare zero bundled third-party code');
  console.log('✓ E: SBOM is valid CycloneDX 1.5 and matches the pinned base image');
  pass++;
}

// ── F. signed checksums (negative + positive) ────────────────────────────────
{
  // Negative: REQUIRE_SIGN=1 without a key must fail the build.
  const asc0 = path.join(SRC, 'dist', 'SHA256SUMS.asc');
  fs.rmSync(asc0, { force: true });
  let failed = false;
  try {
    run('./release.sh', [VERSION], { env: { ...process.env, REQUIRE_SIGN: '1', RELEASE_GPG_KEY: '' } });
  } catch (e) { failed = true; }
  assert(failed, 'F: REQUIRE_SIGN=1 without a key must abort');

  // Positive: with a throwaway key the signature must verify.
  const hasGpg = (() => { try { run('gpg', ['--version']); return true; } catch { return false; } })();
  if (!hasGpg) {
    console.log('✓ F: unsigned build refused under REQUIRE_SIGN=1 (gpg absent — sig check skipped)');
  } else {
    const gnupg = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-gpg-'));
    fs.chmodSync(gnupg, 0o700);
    const env = {
      ...process.env, SOURCE_DATE_EPOCH: '1700000000', GNUPGHOME: gnupg,
      RELEASE_GPG_KEY: 'cirrus-test@example.invalid',
    };
    run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
      '--quick-generate-key', 'Cirrus Test <cirrus-test@example.invalid>', 'ed25519', 'sign', '1d'],
      { env, stdio: 'ignore' });
    run('./release.sh', [VERSION], { env });
    const asc = path.join(SRC, 'dist', 'SHA256SUMS.asc');
    assert(fs.existsSync(asc), 'F: signed build produced no SHA256SUMS.asc');
    // gpg writes "Good signature" to STDERR, so capture both streams.
    const v = spawnSync('gpg', ['--verify', asc, path.join(SRC, 'dist', 'SHA256SUMS')],
      { env: { ...env, GNUPGHOME: gnupg }, encoding: 'utf8' });
    const sigOut = `${v.stdout || ''}${v.stderr || ''}`;
    assert(/Good signature/.test(sigOut),
      `F: SHA256SUMS.asc did not verify (${sigOut.trim().split('\n').slice(-2).join(' | ')})`);
    fs.rmSync(gnupg, { recursive: true, force: true });
    fs.rmSync(asc, { force: true });
    console.log('✓ F: unsigned build refused; throwaway-key signature verifies ("Good signature")');
  }
  pass++;
}

// ── G. --tag creates a local annotated semver tag, without duplicating ───────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-rel-'));
  // Copy the working tree (tracked + the new untracked docs), minus VCS/artifacts.
  const tarBuf = execFileSync('tar', ['-cf', '-', '--exclude=.git', '--exclude=dist',
    '--exclude=backups', '--exclude=node_modules', '--exclude=*.log', '.'],
    { cwd: SRC, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-'], { cwd: tmp, input: tarBuf });

  const git = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'noah@crperdue.com']);
  git(['config', 'user.name', 'Noah']);
  git(['add', '-A']);
  git(['commit', '-qm', 'release test']);

  const env = { ...process.env, SOURCE_DATE_EPOCH: '1700000000' };
  execFileSync('./release.sh', ['--tag', VERSION], { cwd: tmp, env, stdio: 'ignore' });
  const tag = git(['tag', '-l', `v${VERSION}`]).trim();
  assert(tag === `v${VERSION}`, 'G: --tag did not create the semver tag');
  const type = git(['cat-file', '-t', `v${VERSION}`]).trim();
  assert(type === 'tag', 'G: tag must be annotated (object type "tag")');
  // Re-running must not error on the existing tag.
  execFileSync('./release.sh', ['--tag', VERSION], { cwd: tmp, env, stdio: 'ignore' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ G: --tag creates annotated v${VERSION}; re-run is idempotent`);
  pass++;
}

// ── H. new docs ship + are linked from README ────────────────────────────────
{
  const rel = read('release.sh');
  for (const f of ['CHANGELOG.md', 'RELEASING.md']) {
    assert(new RegExp(`(^|\\s)${f}(\\s|$)`, 'm').test(rel), `H: release.sh FILES must include ${f}`);
  }
  const readme = read('README.md');
  assert(readme.includes('](CHANGELOG.md)'), 'H: README must link CHANGELOG.md');
  assert(readme.includes('](RELEASING.md)'), 'H: README must link RELEASING.md');
  console.log('✓ H: CHANGELOG + RELEASING ship in the release and are linked from README');
  pass++;
}

console.log(`\nall ${pass}/8 release-engineering checks passed`);
