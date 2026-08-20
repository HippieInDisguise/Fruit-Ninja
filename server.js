#!/usr/bin/env node
/* Vibe-Sensor Node — the broker.
   No npm install. Node 18+. Serves the pages and relays phone packets to displays.
     node server.js            -> http://localhost:8080
     PORT=3000 node server.js  */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VSN = require('./public/spec.js');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.rooms.json');
const ROOM_TTL = 1000 * 60 * 60 * 12;

/* ---------------------------------------------------------------- rooms --- */

const rooms = new Map(); // code -> { config, clients:Set, last:string|null, touched:number }
let saveTimer = null;

/* An exported bundle ships config.json beside the server and has no studio.
   When it is present the bindings are frozen: every room uses it, nothing is
   restored from a previous run, and nothing is written back — so the config the
   game was built against cannot drift. */
let FROZEN = null;
try {
  const f = path.join(__dirname, 'config.json');
  if (fs.existsSync(f)) {
    FROZEN = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log('  config.json found — bindings are frozen, studio disabled');
  }
} catch (err) {
  console.warn('  config.json could not be read, using defaults:', err.message);
}

try {
  if (!FROZEN && fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [code, entry] of Object.entries(saved)) {
      if (Date.now() - (entry.touched || 0) > ROOM_TTL) continue;
      rooms.set(code, { config: entry.config, clients: new Set(), last: null, touched: entry.touched });
    }
    if (rooms.size) console.log(`  restored ${rooms.size} room(s) from last run`);
  }
} catch (err) {
  console.warn('  could not read saved rooms, starting fresh:', err.message);
}

function persist() {
  if (FROZEN) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const [code, r] of rooms) out[code] = { config: r.config, touched: r.touched };
    fs.writeFile(STATE_FILE, JSON.stringify(out), () => {});
  }, 1500);
}

function room(code) {
  let r = rooms.get(code);
  if (!r) {
    const config = FROZEN ? JSON.parse(JSON.stringify(FROZEN)) : VSN.starterConfig();
    r = { config, clients: new Set(), last: null, touched: Date.now() };
    rooms.set(code, r);
  }
  r.touched = Date.now();
  return r;
}

/* Codes avoid characters kids misread aloud: no O/0, I/1, L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function normaliseCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/* How long a controller may sit still before its slot is handed on. */
const IDLE_MS = Number(process.env.IDLE_MS || 15000);

function activePhone(r) {
  for (const c of r.clients) if (c.role === 'phone' && c.alive) return c;
  return null;
}

function census(r) {
  let phones = 0, displays = 0;
  for (const c of r.clients) {
    if (c.role === 'phone') phones++;
    else if (c.role === 'display') displays++;
  }
  return { phones, displays };
}

function broadcast(r, payload, roles, except) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const c of r.clients) {
    if (c === except) continue;
    if (roles && !roles.includes(c.role)) continue;
    c.send(text);
  }
}

function announce(r) {
  const seats = census(r);
  broadcast(r, { t: 'peers', ...seats });
}

/* ------------------------------------------------------ websocket plumbing */
/* Small, deliberate subset of RFC 6455: text frames, ping/pong, close.
   Enough for JSON telemetry, and it keeps the project install-free. */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket {
  constructor(raw) {
    this.raw = raw;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.alive = true;
    this.onmessage = null;
    this.onclose = null;
    raw.on('data', (chunk) => this._feed(chunk));
    raw.on('error', () => this.close());
    raw.on('close', () => this._dead());
  }

  _dead() {
    if (!this.alive) return;
    this.alive = false;
    if (this.onclose) this.onclose();
  }

  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Cheap guard against a client streaming garbage at us.
    if (this.buf.length > 1 << 20) return this.close();
    while (this.alive) {
      const frame = this._read();
      if (!frame) break;
      this._handle(frame);
    }
  }

  _read() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > 1_000_000n) { this.close(); return null; }
      len = Number(big); off += 8;
    }
    let key = null;
    if (masked) {
      if (b.length < off + 4) return null;
      key = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handle(f) {
    if (f.opcode === 0x8) return this.close();
    if (f.opcode === 0x9) return this._write(0xa, f.payload);
    if (f.opcode === 0xa) return;
    if (f.opcode === 0x0 || f.opcode === 0x1 || f.opcode === 0x2) {
      this.frags.push(f.payload);
      if (!f.fin) return;
      const text = Buffer.concat(this.frags).toString('utf8');
      this.frags = [];
      if (this.onmessage) this.onmessage(text);
    }
  }

  _write(opcode, payload) {
    if (!this.alive) return;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    let head;
    if (body.length < 126) {
      head = Buffer.from([0x80 | opcode, body.length]);
    } else if (body.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2);
    }
    try { this.raw.write(Buffer.concat([head, body])); } catch { this.close(); }
  }

  send(text) { this._write(0x1, text); }

  close() {
    if (!this.alive) return;
    try { this._write(0x8, Buffer.alloc(0)); this.raw.end(); } catch {}
    this._dead();
  }
}

/* ------------------------------------------------------------ http server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveFile(res, file, extraHeaders) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, Object.assign({
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    }, extraHeaders || {}));
    res.end(data);
  });
}

function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] ||
    (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC, 'index.html'));
  if (p === '/new') {
    res.writeHead(302, { location: '/?room=' + newCode() });
    return res.end();
  }
  // Short link a kid can type or scan: /p/ABCD
  const phone = p.match(/^\/p\/([A-Za-z0-9]{1,8})\/?$/);
  if (phone) return serveFile(res, path.join(PUBLIC, 'phone.html'));
  const demo = p.match(/^\/d\/([A-Za-z0-9]{1,8})\/?$/);
  if (demo) return serveFile(res, path.join(PUBLIC, 'demo.html'));

  // The handout, fetchable so a kid can link it rather than paste it.
  const spec = p.match(/^\/spec\/([A-Za-z0-9]{1,8})\.md$/);
  if (spec) {
    const code = normaliseCode(spec[1]);
    const r = rooms.get(code);
    const cfg = r ? r.config : VSN.starterConfig();
    const body = VSN.buildSpec(cfg, { room: code, origin: originOf(req) });
    res.writeHead(200, { 'content-type': MIME['.md'], 'cache-control': 'no-cache' });
    return res.end(body);
  }

  // The standalone bundle: everything the room needs, as a folder in a zip.
  const dl = p.match(/^\/export\/([A-Za-z0-9]{1,8})\.zip$/);
  if (dl) {
    const code = normaliseCode(dl[1]);
    const r = rooms.get(code);
    const cfg = r ? r.config : VSN.starterConfig();
    let out;
    try {
      // Required here, not at boot: a bundle ships server.js without bundle.js,
      // and must still start.
      out = require('./bundle.js').build(code, cfg, originOf(req));
    } catch (err) {
      console.warn('  export failed:', err.message);
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('Could not build the bundle: ' + err.message);
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${out.filename}"`,
      'content-length': out.buffer.length,
      'cache-control': 'no-store'
    });
    return res.end(out.buffer);
  }

  // The other handout: how to restyle the controller without breaking it.
  const phoneSpec = p.match(/^\/phone\/([A-Za-z0-9]{1,8})\.md$/);
  if (phoneSpec) {
    const code = normaliseCode(phoneSpec[1]);
    const r = rooms.get(code);
    const cfg = r ? r.config : VSN.starterConfig();
    const body = VSN.buildPhoneSpec(cfg, { room: code, origin: originOf(req) });
    res.writeHead(200, { 'content-type': MIME['.md'], 'cache-control': 'no-cache' });
    return res.end(body);
  }

  if (p === '/health') {
    res.writeHead(200, { 'content-type': MIME['.json'] });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
  }

  // Static, with a traversal guard.
  const safe = path.normalize(path.join(PUBLIC, p));
  if (!safe.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  serveFile(res, safe);
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    return socket.destroy();
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const code = normaliseCode(url.searchParams.get('room')) || newCode();
  const roleRaw = url.searchParams.get('type');
  const role = ['phone', 'display', 'studio'].includes(roleRaw) ? roleRaw : 'display';
  const r = room(code);

  const ws = new Socket(socket);
  ws.role = role;
  ws.room = code;

  /* One controller at a time. The room is a single experience, so a second
     phone waits rather than fighting the first for the same values. The slot
     frees itself after IDLE_MS of stillness — see the sweep below. */
  if (role === 'phone') {
    const holder = activePhone(r);
    if (holder && holder !== ws) {
      ws.send(JSON.stringify({ t: 'busy', after: Math.max(0, IDLE_MS - (Date.now() - holder.movedAt)) }));
      // Give the frame a moment to leave before the socket goes.
      return setTimeout(() => ws.close(), 50);
    }
    ws.movedAt = Date.now();
    ws.lastActions = null;
  }

  r.clients.add(ws);

  ws.send(JSON.stringify({ t: 'hello', room: code, role, config: r.config, ...census(r) }));
  if (role !== 'phone' && r.last) ws.send(r.last);
  announce(r);

  ws.onmessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    r.touched = Date.now();

    if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', id: msg.id }));

    if (msg.t === 'data' && role === 'phone') {
      // A still phone keeps sending a heartbeat, so idleness is measured by the
      // readings changing, not by packets arriving. Rounded, because a rotation
      // is raw and jitters in its last decimals even on a table — left exact it
      // would hold the room for the next person forever.
      const shape = JSON.stringify(msg.actions, (k, v) =>
        typeof v === 'number' ? Math.round(v * 100) / 100 : v);
      if (shape !== ws.lastActions) {
        ws.lastActions = shape;
        ws.movedAt = Date.now();
      }
      r.last = text;
      return broadcast(r, text, ['display', 'studio'], ws);
    }
    if (msg.t === 'config' && role === 'studio' && msg.config && !FROZEN) {
      r.config = msg.config;
      persist();
      return broadcast(r, JSON.stringify({ t: 'config', config: r.config }), null, ws);
    }
  };

  ws.onclose = () => {
    r.clients.delete(ws);
    announce(r);
  };
});

/* Hand the controller on when it stops moving, so a phone left on a table does
   not hold the room for the next person in the queue. */
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    for (const c of r.clients) {
      if (c.role !== 'phone' || !c.alive) continue;
      if (now - c.movedAt < IDLE_MS) continue;
      c.send(JSON.stringify({ t: 'idle', after: IDLE_MS }));
      setTimeout(() => c.close(), 50);
    }
  }
// Checked often enough that the hand-off lands close to IDLE_MS rather than up
// to a second late — and stays punctual if IDLE_MS is turned right down.
}, Math.max(200, Math.min(1000, IDLE_MS / 3))).unref();

/* Drop rooms nobody has touched, so a term's worth of codes does not pile up. */
setInterval(() => {
  for (const [code, r] of rooms) {
    if (!r.clients.size && Date.now() - r.touched > ROOM_TTL) rooms.delete(code);
  }
}, 1000 * 60 * 10).unref();

/* A best guess at the address to type into a phone on the same wifi. */
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  const code = newCode();
  console.log('');
  console.log('  Vibe-Sensor Node is up.');
  console.log('');
  console.log(`  Studio      http://localhost:${PORT}/?room=${code}`);
  lanAddresses().forEach((ip) => console.log(`  On wifi     http://${ip}:${PORT}/`));
  console.log('');
  console.log('  Phones need HTTPS before they will report any motion.');
  console.log('  On this machine localhost counts as secure, so you can test here now.');
  console.log(`  For real phones:  cloudflared tunnel --url http://localhost:${PORT}`);
  console.log('');
});
