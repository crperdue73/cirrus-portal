#!/usr/bin/env node
'use strict';
/**
 * test-migrate.js — smoke test for plan item 15 (2.x → 3.x migration path).
 *
 * migrate.js is the tool that carries a live 2.x install onto the 3.x schema,
 * so this test builds a realistic 2.x state in a temp dir and drives the real
 * script over it:
 *
 *   A. --dry-run reads + plans but writes NOTHING (byte-identical state, no
 *      secrets file, no snapshot)
 *   B. a live run migrates the config schema (tokens + portalPassword →
 *      0600 secrets, new 3.x keys, schemaVersion stamp), maps the legacy role
 *      model, rotates known-default credentials, and takes a backup first
 *   C. re-running is a no-op (exit 2 — idempotent, no second rotation)
 *   D. --domain / --tls re-expose safely (auto TLS / manual TLS)
 *   E. --allow-insecure-plaintext keeps a deliberate cleartext public bind
 *   F. the migrator's default-password list never drifts from the server's
 *   G. the migrated state actually BOOTS the real portal-server.js (passes the
 *      no-default-credentials, network, and TLS gates)
 *   H. run against a COPY of the real repo state (when present)
 *
 * Zero dependencies. Run: node test-migrate.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const SRC = __dirname;
const MIGRATE = path.join(SRC, 'migrate.js');
let pass = 0;

function scryptHash(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function mkUser(username, role, password, agents) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { username, displayName: username, role, agents, createdAt: 1, salt, hash: scryptHash(password, salt) };
}
function hashMatches(store, username, password) {
  const u = (store.users || []).find(x => x.username === username);
  if (!u) return false;
  const h = Buffer.from(scryptHash(password, u.salt), 'hex');
  const want = Buffer.from(u.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const mode = f => (fs.statSync(f).mode & 0o777).toString(8);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-migrate-'));

// A believable 2.x install: public cleartext bind, plaintext tokens in config,
// the shared bootstrap password, a demo instructor on a legacy role alias, and
// an admin still on admin/admin.
function seedV2(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const config = {
    port: 18800,
    bind: '0.0.0.0',
    gateways: [
      { id: 'home', name: 'Home (188)', url: 'ws://127.0.0.1:18790', token: 'pocket-aegis-root-2026', enabled: true },
      { id: 'lab', name: 'Lab', url: 'ws://192.168.1.111:18789', token: 'e3d063b9f3e9b62d2b823f8725764d2f', enabled: false },
    ],
    portalPassword: 'perdue-portal-2026',
    sessionTtlHours: 12,
  };
  fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(config, null, 2));
  const users = {
    users: [
      mkUser('admin', 'admin', 'admin', ['*']),
      mkUser('instructor', 'teacher', 'instructor-demo', ['*']),
      mkUser('student', 'student', 'S0me-Learner-Pass-9', ['willow']),
    ],
  };
  fs.writeFileSync(path.join(dir, 'portal-users.json'), JSON.stringify(users, null, 2));
  // A REAL ed25519 device identity (mirrors portal-server.js loadOrCreateDevice)
  // so the boot test in section G does not crash signing an invalid seed.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = pkcs8.slice(pkcs8.length - 32);
  const b64u = b => Buffer.from(b).toString('base64url');
  fs.writeFileSync(path.join(dir, 'portal-device.json'), JSON.stringify({
    deviceId: crypto.createHash('sha256').update(pubRaw).digest('hex'),
    seed: b64u(seed), pub: b64u(pubRaw),
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'portal-rooms.json'), JSON.stringify({ rooms: [] }));
  fs.writeFileSync(path.join(dir, 'portal-context.json'), JSON.stringify({ users: {}, course: {} }));
  return { config, users };
}
function runMigrate(dir, args) {
  return spawnSync('node', [MIGRATE, '--dir', dir].concat(args || []), { encoding: 'utf8' });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function waitHttp(port, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', () => { if (Date.now() > deadline) resolve(0); else setTimeout(tick, 200); });
      req.on('timeout', () => { req.destroy(); if (Date.now() > deadline) resolve(0); else setTimeout(tick, 200); });
    };
    tick();
  });
}

async function main() {
  // ── A. dry-run is read-only ────────────────────────────────────────────────
  {
    const dir = tmp();
    seedV2(dir);
    const before = {};
    for (const f of ['portal-config.json', 'portal-users.json']) before[f] = fs.readFileSync(path.join(dir, f), 'utf8');
    const r = runMigrate(dir, ['--dry-run']);
    assert.equal(r.status, 0, `A: dry-run should exit 0 (got ${r.status})\n${r.stderr}`);
    assert(/DRY-RUN/.test(r.stdout), 'A: dry-run must announce DRY-RUN mode');
    assert(/moved gateway "home" token/.test(r.stdout), 'A: plan must show the token relocation');
    assert(/ROTATED known-default password for "admin"/.test(r.stdout), 'A: plan must show the admin rotation');
    for (const f of Object.keys(before)) {
      assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), before[f], `A: dry-run must not modify ${f}`);
    }
    assert(!fs.existsSync(path.join(dir, 'portal-secrets.json')), 'A: dry-run must not create the secrets file');
    assert(!fs.existsSync(path.join(dir, 'backups')), 'A: dry-run must not write a snapshot');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ A: --dry-run plans + rotates on paper, writes nothing');
    pass++;
  }

  // ── B. live run migrates schema + rotates credentials + backs up ───────────
  {
    const dir = tmp();
    const seed = seedV2(dir);
    const seedConfigBytes = fs.readFileSync(path.join(dir, 'portal-config.json'), 'utf8');
    const r = runMigrate(dir, []);
    assert.equal(r.status, 0, `B: live run should exit 0 (got ${r.status})\n${r.stderr}`);

    const cfg = readJson(path.join(dir, 'portal-config.json'));
    assert.equal(cfg.schemaVersion, 3, 'B: config must be stamped schemaVersion 3');
    assert.equal(cfg.bind, '127.0.0.1', 'B: a cleartext public bind must fail closed to loopback');
    assert.equal(cfg.publicBind, false, 'B: publicBind must be false after fail-closed');
    assert(!('portalPassword' in cfg), 'B: legacy portalPassword must be gone from config');
    assert(!JSON.stringify(cfg.gateways).includes('token'), 'B: no gateway token may remain in config');
    assert.equal(cfg.sessionIdleMinutes, 0, 'B: sessionIdleMinutes default added');
    assert.equal(cfg.loginMaxAttempts, 5, 'B: loginMaxAttempts default added');
    assert.equal(cfg.gateways.length, 2, 'B: both gateways preserved (incl. disabled)');

    const sec = readJson(path.join(dir, 'portal-secrets.json'));
    assert.equal(sec.gatewayTokens.home, 'pocket-aegis-root-2026', 'B: home token moved into secrets');
    assert.equal(sec.gatewayTokens.lab, 'e3d063b9f3e9b62d2b823f8725764d2f', 'B: lab token moved into secrets');
    assert.notEqual(sec.portalPassword, 'perdue-portal-2026', 'B: bootstrap portalPassword must be rotated');
    assert(sec.portalPassword.length >= 12, 'B: rotated bootstrap password must be strong');
    assert.equal(mode(path.join(dir, 'portal-secrets.json')), '600', 'B: secrets file must be 0600');

    const users = readJson(path.join(dir, 'portal-users.json'));
    const instr = users.users.find(u => u.username === 'instructor');
    assert.equal(instr.role, 'instructor', 'B: legacy role "teacher" → "instructor"');
    assert(!hashMatches(users, 'admin', 'admin'), 'B: admin/admin must no longer work');
    assert(!hashMatches(users, 'instructor', 'instructor-demo'), 'B: demo password must no longer work');
    assert(hashMatches(users, 'student', 'S0me-Learner-Pass-9'), 'B: a strong non-default password must be untouched');
    assert.deepEqual(users.users.find(u => u.username === 'student').agents, ['willow'], 'B: agents preserved');
    assert.notEqual(seed.users.users[0].hash, users.users[0].hash, 'B: admin hash actually changed');

    const credFile = path.join(dir, 'portal-credentials.txt');
    assert(fs.existsSync(credFile), 'B: rotated passwords must be written to portal-credentials.txt');
    assert.equal(mode(credFile), '600', 'B: credentials file must be 0600');
    const credText = fs.readFileSync(credFile, 'utf8');
    assert(/admin/.test(credText) && /instructor/.test(credText), 'B: creds file lists both rotated accounts');
    const adminPw = (credText.split('\n').find(l => /^\S+\s+admin\s+/.test(l)) || '').trim().split(/\s+/).pop();
    assert(adminPw && hashMatches(users, 'admin', adminPw), 'B: the password in the creds file must verify for admin');

    const backups = fs.readdirSync(path.join(dir, 'backups')).filter(n => n.startsWith('migrate-'));
    assert.equal(backups.length, 1, 'B: exactly one pre-migration snapshot expected');
    const snap = path.join(dir, 'backups', backups[0]);
    assert.equal(mode(snap), '700', 'B: snapshot dir must be 0700');
    assert.equal(fs.readFileSync(path.join(snap, 'portal-config.json'), 'utf8'), seedConfigBytes,
      'B: snapshot must hold the exact pre-migration config');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ B: live run — schema 3, tokens→secrets, role map, rotation, snapshot');
    pass++;
  }

  // ── C. idempotent: a second run is a no-op ─────────────────────────────────
  {
    const dir = tmp();
    seedV2(dir);
    assert.equal(runMigrate(dir, []).status, 0, 'C: first run should succeed');
    const after1 = {};
    for (const f of ['portal-config.json', 'portal-secrets.json', 'portal-users.json']) after1[f] = fs.readFileSync(path.join(dir, f), 'utf8');
    const r2 = runMigrate(dir, []);
    assert.equal(r2.status, 2, `C: second run should report "nothing to do" via exit 2 (got ${r2.status})\n${r2.stdout}`);
    for (const f of Object.keys(after1)) {
      assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), after1[f], `C: second run must not touch ${f}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ C: second run is a no-op (exit 2, byte-identical state)');
    pass++;
  }

  // ── D. safe re-exposure flags ──────────────────────────────────────────────
  {
    const d1 = tmp(); seedV2(d1);
    assert.equal(runMigrate(d1, ['--domain', 'portal.example.com']).status, 0, 'D: --domain run failed');
    const c1 = readJson(path.join(d1, 'portal-config.json'));
    assert.equal(c1.bind, '127.0.0.1', 'D: --domain keeps the portal on loopback (Caddy fronts it)');
    assert.equal(c1.tlsMode, 'auto', 'D: --domain sets tlsMode auto');
    assert.equal(c1.trustProxy, true, 'D: --domain sets trustProxy');
    assert.equal(c1.publicBind, false, 'D: --domain does not set publicBind');

    const d2 = tmp(); seedV2(d2);
    const certPath = path.join(d2, 'fullchain.pem'); const keyPath = path.join(d2, 'privkey.pem');
    fs.writeFileSync(certPath, 'CERT'); fs.writeFileSync(keyPath, 'KEY');
    assert.equal(runMigrate(d2, ['--tls-cert', certPath, '--tls-key', keyPath]).status, 0, 'D: --tls-cert run failed');
    const c2 = readJson(path.join(d2, 'portal-config.json'));
    assert.equal(c2.tlsMode, 'manual', 'D: --tls-cert sets tlsMode manual');
    assert.equal(c2.publicBind, true, 'D: TLS on a public bind keeps publicBind true');
    fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
    console.log('✓ D: --domain / --tls-cert re-expose safely');
    pass++;
  }

  // ── E. explicit cleartext opt-in is honored ────────────────────────────────
  {
    const dir = tmp(); seedV2(dir);
    assert.equal(runMigrate(dir, ['--allow-insecure-plaintext']).status, 0, 'E: insecure run failed');
    const cfg = readJson(path.join(dir, 'portal-config.json'));
    assert.equal(cfg.bind, '0.0.0.0', 'E: explicit cleartext keeps the public bind');
    assert.equal(cfg.publicBind, true, 'E: publicBind true for the preserved public bind');
    assert.equal(cfg.insecurePlaintext, true, 'E: insecurePlaintext recorded');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✓ E: --allow-insecure-plaintext preserves a deliberate public bind');
    pass++;
  }

  // ── F. default-password list never drifts from the server ──────────────────
  {
    function extractArray(file, name) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      const m = src.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
      assert(m, `F: could not find ${name} in ${file}`);
      return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    }
    const a = extractArray('migrate.js', 'KNOWN_DEFAULT_PASSWORDS');
    const b = extractArray('portal-server.js', 'KNOWN_DEFAULT_PASSWORDS');
    assert.deepEqual(a, b, 'F: migrate.js KNOWN_DEFAULT_PASSWORDS must match portal-server.js');
    console.log('✓ F: migrator default-password list matches the server (' + a.length + ' entries)');
    pass++;
  }

  // ── G. the migrated state actually boots the real server ───────────────────
  {
    const dir = tmp();
    seedV2(dir);
    assert.equal(runMigrate(dir, []).status, 0, 'G: migration failed');
    // The server reads state from its own dir, so copy the runtime into the temp dir.
    for (const f of ['portal-server.js', 'branding.json', 'portal.html', 'setup.html']) {
      if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
    }
    // Point the migrated gateways at an unused port so the boot test never
    // contacts (or spams the pairing list of) the live gateway on this host.
    const gwPort = await freePort();
    const bootCfg = readJson(path.join(dir, 'portal-config.json'));
    for (const g of bootCfg.gateways) g.url = `ws://127.0.0.1:${gwPort}`;
    fs.writeFileSync(path.join(dir, 'portal-config.json'), JSON.stringify(bootCfg, null, 2));
    const port = await freePort();
    const child = spawn('node', [path.join(dir, 'portal-server.js')], {
      cwd: dir, env: Object.assign({}, process.env, { PORT: String(port), BIND: '127.0.0.1' }),
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const code = await waitHttp(port, 8000);
    child.kill('SIGKILL');
    assert(code, `G: the migrated server never answered on :${port}\n${out}`);
    assert(!/FATAL/.test(out), `G: migrated state tripped a boot guard (FATAL)\n${out}`);
    assert([200, 302, 401].includes(code), `G: unexpected status ${code}`);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`✓ G: migrated state boots the real server (HTTP ${code}, no boot-guard FATAL)`);
    pass++;
  }

  // ── H. run against a COPY of the real repo state ───────────────────────────
  {
    const cfgPath = path.join(SRC, 'portal-config.json');
    const usrPath = path.join(SRC, 'portal-users.json');
    if (fs.existsSync(cfgPath) && fs.existsSync(usrPath)) {
      const dir = tmp();
      for (const f of ['portal-config.json', 'portal-users.json', 'portal-device.json', 'portal-rooms.json', 'portal-context.json']) {
        if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
      }
      const realCfg = readJson(cfgPath);
      const r = runMigrate(dir, []);
      assert.equal(r.status, 0, `H: real-state migration failed\n${r.stderr}\n${r.stdout}`);
      const migrated = readJson(path.join(dir, 'portal-config.json'));
      assert.equal(migrated.schemaVersion, 3, 'H: real-state copy must reach schema 3');
      if (realCfg.bind && realCfg.bind !== '127.0.0.1') {
        assert.equal(migrated.bind, '127.0.0.1', 'H: real public bind must fail closed');
      }
      assert(!JSON.stringify(migrated).includes('perdue-portal-2026'), 'H: shared bootstrap password must be gone from config');
      console.log('✓ H: migrates a copy of the real repo state cleanly');
      pass++;
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      console.log('· H: skipped (no real portal-config.json/portal-users.json in the repo)');
    }
  }

  console.log(`\n✓ test-migrate.js: ${pass} check(s) passed`);
}

main().catch(e => { console.error('✗ test-migrate.js FAILED:', e.message); process.exit(1); });
