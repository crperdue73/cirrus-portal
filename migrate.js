#!/usr/bin/env node
/**
 * Cirrus Portal — 2.x → 3.x migrator (plan item 15)
 * (family: Cirrus; engine: Cirrus Core)
 *
 * Moves a live 2.x install onto the 3.x schema *safely*:
 *
 *   • config-schema migration — legacy plaintext tokens leave
 *     portal-config.json for the 0600 portal-secrets.json; new 3.x keys
 *     (publicBind / tlsMode / trustProxy / login limits / idle TTL) are added
 *     with sane defaults; the config is stamped `schemaVersion: 3`.
 *   • credential rotation — any account still using a KNOWN-DEFAULT password
 *     (admin/admin, perdue-portal-2026, *-demo, …) is rotated to a fresh,
 *     strong, unique password written to portal-credentials.txt (0600).
 *   • role model — legacy/alias roles (teacher, owner, ta, …) are mapped to
 *     the 3.x roles (student | instructor | admin) and every user record is
 *     normalized (lowercase username, `agents` array, `assignments`, …).
 *   • safe defaults — a 2.x box that bound a public interface in cleartext is
 *     moved back to loopback unless the operator explicitly re-opts in to TLS
 *     (--domain / --tls-cert) or cleartext (--allow-insecure-plaintext).
 *
 * Backup-first: before writing anything this copies config + secrets + all
 * state into backups/migrate-<stamp>/ (0700) so a run is fully reversible.
 *
 * Zero dependencies (Node 22+ builtins only).
 *
 * Usage:
 *   node migrate.js [--dir DIR] [--dry-run]
 *                   [--domain HOST] [--tls-cert PEM --tls-key PEM]
 *                   [--bind ADDR] [--allow-insecure-plaintext]
 *
 * Exit codes: 0 ok / nothing to do · 1 error · 2 nothing to do (already 3.x).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TARGET_SCHEMA = 3;

// ── args ────────────────────────────────────────────────────────────────────
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const DRY_RUN = process.argv.includes('--dry-run');
const DIR = path.resolve(argValue('--dir') || __dirname);
const OPT_DOMAIN = argValue('--domain');
const OPT_TLS_CERT = argValue('--tls-cert');
const OPT_TLS_KEY = argValue('--tls-key');
const OPT_BIND = argValue('--bind');
const ALLOW_INSECURE = process.argv.includes('--allow-insecure-plaintext');

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  const self = fs.readFileSync(__filename, 'utf8');
  console.log(self.split('\n').filter(l => /^ \*|^\/\*\*|^ \*\//.test(l)).map(l => l.replace(/^ ?\* ?/, '').replace(/^\/\*\*/, '')).join('\n'));
  process.exit(0);
}

const CONFIG_PATH = path.join(DIR, 'portal-config.json');
const SECRETS_PATH = path.join(DIR, 'portal-secrets.json');
const USERS_PATH = path.join(DIR, 'portal-users.json');
const DEVICE_PATH = path.join(DIR, 'portal-device.json');
const ROOMS_PATH = path.join(DIR, 'portal-rooms.json');
const CONTEXT_PATH = path.join(DIR, 'portal-context.json');
const AUDIT_PATH = path.join(DIR, 'portal-audit.log');
const CRED_PATH = path.join(DIR, 'portal-credentials.txt');
const BACKUP_ROOT = path.join(DIR, 'backups');

// ── mirrors of the runtime rules (kept in lockstep with portal-server.js;
//    test-migrate.js asserts the default-password list never drifts) ─────────
const KNOWN_DEFAULT_PASSWORDS = [
  'admin', 'password', 'changeme', 'change-me', 'letmein', 'portal',
  'cirrus', 'perdue-portal-2026', 'instructor-demo', 'student-demo',
];

// Legacy role aliases → canonical 3.x roles.
const ROLE_ALIASES = {
  admin: 'admin', owner: 'admin', superadmin: 'admin', 'super-admin': 'admin',
  administrator: 'admin', root: 'admin',
  instructor: 'instructor', teacher: 'instructor', ta: 'instructor',
  'teaching-assistant': 'instructor', grader: 'instructor', staff: 'instructor',
  student: 'student', pupil: 'student', learner: 'student', kid: 'student',
};
const CANONICAL_ROLES = ['student', 'instructor', 'admin'];

const LOOPBACK_RE = /^(127(\.\d+){3}|::1|localhost)$/i;
const WILDCARD_RE = /^(0\.0\.0\.0|::|::0|\[::\]|\*|0\.0\.0\.0\/0)$/i;
const isLoopback = b => LOOPBACK_RE.test(String(b || '').trim().replace(/^\[|\]$/g, ''));
const isWildcard = b => WILDCARD_RE.test(String(b || '').trim());

// ── helpers ─────────────────────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { r: '\x1b[0m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', red: '\x1b[31m' }
  : { r: '', b: '', g: '', y: '', c: '', red: '' };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e && e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; return null; }
}
function readJsonRaw(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function exists(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }
function peerExists(f) { try { fs.statSync(f); return true; } catch { return false; } }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function genStrongPassword(len = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len * 3);
  for (let i = 0; i < bytes.length && out.length < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
function usesKnownDefaultCred(u) {
  if (!u || !u.hash || !u.salt) return false;
  const want = Buffer.from(u.hash, 'hex');
  for (const pw of KNOWN_DEFAULT_PASSWORDS) {
    const h = Buffer.from(hashPassword(pw, u.salt), 'hex');
    if (h.length === want.length && crypto.timingSafeEqual(h, want)) return true;
  }
  return false;
}
function slugId(s) {
  return String(s || '').replace(/[^a-z0-9._-]/gi, '_').toLowerCase() || 'gw';
}
function writeFileSecure(file, data, mode) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true, recursive: true }); } catch { /* nothing staged */ }
    fs.writeFileSync(file, data, { mode });
    try { fs.chmodSync(file, mode); } catch { /* best effort */ }
  }
}

// ── migration plan ──────────────────────────────────────────────────────────
// Pure: reads the current files, returns the transformed objects + a human
// change list. No writes happen here.
function computeMigration() {
  const rawConfig = readJson(CONFIG_PATH);
  const rawSecrets = readJson(SECRETS_PATH) || {};
  const rawUsers = readJson(USERS_PATH) || { users: [] };

  const changes = [];
  const warnings = [];
  const rotated = [];

  // Detect the source schema (a 2.x config has no schemaVersion stamp).
  const fromSchema = Number(rawConfig && rawConfig.schemaVersion) || 2;

  // ── config ────────────────────────────────────────────────────────────────
  const cfg = Object.assign({}, rawConfig || {});
  const secrets = {
    gatewayTokens: Object.assign({}, rawSecrets.gatewayTokens || {}),
    portalPassword: typeof rawSecrets.portalPassword === 'string' ? rawSecrets.portalPassword : '',
  };

  // 1. gateway token(s) out of the config → secrets.
  let gateways = Array.isArray(cfg.gateways) ? cfg.gateways : [];
  if (!gateways.length && (cfg.gatewayUrl || rawConfig && rawConfig.gatewayUrl)) {
    const legacyUrl = cfg.gatewayUrl || rawConfig.gatewayUrl;
    const legacyTok = cfg.gatewayToken || '';
    gateways = [{ id: 'gw1', name: 'Gateway', url: legacyUrl, enabled: true, token: legacyTok }];
    changes.push('config: synthesized a "gateways" entry from legacy gatewayUrl/gatewayToken');
  }
  const normGateways = [];
  for (const g of gateways) {
    if (!g || typeof g !== 'object' || !g.url) continue;
    const id = slugId(g.id || g.url);
    const legacyTok = typeof g.token === 'string' ? g.token.trim() : '';
    if (legacyTok && !secrets.gatewayTokens[id]) {
      secrets.gatewayTokens[id] = legacyTok;
      changes.push(`secrets: moved gateway "${id}" token out of portal-config.json → portal-secrets.json (0600)`);
    }
    const ng = { id, name: String(g.name || id), url: g.url, enabled: g.enabled !== false };
    if (typeof g.origin === 'string' && g.origin) ng.origin = g.origin;
    normGateways.push(ng);
  }
  cfg.gateways = normGateways;
  delete cfg.gatewayToken;
  delete cfg.gatewayUrl;
  delete cfg.portalPassword;
  if (rawConfig && 'portalPassword' in rawConfig) changes.push('config: removed legacy portalPassword (moved to portal-secrets.json)');

  // 2. legacy bootstrap password out of the config → secrets.
  const legacyPw = rawConfig && typeof rawConfig.portalPassword === 'string' ? rawConfig.portalPassword.trim() : '';
  if (legacyPw && !secrets.portalPassword) secrets.portalPassword = legacyPw;

  // 3. network / TLS reconciliation (fail closed).
  let bind = OPT_BIND || cfg.bind || '127.0.0.1';
  let tlsMode = cfg.tlsMode || 'off';
  let trustProxy = cfg.trustProxy === true;
  let insecure = cfg.insecurePlaintext === true || ALLOW_INSECURE;
  let publicBind = isLoopback(bind) ? false : true;

  if (OPT_DOMAIN) {
    bind = '127.0.0.1';
    tlsMode = 'auto';
    trustProxy = true;
    publicBind = false;
    changes.push(`config: --domain ${OPT_DOMAIN} → bind 127.0.0.1, tlsMode auto, trustProxy true (Caddy terminates TLS)`);
  } else if (OPT_TLS_CERT && OPT_TLS_KEY) {
    tlsMode = 'manual';
    cfg.tlsCert = OPT_TLS_CERT;
    cfg.tlsKey = OPT_TLS_KEY;
    publicBind = !isLoopback(bind);
    changes.push(`config: --tls-cert/--tls-key → tlsMode manual (portal terminates TLS directly)`);
  }

  const hasTls = !!(cfg.tlsCert && cfg.tlsKey) || trustProxy || tlsMode === 'auto' || tlsMode === 'manual';
  if (!isLoopback(bind) && !hasTls && !insecure) {
    // A 2.x box could serve cleartext on a public interface; 3.x refuses.
    // Fail closed: preserve the box (it will boot) by moving to loopback.
    warnings.push(`was bound to a PUBLIC interface (${bind}) in CLEARTEXT — 3.x refuses that by default.`);
    warnings.push('moved you to loopback (127.0.0.1) so the box boots. To expose it again, choose ONE:');
    warnings.push(`  • recommended:   node migrate.js --domain portal.example.com   (re-run the installer with --domain)`);
    warnings.push(`  • bring certs:   node migrate.js --tls-cert /path/fullchain.pem --tls-key /path/privkey.pem`);
    warnings.push(`  • cleartext LAN: node migrate.js --allow-insecure-plaintext   (NEVER for the public internet)`);
    bind = '127.0.0.1';
    publicBind = false;
    insecure = false;
  } else if (!isLoopback(bind) && insecure) {
    warnings.push(`keeping a CLEARTEXT public bind (${bind}) because --allow-insecure-plaintext was given — traffic is readable on the wire.`);
  } else if (!isLoopback(bind)) {
    warnings.push(`public bind ${bind} kept with TLS (${tlsMode === 'off' ? 'cert' : tlsMode})${isWildcard(bind) ? ' — listens on ALL interfaces' : ''}.`);
  }

  cfg.bind = bind;
  cfg.publicBind = publicBind;
  cfg.tlsMode = tlsMode;
  cfg.trustProxy = trustProxy;
  if (insecure) cfg.insecurePlaintext = true; else delete cfg.insecurePlaintext;

  // 4. new 3.x keys with 2.x-preserving defaults.
  const setDefault = (key, val) => {
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === '') {
      cfg[key] = val;
      changes.push(`config: added ${key} = ${JSON.stringify(val)} (3.x default)`);
    }
  };
  if (!Number.isInteger(cfg.port)) cfg.port = 18800;
  setDefault('sessionTtlHours', 12);
  setDefault('sessionIdleMinutes', 0);
  setDefault('loginMaxAttempts', 5);
  setDefault('loginWindowSeconds', 900);
  setDefault('loginLockoutSeconds', 300);
  if (fromSchema < TARGET_SCHEMA) {
    cfg.schemaVersion = TARGET_SCHEMA;
    changes.push(`config: stamped schemaVersion ${TARGET_SCHEMA}`);
  }

  // ── users: role model + credential rotation ────────────────────────────────
  const users = Array.isArray(rawUsers.users) ? rawUsers.users.slice() : [];
  const normUsers = [];
  for (const u0 of users) {
    if (!u0 || typeof u0 !== 'object') continue;
    const u = Object.assign({}, u0);
    const uname = String(u.username || '').trim().toLowerCase();
    if (uname !== u.username) changes.push(`users: normalized username "${u0.username}" → "${uname}"`);
    u.username = uname;

    const rawRole = String(u.role || '').trim().toLowerCase();
    let role = ROLE_ALIASES[rawRole];
    if (!role) {
      role = 'student';
      warnings.push(`user "${uname}" had unrecognized role "${rawRole}" — defaulted to least privilege (student).`);
    } else if (role !== rawRole) {
      changes.push(`users: mapped legacy role "${rawRole}" → "${role}" for "${uname}"`);
    }
    u.role = role;

    if (!Array.isArray(u.agents)) {
      u.agents = role === 'admin' ? ['*'] : [];
      changes.push(`users: set "agents" for "${uname}" → ${JSON.stringify(u.agents)}`);
    }
    if (!Array.isArray(u.assignments)) u.assignments = [];
    if (!u.displayName) u.displayName = uname;
    if (!Number.isFinite(u.createdAt)) u.createdAt = Date.now();
    if ('password' in u) { delete u.password; changes.push(`users: dropped plaintext "password" field for "${uname}"`); }

    // Rotate any account still on a known-default password.
    if (usesKnownDefaultCred(u)) {
      const pw = genStrongPassword();
      const salt = crypto.randomBytes(16).toString('hex');
      u.salt = salt;
      u.hash = hashPassword(pw, salt);
      rotated.push({ username: uname, role, password: pw });
      changes.push(`users: ROTATED known-default password for "${uname}" (${role}) — new password saved to portal-credentials.txt`);
    }
    normUsers.push(u);
  }
  if (!normUsers.some(u => u.role === 'admin')) {
    warnings.push('no admin account found — the 3.x portal will serve the first-run setup wizard on next boot.');
  }

  // Rotate the legacy bootstrap password secret if it is a known default too.
  if (secrets.portalPassword && KNOWN_DEFAULT_PASSWORDS.some(p => p === secrets.portalPassword.toLowerCase())) {
    const adminRot = rotated.find(r => r.role === 'admin');
    secrets.portalPassword = adminRot ? adminRot.password : genStrongPassword();
    changes.push('secrets: rotated the known-default bootstrap portalPassword');
  }

  const noop = fromSchema >= TARGET_SCHEMA && changes.length === 0 && warnings.length === 0 && rotated.length === 0;
  return {
    dir: DIR, fromSchema, toSchema: TARGET_SCHEMA,
    config: cfg, secrets, users: { users: normUsers },
    rotated, changes, warnings, noop,
  };
}

// ── backup ──────────────────────────────────────────────────────────────────
function backupFirst() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const dir = path.join(BACKUP_ROOT, 'migrate-' + stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const files = [CONFIG_PATH, SECRETS_PATH, USERS_PATH, DEVICE_PATH, ROOMS_PATH, CONTEXT_PATH, AUDIT_PATH];
  let n = 0;
  for (const f of files) {
    if (!exists(f)) continue;
    fs.copyFileSync(f, path.join(dir, path.basename(f)));
    try { fs.chmodSync(path.join(dir, path.basename(f)), 0o600); } catch { /* best effort */ }
    n++;
  }
  if (!n) { try { fs.rmdirSync(dir); } catch { /* keep empty */ } return null; }
  return dir;
}

// ── output ──────────────────────────────────────────────────────────────────
function printPlan(m) {
  console.log(`${C.b}Cirrus Portal — 2.x → 3.x migration${C.r}`);
  console.log(`  dir:  ${m.dir}`);
  console.log(`  from: schema ${m.fromSchema}  →  target: schema ${m.toSchema}`);
  console.log(`  mode: ${DRY_RUN ? C.c + 'DRY-RUN (no changes written)' : C.y + 'LIVE'}${C.r}`);
  console.log('');
  if (m.noop) { console.log(`${C.g}✓ already on schema ${m.toSchema} — nothing to migrate.${C.r}`); return; }
  console.log(`${C.b}Planned changes (${m.changes.length}):${C.r}`);
  for (const c of m.changes) console.log('  • ' + c);
  if (m.rotated.length) {
    console.log('');
    console.log(`${C.y}Credential rotation (${m.rotated.length} account(s)):${C.r}`);
    for (const r of m.rotated) console.log(`  • ${r.username} (${r.role})`);
    if (!DRY_RUN) console.log(`  → new passwords written to ${path.basename(CRED_PATH)} (0600)`);
  }
  if (m.warnings.length) {
    console.log('');
    console.log(`${C.y}Warnings:${C.r}`);
    for (const w of m.warnings) console.log('  ⚠ ' + w);
  }
}

function main() {
  let plan;
  try { plan = computeMigration(); }
  catch (e) { console.error(`${C.red}[migrate] failed to read state: ${e.message}${C.r}`); process.exit(1); }

  printPlan(plan);
  if (DRY_RUN || plan.noop) process.exit(plan.noop && !DRY_RUN ? 2 : 0);

  // Backup-first: full reversible snapshot before any write.
  let backup = null;
  try { backup = backupFirst(); }
  catch (e) { console.error(`${C.red}[migrate] could not create the pre-migration snapshot: ${e.message}${C.r}`); process.exit(1); }
  if (backup) console.log(`\n${C.g}✓${C.r} pre-migration snapshot: ${path.relative(process.cwd(), backup) || backup} (0700 — includes secrets; delete after verifying)`);

  try {
    writeFileSecure(CONFIG_PATH, JSON.stringify(plan.config, null, 2) + '\n', 0o600);
    writeFileSecure(SECRETS_PATH, JSON.stringify(plan.secrets, null, 2) + '\n', 0o600);
    writeFileSecure(USERS_PATH, JSON.stringify(plan.users, null, 2) + '\n', 0o600);
  } catch (e) {
    console.error(`${C.red}[migrate] write failed: ${e.message}${C.r}`);
    console.error(`[migrate] restore from the snapshot above and re-run.`);
    process.exit(1);
  }

  if (plan.rotated.length) {
    const lines = [
      `# ${'Cirrus Portal'} — passwords rotated during the 2.x → 3.x migration`,
      `# Generated ${new Date().toISOString()}. Sign in, change these, then delete this file.`,
      '',
    ];
    for (const r of plan.rotated) lines.push(`${r.role.padEnd(10)} ${r.username.padEnd(16)} ${r.password}`);
    lines.push('');
    writeFileSecure(CRED_PATH, lines.join('\n'), 0o600);
  }

  console.log(`${C.g}✓ migration complete.${C.r}`);
  console.log('  next: ./install.sh upgrade   (rebuild the container on the new schema)');
  console.log('  then: ./install.sh status && ./install.sh doctor');
  process.exit(0);
}

main();
