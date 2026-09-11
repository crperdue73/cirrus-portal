#!/usr/bin/env node
'use strict';
/**
 * healthcheck.js — Cirrus Portal container HEALTHCHECK probe (plan item 8).
 *
 * Reads the effective bind/port/TLS from portal-config.json (env overrides
 * honoured, mirroring the server's loadConfig) and probes the portal over
 * loopback. Exit 0 = healthy, 1 = not serving. Zero dependencies.
 *
 * Any HTTP response counts as healthy: normally `/` is 200/3xx, but in
 * first-run SETUP mode the portal answers 302→/setup and APIs return 503 —
 * the process is up and routing, which is what liveness means. (A dedicated
 * /healthz + /readyz lands in plan item 16; this will switch to /healthz then.)
 *
 * Run: node healthcheck.js
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const CONFIG_PATH = process.env.PORTAL_CONFIG || path.join(__dirname, 'portal-config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

const cfg = readConfig();

const port = Number(process.env.PORT || cfg.port || 18800);

// Probe the configured bind unless it is a wildcard, in which case loopback is
// the reliable target. A specific non-loopback bind is still probed directly.
let host = process.env.BIND || cfg.bind || '127.0.0.1';
if (host === '0.0.0.0' || host === '::' || host === '' || host === '*') host = '127.0.0.1';

const useTls = Boolean(cfg.tlsCert && cfg.tlsKey)
  || Boolean(process.env.PORTAL_TLS_CERT && process.env.PORTAL_TLS_KEY);
const mod = useTls ? https : http;

const req = mod.request(
  { host, port, path: '/', method: 'GET', timeout: 4000, rejectUnauthorized: useTls ? false : undefined },
  (res) => {
    res.resume();
    process.exit(0);
  },
);
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
req.end();
