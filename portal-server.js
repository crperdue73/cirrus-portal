#!/usr/bin/env node
/**
 * Cirrus Portal — browser console for OpenClaw agent fleets.
 * (family: Cirrus; engine: Cirrus Core)
 *
 * Serves a single-page chat UI and bridges it to the gateway WebSocket
 * (loopback, device-signed operator connection). Lets you talk to any
 * agent's main session (agent:<agentId>:main) straight from a browser —
 * no Telegram, no channel plugins.
 *
 * Phase I (Aug 3 2026): local accounts + roles (student/instructor/admin),
 * permission-aware UI, server-enforced agent access, audit log.
 *
 * Zero dependencies: Node 22+ built-in WebSocket + http.
 *
 * Run:  node portal-server.js
 *       (or via Docker: docker compose up -d --build)
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────
const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'portal-config.json');
const SECRETS_PATH = path.join(DIR, 'portal-secrets.json');
const DEVICE_PATH = path.join(DIR, 'portal-device.json');
const USERS_PATH = path.join(DIR, 'portal-users.json');
const AUDIT_PATH = path.join(DIR, 'portal-audit.log');
const ROOMS_PATH = path.join(DIR, 'portal-rooms.json');
const CONTEXT_PATH = path.join(DIR, 'portal-context.json');
const BRANDING_PATH = path.join(DIR, 'branding.json');

// Single source of truth for product identity (see NAMING.md / branding.json).
const BRAND = (() => {
  const fallback = {
    product: 'Cirrus Portal', shortName: 'Cirrus', family: 'Cirrus',
    engine: 'Cirrus Core', slug: 'cirrus-portal',
    tagline: 'Mission control for your OpenClaw fleet.', vendor: 'Cirrus',
  };
  try {
    return Object.assign(fallback, JSON.parse(fs.readFileSync(BRANDING_PATH, 'utf8')));
  } catch {
    return fallback;
  }
})();

const DEFAULTS = {
  port: 18800,
  // Safe default (plan item 7): loopback only. A bare `node portal-server.js`
  // is never reachable off-host; exposing it needs an explicit opt-in (see
  // assertNetworkPolicy / `PORTAL_PUBLIC_BIND=1` / `--public-bind`).
  bind: '127.0.0.1',
  publicBind: false,       // explicit opt-in to bind a non-loopback interface
  gatewayUrl: 'ws://127.0.0.1:18790',
  gatewayToken: '',
  portalPassword: '',
  sessionTtlHours: 12,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  // TLS / reverse-proxy (plan item 5). `tlsMode` records operator intent:
  //   'off'    — plaintext only (loopback, or an explicitly-insecure public bind)
  //   'auto'   — TLS terminated by a reverse proxy (Caddy handles the certs)
  //   'manual' — TLS terminated by an operator-managed proxy, or served
  //              directly here when tlsCert + tlsKey are configured
  tlsMode: 'off',
  tlsCert: '',             // PEM cert path — with tlsKey the portal serves HTTPS
  tlsKey: '',              // PEM private-key path
  trustProxy: false,       // trust X-Forwarded-Proto from a TLS-terminating proxy
  insecurePlaintext: false,// explicit opt-out of the public-bind TLS gate
  // Auth hardening (plan item 6)
  loginMaxAttempts: 5,      // failed logins (per IP+username) before lockout
  loginWindowSeconds: 900,  // rolling window those failures are counted in
  loginLockoutSeconds: 300, // base lockout; doubles on repeat lockouts (≤1h)
  sessionIdleMinutes: 0,    // 0 = no idle timeout (absolute TTL only)
};

// ── Credential safety ────────────────────────────────────────────────────────
// Passwords that must NEVER grant access. Historically every deployment
// shipped the SAME admin/admin login plus a shared `portalPassword`; that
// convention is gone (see plan item 2). Fresh installs now mint a UNIQUE
// admin password (or read one from PORTAL_ADMIN_PASSWORD / portal-config.json),
// and the server refuses to start if an admin account still matches a known
// default (see assertNoDefaultCreds).
const KNOWN_DEFAULT_PASSWORDS = [
  'admin', 'password', 'changeme', 'change-me', 'letmein', 'portal',
  'cirrus', 'perdue-portal-2026', 'instructor-demo', 'student-demo',
];

// Broader blocklist of the most-abused passwords (plan item 6). Distinct from
// KNOWN_DEFAULT_PASSWORDS (the boot guard for *shipped* defaults): this one is
// enforced wherever an operator/user chooses a password.
const PASSWORD_BLOCKLIST = new Set([
  '123456', '12345678', '123456789', '1234567890', '12345', '111111', '000000',
  'qwerty', 'qwerty123', 'qwertyuiop', '1q2w3e4r', 'qazwsx', 'zxcvbnm', 'asdfghjkl',
  'abc123', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'admin123', 'root',
  'toor', 'welcome', 'welcome1', 'monkey', 'dragon', 'master', 'iloveyou', 'sunshine',
  'princess', 'football', 'baseball', 'superman', 'batman', 'trustno1', 'letmein1',
  '987654321', 'aaaaaaaa', '123123', '654321', 'secret', 'login', 'access', 'guest',
  'default', 'cirrus', 'cirrusportal', 'portal',
]);

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

// True if this account's stored hash matches any known-default password.
function usesKnownDefaultCred(u) {
  if (!u || !u.hash || !u.salt) return false;
  const want = Buffer.from(u.hash, 'hex');
  for (const pw of KNOWN_DEFAULT_PASSWORDS) {
    const h = Buffer.from(hashPassword(pw, u.salt), 'hex');
    if (h.length === want.length && crypto.timingSafeEqual(h, want)) return true;
  }
  return false;
}

// Cryptographically-strong, human-transcribable password (no look-alike chars).
function genStrongPassword(len = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len * 3);
  for (let i = 0; i < bytes.length && out.length < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// First-run admin bootstrap secret: explicit env wins, then portal-config.json,
// else generate a unique one.
function resolveBootstrapPassword() {
  const provided = process.env.PORTAL_ADMIN_PASSWORD || process.env.PORTAL_PASSWORD
    || (SECRETS && SECRETS.portalPassword) || CONFIG.portalPassword;
  if (provided && String(provided).trim()) return { password: String(provided).trim(), generated: false };
  return { password: genStrongPassword(), generated: true };
}

// Drop a generated first-run password in a 0600 file the installer/operator
// can read (and then delete).
function writeFirstRunCredentials(password) {
  try {
    const p = path.join(DIR, 'portal-first-run.txt');
    fs.writeFileSync(p,
      `# ${BRAND.product} — generated first-run admin password\n` +
      `# Keep this safe, then delete this file.\n` +
      `url:      http://<this-host>:${CONFIG.port}/\n` +
      `user:     admin\n` +
      `password: ${password}\n`, { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
    return p;
  } catch (e) {
    console.error('[portal] could not write first-run credentials:', e.message);
    return null;
  }
}

// ── Password policy (plan item 4 groundwork) ────────────────────────────────
// The first-run wizard must not accept a weak admin password. Item 6 grows
// this into a full blocklist; this is the minimum that makes the wizard safe.
const PASSWORD_MIN_LEN = 12;

function passwordPolicyError(pw, username) {
  const s = String(pw || '');
  if (s.length < PASSWORD_MIN_LEN) return `password must be at least ${PASSWORD_MIN_LEN} characters`;
  if (s.length > 200) return 'password is too long';
  if (username && s.toLowerCase().includes(String(username).toLowerCase())) return 'password must not contain the username';
  if (KNOWN_DEFAULT_PASSWORDS.some(d => s.toLowerCase() === String(d).toLowerCase())) return 'password is a known-default/weak password — choose something unique';
  if (PASSWORD_BLOCKLIST.has(s.toLowerCase())) return 'password is in the common-password blocklist — choose something unique';
  if (!/[a-z]/.test(s)) return 'password must include a lowercase letter';
  if (!/[A-Z]/.test(s)) return 'password must include an uppercase letter';
  if (!/[0-9]/.test(s)) return 'password must include a number';
  return null;
}

// True when an operator/installer explicitly supplied the bootstrap admin
// password (env or config). Headless installs use this so they never need a
// browser wizard; a bare `node portal-server.js` does not.
function hasExplicitBootstrapPassword() {
  const p = process.env.PORTAL_ADMIN_PASSWORD || process.env.PORTAL_PASSWORD
    || (SECRETS && SECRETS.portalPassword) || (CONFIG && CONFIG.portalPassword);
  return !!(p && String(p).trim());
}

// Startup guard: never serve with a known-default credential.
function assertNoDefaultCreds() {
  const offenders = USERS.filter(u => u.role === 'admin' && usesKnownDefaultCred(u));
  if (!offenders.length) return;
  const names = offenders.map(u => u.username).join(', ');
  if (process.env.PORTAL_ALLOW_INSECURE_DEFAULTS === '1') {
    console.warn(`[portal] ⚠ PORTAL_ALLOW_INSECURE_DEFAULTS=1 — admin account(s) ${names} use a KNOWN DEFAULT password. Never expose this publicly.`);
    return;
  }
  console.error(`[portal] FATAL: refusing to start — admin account(s) still use a known default password: ${names}`);
  console.error('[portal] Fix it: set a strong password (Users → reset pw, or PORTAL_ADMIN_PASSWORD=...), or delete the account and let the portal mint a fresh one.');
  console.error('[portal] Dev-only escape hatch: PORTAL_ALLOW_INSECURE_DEFAULTS=1');
  process.exit(1);
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    Object.assign(cfg, user);
  } catch (e) {
    console.warn('[portal] no portal-config.json, using defaults');
  }
  // Environment overrides (Docker-friendly); file still wins for anything not set.
  const envMap = {
    PORT: 'port',
    BIND: 'bind',
    GATEWAY_URL: 'gatewayUrl',
    GATEWAY_TOKEN: 'gatewayToken',
    PORTAL_PASSWORD: 'portalPassword',
    SESSION_TTL_HOURS: 'sessionTtlHours',
    RECONNECT_BASE_MS: 'reconnectBaseMs',
    RECONNECT_MAX_MS: 'reconnectMaxMs',
    PORTAL_TLS_MODE: 'tlsMode',
    PORTAL_TLS_CERT: 'tlsCert',
    PORTAL_TLS_KEY: 'tlsKey',
    PORTAL_LOGIN_MAX_ATTEMPTS: 'loginMaxAttempts',
    PORTAL_LOGIN_WINDOW_SECONDS: 'loginWindowSeconds',
    PORTAL_LOGIN_LOCKOUT_SECONDS: 'loginLockoutSeconds',
    PORTAL_SESSION_IDLE_MINUTES: 'sessionIdleMinutes',
  };
  for (const [envKey, cfgKey] of Object.entries(envMap)) {
    if (process.env[envKey] !== undefined) {
      let v = process.env[envKey];
      if (typeof cfg[cfgKey] === 'number') v = Number(v);
      cfg[cfgKey] = v;
    }
  }
  // Boolean flags (env presence overrides the file).
  if (process.env.PORTAL_TRUST_PROXY !== undefined) cfg.trustProxy = truthyEnv(process.env.PORTAL_TRUST_PROXY);
  if (process.env.PORTAL_INSECURE_PLAINTEXT !== undefined) cfg.insecurePlaintext = truthyEnv(process.env.PORTAL_INSECURE_PLAINTEXT);
  if (process.env.PORTAL_PUBLIC_BIND !== undefined) cfg.publicBind = truthyEnv(process.env.PORTAL_PUBLIC_BIND);
  return cfg;
}

function truthyEnv(v) { return typeof v === 'string' && /^(1|true|yes)$/i.test(v.trim()); }

const CONFIG = loadConfig();

// ── TLS + reverse-proxy policy (plan item 5) ─────────────────────────────────
// Public-readiness rule: the portal must never serve cleartext on a public
// interface. Loopback is always fine. A public bind must either terminate TLS
// itself (tlsCert + tlsKey), sit behind a TLS-terminating proxy
// (trustProxy, or tlsMode 'auto'/'manual'), or be explicitly declared
// insecure (`--insecure-plaintext` / PORTAL_INSECURE_PLAINTEXT=1).
const LOOPBACK_RE = /^(127(\.\d+){3}|::1|localhost)$/i;
function isLoopbackBind(b) {
  return LOOPBACK_RE.test(String(b || '').trim().replace(/^\[|\]$/g, ''));
}

// ── Safe network defaults (plan item 7) ──────────────────────────────────────
// The portal binds loopback unless the operator deliberately opts in to a
// non-loopback interface. A wildcard bind (0.0.0.0 / ::) listens on EVERY
// interface, so it must never be a silent default: it requires an explicit
// flag — `PORTAL_PUBLIC_BIND=1` or `--public-bind` (or `"publicBind": true`
// in portal-config.json). When opted in, we still shout about it at boot, and
// the TLS gate (assertTlsPolicy) independently refuses cleartext.
const WILDCARD_RE = /^(0\.0\.0\.0|::|::0|\[::\]|\*|0\.0\.0\.0\/0)$/i;
function isWildcardBind(b) {
  return WILDCARD_RE.test(String(b || '').trim());
}
// True when the operator explicitly asked to expose a non-loopback interface.
function publicBindRequested() {
  return CONFIG.publicBind === true
    || truthyEnv(process.env.PORTAL_PUBLIC_BIND)
    || process.argv.includes('--public-bind');
}
function assertNetworkPolicy() {
  const b = String(CONFIG.bind || '').trim();
  if (isLoopbackBind(b)) return;                  // loopback — always fine
  if (!publicBindRequested()) {
    console.error(`[portal] FATAL: refusing to bind non-loopback interface "${CONFIG.bind}" without an explicit opt-in.`);
    console.error('[portal] The portal defaults to 127.0.0.1 so a fresh install is never exposed by accident.');
    console.error('[portal] To expose it deliberately, choose one:');
    console.error('[portal]   • behind TLS (recommended):  ./install.sh install --domain portal.example.com   (Caddy; portal stays on loopback)');
    console.error('[portal]   • explicit public bind:       PORTAL_PUBLIC_BIND=1 (or --public-bind), plus TLS or --insecure-plaintext');
    console.error('[portal]   • keep it local:              bind 127.0.0.1   (the default)');
    console.error('[portal] A wildcard bind (0.0.0.0) would listen on EVERY interface — never do it by accident.');
    process.exit(1);
  }
  if (isWildcardBind(b)) {
    console.warn(`[portal] ⚠ PUBLIC BIND: ${CONFIG.bind} listens on ALL interfaces — every host that can reach this machine can reach the portal.`);
  } else {
    console.warn(`[portal] ⚠ PUBLIC BIND: ${CONFIG.bind} is a non-loopback interface.`);
  }
}
function readPem(p) { try { return p ? fs.readFileSync(p) : null; } catch { return null; } }

const TLS_CERT = readPem(CONFIG.tlsCert);
const TLS_KEY = readPem(CONFIG.tlsKey);
// The portal terminates TLS itself when a usable cert + key are configured.
const SERVING_TLS = !!(TLS_CERT && TLS_KEY);
// A reverse proxy terminates TLS in front of us (Caddy for tlsMode:'auto').
const TRUST_PROXY = CONFIG.trustProxy === true || truthyEnv(process.env.PORTAL_TRUST_PROXY)
  || CONFIG.tlsMode === 'auto' || (CONFIG.tlsMode === 'manual' && !SERVING_TLS);
// Secure context → `Secure` cookies + HSTS response headers.
const SECURE_CONTEXT = SERVING_TLS || TRUST_PROXY;

function assertTlsPolicy() {
  if (isLoopbackBind(CONFIG.bind)) return;   // local-only — fine
  if (SERVING_TLS) return;                   // we terminate TLS
  if (TRUST_PROXY) return;                   // a proxy terminates TLS
  if (CONFIG.insecurePlaintext === true || truthyEnv(process.env.PORTAL_INSECURE_PLAINTEXT)) {
    console.warn(`[portal] ⚠ INSECURE-PLAINTEXT — binding ${CONFIG.bind} WITHOUT TLS. Traffic is cleartext and can be read or modified on the wire.`);
    console.warn('[portal]   Acceptable on a trusted LAN or behind a tunnel — NEVER expose this to the public internet.');
    return;
  }
  if (process.env.PORTAL_ALLOW_INSECURE_DEFAULTS === '1') {
    console.warn(`[portal] ⚠ PORTAL_ALLOW_INSECURE_DEFAULTS=1 — allowing cleartext public bind ${CONFIG.bind} (dev only).`);
    return;
  }
  console.error(`[portal] FATAL: refusing to bind ${CONFIG.bind} without TLS.`);
  console.error('[portal] Choose one:');
  console.error('[portal]   • automatic HTTPS:       ./install.sh install --domain portal.example.com   (Caddy)');
  console.error('[portal]   • bring your own certs:  set tlsMode:"manual" + tlsCert + tlsKey');
  console.error('[portal]   • TLS-terminating proxy: set trustProxy:true (or tlsMode:"auto") behind nginx/Caddy');
  console.error('[portal]   • local only:            bind 127.0.0.1');
  console.error('[portal]   • explicit opt-out:      --insecure-plaintext / PORTAL_INSECURE_PLAINTEXT=1  (NOT for public hosts)');
  process.exit(1);
}

// ── Secrets at rest (plan item 3) ───────────────────────────────────────────
// Gateway tokens (and the optional first-run bootstrap password) live in a
// dedicated 0600 secrets file — NEVER in portal-config.json, API responses,
// logs, backups, or release tarballs. Token precedence per gateway:
//   1. env  PORTAL_GATEWAY_TOKEN_<ID>  (never persisted)
//   2. portal-secrets.json  { gatewayTokens: { <id>: "<token>" } }
//   3. legacy portal-config.json gateway.token  (migrated on boot, then stripped)
//   4. env  GATEWAY_TOKEN               (single-gateway / one-liner deploys)
function readSecrets() {
  const out = { gatewayTokens: {}, portalPassword: '' };
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    if (raw && typeof raw.gatewayTokens === 'object' && raw.gatewayTokens) {
      for (const [k, v] of Object.entries(raw.gatewayTokens)) {
        if (typeof v === 'string' && v) out.gatewayTokens[k] = v;
      }
    }
    if (typeof raw.portalPassword === 'string') out.portalPassword = raw.portalPassword;
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[portal] could not read portal-secrets.json:', e.message);
  }
  return out;
}

let SECRETS = readSecrets();

// Atomic write that also survives a read-only image rootfs (plan item 8): the
// temp sibling lives on the container rootfs, which is read-only, but the
// target is a bind-mounted file — so fall back to writing it in place.
function writeFileRobust(file, data, mode) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
    return;
  } catch (e) {
    // Read-only rootfs (EROFS), cross-device (EXDEV), perms, or any other
    // reason the staged temp/rename can't work — drop it and write the target.
    try { fs.rmSync(tmp, { force: true, recursive: true }); } catch { /* nothing staged */ }
  }
  fs.writeFileSync(file, data, { mode });
  try { fs.chmodSync(file, mode); } catch { /* best effort */ }
}

function writeSecrets() {
  try {
    writeFileRobust(SECRETS_PATH, JSON.stringify(SECRETS, null, 2), 0o600);
  } catch (e) {
    console.error('[portal] failed to write portal-secrets.json:', e.message);
  }
}

// env var name for a gateway id, e.g. "lab" -> PORTAL_GATEWAY_TOKEN_LAB
function gatewayTokenEnv(id) {
  return 'PORTAL_GATEWAY_TOKEN_' + String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function resolveGatewayToken(g, legacyToken) {
  const env = process.env[gatewayTokenEnv(g.id)];
  if (env && String(env).trim()) return { token: String(env).trim(), source: 'env:' + gatewayTokenEnv(g.id) };
  if (SECRETS.gatewayTokens[g.id]) return { token: SECRETS.gatewayTokens[g.id], source: 'secrets' };
  if (legacyToken && String(legacyToken).trim()) return { token: String(legacyToken).trim(), source: 'legacy-config' };
  const fallback = process.env.GATEWAY_TOKEN;
  if (fallback && String(fallback).trim()) return { token: String(fallback).trim(), source: 'env:GATEWAY_TOKEN' };
  return { token: '', source: 'none' };
}

function isEnvTokenSource(source) { return String(source || '').startsWith('env'); }

// Move any plaintext tokens found in the legacy config file into the secrets
// file, then rewrite portal-config.json without them. Returns the count.
function migrateLegacyTokens() {
  let migrated = 0;
  for (const g of CONFIG.gateways) {
    if (g.token && g.tokenSource === 'legacy-config' && !SECRETS.gatewayTokens[g.id]) {
      SECRETS.gatewayTokens[g.id] = g.token;
      g.tokenSource = 'secrets';
      migrated++;
    }
  }
  if (migrated) {
    writeSecrets();
    saveConfig(); // rewrites portal-config.json with tokens stripped
    console.warn(`[portal] migrated ${migrated} gateway token(s) out of portal-config.json into portal-secrets.json (0600)`);
  }
  return migrated;
}

// ── Gateway farm (multi-server, Aug 2026) ───────────────────────────────────
// One portal, N OpenClaw gateway servers. Config: "gateways":
//   [{ id, name, url, token, enabled }]
// Legacy single gatewayUrl/gatewayToken still works and is synthesized into
// one entry, so nothing breaks for existing single-server deployments.
function normalizeGateways(cfg) {
  const list = [];
  if (Array.isArray(cfg.gateways)) {
    for (const g of cfg.gateways) {
      if (!g || typeof g !== 'object' || !g.url) continue;
      const id = String(g.id || g.url).replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
      list.push({
        id: id || 'gw',
        name: String(g.name || id || 'Gateway'),
        url: g.url,
        _legacyToken: typeof g.token === 'string' ? g.token : '',
        origin: typeof g.origin === 'string' ? g.origin : '',
        enabled: g.enabled !== false,
      });
    }
  }
  if (!list.length) {
    list.push({ id: 'gw1', name: 'Gateway', url: cfg.gatewayUrl, _legacyToken: cfg.gatewayToken || '', enabled: true });
  }
  // Resolve each token from env → secrets → legacy config. The legacy field
  // is dropped from the in-memory gateway so it can never be re-persisted.
  for (const g of list) {
    const r = resolveGatewayToken(g, g._legacyToken);
    g.token = r.token;
    g.tokenSource = r.source;
    delete g._legacyToken;
  }
  // Keep disabled entries so the admin UI can re-enable them; the startup
  // loop only STARTS enabled ones.
  return list;
}
CONFIG.gateways = normalizeGateways(CONFIG);
migrateLegacyTokens();

// Persist the runtime config back to portal-config.json (gateway management
// writes here; the file is bind-mounted read-write in docker-compose). Writes
// a .bak first so a bad edit is never destructive. Tokens are NEVER written
// here — they go to portal-secrets.json (0600) instead (plan item 3).
function saveConfig() {
  try {
    let secretsDirty = false;
    // Keep the secrets store in sync with in-memory gateway tokens (new or
    // edited gateways), except env-provided tokens which stay ephemeral.
    for (const g of CONFIG.gateways) {
      if (g.token && g.tokenSource !== 'secrets' && !isEnvTokenSource(g.tokenSource)) {
        SECRETS.gatewayTokens[g.id] = g.token;
        g.tokenSource = 'secrets';
        secretsDirty = true;
      }
    }
    // Drop secrets for gateways that no longer exist.
    for (const id of Object.keys(SECRETS.gatewayTokens)) {
      if (!CONFIG.gateways.some(g => g.id === id)) { delete SECRETS.gatewayTokens[id]; secretsDirty = true; }
    }
    if (CONFIG.portalPassword && CONFIG.portalPassword !== SECRETS.portalPassword) {
      SECRETS.portalPassword = CONFIG.portalPassword;
      secretsDirty = true;
    }
    if (secretsDirty) writeSecrets();

    const out = {
      port: CONFIG.port,
      bind: CONFIG.bind,
      gateways: CONFIG.gateways.map(g => ({
        id: g.id,
        name: g.name,
        url: g.url,
        origin: typeof g.origin === 'string' && g.origin ? g.origin : undefined,
        enabled: g.enabled !== false,
        // NOTE: no `token` here by design — see portal-secrets.json.
      })),
      sessionTtlHours: CONFIG.sessionTtlHours,
      tlsMode: CONFIG.tlsMode || 'off',
      tlsCert: CONFIG.tlsCert || undefined,
      tlsKey: CONFIG.tlsKey || undefined,
      trustProxy: CONFIG.trustProxy === true ? true : undefined,
      insecurePlaintext: CONFIG.insecurePlaintext === true ? true : undefined,
    };
    if (fs.existsSync(CONFIG_PATH)) {
      try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak'); } catch (e) { /* noop */ }
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[portal] failed to save config:', e.message);
  }
}

// ── Device identity (persisted so reconnects reuse the same device) ────────
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function loadOrCreateDevice() {
  try {
    const d = JSON.parse(fs.readFileSync(DEVICE_PATH, 'utf8'));
    if (d && d.seed && d.pub && d.deviceId) return d;
  } catch (e) { /* first run */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = pkcs8.slice(pkcs8.length - 32);
  const device = {
    deviceId: crypto.createHash('sha256').update(pubRaw).digest('hex'),
    seed: b64u(seed),
    pub: b64u(pubRaw),
  };
  try { fs.writeFileSync(DEVICE_PATH, JSON.stringify(device, null, 2), { mode: 0o600 }); } catch (e) { /* noop */ }
  return device;
}

const DEVICE = loadOrCreateDevice();

function sign(payload) {
  const seed = Buffer.from(DEVICE.seed, 'base64url');
  // Rebuild a KeyObject from the raw 32-byte seed (PKCS8 wrap).
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(payload), key);
}

// ── Gateway WS client ───────────────────────────────────────────────────────
class GatewayClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id || 'gw';
    this.name = cfg.name || this.id;
    this.ws = null;
    this.connected = false;
    this.connId = null;
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.retryMs = cfg.reconnectBaseMs || 1000;
    this.subscribers = new Map(); // sessionKey -> Set<res>
    this.listeners = new Map();   // sessionKey -> Set<fn(payload)> (server-side watchers)
    this.globalListeners = new Set(); // fn(payload) — every chat event, regardless of sessionKey
    this.destroyed = false;
    this.hello = null;
    this.reconnectTimer = null;
    this.helloWatchdog = null;
  }

  start() {
    this.connect();
  }

  connect() {
    if (this.destroyed) return;
    // Never stack connections: if we already have a live or in-flight socket, leave it alone.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    let ws;
    try {
      // Origin must match the gateway's controlUi.allowedOrigins. Derive it
      // from the gateway URL by default; an explicit per-gateway `origin`
      // config wins (used to present the gateway's own loopback origin when
      // its allowedOrigins isn't configured for LAN clients).
      let origin = '';
      try {
        const u = new URL(this.cfg.gatewayUrl);
        origin = `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
      } catch { /* keep default */ }
      ws = new WebSocket(this.cfg.gatewayUrl, {
        headers: { Origin: this.cfg.origin || origin || 'http://127.0.0.1:18790' },
      });
    } catch (e) {
      console.error('[portal] ws construct failed', e.message);
      return this.scheduleReconnect();
    }
    this.ws = ws;

    // fail() is the single teardown path. Whichever event fires first
    // (error OR close — some handshake failures never emit close) tears
    // down and schedules the retry; the guard makes it idempotent.
    let settled = false;
    const teardown = () => {
      this.ws = null; // drop the dead socket so the guard in connect() can't block retries
      this.connected = false;
      this.connId = null;
      this.hello = null;
      if (this.helloWatchdog) { clearTimeout(this.helloWatchdog); this.helloWatchdog = null; }
    };
    const fail = (why) => {
      if (settled) return;
      settled = true;
      teardown();
      console.warn(`[portal] gateway connection failed (${why}) — reconnecting`);
      this.scheduleReconnect();
    };

    ws.onopen = () => {
      settled = true; // handshake done; from here onclose owns teardown
      console.log('[portal] gateway ws open');
      // Watchdog: if the gateway opens the socket but never sends the
      // connect.challenge / hello, don't sit on a dead connection forever.
      this.helloWatchdog = setTimeout(() => {
        if (!this.connected) {
          console.warn('[portal] hello watchdog fired — forcing reconnect');
          try { ws.close(1006); } catch { /* noop */ }
        }
      }, 15000);
    };
    ws.onerror = (e) => {
      console.warn('[portal] gateway ws error:', (e && e.message) || 'handshake rejected (non-101?)');
      fail('ws error');
    };
    ws.onunexpectedresponse = (resp) => {
      // Some gateways reject non-101 upgrades over HTTP before any WS event.
      console.warn(`[portal] gateway ws unexpected HTTP response: ${resp.statusCode} ${resp.statusMessage || ''}`);
      fail('http ' + (resp.statusCode || '?'));
    };
    ws.onclose = (e) => {
      console.warn(`[portal] gateway ws closed (${e.code}) — reconnecting`);
      if (settled) {
        // Post-handshake close (e.g. gateway restart → 1012). fail() is
        // settled-guarded so it would no-op here — tear down and schedule
        // the retry ourselves, or the portal stays dead until restart.
        teardown();
        this.scheduleReconnect();
      } else {
        fail('ws closed');
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        this.respondToChallenge(msg.payload);
        return;
      }

      if (msg.type === 'res') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.payload);
          else {
            // Scope upgrade not approved yet: drop operator.approvals from
            // future connect requests so the portal keeps running.
            if (msg.id === 'c1' && msg.error && msg.error.code === 'NOT_PAIRED' && this.approvalsRequested !== false) {
              console.warn('[portal] operator.approvals not approved for this device — falling back to read/write scopes (approvals will be read-only)');
              this.approvalsRequested = false;
              // The failed handshake left the socket open, which would block
              // connect()'s no-stack guard — force it closed so onclose tears
              // down and the downgraded reconnect actually happens now.
              try { this.ws.close(1000); } catch { /* noop */ }
            }
            p.reject(Object.assign(new Error(msg.error && msg.error.message || 'RPC failed'), { code: msg.error && msg.error.code, details: msg.error && msg.error.details }));
          }
        }
        return;
      }

      if (msg.type === 'event') {
        if (msg.event === 'chat') { this.fanout(msg.payload); return; }
        // Live tool receipts (streams: item / command_output)
        if (msg.event === 'agent') { handleAgentEvent(msg.payload, this); return; }
        // Tool confirmations (approval lifecycle)
        if (msg.event === 'exec.approval.requested' || msg.event === 'plugin.approval.requested') { handleApprovalRequested(msg.event, msg.payload, this); return; }
        if (msg.event === 'exec.approval.resolved' || msg.event === 'plugin.approval.resolved') { handleApprovalResolved(msg.event, msg.payload, this); return; }
      }
      // other events (tick, presence, heartbeat...) ignored
    };
  }

  respondToChallenge(challenge) {
    const nonce = challenge.nonce;
    const signedAt = Date.now();
    const client = { id: 'openclaw-control-ui', version: '2026.5.5', platform: 'web', mode: 'webchat' };
    // Tool confirmations need operator.approvals. Request it; if the gateway
    // rejects it as an unapproved scope upgrade (NOT_PAIRED), fall back to
    // read/write so the portal keeps working — approvals just stay read-only
    // until the device scope upgrade is approved by the gateway owner.
    const scopes = this.approvalsRequested !== false
      ? ['operator.read', 'operator.write', 'operator.approvals']
      : ['operator.read', 'operator.write'];
    const token = this.cfg.gatewayToken;
    const payload = ['v2', DEVICE.deviceId, client.id, client.mode, 'operator', scopes.join(','), String(signedAt), token, nonce].join('|');
    const signature = b64u(sign(payload));
    this.ws.send(JSON.stringify({
      type: 'req', id: 'c1', method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client,
        role: 'operator', scopes,
        caps: [], commands: [], permissions: {},
        auth: { token },
        locale: 'en-US',
        userAgent: 'agent-portal/1.0',
        device: { id: DEVICE.deviceId, publicKey: DEVICE.pub, signature, signedAt, nonce },
      },
    }));
  }

  // Called when hello-ok (connect res id c1) arrives
  onHello(payload) {
    if (this.helloWatchdog) { clearTimeout(this.helloWatchdog); this.helloWatchdog = null; }
    this.connected = true;
    this.connId = payload.server && payload.server.connId;
    this.hello = payload;
    this.retryMs = this.cfg.reconnectBaseMs || 1000;
    this.approvalsGranted = !!(payload.auth && Array.isArray(payload.auth.scopes) && payload.auth.scopes.includes('operator.approvals'));
    console.log(`[portal] connected to gateway ${this.cfg.gatewayUrl} conn=${this.connId} scopes=${JSON.stringify(payload.auth && payload.auth.scopes)} approvals=${this.approvalsGranted}`);
  }

  scheduleReconnect() {
    if (this.destroyed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // Guard against NaN/undefined/0: a non-finite delay makes setTimeout
    // fire immediately → hot spin loop that never recovers (seen Aug 24:
    // retryMs went undefined after connect because the per-gateway cfg
    // never carried reconnectBaseMs, then undefined*2 = NaN forever).
    const base = Number.isFinite(this.cfg.reconnectBaseMs) ? this.cfg.reconnectBaseMs : 1000;
    const max = Number.isFinite(this.cfg.reconnectMaxMs) ? this.cfg.reconnectMaxMs : 30000;
    const current = Number.isFinite(this.retryMs) && this.retryMs > 0 ? this.retryMs : base;
    const delay = current;
    this.retryMs = Math.min(current * 2, max);
    console.log(`[portal] reconnect scheduled in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = 'p' + (this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const sendIt = () => {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN)) {
          this.ws.send(JSON.stringify({ type: 'req', id, method, params: params || {} }));
        } else {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('gateway not connected'));
        }
      };
      if (this.connected) sendIt();
      else {
        // wait briefly for connection
        const wait = setInterval(() => {
          if (this.connected) { clearInterval(wait); sendIt(); }
        }, 200);
        setTimeout(() => { clearInterval(wait); if (this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(new Error('gateway not connected (timeout waiting)')); } }, 10000);
      }
    });
  }

  // ── SSE subscription hub ──
  subscribe(sessionKey, res) {
    if (!this.subscribers.has(sessionKey)) this.subscribers.set(sessionKey, new Set());
    this.subscribers.get(sessionKey).add(res);
  }
  unsubscribe(sessionKey, res) {
    const s = this.subscribers.get(sessionKey);
    if (s) { s.delete(res); if (s.size === 0) this.subscribers.delete(sessionKey); }
  }
  fanout(payload) {
    payload = payload || {};
    payload._gw = this.id;
    // Translate the gateway's real session key to this portal's namespaced
    // key (agent:<gwId>:<agentId>:main) so subscriber maps can't collide
    // across servers that happen to share agent ids.
    const key = realToPortal(this.id, payload.sessionKey);
    for (const fn of this.globalListeners) {
      try { fn(payload); } catch { /* a listener must never break fanout */ }
    }
    if (!key) return;
    const s = this.subscribers.get(key);
    if (s) {
      // The browser subscribes with the PORTAL-namespaced key
      // (agent:<gwId>:<agentId>:main) and drops any event whose sessionKey
      // doesn't match. The gateway's raw payload carries the un-namespaced
      // key (agent:<agentId>:main), so rewrite it before sending — otherwise
      // every live chat event is discarded and users must refresh to see
      // replies (while tool receipts, which ARE namespaced, still show up).
      const data = `event: chat\ndata: ${JSON.stringify({ ...payload, sessionKey: key })}\n\n`;
      for (const res of s) {
        try { res.write(data); } catch { /* dead */ }
      }
    }
    const ls = this.listeners.get(key);
    if (ls) {
      for (const fn of ls) {
        try { fn(payload); } catch { /* a listener must never break fanout */ }
      }
    }
  }

  // Server-side event watchers (used by the group-chat room engine).
  addListener(sessionKey, fn) {
    if (!this.listeners.has(sessionKey)) this.listeners.set(sessionKey, new Set());
    this.listeners.get(sessionKey).add(fn);
  }
  removeListener(sessionKey, fn) {
    const s = this.listeners.get(sessionKey);
    if (s) { s.delete(fn); if (s.size === 0) this.listeners.delete(sessionKey); }
  }
  // Watch every chat event regardless of sessionKey. Needed because agents
  // bound to external channels (Telegram) get their replies tagged with the
  // channel session key, not agent:<id>:main. Match by runId instead.
  addGlobalListener(fn) {
    this.globalListeners.add(fn);
  }
  removeGlobalListener(fn) {
    this.globalListeners.delete(fn);
  }
}

// ── Gateway farm: one client per configured gateway ─────────────────────────
const GATEWAYS = [];            // GatewayClient[], config order
const GATEWAY_BY_ID = new Map();
const AGENT_REGISTRY = new Map(); // gwId -> Map<agentId, {name, emoji, default}>
const AGENT_NAMES = new Map();    // ref (gwId:agentId or bare) -> {name, emoji}

function startGateway(cfg) {
  // GatewayClient expects gatewayUrl/gatewayToken; config uses url/token.
  const client = new GatewayClient(Object.assign({}, cfg, {
    gatewayUrl: cfg.url,
    gatewayToken: cfg.token,
    reconnectBaseMs: CONFIG.reconnectBaseMs,
    reconnectMaxMs: CONFIG.reconnectMaxMs,
  }));
  // Hook hello-ok resolution: the connect response comes as a normal res with id c1.
  {
    const _origRespond = client.respondToChallenge.bind(client);
    client.respondToChallenge = (challenge) => {
      _origRespond(challenge);
      const id = 'c1';
      client.pending.set(id, {
        resolve: (payload) => { client.onHello(payload); },
        reject: (err) => { console.error(`[portal] ${client.id}: connect failed:`, err.message); client.scheduleReconnect(); },
        timer: setTimeout(() => {
          client.pending.delete(id);
          console.error(`[portal] ${client.id}: connect handshake timed out`);
          client.scheduleReconnect();
        }, 15000),
      });
    };
  }
  client.start();
  GATEWAYS.push(client);
  GATEWAY_BY_ID.set(client.id, client);
  return client;
}

for (const g of CONFIG.gateways) if (g.enabled !== false) startGateway(g);

// ── Runtime gateway management (admin UI: Gateways view) ───────────────────
// The admin can add/remove/edit gateways without restarting the portal.
// These helpers keep the config file, the client farm, and the agent
// registry in sync. Every change is audited by the API handlers.

function stopGateway(id) {
  const client = GATEWAY_BY_ID.get(id);
  if (client) {
    client.destroyed = true;
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    if (client.helloWatchdog) clearTimeout(client.helloWatchdog);
    client.reconnectTimer = null;
    client.helloWatchdog = null;
    try { if (client.ws) client.ws.close(1000, 'gateway removed'); } catch (e) { /* noop */ }
    client.ws = null;
    client.connected = false;
    for (const p of client.pending.values()) { clearTimeout(p.timer); p.reject(new Error('gateway removed')); }
    client.pending.clear();
    client.subscribers.clear();
    client.listeners.clear();
    client.globalListeners.clear();
    const i = GATEWAYS.indexOf(client);
    if (i >= 0) GATEWAYS.splice(i, 1);
    GATEWAY_BY_ID.delete(id);
  }
  AGENT_REGISTRY.delete(id);
  for (const ref of [...AGENT_NAMES.keys()]) {
    if (ref.startsWith(id + ':')) AGENT_NAMES.delete(ref);
  }
}

function startOrRestartGateway(g) {
  if (g.enabled === false) { stopGateway(g.id); return; }
  if (!GATEWAY_BY_ID.has(g.id)) startGateway(g);
  else if (!GATEWAY_BY_ID.get(g.id).connected) {
    // Config changed while offline: restart so the new url/token applies.
    stopGateway(g.id);
    startGateway(g);
  }
}

function gw(id) { return GATEWAY_BY_ID.get(id) || null; }

// Shared gateway-object factory: validate + build (not register) a gateway from
// a request body. Used by the admin API and the first-run wizard so both
// enforce the same url/id rules. Returns { gateway } or { error, status }.
function createGateway(body) {
  if (!body || !body.url) return { error: 'url required' };
  const url = String(body.url).trim();
  if (!/^wss?:\/\//i.test(url)) return { error: 'url must start with ws:// or wss://' };
  let id = String(body.id || '').trim().toLowerCase().replace(/[^a-z0-9._-]/gi, '_');
  if (!id) id = url.replace(/^wss?:\/\//i, '').replace(/[^a-z0-9._-]/gi, '_').slice(0, 24) || 'gw';
  if (GATEWAY_BY_ID.has(id) || CONFIG.gateways.some(g => g.id === id)) return { error: 'gateway id already exists: ' + id, status: 409 };
  return {
    gateway: {
      id,
      name: String(body.name || id).slice(0, 60),
      url,
      token: typeof body.token === 'string' ? body.token.trim() : '',
      tokenSource: (typeof body.token === 'string' && body.token.trim()) ? 'runtime' : 'none',
      origin: typeof body.origin === 'string' ? String(body.origin).trim() : '',
      enabled: body.enabled !== false,
    },
  };
}

function gatewaysConnected() { return GATEWAYS.filter(g => g.connected); }

// Resolve an agent ref ("gwId:agentId" or bare "agentId") to a connected
// gateway client. Bare refs match any connected gateway that has that agent
// (config order wins). Returns null when unreachable.
function resolveAgentRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.includes(':')) {
    const [gwId, agentId] = ref.split(':');
    const c = gw(gwId);
    if (c && c.connected) return { gwId, agentId, client: c };
    return null;
  }
  for (const c of GATEWAYS) {
    if (!c.connected) continue;
    const reg = AGENT_REGISTRY.get(c.id);
    if (reg && reg.has(ref)) return { gwId: c.id, agentId: ref, client: c };
  }
  return null;
}

// Portal session keys are namespaced per server: agent:<gwId>:<agentId>:main.
// Legacy agent:<id>:main keys still parse (gwId null → resolved at use time).
function parsePortalSession(key) {
  if (!key || typeof key !== 'string') return null;
  let m = /^agent:([^:]+):([^:]+):main$/.exec(key);
  if (m) return { gwId: m[1], agentId: m[2] };
  m = /^agent:([^:]+):main$/.exec(key);
  if (m) return { gwId: null, agentId: m[1] };
  return null;
}

// Gateway events carry real session keys (agent:<id>:main or channel keys).
// Map them into this portal's namespaced space for subscriber/policy maps.
function realToPortal(gwId, realKey) {
  const m = /^agent:([^:]+):main$/.exec(realKey || '');
  if (m) return `agent:${gwId}:${m[1]}:main`;
  return `${gwId}:${realKey}`;
}

// Which gateway owns a portal session key?
function clientForPortalSession(portalKey) {
  const p = parsePortalSession(portalKey);
  if (!p) return null;
  if (p.gwId) return gw(p.gwId);
  const t = resolveAgentRef(p.agentId);
  return t ? t.client : null;
}

// ── Tool receipts + confirmations (Phase I) ────────────────────────────────
// Live tool activity arrives as `agent` events (streams: item/command_output).
// Approval lifecycle arrives as exec/plugin approval broadcasts. Both fan out
// to the SSE subscribers of the session they belong to — keyed strictly off
// sessionKey so nothing leaks across sessions.

const APPROVALS = new Map(); // id -> approval record
// Per-assignment policy (Phase I item 4): which tools an agent may use while
// helping a student on their active assignment. Set at send time (we know the
// student then); checked on tool receipts so blocked calls get flagged + audited.
const SESSION_POLICY = new Map(); // sessionKey -> { assignmentId, blockedTools:Set, allowedTools:Set|null }

function handleAgentEvent(payload, client) {
  const stream = payload && payload.stream;
  if (stream !== 'item' && stream !== 'command_output') return;
  const d = (payload && payload.data) || {};
  const realKey = payload.sessionKey;
  // Namespace the session key by its source gateway so receipts land on the
  // right subscriber even when two servers share an agent id.
  const sessionKey = client ? realToPortal(client.id, realKey) : realKey;
  if (!sessionKey) return;
  const ev = {
    runId: payload.runId || null,
    sessionKey,
    stream,
    toolCallId: d.toolCallId || d.itemId || null,
    name: d.name || null,
    kind: d.kind || null,
    phase: d.phase || null,
    status: d.status || null,
    title: d.title || null,
    output: d.output || null,
    exitCode: d.exitCode !== undefined && d.exitCode !== null ? d.exitCode : null,
    durationMs: d.durationMs || null,
    cwd: d.cwd || null,
    ts: payload.ts || null,
  };
  // Policy check (item 4): if this session's active assignment blocks (or
  // doesn't allow) the tool that just fired, flag the receipt + audit it.
  const pol = SESSION_POLICY.get(sessionKey);
  if (pol && ev.name) {
    const blocked = pol.blockedTools.has(ev.name) || (pol.allowedTools && !pol.allowedTools.has(ev.name));
    if (blocked) {
      ev.policyBlocked = true;
      ev.policyAssignment = pol.assignmentId;
      audit('tool_policy_block', 'system', 'system', { session: sessionKey, tool: ev.name, assignment: pol.assignmentId });
    }
  }
  const s = client ? client.subscribers.get(sessionKey) : null;
  if (s) {
    const line = `event: tool\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of s) { try { res.write(line); } catch { /* dead */ } }
  }
}

function publicApproval(rec) {
  return {
    id: rec.id,
    kind: rec.kind,
    status: rec.status,
    command: rec.command,
    agentId: rec.agentId,
    sessionKey: rec.sessionKey,
    warningText: rec.warningText,
    title: rec.title,
    description: rec.description,
    toolName: rec.toolName,
    severity: rec.severity,
    createdAtMs: rec.createdAtMs,
    expiresAtMs: rec.expiresAtMs,
    resolvedBy: rec.resolvedBy,
    decision: rec.decision,
    ts: rec.ts,
  };
}

function fanoutApproval(rec) {
  const safe = Object.assign({ canResolve: false }, publicApproval(rec));
  if (!rec.sessionKey) return;
  const client = clientForPortalSession(rec.sessionKey);
  if (client) {
    const s = client.subscribers.get(rec.sessionKey);
    if (s) {
      const line = `event: approval\ndata: ${JSON.stringify(safe)}\n\n`;
      for (const res of s) { try { res.write(line); } catch { /* dead */ } }
    }
  }
}

function handleApprovalRequested(kind, payload, client) {
  const req = (payload && payload.request) || payload || {};
  const rawId = payload && payload.id ? String(payload.id) : (req.id ? String(req.id) : ('a' + Date.now()));
  const rec = {
    // Namespace approval ids by gateway so concurrent approvals on different
    // servers can't collide.
    id: client ? `${client.id}:${rawId}` : rawId,
    kind: kind.indexOf('exec') === 0 ? 'exec' : 'plugin',
    status: 'pending',
    command: req.command || (req.systemRunPlan && req.systemRunPlan.commandText) || null,
    agentId: req.agentId || (req.systemRunPlan && req.systemRunPlan.agentId) || null,
    sessionKey: client ? realToPortal(client.id, req.sessionKey || (req.systemRunPlan && req.systemRunPlan.sessionKey)) : (req.sessionKey || (req.systemRunPlan && req.systemRunPlan.sessionKey)),
    warningText: req.warningText || null,
    title: req.title || null,
    description: req.description || null,
    toolName: req.toolName || null,
    severity: req.severity || null,
    createdAtMs: (payload && payload.createdAtMs) || Date.now(),
    expiresAtMs: (payload && payload.expiresAtMs) || null,
    resolvedBy: null,
    decision: null,
    ts: null,
  };
  APPROVALS.set(rec.id, rec);
  console.log(`[portal] approval ${rec.kind}:${rec.id} pending agent=${rec.agentId || '?'} session=${rec.sessionKey || '?'} cmd=${rec.command ? String(rec.command).slice(0, 80) : rec.title || ''}`);
  fanoutApproval(rec);
}

function handleApprovalResolved(kind, payload, client) {
  const rec = payload && APPROVALS.get(client ? `${client.id}:${payload.id}` : payload.id);
  if (!rec) return;
  rec.status = (payload.decision === 'approve' || payload.decision === 'allow-always') ? 'approved' : 'denied';
  rec.decision = payload.decision || null;
  rec.resolvedBy = payload.resolvedBy || null;
  rec.ts = payload.ts || Date.now();
  console.log(`[portal] approval ${rec.id} ${rec.status} by ${rec.resolvedBy || '?'}`);
  fanoutApproval(rec);
}

// ── Local accounts (Phase I) ────────────────────────────────────────────────
const ROLES = { student: 1, instructor: 2, admin: 3 };
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

// True once the portal decides a fresh box must be configured through the
// browser wizard before any account can log in (plan item 4). No working
// default exists while this is true.
let SETUP_REQUIRED = false;

function loadUsers() {
  let users = [];
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    if (Array.isArray(raw.users)) users = raw.users;
  } catch (e) { /* first run */ }
  // First run with nothing configured. Two paths:
  //   • an explicit bootstrap password was supplied (installer/headless) →
  //     mint ONE admin with it, exactly as before; or
  //   • nothing was supplied (bare `node portal-server.js`) → do NOT mint a
  //     default admin. Enter SETUP mode and serve the first-run wizard, so no
  //     working credential exists until the operator creates one (item 4).
  if (!users.some(u => u.role === 'admin')) {
    if (!hasExplicitBootstrapPassword()) {
      SETUP_REQUIRED = true;
      return users;
    }
    const boot = resolveBootstrapPassword();
    const salt = crypto.randomBytes(16).toString('hex');
    users.push({
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      agents: ['*'],
      assignments: [],
      hash: hashPassword(boot.password, salt),
      salt,
      createdAt: Date.now(),
    });
    if (boot.generated) {
      const f = writeFirstRunCredentials(boot.password);
      console.warn('[portal] no admin account found — created "admin" with a UNIQUE generated password.');
      console.warn(`[portal] retrieve it from ${f || 'portal-first-run.txt'} (chmod 600), then change it after first login.`);
    } else {
      console.warn('[portal] no admin account found — created "admin" using the configured bootstrap password.');
    }
  }
  saveUsers(users);
  return users;
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_PATH, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[portal] failed to write users file:', e.message);
  }
}

let USERS = loadUsers();
assertNoDefaultCreds();

function findUser(username) {
  return USERS.find(u => u.username === String(username).toLowerCase());
}

function verifyUser(username, password) {
  const u = findUser(username);
  if (!u || !u.hash || !u.salt) return null;
  const h = Buffer.from(hashPassword(password, u.salt), 'hex');
  const want = Buffer.from(u.hash, 'hex');
  if (h.length !== want.length) return null;
  return crypto.timingSafeEqual(h, want) ? u : null;
}

function publicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role,
    agents: u.agents || [],
    createdAt: u.createdAt,
  };
}

// ── First-run setup wizard (plan item 4) ────────────────────────────────────
// On a fresh box with no accounts and no configured bootstrap password the
// portal serves a browser wizard instead of minting a default admin. The
// wizard creates the admin (strong password enforced), can move bind/port,
// records the TLS intent, and can register the first gateway. Until it
// completes, no account can authenticate and every other API is refused.

// Public, unauthenticated view of the setup state.
function setupStatus() {
  return {
    needed: SETUP_REQUIRED,
    product: BRAND.product,
    family: BRAND.family,
    tagline: BRAND.tagline,
    slug: BRAND.slug,
    defaults: {
      bind: CONFIG.bind,
      port: CONFIG.port,
      tlsMode: CONFIG.tlsMode || 'off',
      gatewayUrl: CONFIG.gateways[0] ? CONFIG.gateways[0].url : DEFAULTS.gatewayUrl,
    },
    passwordMinLength: PASSWORD_MIN_LEN,
  };
}

// Validate + apply the wizard payload, mint the first admin, and return a
// session token. Returns { error } on any validation failure (nothing is
// committed unless the whole payload validates).
function completeSetup(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid request body' };

  const username = String(body.username || 'admin').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return { error: 'username must be 2-32 chars: lowercase letters, digits, dot, dash or underscore' };
  if (USERS.some(u => u.username === username)) return { error: 'username already exists' };

  const pwErr = passwordPolicyError(body.password, username);
  if (pwErr) return { error: pwErr };
  if (typeof body.passwordConfirm === 'string' && body.passwordConfirm !== String(body.password)) {
    return { error: 'passwords do not match' };
  }

  // Validate bind/port up front so a bad value never half-applies.
  let port = null;
  if (body.port !== undefined && body.port !== null && String(body.port).trim() !== '') {
    port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'port must be an integer between 1 and 65535' };
  }
  let bind = null;
  if (typeof body.bind === 'string' && body.bind.trim()) {
    bind = body.bind.trim();
    if (!/^[a-zA-Z0-9.:_\-]+$/.test(bind) || bind.length > 64) return { error: 'bind must be a valid IP or hostname (e.g. 127.0.0.1 or 0.0.0.0)' };
  }

  const tlsMode = ['off', 'auto', 'manual'].includes(body.tlsMode) ? body.tlsMode : (CONFIG.tlsMode || 'off');

  // A public bind without TLS is refused at boot (plan item 5). Catch it here so
  // the operator fixes it in the wizard instead of bricking the next restart.
  const willBind = bind !== null ? bind : CONFIG.bind;
  if (!isLoopbackBind(willBind) && tlsMode === 'off') {
    return { error: 'a public bind address requires TLS — choose Automatic or Manual TLS, or bind 127.0.0.1' };
  }

  // Optional first gateway — validated before anything is committed.
  let gateway = null;
  if (body.gateway && (body.gateway.url || body.gateway.id)) {
    const r = createGateway(body.gateway);
    if (r.error) return { error: 'first gateway: ' + r.error };
    gateway = r.gateway;
  }

  // ── Commit ──
  const salt = crypto.randomBytes(16).toString('hex');
  const admin = {
    username,
    displayName: String(body.displayName || 'Admin').trim().slice(0, 60) || 'Admin',
    role: 'admin',
    agents: ['*'],
    assignments: [],
    hash: hashPassword(String(body.password), salt),
    salt,
    createdAt: Date.now(),
  };
  USERS.push(admin);
  saveUsers(USERS);

  const prevPort = CONFIG.port;
  const prevBind = CONFIG.bind;
  if (port !== null) CONFIG.port = port;
  if (bind !== null) CONFIG.bind = bind;
  CONFIG.tlsMode = tlsMode;
  if (gateway) { CONFIG.gateways.push(gateway); }
  saveConfig();
  if (gateway && gateway.enabled) startGateway(gateway);

  SETUP_REQUIRED = false;
  const tok = createSession(admin);
  const sess = sessions.get(tok);
  audit('setup_complete', admin.username, admin.role, {
    bind: CONFIG.bind, port: CONFIG.port, tlsMode, gateway: gateway ? gateway.id : null,
  });
  return {
    ok: true,
    user: publicUser(admin),
    session: tok,
    csrfToken: sess ? sess.csrf : null,
    // bind/port only take effect on the next start; be honest about it.
    restartRequired: CONFIG.port !== prevPort || CONFIG.bind !== prevBind,
    config: { bind: CONFIG.bind, port: CONFIG.port, tlsMode },
  };
}

// Validate + dedupe an agent id list. '*' means all agents; 'gwId:agentId'
// and 'gwId:*' mean a specific agent / all agents on one gateway server.
function sanitizeAgents(list) {
  return [...new Set(list.filter(a => {
    if (typeof a !== 'string' || !a.length || a.length > 64) return false;
    const parts = a.split(':');
    if (parts.length > 2) return false;
    return parts.every(p => /^[a-zA-Z0-9._*-]+$/.test(p));
  }))];
}

// ── CI30 context injection (Phase I item 2) ────────────────────────────────
// A small context store: course info (code, term, syllabus, assignments) plus
// per-user context (profile, active assignment, notes). When a student sends a
// message, the portal prepends a context block so the agent knows who it's
// talking to and what the course/assignment is — no gateway changes needed.
//
// Seed defaults are a CI30 demo (help-desk org chart). Admins/instructors can
// edit course + per-user context from the UI; the block is rebuilt on send.

function loadContextStore() {
  const store = {
    course: {
      code: 'CI30',
      name: 'Intro to Interactive Systems',
      term: 'Summer 2026',
      syllabus: 'Build a working help-desk agent and document it.',
      assignments: [
        { id: 'a1', title: 'Help Desk Bot', due: '2026-08-15', brief: 'Deploy a chat agent that answers course questions.' },
      ],
    },
    users: {}, // username -> { enabled, profile, assignment, notes }
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CONTEXT_PATH, 'utf8'));
    if (raw && raw.course) store.course = Object.assign(store.course, raw.course);
    if (raw && raw.users && typeof raw.users === 'object') store.users = raw.users;
  } catch (e) { /* first run */ }
  saveContextStore(store);
  return store;
}

function saveContextStore(store) {
  try {
    fs.writeFileSync(CONTEXT_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[portal] failed to write context file:', e.message);
  }
}

const CONTEXT_STORE = loadContextStore();

function userContext(u) {
  return CONTEXT_STORE.users[u.username] || {};
}

function assignmentById(id) {
  return (CONTEXT_STORE.course.assignments || []).find(a => a.id === id) || null;
}

// Build the context block injected ahead of a student's message. Returns null
// when the user has no context or has explicitly disabled injection.
function buildContextBlock(u) {
  const ctx = userContext(u);
  if (ctx.enabled === false) return null;
  const course = CONTEXT_STORE.course;
  const asg = assignmentById(ctx.assignment);
  const lines = [`[Portal context · ${course.code} — ${course.name}]`];
  lines.push(`Student: ${u.displayName || u.username} (@${u.username})`);
  if (course.term) lines.push(`Term: ${course.term}`);
  if (asg) {
    lines.push(`Assignment: ${asg.id} — ${asg.title}${asg.due ? ' (due ' + asg.due + ')' : ''}`);
    if (asg.brief) lines.push(`Brief: ${asg.brief}`);
    if (asg.policy) {
      const p = asg.policy;
      const bits = [];
      if (Array.isArray(p.allowedTools) && p.allowedTools.length) bits.push(`allowed tools: ${p.allowedTools.join(', ')}`);
      if (Array.isArray(p.blockedTools) && p.blockedTools.length) bits.push(`blocked tools: ${p.blockedTools.join(', ')}`);
      if (bits.length) lines.push(`Assignment policy: ${bits.join('; ')}.`);
      if (Array.isArray(p.rules) && p.rules.length) lines.push(`Policy rules: ${p.rules.join(' ')}`);
    }
  }
  if (ctx.profile) lines.push(`Profile: ${ctx.profile}`);
  if (ctx.notes) lines.push(`Notes: ${ctx.notes}`);
  if (course.syllabus) lines.push(`Course: ${course.syllabus}`);
  lines.push('Help this student with their coursework. Be clear and encouraging.');
  return lines.join('\n');
}

// ── Sessions (hardened — plan item 6) ──────────────────────────────────────
// token -> { username, csrf, createdAt, lastSeen, expiresAt }. The token is a
// 256-bit random value; each session also carries a CSRF secret. Absolute TTL
// is CONFIG.sessionTtlHours; an optional idle timeout is CONFIG.sessionIdleMinutes.
const sessions = new Map();

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sessionTtlMs() { return Math.max(1, Number(CONFIG.sessionTtlHours) || 12) * 3600_000; }
function sessionIdleMs() {
  const m = Number(CONFIG.sessionIdleMinutes);
  return Number.isFinite(m) && m > 0 ? m * 60_000 : 0;
}

function createSession(user) {
  const tok = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(tok, {
    username: user.username,
    csrf: crypto.randomBytes(32).toString('hex'),
    createdAt: now,
    lastSeen: now,
    expiresAt: now + sessionTtlMs(),
  });
  return tok;
}

function destroySession(token) { if (token) sessions.delete(token); }

// Nuke every session for a user — logout-all, and on password change/delete.
function destroyUserSessions(username) {
  let n = 0;
  for (const [tok, s] of sessions) {
    if (s.username === username) { sessions.delete(tok); n++; }
  }
  return n;
}

function sessionTokenFromReq(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim());
  for (const c of cookie) {
    if (c.startsWith('portal_session=')) return c.slice('portal_session='.length);
  }
  return null;
}

// Resolve (and lazily evict) the session for this request, enforcing the
// absolute TTL and the optional idle timeout.
function currentSession(req) {
  const tok = sessionTokenFromReq(req);
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s) return null;
  const now = Date.now();
  const idle = sessionIdleMs();
  if (s.expiresAt < now || (idle && now - s.lastSeen > idle)) { sessions.delete(tok); return null; }
  if (!findUser(s.username)) { sessions.delete(tok); return null; }
  s.lastSeen = now;
  return { token: tok, ...s };
}

function currentUser(req) {
  const s = currentSession(req);
  return s ? findUser(s.username) : null;
}

function auth(req) {
  return currentSession(req) !== null;
}

// ── CSRF (plan item 6) ──────────────────────────────────────────────────────
// Every state-changing request must carry the token minted with the caller's
// session, in `X-CSRF-Token`. SameSite=Strict already blocks classic cross-site
// form posts; the session-bound token blocks the rest (and a same-site XSS-less
// forgery). If the browser sent an Origin, its host must also match ours —
// defense in depth for callers that don't send the token.
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function csrfOk(req, session) {
  if (!session) return false;
  const sent = req.headers['x-csrf-token'];
  return typeof sent === 'string' && timingSafeEq(sent, session.csrf);
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser callers (installer/curl) send none
  try {
    const o = new URL(origin);
    return o.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch { return false; }
}

// ── Login rate-limit + progressive lockout (plan item 6) ────────────────────
// Keyed per (client IP | username) so one source cannot lock out a known user
// for everyone, and a single username cannot be sprayed from one IP. In-memory:
// a restart clears the counters (the only state lost is the attacker's lockout).
const loginFailures = new Map(); // key -> { hits: [ts], lockouts: n, lockedUntil: ts }

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function loginKey(req, username) { return clientIp(req) + '|' + String(username || '').toLowerCase(); }

function pruneHits(rec, now) {
  const win = (Number(CONFIG.loginWindowSeconds) || 900) * 1000;
  rec.hits = (rec.hits || []).filter(t => now - t < win);
}

// → null when allowed, else { retryAfter } seconds until the lockout expires.
function loginGuard(req, username) {
  const now = Date.now();
  const rec = loginFailures.get(loginKey(req, username));
  if (!rec) return null;
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return null;
}

function recordLoginFailure(req, username) {
  const now = Date.now();
  const max = Math.max(1, Number(CONFIG.loginMaxAttempts) || 5);
  const base = Math.max(1, Number(CONFIG.loginLockoutSeconds) || 300);
  const key = loginKey(req, username);
  const rec = loginFailures.get(key) || { hits: [], lockouts: 0, lockedUntil: 0 };
  pruneHits(rec, now);
  rec.hits.push(now);
  if (rec.hits.length >= max) {
    rec.lockouts += 1;
    const secs = Math.min(base * Math.pow(2, rec.lockouts - 1), 3600); // progressive, capped at 1h
    rec.lockedUntil = now + secs * 1000;
    rec.hits = [];
    loginFailures.set(key, rec);
    return { locked: true, retryAfter: secs, lockouts: rec.lockouts };
  }
  loginFailures.set(key, rec);
  return { locked: false, remaining: max - rec.hits.length };
}

function clearLoginFailures(req, username) { loginFailures.delete(loginKey(req, username)); }

// Access: which agents can this user reach? '*' = all, 'gwId:*' = all agents
// on one server, bare id matches any server with that agent.
function agentAllowed(user, refOrId) {
  if (user.role === 'admin' || user.role === 'instructor') return true;
  const allowed = user.agents || [];
  if (allowed.includes('*')) return true;
  if (typeof refOrId !== 'string' || !refOrId) return false;
  if (allowed.includes(refOrId)) return true;
  const idx = refOrId.indexOf(':');
  if (idx > 0) {
    const gwPart = refOrId.slice(0, idx);
    const agentPart = refOrId.slice(idx + 1);
    if (allowed.includes(agentPart)) return true;     // bare id matches
    if (allowed.includes(gwPart + ':*')) return true;  // whole server
  }
  return false;
}

// Session keys look like agent:<gwId>:<agentId>:main (or legacy agent:<id>:main).
function canAccessSession(user, sessionKey) {
  if (!sessionKey) return false;
  const p = parsePortalSession(sessionKey);
  if (!p) return false;
  return agentAllowed(user, p.gwId ? `${p.gwId}:${p.agentId}` : p.agentId);
}

// ── Audit log (Phase I groundwork) ─────────────────────────────────────────
const AUDIT_MAX_BYTES = 1024 * 1024;

function audit(action, username, role, detail) {
  const entry = {
    ts: Date.now(),
    action,
    user: username || '?',
    role: role || 'anon',
  };
  if (detail) entry.detail = detail;
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
    // keep the file bounded
    if (fs.statSync(AUDIT_PATH).size > AUDIT_MAX_BYTES) {
      const lines = fs.readFileSync(AUDIT_PATH, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(AUDIT_PATH, lines.slice(-5000).join('\n') + '\n');
    }
  } catch (e) { /* audit must never break the portal */ }
}

function readAudit(limit) {
  try {
    const lines = fs.readFileSync(AUDIT_PATH, 'utf8').split('\n').filter(Boolean);
    const n = Math.min(limit || 100, lines.length);
    return lines.slice(-n).reverse().map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Group chat rooms (panel mode, Aug 3 2026) ───────────────────────────────
// A room is 2+ agents plus a shared transcript. A *round* sends the full
// transcript to each agent in turn, waits for its reply, appends, and moves
// on — one response per agent per round. Rounds are human-triggered (drop a
// message or press "next round"), so infinite ping-pong is impossible by
// construction. Loop-safe by design.
const roomSubs = new Map();   // roomId -> Set<res> (SSE)
const agentBusy = new Map();  // agentId -> roomId (one round per agent at a time)
const BURST_MAX = 20;         // free-flow: max auto-replies per human message
let roomSeq = 1;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadRooms() {
  const rooms = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_PATH, 'utf8'));
    for (const r of (raw.rooms || [])) {
      if (!r || !r.id || !Array.isArray(r.agents)) continue;
      rooms.set(r.id, {
        id: r.id,
        name: String(r.name || r.id),
        agents: r.agents.filter(a => typeof a === 'string'),
        transcript: Array.isArray(r.transcript) ? r.transcript : [],
        round: r.round || 0,
        mode: r.mode === 'free' ? 'free' : 'rounds',
        paused: !!r.paused,
        status: 'idle',
        currentAgent: null,
        currentRunId: null,
        stopRequested: false,
        createdAt: r.createdAt || Date.now(),
        createdBy: r.createdBy || 'admin',
        // in-memory free-flow state (not persisted)
        msgSeq: (Array.isArray(r.transcript) ? r.transcript.length : 0),
        burstUsed: 0,
        ffReplied: new Map(),  // msg uid -> Set<agentId> who already replied
        ffRunning: false,
      });
    }
  } catch (e) { /* first run */ }
  return rooms;
}

function saveRooms() {
  try {
    const list = [...ROOMS.values()].map(r => ({
      id: r.id, name: r.name, agents: r.agents, transcript: r.transcript.slice(-300),
      round: r.round, mode: r.mode, paused: !!r.paused,
      createdAt: r.createdAt, createdBy: r.createdBy,
    }));
    fs.writeFileSync(ROOMS_PATH, JSON.stringify({ rooms: list }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[portal] failed to write rooms file:', e.message);
  }
}

const ROOMS = loadRooms();

function roomPublic(room) {
  return {
    id: room.id, name: room.name, agents: room.agents,
    round: room.round, mode: room.mode, paused: !!room.paused,
    status: room.status, currentAgent: room.currentAgent,
    createdAt: room.createdAt, createdBy: room.createdBy,
    transcript: room.transcript,
  };
}

function roomSummary(room) {
  const last = room.transcript.length ? room.transcript[room.transcript.length - 1] : null;
  return {
    id: room.id, name: room.name, agents: room.agents,
    round: room.round, mode: room.mode, paused: !!room.paused,
    status: room.status, currentAgent: room.currentAgent,
    createdAt: room.createdAt, createdBy: room.createdBy,
    lastAt: last ? last.ts : null, lastSender: last ? last.sender : null,
    lastText: last ? String(last.text || '').slice(0, 90) : '',
  };
}

function emitRoom(room, event, data) {
  const subs = roomSubs.get(room.id);
  if (!subs) return;
  const payload = JSON.stringify({ room: room.id, event, data });
  for (const res of subs) {
    try { res.write(`event: room\ndata: ${payload}\n\n`); } catch { /* dead */ }
  }
}

function agentName(agentId) {
  const a = AGENT_NAMES.get(agentId);
  return (a && a.name) || agentId;
}

// ── Anti-loop helpers (Sep 5 2026) ─────────────────────────────────────────
// Rooms used to grind into echo loops: every agent was handed the same raw
// transcript (so finished plot points got re-litigated) and was forced to
// produce a reply even with nothing new to say (so they replayed their own
// last beat, and the scene re-ran forever). Fixes, all deterministic, no
// extra LLM calls:
//   1. tokenSim()   — word-bigram Jaccard similarity for cheap dedup.
//   2. condenseTranscript() — collapses near-duplicate messages before the
//      prompt is built, so one repeated scene can't drown out new input.
//   3. isPassReply() / [pass] — agents may explicitly pass instead of padding.
//   4. appendAgentReply() — repeat guard: near-verbatim re-says of an agent's
//      own earlier lines are dropped as meta notes instead of appended.
//   5. runRound() auto-pauses when a whole round adds zero new content.
function normWords(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}
function tokenSim(a, b) {
  const A = normWords(a);
  const B = normWords(b);
  if (!A.length || !B.length) return 0;
  const bigrams = arr => {
    const s = new Set();
    for (let i = 0; i < arr.length - 1; i++) s.add(arr[i] + ' ' + arr[i + 1]);
    return s;
  };
  const SA = bigrams(A);
  const SB = bigrams(B);
  let inter = 0;
  for (const x of SA) if (SB.has(x)) inter++;
  const union = SA.size + SB.size - inter;
  return union ? inter / union : 0;
}

// True when an agent explicitly declined to speak this turn.
function isPassReply(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[’']/g, '');
  return /^\(?pass\)?[\.\,\!\s]*$/.test(t)
    || t.startsWith('[pass]')
    || /^i (will |'?ll )?pass[.!\s]*$/.test(t);
}

// Collapse near-duplicate messages in the transcript window so repeated
// scene replays appear once. User/system messages and meta notes always stay.
// Walk newest→oldest so the freshest wording of a beat survives.
// Threshold tuned on real stuck rooms (Sep 5): role-play loops REWRITE each
// beat, so same-beat repeats score ~0.4-0.65 while distinct beats sit below
// ~0.3. 0.45 on long messages collapses the replay without eating real turns.
function condenseTranscript(room, maxRaw, maxKeep) {
  const raw = room.transcript.slice(-(maxRaw || 60));
  const kept = []; // newest-first while building
  let dropped = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i];
    const isAgentText = !m.meta && m.sender && m.sender !== 'user' && m.sender !== 'system' && String(m.text || '').length > 200;
    if (isAgentText) {
      let dup = false;
      for (const k of kept) {
        if (k.meta || k.sender === 'user' || k.sender === 'system') continue;
        if (tokenSim(m.text, k.text) >= 0.45) { dup = true; break; }
      }
      if (dup) { dropped++; continue; }
    }
    kept.push(m);
    if (kept.length >= (maxKeep || 32)) break;
  }
  kept.reverse();
  return { kept, dropped };
}

// Append an agent reply to the room with anti-loop guards. Returns true when
// real content was appended; false when it was dropped (pass / near-repeat).
const REPEAT_SKIP_SIM = 0.6; // catches rewritten re-says (real loops score 0.4-0.65)
function appendAgentReply(room, agentRef, rawText) {
  const text = String(rawText || '').trim();
  if (!text) return false;
  if (isPassReply(text)) {
    pushRoomMsg(room, agentRef, '[passed — nothing new to add]', true);
    return false;
  }
  if (text.length > 60) {
    const own = room.transcript.filter(m => !m.meta && m.sender === agentRef).slice(-3);
    for (const prev of own) {
      const s = tokenSim(text, prev.text);
      if (s >= REPEAT_SKIP_SIM) {
        pushRoomMsg(room, agentRef, `[skipped — near-repeat of ${agentName(agentRef)}'s earlier reply (${Math.round(s * 100)}% similar)]`, true);
        return false;
      }
    }
  }
  pushRoomMsg(room, agentRef, text);
  return true;
}

function buildTurnPrompt(room, agentId, freeMode) {
  const others = room.agents.filter(a => a !== agentId).map(agentName).join(', ') || 'no one else yet';
  const { kept, dropped } = condenseTranscript(room, 50, 20);
  // Per-message readability cap. 800 was too small: a reply longer than that
  // was cut mid-sentence when building the next agent's prompt, so agents
  // literally could not read the full response. 6000 chars (~1500 tokens)
  // keeps any real reply readable in full; the total-prompt budget below
  // still bounds the damage in very chatty rooms.
  const MAX_PER_MSG = 6000;
  const lines = [`Group chat: ${room.name}`, `Participants: ${room.agents.map(agentName).join(', ')}`, ''];
  if (kept.length) {
    // Split at the newest operator beat: everything before is backstory,
    // everything after is the live exchange. Models anchor hard on the tail,
    // so make the current beat unmistakable instead of burying it in a wall
    // of agent replies replaying finished moments.
    let beatAt = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].sender === 'user') { beatAt = i; break; }
    }
    lines.push('Conversation so far:');
    for (let i = 0; i < kept.length; i++) {
      const m = kept[i];
      const who = m.sender === 'user' ? 'the operator' : agentName(m.sender);
      if (i === beatAt) {
        lines.push('');
        lines.push('--- CURRENT SCENE: the operator just said this — everything below reacts to it ---');
        lines.push(`— the operator: ${String(m.text || '').slice(0, MAX_PER_MSG)}`);
        continue;
      }
      lines.push(`— ${who}: ${String(m.text || '').slice(0, MAX_PER_MSG)}`);
    }
    if (dropped > 0) lines.push(`(note: ${dropped} near-duplicate earlier message${dropped > 1 ? 's' : ''} condensed out — do not redo actions that already happened)`);
    if (beatAt >= 0) lines.push('');
  }
  const passRule = 'If the scene is resolved, the others have it handled, or you have nothing new to add, reply with exactly: [pass]. Passing is honest. Never redo an action another participant (or you) already performed — the moment is finished. Never recap or repeat lines; repeated actions get dropped.';
  if (freeMode) {
    lines.push(`It's your turn, ${agentName(agentId)}. You're in a free-flowing group chat with ${others} — people reply as the conversation moves, nobody waits for a formal turn.`);
    lines.push(`Reply naturally as yourself — concise, in character, no meta-commentary about the chat format. ${passRule}`);
  } else {
    lines.push(`It's your turn, ${agentName(agentId)}. You're chatting with ${others} in a group conversation.`);
    lines.push(`Reply naturally as yourself — concise, in character, no meta-commentary about the chat format. This is one message in a round; every participant speaks once per round. ${passRule}`);
  }
  // Total-prompt budget: chat.send caps at 16000 chars, and naive head-slicing
  // at the call site cut the NEWEST lines — the very scene the agent must
  // react to — whenever a room got chatty. Trim oldest content first instead:
  // the room header and turn instructions always survive, and backstory is
  // dropped before the live exchange ever is.
  const MAX_BODY = 15000;
  const head = lines.slice(0, 3);      // room header
  const instr = lines.slice(-2);       // turn instructions
  const rest = lines.slice(3, -2);     // transcript body, oldest → newest
  let budget = MAX_BODY - head.join('\n').length - instr.join('\n').length - 2;
  const fitted = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const l = rest[i];
    if (l.length + 1 > budget) continue; // over budget → drop from oldest end
    fitted.unshift(l);
    budget -= l.length + 1;
  }
  return head.concat(fitted, instr).join('\n');
}

// Wait for an agent's reply to finish by watching chat events. We match by
// runId across ALL sessions (global listener), because channel-bound agents
// (Telegram DMs) deliver their reply events under the channel session key,
// not agent:<id>:main. Matching by runId makes the round engine channel-agnostic.
// Debounce on 'final': some sessions emit an early empty final (ack/status),
// then stream the real reply — so we resolve only after a quiet 2s window.
function awaitAgentReply(room, agentId, runId, timeoutMs, client) {
  const gwClient = client || gatewaysConnected()[0] || null;
  if (!gwClient) return Promise.resolve({ text: '', timedOut: true });
  return new Promise((resolve) => {
    let text = '';
    let settleTimer = null;
    const settle = () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      gwClient.removeGlobalListener(onEvent);
      clearTimeout(timeoutTimer);
      resolve({ text: text || '', timedOut: false });
    };
    const timeoutTimer = setTimeout(() => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      gwClient.removeGlobalListener(onEvent);
      resolve({ text: text || '', timedOut: !text });
    }, timeoutMs);
    const onEvent = (p) => {
      if (!p || p.runId !== runId) return;
      if (p._gw && gwClient && p._gw !== gwClient.id) return;
      const t = extractText(p.message && p.message.content).trim();
      console.log(`[portal] room ${room.id}: ${agentId} evt state=${p.state} len=${t.length} via=${p.sessionKey || '?'}`);
      if (p.state === 'delta' && t) text = t;
      else if (p.state === 'final') {
        if (t) text = t;
        // Empty finals are often acks emitted before the real stream starts
        // (some gateways/sessions do this on every send). Only settle on a
        // quiet window; if we've never seen content, give the agent a longer
        // beat (10s) before declaring silence. With content, 2s of quiet
        // after the last final is enough.
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, text ? 2000 : 10000);
      }
    };
    gwClient.addGlobalListener(onEvent);
  });
}

// ── History-fallback (room engine) ──────────────────────────────────────────
// Known gap: when an agent's session is busy/queued, chat.send acks with a
// runId but the REAL run happens later under a different runId — so the
// runId watcher settles empty and the room records "[no reply]" even though
// the agent answered. This polls chat.history for the agent's main session
// and recovers the newest assistant message that landed after we sent the
// prompt. Returns '' if nothing new shows up in the window (agent genuinely
// stayed quiet).
async function historyFallbackReply(client, agentId, sentAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const grace = 10000; // tolerate gateway clock skew vs this host
  while (Date.now() < deadline) {
    try {
      const payload = await client.request('chat.history', { sessionKey: `agent:${agentId}:main`, maxChars: 300000 }, 20000);
      const msgs = (payload.messages || []).map(normalizeMessage).filter(m => m.text && m.text.trim());
      let best = '';
      let bestTime = -Infinity;
      for (const m of msgs) {
        if (m.role !== 'assistant') continue;
        const t = m.time || 0;
        if (t >= sentAt - grace && t > bestTime) { bestTime = t; best = m.text.trim(); }
      }
      if (best) return best;
    } catch (e) { /* transient — keep polling */ }
    await sleep(2500);
  }
  return '';
}

function pushRoomMsg(room, sender, text, meta) {
  const msg = { uid: 'm' + (room.msgSeq++), sender, text, ts: Date.now(), meta: !!meta };
  room.transcript.push(msg);
  emitRoom(room, 'transcript', { message: msg });
  saveRooms();
  return msg;
}

async function runRound(room, byUser) {
  if (room.status === 'running') return;
  room.status = 'running';
  room.stopRequested = false;
  room.round += 1;
  emitRoom(room, 'status', { status: 'running', round: room.round, currentAgent: null });
  saveRooms();
  audit('room_round', byUser || 'system', 'system', { room: room.id, round: room.round });
  // Round health counters (anti-loop): asked = agents we actually prompted;
  // added = real content appended; transportErr = send-time failures/timeouts.
  let asked = 0, added = 0, transportErr = 0;
  try {
    for (const agentRef of room.agents) {
      if (room.stopRequested) break;
      const t = resolveAgentRef(agentRef);
      const refKey = t ? `${t.gwId}:${t.agentId}` : agentRef;
      const busyFor = agentBusy.get(refKey);
      if (busyFor && busyFor !== room.id) {
        pushRoomMsg(room, agentRef, `[skipped — ${agentName(agentRef)} is busy in another room]`, true);
        transportErr++;
        continue;
      }
      if (!t) {
        pushRoomMsg(room, agentRef, `[${agentName(agentRef)} unreachable — server offline]`, true);
        transportErr++;
        continue;
      }
      agentBusy.set(refKey, room.id);
      room.currentAgent = agentRef;
      room.currentRunId = null;
      emitRoom(room, 'status', { status: 'running', round: room.round, currentAgent: agentRef });
      try {
        const prompt = buildTurnPrompt(room, agentRef);
        const sent = await t.client.request('chat.send', {
          sessionKey: `agent:${t.agentId}:main`,
          message: prompt.slice(0, 16000),
          deliver: false,
          idempotencyKey: crypto.randomUUID(),
        }, 30000);
        asked++;
        room.currentRunId = sent.runId;
        const sentAt = Date.now();
        let reply = await awaitAgentReply(room, agentRef, sent.runId, 240000, t.client);
        if (!reply.text) {
          // Busy/queued session: the ack'd runId isn't the run that answered.
          // Recover the real reply from history before declaring silence.
          const recovered = await historyFallbackReply(t.client, t.agentId, sentAt, 90000);
          if (recovered) {
            if (appendAgentReply(room, agentRef, recovered)) added++;
          } else if (reply.timedOut) {
            pushRoomMsg(room, agentRef, `[${agentName(agentRef)} timed out]`, true);
            transportErr++;
          } else {
            pushRoomMsg(room, agentRef, '[no reply]', true);
          }
        } else {
          if (appendAgentReply(room, agentRef, reply.text)) added++;
        }
      } catch (e) {
        pushRoomMsg(room, agentRef, `[${agentName(agentRef)} failed: ${e.message}]`, true);
        transportErr++;
      } finally {
        agentBusy.delete(refKey);
      }
    }
    // Auto-pause: a full round with zero new content means the room is
    // looping or resolved. Don't keep grinding — surface it and stop.
    if (asked > 0 && added === 0 && transportErr === 0) {
      room.paused = true;
      pushRoomMsg(room, 'system', `[Round ${room.round} added nothing new — every agent passed, repeated itself, or stayed quiet. Room auto-paused. Send a message or press Next round to continue.]`, true);
      audit('room_autopause', byUser || 'system', 'system', { room: room.id, round: room.round });
    }
  } catch (e) {
    console.error('[portal] round crashed:', e.message);
    pushRoomMsg(room, 'system', `[round error: ${e.message}]`, true);
  } finally {
    room.currentAgent = null;
    room.currentRunId = null;
    room.stopRequested = false;
    room.status = room.paused ? 'paused' : 'idle';
    emitRoom(room, 'status', { status: room.status, round: room.round, currentAgent: null });
    saveRooms();
  }
}

async function stopRoomRound(room) {
  room.stopRequested = true;
  if (room.mode === 'free') room.paused = true; // Stop = full halt in free-flow
  if (room.currentRunId && room.currentAgent) {
    const t = resolveAgentRef(room.currentAgent);
    if (t) {
      try {
        await t.client.request('chat.abort', { sessionKey: `agent:${t.agentId}:main`, runId: room.currentRunId }, 10000);
      } catch { /* best effort */ }
    }
  }
}

// Run N rounds back-to-back (1-10). Each round is one reply per agent;
// the room returns to idle between rounds and honours Stop between them.
async function runRounds(room, byUser, count) {
  const n = Math.max(1, Math.min(parseInt(count, 10) || 1, 10));
  for (let i = 0; i < n; i++) {
    if (room.stopRequested || room.paused || room.status === 'running') break;
    await runRound(room, byUser);
    if (room.paused) break; // auto-pause fired (empty round) — don't grind the rest
    if (i < n - 1) await sleep(900); // small beat between rounds so it reads naturally
  }
}

// Free-flow engine: every non-meta message (user or agent) triggers one reply
// from each OTHER agent who hasn't already replied to that message. The loop
// keeps cascading until: the burst budget for the current human message runs
// out, the room is paused, Stop is hit, or nobody has anything left to say.
// Loop-safe by construction: per-message dedupe (no agent replies twice to the
// same message), no self-replies (never trigger the sender), a hard burst cap
// per human message, and a human Pause that halts the cascade between turns.
async function freeflowTick(room) {
  if (room.mode !== 'free' || room.paused || room.ffRunning) return;
  room.ffRunning = true;
  room.status = 'running';
  try {
    // prune stale per-message reply tracking
    const live = new Set(room.transcript.slice(-100).map(m => m.uid).filter(Boolean));
    for (const k of room.ffReplied.keys()) if (!live.has(k)) room.ffReplied.delete(k);
    let anyTurn = false;
    while (room.mode === 'free' && !room.paused && !room.stopRequested) {
      const last = room.transcript[room.transcript.length - 1];
      if (!last || !last.uid || last.meta) break;
      if (room.burstUsed >= BURST_MAX) break;
      let replied = room.ffReplied.get(last.uid);
      if (!replied) { replied = new Set(); room.ffReplied.set(last.uid, replied); }
      const next = room.agents.find(a => {
        if (a === last.sender || replied.has(a)) return false;
        const t = resolveAgentRef(a);
        const k = t ? `${t.gwId}:${t.agentId}` : a;
        return !agentBusy.has(k) || agentBusy.get(k) === room.id;
      });
      if (!next) break;
      const tNext = resolveAgentRef(next);
      if (!tNext) {
        // agent registered but server went offline mid-freeflow
        replied.add(next);
        pushRoomMsg(room, next, `[${agentName(next)} unreachable — server offline]`, true);
        continue;
      }
      const nextKey = `${tNext.gwId}:${tNext.agentId}`;
      replied.add(next);
      room.burstUsed += 1;
      agentBusy.set(nextKey, room.id);
      room.currentAgent = next;
      room.currentRunId = null;
      anyTurn = true;
      emitRoom(room, 'status', { status: 'running', round: room.round, currentAgent: next });
      try {
        const prompt = buildTurnPrompt(room, next, true);
        const sent = await tNext.client.request('chat.send', {
          sessionKey: `agent:${tNext.agentId}:main`,
          message: prompt.slice(0, 16000),
          deliver: false,
          idempotencyKey: crypto.randomUUID(),
        }, 30000);
        room.currentRunId = sent.runId;
        const sentAt = Date.now();
        const reply = await awaitAgentReply(room, next, sent.runId, 240000, tNext.client);
        if (reply.text && reply.text.trim()) {
          // [pass] and near-verbatim repeats land as meta notes — which also
          // stops the free-flow cascade (the while loop ends on a meta tail).
          appendAgentReply(room, next, reply.text.trim());
        } else {
          // Same ack-then-queue recovery as rounds mode; if history also has
          // nothing new, the agent genuinely stayed quiet — loop moves on.
          const recovered = await historyFallbackReply(tNext.client, tNext.agentId, sentAt, 45000);
          if (recovered) appendAgentReply(room, next, recovered);
        }
      } catch (e) {
        pushRoomMsg(room, next, `[${agentName(next)} failed: ${e.message}]`, true);
      } finally {
        agentBusy.delete(nextKey);
        room.currentAgent = null;
        room.currentRunId = null;
      }
    }
    if (anyTurn) {
      if (room.paused) emitRoom(room, 'status', { status: 'paused', round: room.round, currentAgent: null });
      else emitRoom(room, 'status', { status: 'idle', round: room.round, currentAgent: null });
    }
  } finally {
    room.ffRunning = false;
    room.stopRequested = false;
    room.status = room.paused ? 'paused' : 'idle';
    saveRooms();
    if (!anyTurn) emitRoom(room, 'status', { status: room.status, round: room.round, currentAgent: null });
  }
}

// ── Message normalization ───────────────────────────────────────────────────
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

function normalizeMessage(m) {
  const role = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : 'tool');
  const text = extractText(m.content).trim();
  return {
    role,
    text,
    time: m.timestamp || null,
    toolName: m.role === 'toolResult' ? (m.toolName || 'tool') : undefined,
    senderLabel: m.senderLabel,
  };
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const requestListener = (req, res) => {
  // HSTS whenever we are in a secure context — direct TLS, or a trusted proxy
  // terminates it. Browsers ignore it over plaintext (plan item 5).
  if (SECURE_CONTEXT) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Static UI
  // First-run: until an admin exists, every page funnels to the setup wizard
  // and the app shell is unreachable (plan item 4).
  if (req.method === 'GET' && (url.pathname === '/setup' || url.pathname === '/setup.html')) {
    return serveFile(path.join(DIR, 'setup.html'), 'text/html; charset=utf-8', res);
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (SETUP_REQUIRED) return redirect(res, '/setup');
    return serveFile(path.join(DIR, 'portal.html'), 'text/html; charset=utf-8', res);
  }

  // Nexus web surface (Cirrus Core — Spark lab control dashboard)
  if (req.method === 'GET' && (url.pathname === '/nexus' || url.pathname === '/nexus.html')) {
    return serveFile(path.join(DIR, 'nexus.html'), 'text/html; charset=utf-8', res);
  }

  // API
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    return handleApi(req, res, url);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
};

// Serve HTTPS directly when a cert + key are configured, else plain HTTP for
// loopback / behind a TLS-terminating reverse proxy (plan item 5).
const server = SERVING_TLS
  ? https.createServer({ cert: TLS_CERT, key: TLS_KEY }, requestListener)
  : http.createServer(requestListener);

function serveFile(file, type, res) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('portal.html missing: ' + file);
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
    });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Session cookie: always HttpOnly + SameSite=Strict; adds `Secure` whenever the
// request reached us over TLS (directly or via a trusted proxy) — plan item 5.
function sessionCookie(value, maxAge) {
  const parts = [`portal_session=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (SECURE_CONTEXT) parts.push('Secure');
  parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function requireRole(user, role) {
  return user && (ROLES[user.role] || 0) >= ROLES[role];
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  // ── First-run setup (plan item 4) — the ONLY live API until an admin exists ──
  if (p === '/api/setup/status') {
    return json(res, 200, setupStatus());
  }
  if (p === '/api/setup' && req.method === 'POST') {
    if (!SETUP_REQUIRED) return json(res, 403, { error: 'setup already complete — use the admin API' });
    const result = completeSetup(await readBody(req));
    if (result.error) {
      audit('setup_failed', null, 'anon', { error: result.error });
      return json(res, 400, { error: result.error, setupRequired: true });
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie(result.session, CONFIG.sessionTtlHours * 3600),
    });
    return res.end(JSON.stringify({ ok: true, user: result.user, csrfToken: result.csrfToken, restartRequired: result.restartRequired, config: result.config }));
  }
  // While setup is pending, refuse everything else: no account can work yet.
  if (SETUP_REQUIRED) {
    return json(res, 503, { error: 'setup required', setupRequired: true, setupUrl: '/setup' });
  }

  // ── Public ──
  if (p === '/api/me') {
    const sess = currentSession(req);
    const u = sess ? findUser(sess.username) : null;
    // defaultCreds=true only if an admin still uses a known-default password.
    // No defaults ship anymore, and the startup guard blocks boot on one — so
    // this is only reachable under PORTAL_ALLOW_INSECURE_DEFAULTS=1 (dev only).
    const defaultCreds = !!(u && u.role === 'admin' &&
      USERS.some(a => a.role === 'admin' && usesKnownDefaultCred(a)));
    return json(res, 200, u
      ? { authed: true, user: publicUser(u), role: u.role, csrfToken: sess.csrf, defaultCreds }
      : { authed: false, defaultCreds: false });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (!originOk(req)) return json(res, 403, { error: 'cross-origin login refused' });
    const body = await readBody(req);
    if (!body || !body.username || !body.password) return json(res, 400, { error: 'username and password required' });
    // Progressive lockout (plan item 6): check before verifying at all.
    const gate = loginGuard(req, body.username);
    if (gate) {
      audit('login_throttled', String(body.username || '?').toLowerCase(), 'anon', { retryAfter: gate.retryAfter });
      res.setHeader('Retry-After', String(gate.retryAfter));
      return json(res, 429, { error: `too many failed attempts — try again in ${gate.retryAfter}s`, retryAfter: gate.retryAfter });
    }
    const u = verifyUser(body.username, body.password);
    if (!u) {
      const r = recordLoginFailure(req, body.username);
      audit('login_failed', String(body.username || '?').toLowerCase(), 'anon',
        r.locked ? { locked: true, retryAfter: r.retryAfter } : { remaining: r.remaining });
      if (r.locked) {
        res.setHeader('Retry-After', String(r.retryAfter));
        return json(res, 429, { error: `too many failed attempts — locked for ${r.retryAfter}s`, retryAfter: r.retryAfter });
      }
      return json(res, 401, { error: 'wrong username or password', remaining: r.remaining });
    }
    clearLoginFailures(req, body.username);
    // Session rotation on login: drop any cookie that arrived with the login
    // request so a fixed/planted session id can never survive authentication.
    destroySession(sessionTokenFromReq(req));
    const tok = createSession(u);
    const sess = sessions.get(tok);
    audit('login', u.username, u.role);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie(tok, Math.floor(sessionTtlMs() / 1000)),
    });
    return res.end(JSON.stringify({ ok: true, user: publicUser(u), csrfToken: sess.csrf }));
  }

  if (p === '/api/logout' && req.method === 'POST') {
    if (!originOk(req)) return json(res, 403, { error: 'cross-origin request refused' });
    const sess = currentSession(req);
    if (sess && !csrfOk(req, sess)) return json(res, 403, { error: 'csrf token missing or invalid' });
    const u = sess ? findUser(sess.username) : null;
    if (u) audit('logout', u.username, u.role);
    destroySession(sessionTokenFromReq(req));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie('', 0) });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Log out everywhere: revoke every session for this user (plan item 6).
  if (p === '/api/logout-all' && req.method === 'POST') {
    if (!originOk(req)) return json(res, 403, { error: 'cross-origin request refused' });
    const sess = currentSession(req);
    if (!sess) return json(res, 401, { error: 'unauthorized' });
    if (!csrfOk(req, sess)) return json(res, 403, { error: 'csrf token missing or invalid' });
    const u = findUser(sess.username);
    const n = destroyUserSessions(sess.username);
    if (u) audit('logout_all', u.username, u.role, { sessions: n });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie('', 0) });
    return res.end(JSON.stringify({ ok: true, sessions: n }));
  }

  // ── Authed below ──
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'unauthorized' });

  // CSRF gate (plan item 6): every state-changing request needs the token bound
  // to this session. Login and setup are handled above (no session yet); every
  // route under here is state-changing or a read and gets the same treatment.
  if (STATE_CHANGING.has(req.method)) {
    if (!originOk(req)) return json(res, 403, { error: 'cross-origin request refused' });
    if (!csrfOk(req, currentSession(req))) {
      audit('csrf_reject', user.username, user.role, { path: p, method: req.method });
      return json(res, 403, { error: 'csrf token missing or invalid' });
    }
  }

  if (p === '/api/agents' && req.method === 'GET') {
    // Fan out agents.list to every configured gateway and merge, tagging each
    // agent with its server. One server down = its agents just don't appear
    // (and the servers[] list says so); everything else keeps working.
    const results = await Promise.allSettled(
      GATEWAYS.map(c => c.connected
        ? c.request('agents.list', {}, 15000).then(payload => ({ client: c, payload }))
        : Promise.resolve({ client: c, payload: null }))
    );
    const agents = [];
    const servers = [];
    for (const r of results) {
      const value = r.status === 'fulfilled' && r.value ? r.value : null;
      const client = value && value.client;
      if (!client) continue;
      const payload = value.payload;
      if (!payload || !Array.isArray(payload.agents)) {
        servers.push({ id: client.id, name: client.name, connected: false, agentCount: 0, error: 'offline' });
        continue;
      }
      const reg = new Map();
      for (const a of payload.agents) {
        const name = a.name || a.id;
        const emoji = (a.identity && a.identity.emoji) || '';
        reg.set(a.id, { name, emoji, default: !!a.default });
        const ref = `${client.id}:${a.id}`;
        AGENT_NAMES.set(ref, { name, emoji });
        if (!AGENT_NAMES.has(a.id)) AGENT_NAMES.set(a.id, { name, emoji });
        agents.push({
          id: a.id,
          name,
          emoji,
          default: !!a.default,
          server: client.id,
          serverName: client.name,
          ref,
          key: `agent:${client.id}:${a.id}:main`,
        });
      }
      AGENT_REGISTRY.set(client.id, reg);
      servers.push({ id: client.id, name: client.name, connected: true, agentCount: payload.agents.length });
    }
    // Drop registries for gateways that were removed from config.
    for (const id of [...AGENT_REGISTRY.keys()]) if (!gw(id)) AGENT_REGISTRY.delete(id);
    const order = new Map(GATEWAYS.map((g, i) => [g.id, i]));
    agents.sort((a, b) => (order.get(a.server) - order.get(b.server)) || String(a.name).localeCompare(String(b.name)));
    let visible = agents;
    if (user.role === 'student') {
      visible = agents.filter(a => agentAllowed(user, a.ref));
    }
    const connected = GATEWAYS.some(g => g.connected);
    return json(res, 200, { agents: visible, all: agents.length, servers, connected, restricted: user.role === 'student' });
  }

  if (p === '/api/history' && req.method === 'GET') {
    const session = url.searchParams.get('session');
    if (!session) return json(res, 400, { error: 'need ?session=' });
    if (!canAccessSession(user, session)) return json(res, 403, { error: 'not allowed for this agent' });
    const client = clientForPortalSession(session);
    if (!client) return json(res, 502, { error: 'agent server offline' });
    const ps = parsePortalSession(session);
    try {
      const payload = await client.request('chat.history', { sessionKey: `agent:${ps.agentId}:main`, maxChars: 200000 }, 20000);
      const messages = (payload.messages || []).map(normalizeMessage).filter(m => m.text);
      return json(res, 200, { session: payload.sessionKey || session, messages });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (p === '/api/send' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.session || !body.message) return json(res, 400, { error: 'need session + message' });
    if (typeof body.message !== 'string' || !body.message.trim()) return json(res, 400, { error: 'empty message' });
    if (!canAccessSession(user, body.session)) return json(res, 403, { error: 'not allowed for this agent' });
    // CI30 context injection: prepend the user's context block so the agent
    // knows who it's helping. Students get injection; instructors/admins send
    // as-is (they're operating the portal, not taking the course).
    let contextBlock = null;
    let finalMessage = body.message;
    if (user.role === 'student') {
      contextBlock = buildContextBlock(user);
      if (contextBlock) finalMessage = `${contextBlock}\n\n—\n\n${body.message}`;
      // Record the student's active-assignment policy for this session so tool
      // receipts can be checked against it (blocked calls get flagged + audited).
      const asg = assignmentById(userContext(user).assignment);
      if (asg && asg.policy) {
        SESSION_POLICY.set(body.session, {
          assignmentId: asg.id,
          blockedTools: new Set(Array.isArray(asg.policy.blockedTools) ? asg.policy.blockedTools : []),
          allowedTools: Array.isArray(asg.policy.allowedTools) && asg.policy.allowedTools.length ? new Set(asg.policy.allowedTools) : null,
        });
      } else {
        SESSION_POLICY.delete(body.session);
      }
    }
    try {
      const client = clientForPortalSession(body.session);
      if (!client) return json(res, 502, { error: 'agent server offline' });
      const ps = parsePortalSession(body.session);
      const payload = await client.request('chat.send', {
        sessionKey: `agent:${ps.agentId}:main`,
        message: finalMessage.slice(0, 16000),
        deliver: false,
        idempotencyKey: crypto.randomUUID(),
      }, 30000);
      audit('send', user.username, user.role, { session: body.session, server: client.id, msg: body.message.slice(0, 120), injected: !!contextBlock });
      return json(res, 200, { runId: payload.runId, status: payload.status, injected: !!contextBlock, context: contextBlock });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (p === '/api/abort' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.session) return json(res, 400, { error: 'need session' });
    if (!canAccessSession(user, body.session)) return json(res, 403, { error: 'not allowed for this agent' });
    try {
      const client = clientForPortalSession(body.session);
      if (!client) return json(res, 502, { error: 'agent server offline' });
      const ps = parsePortalSession(body.session);
      const payload = await client.request('chat.abort', { sessionKey: `agent:${ps.agentId}:main`, runId: body.runId || undefined }, 10000);
      audit('abort', user.username, user.role, { session: body.session, server: client.id });
      return json(res, 200, { ok: true, payload });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // ── Approvals (tool confirmations) ──
  // Staff see all approvals (pending first); students see only approvals on
  // sessions they can access, and never the resolve button. canResolve is
  // server-computed — the UI just renders it.
  if (p === '/api/approvals' && req.method === 'GET') {
    const scopeOk = gatewaysConnected().some(g => !!(g.hello && g.hello.auth && Array.isArray(g.hello.auth.scopes) && g.hello.auth.scopes.includes('operator.approvals')));
    const cutoff = Date.now() - 30 * 60 * 1000; // pending + last 30 min
    let list = [...APPROVALS.values()].filter(a => a.status === 'pending' || (a.ts || a.createdAtMs) >= cutoff);
    if (user.role === 'student') {
      list = list.filter(a => a.sessionKey && canAccessSession(user, a.sessionKey));
    }
    const out = list.map(a => Object.assign({ canResolve: user.role !== 'student' && a.status === 'pending' }, publicApproval(a)));
    out.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAtMs - a.createdAtMs);
    return json(res, 200, { approvals: out, scopeOk });
  }

  if (/^\/api\/approvals\/[^/]+\/resolve$/.test(p) && req.method === 'POST') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'staff only' });
    const id = decodeURIComponent(p.split('/')[3]);
    const body = await readBody(req);
    const decision = body && body.decision;
    if (decision !== 'approve' && decision !== 'deny') return json(res, 400, { error: "decision must be 'approve' or 'deny'" });
    const rec = APPROVALS.get(id);
    if (!rec) return json(res, 404, { error: 'no such approval' });
    if (rec.status !== 'pending') return json(res, 409, { error: 'already ' + rec.status });
    const method = rec.kind === 'exec' ? 'exec.approval.resolve' : 'plugin.approval.resolve';
    // Approval ids are namespaced gwId:rawId — resolve on the owning gateway.
    const ci = id.indexOf(':');
    const client = ci > 0 ? gw(id.slice(0, ci)) : gatewaysConnected()[0] || null;
    const rawId = ci > 0 ? id.slice(ci + 1) : id;
    if (!client) return json(res, 502, { error: 'approval server offline' });
    try {
      await client.request(method, { id: rawId, decision }, 15000);
      rec.decision = decision;
      rec.status = decision === 'approve' ? 'approved' : 'denied';
      rec.resolvedBy = user.username;
      rec.ts = Date.now();
      audit('approval_resolve', user.username, user.role, { id, kind: rec.kind, decision, agent: rec.agentId, session: rec.sessionKey, command: rec.command ? String(rec.command).slice(0, 120) : undefined });
      fanoutApproval(rec);
      return json(res, 200, { ok: true, approval: Object.assign({ canResolve: false }, publicApproval(rec)) });
    } catch (e) {
      audit('approval_resolve_failed', user.username, user.role, { id, decision, error: e.message });
      return json(res, 502, { error: e.message });
    }
  }

  // SSE stream — chat events for one session
  if (p === '/api/stream' && req.method === 'GET') {
    const session = url.searchParams.get('session');
    if (!session) return json(res, 400, { error: 'need ?session=' });
    if (!canAccessSession(user, session)) return json(res, 403, { error: 'not allowed for this agent' });
    const client = clientForPortalSession(session);
    if (!client) return json(res, 502, { error: 'agent server offline' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ session })}\n\n`);
    client.subscribe(session, res);
    const ping = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch { /* dead */ } }, 20000);
    req.on('close', () => {
      clearInterval(ping);
      client.unsubscribe(session, res);
    });
    return; // keep open
  }

  // ── Admin / instructor management ──

  // User list: admin sees everyone; instructor sees students only.
  if (p === '/api/users' && req.method === 'GET') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'admins only' });
    let list = USERS.map(publicUser);
    if (user.role === 'instructor') list = list.filter(u => u.role === 'student');
    return json(res, 200, { users: list });
  }

  if (p === '/api/users' && req.method === 'POST') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const body = await readBody(req);
    if (!body || !body.username || !body.password) return json(res, 400, { error: 'username and password required' });
    const username = String(body.username).toLowerCase().trim();
    if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'username: 2-32 chars, lowercase letters/numbers/._-' });
    const role = ['student', 'instructor', 'admin'].includes(body.role) ? body.role : 'student';
    let agents = Array.isArray(body.agents) ? body.agents.map(String) : [];
    agents = sanitizeAgents(agents);
    if (findUser(username)) return json(res, 409, { error: 'username already exists' });
    // Password policy (length + blocklist, plan item 6) — same bar as the wizard.
    const newPwErr = passwordPolicyError(body.password, username);
    if (newPwErr) return json(res, 400, { error: newPwErr });
    const salt = crypto.randomBytes(16).toString('hex');
    const u = {
      username,
      displayName: String(body.displayName || username).slice(0, 60),
      role,
      agents,
      assignments: [],
      hash: hashPassword(body.password, salt),
      salt,
      createdAt: Date.now(),
    };
    USERS.push(u);
    saveUsers(USERS);
    audit('user_create', user.username, user.role, { target: username, role });
    return json(res, 200, { ok: true, user: publicUser(u) });
  }

  // Reset password
  if (/^\/api\/users\/[^/]+\/password$/.test(p) && req.method === 'POST') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const target = decodeURIComponent(p.split('/')[3]).toLowerCase();
    const body = await readBody(req);
    const u = findUser(target);
    if (!u) return json(res, 404, { error: 'no such user' });
    const resetPwErr = passwordPolicyError(body && body.password, target);
    if (resetPwErr) return json(res, 400, { error: resetPwErr });
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashPassword(body.password, u.salt);
    saveUsers(USERS);
    // A password change must invalidate every existing session for that user.
    const revoked = destroyUserSessions(target);
    audit('user_password', user.username, user.role, { target, sessionsRevoked: revoked });
    return json(res, 200, { ok: true, sessionsRevoked: revoked });
  }

  // Update a user's assigned agents (admin) — lets admins change access
  // after creation, not just at signup time.
  if (/^\/api\/users\/[^/]+\/agents$/.test(p) && req.method === 'POST') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const target = decodeURIComponent(p.split('/')[3]).toLowerCase();
    const body = await readBody(req);
    const u = findUser(target);
    if (!u) return json(res, 404, { error: 'no such user' });
    const agents = sanitizeAgents(Array.isArray(body && body.agents) ? body.agents.map(String) : []);
    u.agents = agents;
    saveUsers(USERS);
    audit('user_agents', user.username, user.role, { target, agents });
    return json(res, 200, { ok: true, user: publicUser(u) });
  }

  // Delete user
  if (/^\/api\/users\/[^/]+$/.test(p) && req.method === 'DELETE') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const target = decodeURIComponent(p.split('/')[3]).toLowerCase();
    const u = findUser(target);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.username === user.username) return json(res, 400, { error: 'cannot delete yourself' });
    if (u.role === 'admin' && USERS.filter(x => x.role === 'admin').length <= 1) return json(res, 400, { error: 'cannot delete the last admin' });
    USERS = USERS.filter(x => x.username !== target);
    saveUsers(USERS);
    destroyUserSessions(target);
    audit('user_delete', user.username, user.role, { target });
    return json(res, 200, { ok: true });
  }

  // ── Context injection API (CI30) ──
  // View course + context state. Students see their own context + the exact
  // block that will be injected; instructors/admins see everyone's.
  if (p === '/api/context' && req.method === 'GET') {
    const course = CONTEXT_STORE.course;
    let users = null;
    if (user.role !== 'student') {
      users = {};
      for (const u of USERS) users[u.username] = { context: CONTEXT_STORE.users[u.username] || {} };
    }
    const own = { context: userContext(user), block: buildContextBlock(user) };
    return json(res, 200, { course, own, users });
  }

  // Edit course context (instructor+)
  if (p === '/api/context/course' && req.method === 'POST') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'instructors and admins only' });
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad body' });
    const course = CONTEXT_STORE.course;
    if (typeof body.code === 'string') course.code = String(body.code).slice(0, 20);
    if (typeof body.name === 'string') course.name = String(body.name).slice(0, 80);
    if (typeof body.term === 'string') course.term = String(body.term).slice(0, 40);
    if (typeof body.syllabus === 'string') course.syllabus = String(body.syllabus).slice(0, 2000);
    if (Array.isArray(body.assignments)) {
      course.assignments = body.assignments.slice(0, 20).map(a => {
        const out = {
          id: String(a.id || '').slice(0, 20),
          title: String(a.title || '').slice(0, 80),
          due: String(a.due || '').slice(0, 40),
          brief: String(a.brief || '').slice(0, 500),
        };
        if (a.policy && typeof a.policy === 'object') {
          const p = out.policy = {};
          if (Array.isArray(a.policy.allowedTools)) p.allowedTools = a.policy.allowedTools.map(String).slice(0, 12).map(s => s.slice(0, 40));
          if (Array.isArray(a.policy.blockedTools)) p.blockedTools = a.policy.blockedTools.map(String).slice(0, 12).map(s => s.slice(0, 40));
          if (Array.isArray(a.policy.rules)) p.rules = a.policy.rules.map(String).slice(0, 12).map(s => s.slice(0, 300));
        }
        return out;
      }).filter(a => a.id && a.title);
    }
    saveContextStore(CONTEXT_STORE);
    audit('context_course', user.username, user.role, { code: course.code });
    return json(res, 200, { ok: true, course });
  }

  // Edit a user's context (instructor+; instructors may only edit students)
  if (/^\/api\/users\/[^/]+\/context$/.test(p) && req.method === 'POST') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'instructors and admins only' });
    const target = decodeURIComponent(p.split('/')[3]).toLowerCase();
    const u = findUser(target);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (user.role === 'instructor' && u.role !== 'student') return json(res, 403, { error: 'instructors can only edit student contexts' });
    const body = await readBody(req);
    const ctx = CONTEXT_STORE.users[target] || {};
    if (body && typeof body.enabled === 'boolean') ctx.enabled = body.enabled;
    if (body && typeof body.profile === 'string') ctx.profile = String(body.profile).slice(0, 500);
    if (body && typeof body.assignment === 'string') ctx.assignment = String(body.assignment).slice(0, 20);
    if (body && typeof body.notes === 'string') ctx.notes = String(body.notes).slice(0, 1000);
    CONTEXT_STORE.users[target] = ctx;
    saveContextStore(CONTEXT_STORE);
    audit('context_user', user.username, user.role, { target });
    return json(res, 200, { ok: true, context: ctx });
  }

  // Audit log — admins only
  if (p === '/api/audit' && req.method === 'GET') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
    return json(res, 200, { entries: readAudit(limit) });
  }

  // ── Gateway management (admin: Gateways view, Aug 2026) ───────────────
  // Admin can add/remove/edit gateway servers from the UI without touching
  // portal-config.json by hand or restarting the portal. Runtime state
  // (connected, agentCount) comes from the live client farm; config is
  // persisted via saveConfig(). Tokens are write-only: we never echo them
  // back, only whether one is set.

  // GET /api/gateways — list configured gateways + live status
  if (p === '/api/gateways' && req.method === 'GET') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const list = CONFIG.gateways.map(g => {
      const c = GATEWAY_BY_ID.get(g.id) || null;
      return {
        id: g.id,
        name: g.name,
        url: g.url,
        origin: g.origin || '',
        enabled: g.enabled !== false,
        hasToken: typeof g.token === 'string' && g.token.length > 0,
        connected: !!(c && c.connected),
        agentCount: AGENT_REGISTRY.get(g.id) ? AGENT_REGISTRY.get(g.id).size : 0,
      };
    });
    return json(res, 200, { gateways: list });
  }

  // POST /api/gateways — add a gateway (starts connecting immediately)
  if (p === '/api/gateways' && req.method === 'POST') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const body = await readBody(req);
    const r = createGateway(body);
    if (r.error) return json(res, r.status || 400, { error: r.error });
    const g = r.gateway;
    CONFIG.gateways.push(g);
    saveConfig(); // writes the token to portal-secrets.json (0600), not the config
    if (g.enabled) startGateway(g);
    audit('gateway_add', user.username, user.role, { id: g.id, name: g.name, url: g.url, enabled: g.enabled, hasToken: !!g.token });
    return json(res, 200, { ok: true, gateway: { id: g.id, name: g.name, url: g.url, enabled: g.enabled, hasToken: !!g.token, connected: false } });
  }

  // PATCH /api/gateways/:id — edit name/url/token/origin/enabled
  if (/^\/api\/gateways\/[^/]+$/.test(p) && req.method === 'PATCH') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const id = decodeURIComponent(p.split('/')[3]);
    const g = CONFIG.gateways.find(x => x.id === id);
    if (!g) return json(res, 404, { error: 'no such gateway' });
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'empty body' });
    const urlChanged = typeof body.url === 'string' && body.url.trim() && body.url.trim() !== g.url;
    if (urlChanged) {
      if (!/^wss?:\/\//i.test(body.url.trim())) return json(res, 400, { error: 'url must start with ws:// or wss://' });
      g.url = body.url.trim();
    }
    if (typeof body.name === 'string' && body.name.trim()) g.name = String(body.name).trim().slice(0, 60);
    const tokenChanged = typeof body.token === 'string' && body.token.trim() && body.token.trim() !== g.token;
    if (tokenChanged) { g.token = String(body.token).trim(); g.tokenSource = 'runtime'; }
    if (typeof body.origin === 'string') g.origin = String(body.origin).trim();
    if (typeof body.enabled === 'boolean') g.enabled = body.enabled;
    saveConfig(); // token goes to portal-secrets.json (0600); config stays token-free
    // URL/token edits must reconnect now, even if the client is live.
    if (urlChanged || tokenChanged) {
      stopGateway(g.id);
      if (g.enabled) startGateway(g);
    } else {
      startOrRestartGateway(g);
    }
    audit('gateway_update', user.username, user.role, { id, fields: Object.keys(body), enabled: g.enabled, tokenChanged });
    return json(res, 200, { ok: true, gateway: { id: g.id, name: g.name, url: g.url, enabled: g.enabled, hasToken: !!g.token, connected: !!(GATEWAY_BY_ID.get(id) && GATEWAY_BY_ID.get(id).connected) } });
  }

  // DELETE /api/gateways/:id — remove entirely (config + client)
  if (/^\/api\/gateways\/[^/]+$/.test(p) && req.method === 'DELETE') {
    if (!requireRole(user, 'admin')) return json(res, 403, { error: 'admins only' });
    const id = decodeURIComponent(p.split('/')[3]);
    if (!CONFIG.gateways.some(x => x.id === id)) return json(res, 404, { error: 'no such gateway' });
    stopGateway(id);
    CONFIG.gateways = CONFIG.gateways.filter(x => x.id !== id);
    saveConfig(); // also prunes the gateway token from portal-secrets.json
    audit('gateway_remove', user.username, user.role, { id });
    return json(res, 200, { ok: true });
  }

  // ── Instructor dashboard v1 (Phase I, Aug 7 2026) ──
  // One lean aggregation endpoint: roster + activity + policy violations.
  if (p === '/api/dashboard' && req.method === 'GET') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'instructors and admins only' });
    const students = USERS.filter(u => u.role === 'student');
    const studentNames = new Set(students.map(s => s.username));
    const entries = readAudit(3000);
    const relevant = entries.filter(e => {
      if (studentNames.has(e.user)) return true;
      const d = e.detail;
      return !!(d && typeof d === 'object' && studentNames.has(d.target));
    });
    const dayAgo = Date.now() - 86400000;
    const blocks = relevant.filter(e => e.action === 'tool_policy_block');
    const sends = relevant.filter(e => e.action === 'send' || e.action === 'message' || e.action === 'room_message');
    const rows = students.map(s => {
      const ctx = CONTEXT_STORE.users[s.username] || {};
      const aId = ctx.assignment || (Array.isArray(s.assignments) && s.assignments[0]) || null;
      const a = aId ? assignmentById(aId) : null;
      const last = relevant.find(e => e.user === s.username || (e.detail && e.detail.target === s.username));
      return {
        username: s.username,
        displayName: s.displayName,
        agents: s.agents || [],
        assignment: aId,
        assignmentTitle: a ? a.title : null,
        contextEnabled: ctx.enabled !== false,
        lastSeen: last ? last.ts : null,
      };
    });
    const byAssignment = {};
    for (const r of rows) {
      const k = r.assignment || 'none';
      byAssignment[k] = (byAssignment[k] || 0) + 1;
    }
    return json(res, 200, {
      course: CONTEXT_STORE.course || null,
      stats: {
        students: students.length,
        active24h: relevant.filter(e => e.ts >= dayAgo).length,
        sends: sends.length,
        policyBlocks: blocks.length,
        assignments: (CONTEXT_STORE.course.assignments || []).length,
      },
      byAssignment,
      rows,
      blocks: blocks.slice(0, 12),
      recent: relevant.slice(0, 25),
    });
  }

  // ── Rooms (group chat / panel mode) — instructor+ ──
  if (p === '/api/rooms' && req.method === 'GET') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'instructors and admins only' });
    return json(res, 200, { rooms: [...ROOMS.values()].map(roomSummary) });
  }

  if (p === '/api/rooms' && req.method === 'POST') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'instructors and admins only' });
    const body = await readBody(req);
    if (!body || !body.name || !Array.isArray(body.agents) || !body.agents.length) return json(res, 400, { error: 'need name + agents[]' });
    if (body.agents.length > 12) return json(res, 400, { error: 'max 12 agents per room' });
    const mode = body.mode === 'free' ? 'free' : 'rounds';
    // Resolve bare ids to server-qualified refs when possible; unresolvable
    // (offline server) refs stay as-is and are re-resolved at round time.
    const agents = sanitizeAgents(body.agents.map(String)).map(a => {
      const t = resolveAgentRef(a);
      return t ? `${t.gwId}:${t.agentId}` : a;
    });
    if (!agents.length) return json(res, 400, { error: 'no valid agents' });
    if (mode === 'free' && agents.length < 2) return json(res, 400, { error: 'free-flow rooms need at least 2 agents' });
    for (const a of agents) {
      if (!agentAllowed(user, a)) return json(res, 403, { error: `not allowed to add agent: ${a}` });
    }
    const id = 'room_' + Date.now().toString(36) + '_' + (roomSeq++);
    const room = {
      id, name: String(body.name).slice(0, 60), agents, transcript: [],
      round: 0, mode, paused: false,
      status: 'idle', currentAgent: null, currentRunId: null, stopRequested: false,
      createdAt: Date.now(), createdBy: user.username,
      msgSeq: 0, burstUsed: 0, ffReplied: new Map(), ffRunning: false,
    };
    ROOMS.set(id, room);
    saveRooms();
    audit('room_create', user.username, user.role, { room: id, name: room.name, agents, mode });
    return json(res, 200, { ok: true, room: roomPublic(room) });
  }

  // Room actions + detail
  if (/^\/api\/rooms\/[^/]+$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[3]);
    const room = ROOMS.get(id);
    if (!room) return json(res, 404, { error: 'no such room' });
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'instructors and admins only' });

    if (req.method === 'GET') return json(res, 200, { room: roomPublic(room) });

    if (req.method === 'DELETE') {
      if (user.role !== 'admin' && room.createdBy !== user.username) return json(res, 403, { error: 'only creator or admin can delete' });
      room.stopRequested = true;
      ROOMS.delete(id);
      saveRooms();
      audit('room_delete', user.username, user.role, { room: id });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = body && body.action;
      if (action === 'message') {
        const text = body.text;
        if (!text || !String(text).trim()) return json(res, 400, { error: 'need text' });
        pushRoomMsg(room, 'user', String(text).slice(0, 4000));
        room.paused = false; // a human beat resumes an auto-paused room
        audit('room_message', user.username, user.role, { room: id, msg: String(text).slice(0, 120) });
        if (room.mode === 'free') {
          room.burstUsed = 0; // each human message grants a fresh burst budget
          freeflowTick(room).catch(e => console.error('[portal] freeflow error:', e.message));
        } else {
          runRound(room, user.username).catch(e => console.error('[portal] round error:', e.message));
        }
        return json(res, 200, { ok: true, room: roomPublic(room) });
      }
      if (action === 'round') {
        if (room.mode === 'free') return json(res, 400, { error: 'room is free-flowing — use pause/resume or send a message' });
        room.paused = false; // explicit "next round" resumes an auto-paused room
        runRounds(room, user.username, body.rounds).catch(e => console.error('[portal] round error:', e.message));
        return json(res, 200, { ok: true, room: roomPublic(room) });
      }
      if (action === 'pause') {
        if (room.mode !== 'free') return json(res, 400, { error: 'only free-flow rooms can be paused' });
        room.paused = true;
        saveRooms();
        emitRoom(room, 'status', { status: 'paused', round: room.round, currentAgent: null });
        audit('room_pause', user.username, user.role, { room: id });
        return json(res, 200, { ok: true, room: roomPublic(room) });
      }
      if (action === 'resume') {
        if (room.mode !== 'free') return json(res, 400, { error: 'only free-flow rooms can be resumed' });
        room.paused = false;
        saveRooms();
        emitRoom(room, 'status', { status: 'idle', round: room.round, currentAgent: null });
        audit('room_resume', user.username, user.role, { room: id });
        freeflowTick(room).catch(e => console.error('[portal] freeflow error:', e.message));
        return json(res, 200, { ok: true, room: roomPublic(room) });
      }
      if (action === 'stop') {
        stopRoomRound(room).catch(() => {});
        audit('room_stop', user.username, user.role, { room: id });
        if (room.mode === 'free') emitRoom(room, 'status', { status: 'paused', round: room.round, currentAgent: null });
        return json(res, 200, { ok: true, room: roomPublic(room) });
      }
      if (action === 'agents') {
        if (user.role !== 'admin' && room.createdBy !== user.username) return json(res, 403, { error: 'only creator or admin can change agents' });
        if (!Array.isArray(body.agents) || !body.agents.length) return json(res, 400, { error: 'need agents[]' });
        const agents = sanitizeAgents(body.agents.map(String));
        for (const a of agents) {
          if (!agentAllowed(user, a)) return json(res, 403, { error: `not allowed to add agent: ${a}` });
        }
        room.agents = agents;
        saveRooms();
        audit('room_agents', user.username, user.role, { room: id, agents });
        return json(res, 200, { ok: true, room: roomPublic(room) });
      }
      return json(res, 400, { error: 'unknown action' });
    }
  }

  // Room SSE stream
  if (/^\/api\/rooms\/[^/]+\/stream$/.test(p) && req.method === 'GET') {
    if (!requireRole(user, 'instructor')) return json(res, 403, { error: 'instructors and admins only' });
    const id = decodeURIComponent(p.split('/')[3]);
    const room = ROOMS.get(id);
    if (!room) return json(res, 404, { error: 'no such room' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ room: id })}\n\n`);
    if (!roomSubs.has(id)) roomSubs.set(id, new Set());
    roomSubs.get(id).add(res);
    const ping = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch { /* dead */ } }, 20000);
    req.on('close', () => {
      clearInterval(ping);
      const s = roomSubs.get(id);
      if (s) { s.delete(res); if (s.size === 0) roomSubs.delete(id); }
    });
    return; // keep open
  }

  json(res, 404, { error: 'not found' });
}

// ── Main ────────────────────────────────────────────────────────────────────
// Safe network defaults first: loopback unless explicitly opted out of.
assertNetworkPolicy();
// Then the TLS gate: refuses to bind a public interface in cleartext unless
// explicitly allowed.
assertTlsPolicy();
const SCHEME = SERVING_TLS ? 'https' : 'http';
server.listen(CONFIG.port, CONFIG.bind, () => {
  console.log(`🟠 ${BRAND.product} — ${BRAND.tagline}`);
  console.log(`   ${BRAND.family} · engine: ${BRAND.engine} · ${BRAND.slug}`);
  console.log(`   listen:  ${SCHEME}://${CONFIG.bind}:${CONFIG.port}${isWildcardBind(CONFIG.bind) ? '  (all interfaces)' : ''}`);
  if (isLoopbackBind(CONFIG.bind)) {
    console.log('   net:     loopback only — not reachable off-host (use --domain, or PORTAL_PUBLIC_BIND=1 + TLS, to expose)');
  } else {
    console.log('   net:     ⚠ PUBLIC — reachable off-host; add a firewall rule (ufw allow 80,443/tcp) and keep TLS on');
  }
  if (SERVING_TLS) {
    console.log(`   tls:     ON (served directly) — cert ${CONFIG.tlsCert}`);
  } else if (TRUST_PROXY) {
    console.log(`   tls:     terminated by a reverse proxy (tlsMode ${CONFIG.tlsMode}) — Secure cookies + HSTS on`);
  } else if (isLoopbackBind(CONFIG.bind)) {
    console.log('   tls:     off (loopback only — reachable from this host)');
  } else {
    console.log('   tls:     ⚠ OFF — explicit insecure-plaintext public bind');
  }
  for (const g of GATEWAYS) console.log(`   gateway ${g.id} (${g.name}): ${g.cfg.url}`);
  {
    const withTok = CONFIG.gateways.filter(g => g.token).length;
    const envTok = CONFIG.gateways.filter(g => isEnvTokenSource(g.tokenSource)).length;
    const src = fs.existsSync(SECRETS_PATH) ? 'portal-secrets.json (0600)' : 'env/none';
    console.log(`   secrets: ${src} — ${withTok}/${CONFIG.gateways.length} gateway token(s)${envTok ? `, ${envTok} from env` : ''}`);
  }
  console.log(`   device:  ${DEVICE.deviceId.slice(0, 12)}…`);
  console.log(`   users:   ${USERS.length} account(s) — ${USERS.filter(u => u.role === 'admin').length} admin, ${USERS.filter(u => u.role === 'instructor').length} instructor, ${USERS.filter(u => u.role === 'student').length} student`);
  if (SETUP_REQUIRED) {
    console.log('   setup:   REQUIRED — no accounts yet. Open the wizard to create the first admin:');
    console.log(`            ${SCHEME}://${isLoopbackBind(CONFIG.bind) || isWildcardBind(CONFIG.bind) ? '<this-host>' : CONFIG.bind}:${CONFIG.port}/setup`);
    console.log('            (all other routes are refused until setup completes — there is no default login)');
  }
  console.log('   ready.');
});
server.on('error', (e) => {
  console.error('[portal] http server error:', e.message);
  process.exit(1);
});

process.on('SIGINT', () => { for (const g of GATEWAYS) g.destroyed = true; process.exit(0); });
process.on('SIGTERM', () => { for (const g of GATEWAYS) g.destroyed = true; process.exit(0); });
