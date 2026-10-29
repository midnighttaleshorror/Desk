// Deskwork signaling server
// Purpose: introduce Host and Viewer and relay WebRTC signals (offer/answer/ICE).
// Screen video does not pass through this server; it goes directly between the two PCs.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_FAILS = 5;            // max wrong-password attempts
const BLOCK_MS = 60 * 1000;     // block for 1 minute after the limit
const MAX_MSG_BYTES = 64 * 1024;

const rooms = new Map();        // id -> { host, viewer, passHash }
const fails = new Map();        // ip -> { count, until }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(a, b);
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function newId() {
  let id;
  do { id = String(Math.floor(100000000 + Math.random() * 900000000)); }
  while (rooms.has(id));
  return id;
}

function isBlocked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now();
}
function addFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + BLOCK_MS; f.count = 0; }
  fails.set(ip, f);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Deskwork signaling server is running');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.isAlive = true;
  ws.role = null;
  ws.roomId = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    // Host: office PC registers
    if (m.type === 'register') {
      if (ws.roomId) return;
      const pass = String(m.pass || '');
      if (pass.length < 6) return send(ws, { type: 'error', message: 'Password must be at least 6 characters' });
      let id = /^\d{9}$/.test(m.id || '') ? m.id : null;
      if (!id || rooms.has(id)) id = newId();
      rooms.set(id, { host: ws, viewer: null, passHash: sha(pass) });
      ws.role = 'host';
      ws.roomId = id;
      return send(ws, { type: 'registered', id });
    }

    // Viewer: home PC wants to connect
    if (m.type === 'join') {
      if (ws.roomId) return;
      if (isBlocked(ip)) return send(ws, { type: 'error', message: 'Too many failed attempts. Try again in 1 minute' });
      const room = rooms.get(String(m.id || ''));
      if (!room || !safeEq(sha(m.pass || ''), room.passHash)) {
        addFail(ip);
        return send(ws, { type: 'error', message: 'Incorrect ID or password' });
      }
      if (room.viewer) return send(ws, { type: 'error', message: 'Someone is already connected to this computer' });
      room.viewer = ws;
      ws.role = 'viewer';
      ws.roomId = String(m.id);
      send(ws, { type: 'joined' });
      return send(room.host, { type: 'viewer-joined' });
    }

    // relay WebRTC signals to the other side
    if (m.type === 'signal') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const other = ws.role === 'host' ? room.viewer : room.host;
      return send(other, { type: 'signal', data: m.data });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (ws.role === 'host') {
      send(room.viewer, { type: 'host-left' });
      rooms.delete(ws.roomId);
    } else if (ws.role === 'viewer') {
      room.viewer = null;
      send(room.host, { type: 'viewer-left' });
    }
  });
});

// clean up dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Deskwork server port ' + PORT));
