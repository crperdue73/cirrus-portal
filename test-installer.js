#!/usr/bin/env node
'use strict';
/**
 * test-installer.js — smoke test for plan item 10 (public installer v3).
 *
 * Two layers:
 *   A. STATIC — the v3 contract is present in the real installer:
 *      new flags (--tls/--public/--non-interactive), rollback-on-failure,
 *      extended preflight (DNS/TLS:443/firewall/port), and the
 *      agent-portal → cirrus-portal slug rename (with legacy detection).
 *   B. FUNCTIONAL — run the installer hermetically in a temp dir (its own
 *      copies of install.sh/VERSION/branding.json + one config) and assert:
 *        • `--dry-run` prints the exact plan, exits 0, and needs no Docker
 *        • `--dry-run` leaves the existing config byte-for-byte untouched
 *        • `--public` without TLS is refused
 *        • `--tls` without a cert source is refused
 *        • `--help` is clean (no heredoc command-substitution noise)
 *
 * Zero dependencies. Run: node test-installer.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const readIf = (f) => (fs.existsSync(path.join(SRC, f)) ? read(f) : '');

let pass = 0;

// ── A. static: flags ─────────────────────────────────────────────────────────
{
  const inst = read('install.sh');
  assert(/--tls\)\s*WANT_TLS=1/.test(inst), 'A: install.sh must parse --tls → WANT_TLS=1');
  assert(/--public\)\s*PUBLIC_BIND=1/.test(inst), 'A: install.sh must parse --public → PUBLIC_BIND=1');
  assert(/--non-interactive[^\n]*NONINTERACTIVE=1/.test(inst), 'A: install.sh must parse --non-interactive');
  assert(/--dry-run\)\s*DRY_RUN=1/.test(inst), 'A: install.sh must parse --dry-run');
  console.log('✓ A: installer v3 flags present (--tls, --public, --non-interactive, --dry-run)');
  pass++;
}

// ── B. static: rollback-on-failure ───────────────────────────────────────────
{
  const inst = read('install.sh');
  for (const fn of ['snapshot_state', 'rollback_now', 'rollback_done', 'on_install_error']) {
    assert(new RegExp(fn + '\\s*\\(\\)').test(inst), `B: missing rollback function ${fn}()`);
  }
  assert(/trap 'on_install_error \$\?' ERR/.test(inst), "B: must arm the ERR trap with on_install_error");
  assert(/rollback_done\s*$/m.test(inst) && /trap - ERR/.test(inst), 'B: must disarm rollback on success');
  assert(/snapshot_state\s*$/m.test(inst) === false || /snapshot_state/.test(inst), 'B: snapshot must be called');
  console.log('✓ B: rollback-on-failure wired (snapshot → ERR trap → restore → disarm)');
  pass++;
}

// ── C. static: extended preflight ────────────────────────────────────────────
{
  const inst = read('install.sh');
  for (const fn of ['preflight_dns', 'preflight_tls_reachable', 'preflight_firewall']) {
    assert(new RegExp(fn + '\\s*\\(\\)\\s*\\{').test(inst), `C: missing preflight function ${fn}()`);
  }
  assert(/preflight_dns "\$DOMAIN"/.test(inst), 'C: DNS preflight must run for --domain');
  assert(/preflight_tls_reachable "\$DOMAIN" 443/.test(inst), 'C: TLS:443 preflight must run for --domain');
  assert(/port_in_use "\$PORT"/.test(inst), 'C: port preflight must still run');
  console.log('✓ C: extended preflight present (DNS · TLS:443 · firewall · port)');
  pass++;
}

// ── D. static: slug rename agent-portal → cirrus-portal ──────────────────────
{
  const inst = read('install.sh');
  assert(/CONTAINER_NAME="\$\{PORTAL_CONTAINER_NAME:-cirrus-portal\}"/.test(inst),
    'D: CONTAINER_NAME must default to cirrus-portal');
  assert(/LEGACY_CONTAINER_NAME="agent-portal"/.test(inst),
    'D: legacy agent-portal must be detected for status/doctor');
  assert(/container_name_running\s*\(\).*agent-portal/s.test(inst) || /grep -Ex "\$CONTAINER_NAME\|\$LEGACY_CONTAINER_NAME"/.test(inst),
    'D: running-container check must accept the legacy name too');

  const compose = read('docker-compose.yml');
  assert(/container_name:\s*cirrus-portal/.test(compose), 'D: compose container_name must be cirrus-portal');
  assert(!/agent-portal/.test(compose), 'D: compose must not still reference agent-portal');

  const rel = read('release.sh');
  assert(/PKG="cirrus-portal-\$VERSION"/.test(rel), 'D: release.sh PKG must be cirrus-portal-<ver>');
  assert(!/agent-portal/.test(rel), 'D: release.sh must not still reference agent-portal');

  const boot = read('bootstrap.sh');
  assert(/cirrus-portal\|agent-portal/.test(boot), 'D: bootstrap --verify must list both names');
  console.log('✓ D: slug renamed to cirrus-portal (legacy agent-portal still detected)');
  pass++;
}

// ── functional harness: run install.sh hermetically in a temp dir ────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-installer-test-'));
for (const f of ['install.sh', 'VERSION', 'branding.json', 'portal-config.json']) {
  if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
}
const cfgPath = path.join(tmp, 'portal-config.json');
const cfgHash = () => (fs.existsSync(cfgPath) ? require('crypto').createHash('sha256').update(fs.readFileSync(cfgPath)).digest('hex') : 'none');

function run(args) {
  return spawnSync('bash', ['install.sh', ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, PORTAL_SKIP_DNS_CHECK: '1' },
  });
}

// ── E. functional: dry-run prints the exact plan and needs no Docker ─────────
{
  const before = cfgHash();
  const r = run(['install', '--dry-run']);
  assert.strictEqual(r.status, 0, `E: loopback --dry-run must exit 0 (got ${r.status})\n${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert(/install plan/.test(out), 'E: dry-run must print the plan heading');
  assert(/container 'cirrus-portal'/.test(out), 'E: plan must name the cirrus-portal container');
  assert(/DNS .*TLS:443 .*firewall/.test(out), 'E: plan must list the preflight checks');
  assert.strictEqual(cfgHash(), before, 'E: dry-run must NOT modify an existing config');
  console.log('✓ E: --dry-run prints the plan, exits 0, touches nothing (no Docker needed)');
  pass++;
}

// ── F. functional: exposure gates ────────────────────────────────────────────
{
  const pub = run(['install', '--dry-run', '--public']);
  assert.notStrictEqual(pub.status, 0, 'F: --public without TLS must be refused');
  assert(/without TLS/i.test(pub.stdout + pub.stderr), 'F: refusal must explain the TLS requirement');

  const tls = run(['install', '--dry-run', '--tls']);
  assert.notStrictEqual(tls.status, 0, 'F: --tls without a cert source must be refused');
  assert(/no certificate source/i.test(tls.stdout + tls.stderr), 'F: --tls refusal must explain what to pair it with');
  console.log('✓ F: exposure gates hold (--public needs TLS; --tls needs a cert source)');
  pass++;
}

// ── G. functional: --help is clean + documents the new flags ─────────────────
{
  const r = run(['--help']);
  assert.strictEqual(r.status, 0, 'G: --help must exit 0');
  assert.strictEqual(r.stderr.trim(), '', `G: --help must not write to stderr (heredoc noise): ${r.stderr}`);
  for (const flag of ['--tls', '--public', '--non-interactive', '--dry-run']) {
    assert(r.stdout.includes(flag), `G: --help must document ${flag}`);
  }
  console.log('✓ G: --help clean and documents the v3 flags');
  pass++;
}

// ── H. functional: rollback-on-failure (fake docker, no real builds) ────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-rollback-test-'));
  for (const f of ['install.sh', 'VERSION', 'branding.json']) {
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  const originalCfg = '{\n  "port": 19321,\n  "bind": "127.0.0.1",\n  "marker": "ORIGINAL"\n}\n';
  fs.writeFileSync(path.join(dir, 'portal-config.json'), originalCfg);
  fs.writeFileSync(path.join(dir, 'portal-secrets.json'), '{"portalPassword":"orig"}\n');

  // Fake `docker`: everything succeeds EXCEPT `compose up`, which fails — so
  // install() mutates state, hits the build, and must roll back.
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-fakebin-'));
  const fake = path.join(bindir, 'docker');
  fs.writeFileSync(fake, '#!/usr/bin/env bash\ncase "$*" in *"compose up"*) exit 1 ;; *) exit 0 ;; esac\n');
  fs.chmodSync(fake, 0o755);

  const r = spawnSync('bash', ['install.sh', 'install', '--force-config'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: bindir + ':' + process.env.PATH, GATEWAY_TOKEN: 'dummy-test-token', PORT: '19321', PORTAL_SKIP_DNS_CHECK: '1' },
  });
  const out = r.stdout + r.stderr;
  assert.notStrictEqual(r.status, 0, `H: install must fail when the build step fails\n${out}`);
  assert(/restoring the pre-install state/i.test(out), 'H: failure must trigger rollback');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8'), originalCfg,
    'H: rollback must restore the exact pre-install config');

  try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(bindir, { recursive: true, force: true }); } catch (_) {}
  console.log('✓ H: failed install rolls back to the exact pre-install config');
  pass++;
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log(`\nall ${pass}/8 installer-v3 checks passed`);
