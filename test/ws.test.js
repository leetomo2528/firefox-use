'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encodeFrame, decodeFrame, OP } = require('../src/ws');

function roundtrip(payload, opcode = OP.TEXT) {
  const frame = encodeFrame(opcode, Buffer.from(payload));
  const decoded = decodeFrame(frame, 1e9);
  assert.ok(decoded && !(decoded instanceof Error), 'decodes');
  assert.equal(decoded.size, frame.length);
  assert.equal(decoded.opcode, opcode);
  assert.ok(decoded.fin);
  return decoded.payload.toString();
}

test('encodes and decodes short frames', () => {
  assert.equal(roundtrip('hello'), 'hello');
});

test('handles the 126 and 65536 length boundaries', () => {
  for (const len of [125, 126, 127, 65535, 65536, 70000]) {
    const payload = 'x'.repeat(len);
    assert.equal(roundtrip(payload).length, len, `length ${len}`);
  }
});

test('masks client frames', () => {
  const frame = encodeFrame(OP.TEXT, Buffer.from('secret'));
  assert.equal(frame[1] & 0x80, 0x80, 'mask bit set');
  assert.ok(!frame.subarray(6).toString().includes('secret'), 'payload is masked on the wire');
});

test('waits for more bytes instead of guessing', () => {
  const frame = encodeFrame(OP.TEXT, Buffer.from('abcdefghij'));
  assert.equal(decodeFrame(frame.subarray(0, 1), 1e9), null);
  assert.equal(decodeFrame(frame.subarray(0, frame.length - 1), 1e9), null);
  assert.ok(decodeFrame(frame, 1e9));
});

test('rejects reserved bits and oversized frames', () => {
  const frame = encodeFrame(OP.TEXT, Buffer.from('hi'));
  const bad = Buffer.from(frame);
  bad[0] |= 0x40;
  assert.ok(decodeFrame(bad, 1e9) instanceof Error, 'reserved bit');
  assert.ok(decodeFrame(frame, 1) instanceof Error, 'over max payload');
});

test('decodes several frames from one buffer', () => {
  const a = encodeFrame(OP.TEXT, Buffer.from('one'));
  const b = encodeFrame(OP.PING, Buffer.from('p'));
  const joined = Buffer.concat([a, b]);
  const first = decodeFrame(joined, 1e9);
  assert.equal(first.payload.toString(), 'one');
  const second = decodeFrame(joined.subarray(first.size), 1e9);
  assert.equal(second.opcode, OP.PING);
});

const net = require('node:net');
const crypto = require('node:crypto');
const { WebSocket } = require('../src/ws');
const { BidiConnection } = require('../src/bidi');

// A WebSocket peer that completes the handshake, then sends a close frame and
// keeps the TCP connection open - what Firefox does while it is quitting.
function quittingPeer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', (head) => {
      const key = /Sec-WebSocket-Key: (\S+)/i.exec(head.toString('latin1'))[1];
      const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      server.emit('upgraded', socket);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `ws://127.0.0.1:${server.address().port}`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

const GOING_AWAY = Buffer.from([0x88, 0x02, 0x03, 0xe9]); // close frame, code 1001, unmasked

async function openAgainst(peer) {
  const upgraded = new Promise((resolve) => peer.server.once('upgraded', resolve));
  const ws = new WebSocket(peer.url);
  ws.on('error', () => {});
  await new Promise((resolve) => ws.once('open', resolve));
  return { ws, socket: await upgraded };
}

function settlesWithin(ms, promise) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}

test('a close frame from the peer ends the connection without waiting for the socket', async () => {
  const peer = await quittingPeer();
  try {
    const { ws, socket } = await openAgainst(peer);
    let closes = 0;
    const closed = new Promise((resolve) => ws.on('close', () => { closes++; resolve(); }));
    socket.write(GOING_AWAY); // and keep the TCP connection open
    assert.equal(await settlesWithin(1000, closed), true, "'close' arrives with the close frame");
    assert.throws(() => ws.send('x'), /not open/);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closes, 1, "'close' is emitted once, not again when the socket goes");
  } finally {
    peer.close();
  }
});

test('a BiDi connection whose browser said goodbye reports itself closed', async () => {
  const peer = await quittingPeer();
  try {
    const upgraded = new Promise((resolve) => peer.server.once('upgraded', resolve));
    const conn = await BidiConnection.connect(peer.url, { timeout: 2000 });
    const socket = await upgraded;
    const pending = conn.send('script.evaluate', {}, { timeout: 30000 });
    socket.write(GOING_AWAY);
    await assert.rejects(pending, /closed/i);
    assert.equal(conn.closed, true, 'so the host opens a new connection instead of reusing this one');
    await assert.rejects(conn.send('session.status', {}), /closed/i);
  } finally {
    peer.close();
  }
});
