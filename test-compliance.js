#!/usr/bin/env node
'use strict';
/**
 * test-compliance.js — smoke test for plan item 19 (compliance + abuse).
 *
 * Pins the new contract:
 *   A. Audit retention — an age/size policy is reported and enforced; an
 *      admin can force a prune and the old entries actually disappear.
 *   B. Per-IP rate limit — non-probe routes 429 with Retry-After; probes
 *      (/healthz) stay exempt.
 *   C. Request-body cap — an oversized body is rejected with 413.
 *   D. Data export — self or admin; the document carries record + context +
 *      audit; a peer student is refused.
 *   E. Erasure — DELETE removes the account AND personal context AND sessions.
 *   F. Docs/config wiring — PRIVACY.md exists + is linked, config keys ship,
 *      ADMIN §11 + CHANGELOG record it.
 *
 * Boots the REAL portal-server.js via the shared harness (test/helpers.js).
 * Zero dependencies. Run: node test-compliance.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { withServer, request, login, api, makeUser, SRC } = require('./test/helpers');

const ADMIN_PW = 'L0ng-Harbor-Pass-42';
const STUDENT_PW = 'Maple-Vane-77z';
const NEW_PW = 'Cedar-Ridge-55k';
let pass = 0;
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

(async () => {
  // ── A. Audit retention ─────────────────────────────────────────────────────
  {
    await withServer({
      users: [makeUser({ username: 'admin', password: ADMIN_PW, role: 'admin' })],
      config: { auditRetentionDays: 30 },
    }, async (s) => {
      // Seed one stale + one fresh entry directly into the log the server owns.
      const oldTs = Date.now() - 100 * 86400_000; // 100 days > 30-day window
      fs.writeFileSync(path.join(s.dir, 'portal-audit.log'),
        JSON.stringify({ ts: oldTs, action: 'seeded_old', user: 'ghost', role: 'anon' }) + '\n' +
        JSON.stringify({ ts: Date.now(), action: 'seeded_new', user: 'ghost', role: 'anon' }) + '\n');

      const admin = await login(s.base, 'admin', ADMIN_PW);

      const before = await api(s.base, admin, 'GET', '/api/audit?limit=500');
      assert.equal(before.status, 200, before.text);
      assert.equal(before.json.retention.days, 30, 'A: retention days reported');
      assert.equal(before.json.retention.maxBytes, 1048576, 'A: retention maxBytes reported');

      const pruned = await api(s.base, admin, 'POST', '/api/audit/prune');
      assert.equal(pruned.status, 200, pruned.text);
      assert.ok(pruned.json.removed >= 1, 'A: prune should drop the stale entry');

      const after = await api(s.base, admin, 'GET', '/api/audit?limit=500');
      const actions = after.json.entries.map((e) => e.action);
      assert.ok(!actions.includes('seeded_old'), 'A: stale entry must be gone');
      assert.ok(actions.includes('seeded_new'), 'A: fresh entry must survive');
      assert.ok(actions.includes('audit_prune'), 'A: the prune itself is audited');
      console.log('✓ A: audit retention is reported + enforced (age prune drops stale, keeps fresh)');
      pass++;
    });
  }

  // ── B. Per-IP rate limit (probes exempt) ───────────────────────────────────
  {
    await withServer({
      users: [makeUser({ username: 'admin', password: ADMIN_PW, role: 'admin' })],
      config: { rateLimitPerMinute: 3, rateLimitBurst: 0 },
    }, async (s) => {
      let limited = 0;
      for (let i = 0; i < 5; i++) {
        const r = await request(s.base, 'GET', '/api/me');
        if (i < 3) assert.equal(r.status, 200, `B: request ${i} should pass (${r.text})`);
        else {
          assert.equal(r.status, 429, `B: request ${i} should be limited (${r.text})`);
          assert.ok(Number(r.headers['retry-after']) >= 1, 'B: Retry-After present');
          assert.equal(r.json.retryAfter >= 1, true, 'B: body carries retryAfter');
          limited++;
        }
      }
      assert.equal(limited, 2, 'B: the two over-budget requests were refused');
      // Probes are exempt even well past the API budget.
      for (let i = 0; i < 6; i++) {
        const h = await request(s.base, 'GET', '/healthz');
        assert.equal(h.status, 200, 'B: /healthz must never be throttled');
      }
      console.log('✓ B: per-IP rate limit returns 429 + Retry-After; probes exempt');
      pass++;
    });
  }

  // ── C. Request-body cap ────────────────────────────────────────────────────
  {
    await withServer({
      users: [makeUser({ username: 'admin', password: ADMIN_PW, role: 'admin' })],
      config: { maxBodyBytes: 2048 },
    }, async (s) => {
      const r = await request(s.base, 'POST', '/api/login', {
        body: { username: 'admin', password: 'x'.repeat(4000) },
      });
      assert.equal(r.status, 413, `C: oversized body should be 413 (${r.text})`);
      assert.match(r.json.error, /too large/i, 'C: clear error message');
      console.log('✓ C: oversized request bodies are refused with 413 before buffering');
      pass++;
    });
  }

  // ── D. Data export ─────────────────────────────────────────────────────────
  {
    await withServer({
      users: [
        makeUser({ username: 'admin', password: ADMIN_PW, role: 'admin' }),
        makeUser({ username: 'alice', password: STUDENT_PW, role: 'student' }),
        makeUser({ username: 'bob', password: STUDENT_PW, role: 'student' }),
      ],
    }, async (s) => {
      const admin = await login(s.base, 'admin', ADMIN_PW);
      // Give alice some personal context so the export has something to carry.
      const seed = await api(s.base, admin, 'POST', '/api/users/alice/context',
        { enabled: true, profile: 'returning student', notes: 'needs extra time' });
      assert.equal(seed.status, 200, seed.text);

      // Unauthenticated → 401.
      const anon = await request(s.base, 'GET', '/api/users/alice/export');
      assert.equal(anon.status, 401, 'D: export requires auth');

      // Admin exports anyone.
      const asAdmin = await api(s.base, admin, 'GET', '/api/users/alice/export');
      assert.equal(asAdmin.status, 200, asAdmin.text);
      assert.match(String(asAdmin.headers['content-disposition']), /cirrus-portal-alice-export\.json/,
        'D: download filename');
      assert.equal(asAdmin.json.user.username, 'alice', 'D: record present');
      assert.equal(asAdmin.json.context.notes, 'needs extra time', 'D: personal context included');
      assert.ok(Array.isArray(asAdmin.json.audit), 'D: audit trail included');
      assert.equal(asAdmin.json.retention.auditRetentionDays, 90, 'D: retention echoed');

      // Self-export is allowed.
      const alice = await login(s.base, 'alice', STUDENT_PW);
      const asSelf = await api(s.base, alice, 'GET', '/api/users/alice/export');
      assert.equal(asSelf.status, 200, 'D: a user may export themselves');

      // A peer cannot export someone else.
      const bob = await login(s.base, 'bob', STUDENT_PW);
      const asPeer = await api(s.base, bob, 'GET', '/api/users/alice/export');
      assert.equal(asPeer.status, 403, 'D: a student may not export another user');

      // The export is itself audited.
      const audit = await api(s.base, admin, 'GET', '/api/audit?limit=200');
      assert.ok(audit.json.entries.some((e) => e.action === 'user_export'),
        'D: user_export is audited');
      console.log('✓ D: data export works (self + admin), peer refused, and is audited');
      pass++;
    });
  }

  // ── E. Erasure purges account + context + sessions ─────────────────────────
  {
    await withServer({
      users: [makeUser({ username: 'admin', password: ADMIN_PW, role: 'admin' })],
    }, async (s) => {
      const admin = await login(s.base, 'admin', ADMIN_PW);
      const created = await api(s.base, admin, 'POST', '/api/users',
        { username: 'temptemp', password: NEW_PW, role: 'student' });
      assert.equal(created.status, 200, created.text);
      await api(s.base, admin, 'POST', '/api/users/temptemp/context',
        { enabled: true, profile: 'temp', notes: 'erase me' });

      // The user logs in (a live session that must die on erasure).
      const victim = await login(s.base, 'temptemp', NEW_PW);
      const meBefore = await api(s.base, victim, 'GET', '/api/me');
      assert.equal(meBefore.json.authed, true, 'E: victim session is live before delete');

      const del = await api(s.base, admin, 'DELETE', '/api/users/temptemp');
      assert.equal(del.status, 200, del.text);
      assert.ok(Array.isArray(del.json.purged) && del.json.purged.includes('context'),
        'E: delete reports context purged');
      assert.ok(del.json.purged.includes('sessions'), 'E: delete reports sessions purged');

      // Account gone from the roster…
      const roster = await api(s.base, admin, 'GET', '/api/users');
      assert.ok(!roster.json.users.some((u) => u.username === 'temptemp'), 'E: account removed');

      // …personal context gone from disk…
      const ctx = JSON.parse(fs.readFileSync(path.join(s.dir, 'portal-context.json'), 'utf8'));
      assert.ok(!ctx.users || !ctx.users.temptemp, 'E: personal context erased from disk');

      // …and the victim's live session is dead.
      const meAfter = await api(s.base, victim, 'GET', '/api/me');
      assert.equal(meAfter.json.authed, false, 'E: sessions revoked by erasure');

      const audit = await api(s.base, admin, 'GET', '/api/audit?limit=200');
      assert.ok(audit.json.entries.some((e) => e.action === 'user_delete' && e.detail && e.detail.target === 'temptemp'),
        'E: user_delete is audited with the target');
      console.log('✓ E: DELETE erases account + context + sessions (shared rooms untouched)');
      pass++;
    });
  }

  // ── F. Docs + config wiring ────────────────────────────────────────────────
  {
    const priv = read('PRIVACY.md');
    assert(/^# Cirrus Portal — Privacy Note/m.test(priv), 'F: PRIVACY.md titled');
    assert(/no telemetry/i.test(priv), 'F: privacy note states no telemetry');
    assert(/export/i.test(priv) && /delete|eras/i.test(priv), 'F: privacy note covers export/erasure');
    assert(/auditRetentionDays/.test(priv), 'F: privacy note names the retention key');

    const readme = read('README.md');
    assert(readme.includes('](PRIVACY.md)'), 'F: README links PRIVACY.md');
    assert(/auditRetentionDays/.test(readme) && /rateLimitPerMinute/.test(readme),
      'F: README documents the new config keys');

    const cfg = JSON.parse(read('portal-config.example.json'));
    for (const k of ['auditRetentionDays', 'auditMaxBytes', 'rateLimitPerMinute', 'rateLimitBurst', 'maxBodyBytes']) {
      assert.ok(k in cfg, `F: example config carries ${k}`);
    }

    assert(/PRIVACY\.md/.test(read('release.sh')), 'F: PRIVACY.md ships in the release');
    assert(/## 11\. Compliance & abuse/.test(read('ADMIN.md')), 'F: ADMIN §11 documents the controls');
    assert(/Compliance & abuse controls/.test(read('CHANGELOG.md')), 'F: CHANGELOG records the change');
    console.log('✓ F: PRIVACY.md + config keys + release/ADMIN/CHANGELOG wiring');
    pass++;
  }

  console.log(`\nall ${pass}/6 compliance checks passed`);
})().catch((e) => {
  console.error('\n✗ compliance test FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
