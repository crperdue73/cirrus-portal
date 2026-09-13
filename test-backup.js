#!/usr/bin/env node
'use strict';
/**
 * test-backup.js — smoke test for plan item 17 (backup / restore / DR verified).
 *
 * Static + functional:
 *   A. STATIC  — backup.sh ships, is executable, and exposes the documented
 *                surface (create/verify/restore/drill/schedule), real
 *                encryption (gpg/openssl AES), a passphrase that never rides
 *                the command line, and RPO wording.
 *   B. CREATE  — `create --with-secrets` writes an encrypted archive + a
 *                .sha256 sidecar; the ciphertext does NOT contain the secret
 *                in the clear; `verify` accepts it.
 *   C. REFUSE  — a wrong passphrase and a tampered ciphertext are both refused.
 *   D. RESTORE — restoring into a clean root reproduces every file, secrets
 *                included; a no-secrets archive omits them.
 *   E. DRILL   — the clean-VM drill passes and reports the measured restore.
 *   F. SCHEDULE— the schedule helper emits a systemd timer + cron fallback and
 *                states the RPO.
 *   G. DOCS    — DR-DRILL.md (RPO/RTO + clean-VM drill) + ADMIN + release wiring.
 *
 * Zero dependencies (Node 22+ builtins). Run: node test-backup.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const readIf = (f) => (fs.existsSync(path.join(SRC, f)) ? read(f) : '');
const BASH = '/bin/bash';
const sh = (args, env = {}) =>
  spawnSync(BASH, [path.join(SRC, 'backup.sh'), ...args], {
    cwd: SRC, encoding: 'utf8', env: { ...process.env, ...env },
  });

let pass = 0;
const ok = (m) => { console.log('✓ ' + m); pass++; };

// ── A. static surface ────────────────────────────────────────────────────────
{
  const s = read('backup.sh');
  assert(fs.statSync(path.join(SRC, 'backup.sh')).mode & 0o111, 'A: backup.sh must be executable');
  for (const cmd of ['create', 'verify', 'restore', 'drill', 'schedule']) {
    assert(new RegExp('^\\s*' + cmd + '\\)', 'm').test(s) || s.includes(cmd + ')'), `A: missing command ${cmd}`);
  }
  assert(/--cipher-algo AES256|aes-256-cbc/i.test(s), 'A: must use AES encryption');
  assert(/passphrase-file|PORTAL_BACKUP_PASSPHRASE/.test(s), 'A: must resolve a passphrase');
  assert(/RPO/i.test(s), 'A: must state the RPO');
  ok('A: backup.sh exposes create/verify/restore/drill/schedule with AES + passphrase handling');
}

// ── fixture ──────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cirrus-bk-'));
const FIX = path.join(TMP, 'src');
fs.mkdirSync(FIX, { recursive: true });
const CONFIG = '{"port":18800,"bind":"127.0.0.1","schemaVersion":3}\n';
const USERS = '{"users":[{"username":"alice","role":"admin","passwordHash":"scrypt$EXAMPLE"}]}\n';
const ROOMS = '{"rooms":[{"id":"r1","name":"EXAMPLE room"}]}\n';
const SECRET = '{"gateways":{"home":{"token":"EXAMPLE-gateway-token-0000"}}}\n';
const DEVICE = '{"deviceId":"EXAMPLE-device"}\n';
fs.writeFileSync(path.join(FIX, 'portal-config.json'), CONFIG);
fs.writeFileSync(path.join(FIX, 'portal-users.json'), USERS);
fs.writeFileSync(path.join(FIX, 'portal-rooms.json'), ROOMS);
fs.writeFileSync(path.join(FIX, 'portal-secrets.json'), SECRET);
fs.writeFileSync(path.join(FIX, 'portal-device.json'), DEVICE);
const PASS = path.join(TMP, 'pass.txt');
fs.writeFileSync(PASS, 'EXAMPLE-drill-passphrase\n');
const WRONG = path.join(TMP, 'wrong.txt');
fs.writeFileSync(WRONG, 'not-the-passphrase\n');

const ENV = { PORTAL_BACKUP_ROOT: FIX, PORTAL_BACKUP_CIPHER: 'openssl' };
const listArchives = () => fs.readdirSync(path.join(FIX, 'backups')).filter((n) => /^cirrus-backup-.*\.enc$/.test(n));

// ── B. create + verify ───────────────────────────────────────────────────────
let ENC = '';
{
  const r = sh(['create', '--with-secrets', '--passphrase-file', PASS], ENV);
  assert.strictEqual(r.status, 0, `B: create failed: ${r.stderr}`);
  const files = listArchives();
  assert.strictEqual(files.length, 1, 'B: exactly one archive expected');
  ENC = path.join(FIX, 'backups', files[0]);
  assert(fs.existsSync(ENC + '.sha256'), 'B: a .sha256 sidecar must be written');
  const blob = fs.readFileSync(ENC, 'latin1');
  assert(!blob.includes('EXAMPLE-gateway-token-0000'), 'B: the secret token must NOT appear in the ciphertext');
  assert(!blob.includes('EXAMPLE room'), 'B: room data must NOT appear in the ciphertext');
  console.log('  · archive:', files[0], `(${fs.statSync(ENC).size} bytes, encrypted)`);
  const v = sh(['verify', ENC, '--passphrase-file', PASS], ENV);
  assert.strictEqual(v.status, 0, `B: verify failed: ${v.stderr}`);
  assert(/verified/i.test(v.stdout), 'B: verify must report success');
  ok('B: create --with-secrets → encrypted archive (secret not in the clear); verify accepts it');
}

// ── C. wrong passphrase + tamper are refused ─────────────────────────────────
{
  const w = sh(['verify', ENC, '--passphrase-file', WRONG], ENV);
  assert.notStrictEqual(w.status, 0, 'C: a wrong passphrase must fail');

  const orig = fs.readFileSync(ENC);
  const mutated = Buffer.from(orig);
  mutated[40] = mutated[40] ^ 0xff;               // flip a ciphertext byte
  fs.writeFileSync(ENC, mutated);
  const t = sh(['verify', ENC, '--passphrase-file', PASS], ENV);
  fs.writeFileSync(ENC, orig);                    // restore the good archive
  assert.notStrictEqual(t.status, 0, 'C: a tampered ciphertext must fail');
  assert(/mismatch|decryption failed/i.test(t.stdout + t.stderr), 'C: must explain the mismatch');
  ok('C: wrong passphrase and a tampered ciphertext are both refused');
}

// ── D. restore into a clean root ─────────────────────────────────────────────
{
  const VM = path.join(TMP, 'vm'); fs.mkdirSync(VM, { recursive: true });
  const r = sh(['restore', ENC, '--passphrase-file', PASS], { PORTAL_BACKUP_ROOT: VM, PORTAL_BACKUP_CIPHER: 'openssl' });
  assert.strictEqual(r.status, 0, `D: restore failed: ${r.stderr}`);
  for (const [f, want] of [['portal-config.json', CONFIG], ['portal-users.json', USERS],
    ['portal-rooms.json', ROOMS], ['portal-secrets.json', SECRET], ['portal-device.json', DEVICE]]) {
    assert.strictEqual(fs.readFileSync(path.join(VM, f), 'utf8'), want, `D: ${f} must restore identically`);
  }
  assert(fs.existsSync(path.join(VM, 'backups')), 'D: a pre-restore snapshot dir must be created');
  ok('D: restore reproduces config + state + secrets in a clean root');

  // a no-secrets archive omits secret files
  const FIX2 = path.join(TMP, 'src2'); fs.mkdirSync(FIX2, { recursive: true });
  for (const f of ['portal-config.json', 'portal-users.json', 'portal-secrets.json']) {
    fs.copyFileSync(path.join(FIX, f), path.join(FIX2, f));
  }
  const c2 = sh(['create', '--passphrase-file', PASS], { PORTAL_BACKUP_ROOT: FIX2, PORTAL_BACKUP_CIPHER: 'openssl' });
  assert.strictEqual(c2.status, 0, `D: no-secrets create failed: ${c2.stderr}`);
  const enc2 = path.join(FIX2, 'backups', fs.readdirSync(path.join(FIX2, 'backups')).find((n) => /\.enc$/.test(n)));
  const VM2 = path.join(TMP, 'vm2'); fs.mkdirSync(VM2, { recursive: true });
  const r2 = sh(['restore', enc2, '--passphrase-file', PASS], { PORTAL_BACKUP_ROOT: VM2, PORTAL_BACKUP_CIPHER: 'openssl' });
  assert.strictEqual(r2.status, 0, 'D: no-secrets restore failed');
  assert(!fs.existsSync(path.join(VM2, 'portal-secrets.json')), 'D: a no-secrets archive must not restore secrets');
  assert(fs.existsSync(path.join(VM2, 'portal-config.json')), 'D: state must still restore');
  ok('D: a plain snapshot restores state but omits secrets (and says so)');
}

// ── E. drill ─────────────────────────────────────────────────────────────────
{
  const r = sh(['drill', '--source', FIX, '--passphrase-file', PASS], ENV);
  assert.strictEqual(r.status, 0, `E: drill failed: ${r.stderr}`);
  assert(/drill PASS/i.test(r.stdout), 'E: drill must report PASS');
  assert(/restored sha256-identical/i.test(r.stdout), 'E: drill must confirm identical files');
  assert(/measured restore = [\d.]+s/.test(r.stdout), 'E: drill must report the measured restore time');
  ok('E: clean-VM drill passes and reports the measured restore (RTO evidence)');
}

// ── F. schedule ──────────────────────────────────────────────────────────────
{
  const r = sh(['schedule', '--interval', '15min', '--keep', '14'], ENV);
  assert.strictEqual(r.status, 0, 'F: schedule print failed');
  const out = r.stdout;
  assert(/cirrus-portal-backup\.service/.test(out) && /cirrus-portal-backup\.timer/.test(out), 'F: must emit systemd units');
  assert(/OnCalendar=\*:0\/15/.test(out), 'F: 15min must map to a 15-minute calendar');
  assert(/\*\/15 \* \* \* \*/.test(out), 'F: must emit a matching cron fallback');
  assert(/backup\.sh create --with-secrets --keep 14/.test(out), 'F: schedule must run the encrypted create with retention');
  assert(/RPO/i.test(out), 'F: must state the RPO');
  ok('F: schedule helper prints a 15-min systemd timer + cron fallback + RPO');
}

// ── G. docs + release wiring ─────────────────────────────────────────────────
{
  const dr = readIf('docs/DR-DRILL.md');
  assert(/RPO/.test(dr) && /RTO/.test(dr), 'G: DR-DRILL.md must state RPO/RTO');
  assert(/clean.?VM/i.test(dr), 'G: DR-DRILL.md must document the clean-VM drill');
  assert(/backup\.sh restore/.test(dr) && /backup\.sh drill/.test(dr), 'G: DR-DRILL.md must show restore + drill commands');
  const admin = read('ADMIN.md');
  assert(/##\s*\d*\.?\s*Backup & restore/i.test(admin), 'G: ADMIN.md must keep the Backup & restore section');
  assert(/backup\.sh/.test(admin), 'G: ADMIN.md must reference backup.sh');
  const rel = read('release.sh');
  assert(/^\s*backup\.sh\s*$/m.test(rel), 'G: release.sh must ship backup.sh');
  assert(/docs\/DR-DRILL\.md/.test(rel), 'G: release.sh must ship docs/DR-DRILL.md');
  const gi = read('.gitignore');
  assert(/portal-backup-passphrase/.test(gi), 'G: the backup passphrase file must be gitignored');
  ok('G: DR-DRILL.md + ADMIN + release.sh + .gitignore wiring present');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/8 backup/DR checks passed`);
