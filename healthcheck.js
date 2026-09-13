#!/usr/bin/env node
'use strict';
/**
 * healthcheck.js — Cirrus Portal container HEALTHCHECK probe (plan item 8).
 *
 * Reads the effective bind/port/TLS from portal-config.json (env overrides
 * honoured, mirroring the server's loadConfig) and probes the portal's
 * /healthz liveness endpoint over loopback. Exit 0 = healthy, 1 = not serving.
 * Zero dependencies.
 *
 * /healthz (plan item 16) answers 200 whenever the process is up and routing —
 * including first-run SETUP mode, which is exactly what a liveness probe wants
 * (the container is healthy even before the wizard is completed). Any 2xx/3xx
 * now counts; a 5xx or a connection error is unhealthy.
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
  { host, port, path: '/healthz', method: 'GET', timeout: 4000, rejectUnauthorized: useTls ? false : undefined },
  (res) => {
    res.resume();
    // Liveness: 2xx/3xx means the process is up and routing; 4xx/5xx is not healthy.
    process.exit(res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
  },
);
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
req.end();
