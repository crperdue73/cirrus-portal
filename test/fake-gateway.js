'use strict';
/**
 * test/fake-gateway.js — a dependency-free OpenClaw gateway stub for tests.
 *
 * The portal's tests used to run with `gateways: []` and could only exercise
 * routes that touch no live server. The phone book (3a/3b) and cross-server DM
 * (Phase 4) need a REAL gateway on the other end of the WS — so this stub speaks
 * just enough of the protocol (RFC6455 handshake + the portal's `connect` and
 * `agents.list` RPCs) to drive those paths end-to-end.
 *
 * It implements the WebSocket server framing by hand (Node has a WS *client*
 * globally but no server), which keeps the suite zero-dependency.
 *
 * Not named *.test.js on purpose, so `node --test test/` never runs it directly.
 */

const http = require('http');
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ── RFC6455 framing (server → client frames are never masked) ───────────────
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

// Pull whole frames out of `buf`; return { frames:[{opcode,payload}], rest }.
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    let payload = buf.slice(p, p + len);
    if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.slice(off) };
}

class FakeGateway {
  /**
   * opts.agents: [{ id, name, emoji?, default? }]
   * opts.onRequest(method, params, conn): optional custom RPC responder.
   *   Return an object to be used as the `res` result (ok:true) — or
   *   { __error: { code, message } } to reply with an error.
   * opts.rejectConnect: when true, reply to `connect` with ok:false (offline-ish).
   * opts.connectDelayMs: delay the hello-ok reply (to probe timing).
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.agents = Array.isArray(opts.agents) ? opts.agents : [];
    this.onRequest = typeof opts.onRequest === 'function' ? opts.onRequest : null;
    this.sockets = new Set();
    this.conns = new Set();
    this.requests = []; // { method, params } audit of every RPC seen
    this.connections = 0;
    this.server = null;
    this.port = null;
  }

  wsUrl() { return `ws://127.0.0.1:${this.port}`; }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { res.writeHead(426); res.end('upgrade required'); });
      server.on('upgrade', (req, socket) => this._onUpgrade(req, socket));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    for (const s of this.sockets) { try { s.destroy(); } catch { /* gone */ } }
    this.sockets.clear();
    this.conns.clear();
    if (this.server) { try { this.server.close(); } catch { /* gone */ } this.server = null; }
  }

  _onUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    this.connections++;
    this.sockets.add(socket);
    const conn = { socket, hello: false, buffer: Buffer.alloc(0) };
    this.conns.add(conn);
    socket.on('data', (chunk) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk]);
      const { frames, rest } = decodeFrames(conn.buffer);
      conn.buffer = rest;
      for (const f of frames) this._onFrame(conn, f);
    });
    socket.on('error', () => { this.sockets.delete(socket); this.conns.delete(conn); });
    socket.on('close', () => { this.sockets.delete(socket); this.conns.delete(conn); });

    // The portal expects a challenge before it will send `connect`.
    this._send(conn, { type: 'event', event: 'connect.challenge', payload: { nonce: crypto.randomBytes(16).toString('hex') } });
  }

  _onFrame(conn, frame) {
    if (frame.opcode === 0x8) { try { conn.socket.destroy(); } catch { /* gone */ } return; }
    if (frame.opcode === 0x9) { this._sendRaw(conn, encodeFrame(0xA, frame.payload)); return; } // ping → pong
    if (frame.opcode !== 0x1) return; // only text frames carry JSON
    let msg;
    try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { return; }
    if (!msg || msg.type !== 'req') return;
    const params = msg.params || {};
    this.requests.push({ method: msg.method, params });

    if (msg.method === 'connect') {
      if (this.opts.rejectConnect) {
        this._send(conn, { type: 'res', id: msg.id, ok: false, error: { code: 'NOT_PAIRED', message: 'stub rejects connect' } });
        return;
      }
      const reply = { type: 'res', id: msg.id, ok: true, payload: { server: { connId: 'fake-' + this.port }, auth: { scopes: ['operator.read', 'operator.write'] } } };
      if (this.opts.connectDelayMs) setTimeout(() => this._send(conn, reply), this.opts.connectDelayMs);
      else this._send(conn, reply);
      conn.hello = true;
      return;
    }

    if (msg.method === 'agents.list') {
      const agents = this.agents.map((a) => ({
        id: a.id, name: a.name || a.id, default: !!a.default,
        identity: a.emoji ? { emoji: a.emoji } : undefined,
      }));
      this._send(conn, { type: 'res', id: msg.id, ok: true, payload: { agents } });
      return;
    }

    if (this.onRequest) {
      const out = this.onRequest(msg.method, params, conn);
      if (out && out.__error) this._send(conn, { type: 'res', id: msg.id, ok: false, error: out.__error });
      else this._send(conn, { type: 'res', id: msg.id, ok: true, payload: out === undefined ? {} : out });
      return;
    }

    this._send(conn, { type: 'res', id: msg.id, ok: false, error: { code: 'UNKNOWN', message: 'unknown method ' + msg.method } });
  }

  _send(conn, obj) { this._sendRaw(conn, encodeFrame(0x1, JSON.stringify(obj))); }
  _sendRaw(conn, buf) { try { conn.socket.write(buf); } catch { /* gone */ } }

  // Push an arbitrary event payload to every connected client. Phase-4 DM
  // tests use this to emit a chat `state:final` for an awaitReply watcher.
  broadcast(payload) { for (const conn of this.conns) this._send(conn, payload); }
}

module.exports = { FakeGateway, encodeFrame, decodeFrames };
