/**
 * Zero-dependency WebSocket relay for remote spectating / telemetry sync.
 *
 * Implements the RFC-6455 server handshake + frame codec by hand (Node's
 * built-in `http` + `crypto` only) so the project has NO runtime server deps.
 * Messages are JSON {type, roomId, role, payload}; the relay simply fans each
 * message out to every other client in the same room.
 *
 * Run:  npm run relay         (defaults to ws://0.0.0.0:8787)
 * Then: open the game, and open a spectator at:
 *       <app-url>?spectate=1&relay=ws://localhost:8787&room=local-race
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : 8787;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** roomId -> Set<socket> */
const rooms = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  // Tiny health endpoint.
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`NEONDRIFT relay up. rooms=${rooms.size} clients=${[...rooms.values()].reduce((n, s) => n + s.size, 0)}\n`);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.id = nextId++;
  socket.room = null;
  socket.buffer = Buffer.alloc(0);
  socket.setNoDelay(true);

  socket.on('data', (chunk) => onData(socket, chunk));
  socket.on('close', () => leave(socket));
  socket.on('error', () => leave(socket));
});

function leave(socket) {
  if (socket.room && rooms.has(socket.room)) {
    const set = rooms.get(socket.room);
    set.delete(socket);
    if (set.size === 0) rooms.delete(socket.room);
  }
}

function onData(socket, chunk) {
  socket.buffer = Buffer.concat([socket.buffer, chunk]);
  let frame;
  while ((frame = decodeFrame(socket.buffer))) {
    socket.buffer = frame.rest;
    if (frame.opcode === 0x8) {
      socket.end();
      return;
    }
    if (frame.opcode === 0x9) {
      // ping -> pong
      socket.write(encodeFrame(frame.payload, 0xa));
      continue;
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      handleMessage(socket, frame.payload.toString('utf8'));
    }
  }
}

function handleMessage(socket, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.roomId && socket.room !== msg.roomId) {
    leave(socket);
    socket.room = msg.roomId;
    if (!rooms.has(msg.roomId)) rooms.set(msg.roomId, new Set());
    rooms.get(msg.roomId).add(socket);
  }
  // Fan out to everyone else in the room.
  const set = rooms.get(socket.room);
  if (!set) return;
  const out = encodeFrame(Buffer.from(text, 'utf8'), 0x1);
  for (const peer of set) {
    if (peer !== socket && peer.writable) peer.write(out);
  }
}

// ---- minimal RFC6455 frame codec ----------------------------------------

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = buf.slice(offset, offset + len);
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  void fin;
  return { opcode, payload, rest: buf.slice(offset + len) };
}

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

server.listen(PORT, () => {
  console.log(`[relay] NEONDRIFT telemetry relay listening on ws://0.0.0.0:${PORT}`);
  console.log(`[relay] spectate URL param:  ?spectate=1&relay=ws://localhost:${PORT}&room=local-race`);
});
