'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { BidiConnection, BidiError } = require('../src/bidi');

// A WebSocket stand-in with the surface BidiConnection uses.
class FakeWs extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.emit('close'); }
  reply(msg) { this.emit('message', JSON.stringify(msg)); }
}

function connect() {
  const ws = new FakeWs();
  return { ws, conn: new BidiConnection(ws) };
}

test('commands resolve with their result', async () => {
  const { ws, conn } = connect();
  const pending = conn.send('session.status', {});
  assert.equal(ws.sent[0].method, 'session.status');
  ws.reply({ type: 'success', id: ws.sent[0].id, result: { ready: true } });
  assert.deepEqual(await pending, { ready: true });
});

test('errors arrive as BidiError with the error code', async () => {
  const { ws, conn } = connect();
  const pending = conn.send('browsingContext.create', {});
  ws.reply({ type: 'error', id: ws.sent[0].id, error: 'no such frame', message: 'gone' });
  await assert.rejects(pending, (err) => err instanceof BidiError && err.code === 'no such frame');
});

test('events reach both the generic and the named listener', async () => {
  const { ws, conn } = connect();
  const seen = [];
  conn.on('event', (method) => seen.push(`any:${method}`));
  conn.on('log.entryAdded', () => seen.push('named'));
  ws.reply({ type: 'event', method: 'log.entryAdded', params: { level: 'info' } });
  assert.deepEqual(seen, ['any:log.entryAdded', 'named']);
});

test('closing rejects in-flight commands instead of leaving them hanging', async () => {
  const { ws, conn } = connect();
  const pending = conn.send('browsingContext.captureScreenshot', {}, { timeout: 90000 });
  conn.close();
  await assert.rejects(pending, /closed/i);
  assert.ok(ws.closed);
});

test('a dropped socket rejects everything in flight', async () => {
  const { ws, conn } = connect();
  const pending = conn.send('script.evaluate', {});
  ws.emit('close');
  await assert.rejects(pending, /closed/i);
  assert.equal(conn.closed, true);
});

test('sending on a closed connection fails fast', async () => {
  const { conn } = connect();
  conn.close();
  await assert.rejects(() => conn.send('session.status', {}), /closed/i);
});

const net = require('node:net');
const { BidiTimeoutError } = require('../src/bidi');

function tcpServer(onSocket) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    onSocket(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `ws://127.0.0.1:${server.address().port}`,
      close: () => { for (const s of sockets) s.destroy(); server.close(); },
    }));
  });
}

test('a command that runs out of time rejects with a timeout code', async () => {
  const { conn } = connect();
  await assert.rejects(conn.send('script.evaluate', {}, { timeout: 20 }), (err) => {
    assert.ok(err instanceof BidiTimeoutError);
    assert.equal(err.code, 'timeout');
    assert.match(err.message, /timed out after 20ms: script\.evaluate/);
    return true;
  });
});

test('connecting to a peer that hangs up mid-handshake fails at once', async () => {
  // Reads the upgrade request, then hangs up without answering it.
  const peer = await tcpServer((socket) => socket.once('data', () => socket.end()));
  try {
    const started = Date.now();
    // A FIN arrives as a bare close; a reset would arrive as ECONNRESET first.
    await assert.rejects(
      BidiConnection.connect(peer.url, { timeout: 5000 }),
      /closed the connection during the handshake|ECONNRESET/
    );
    assert.ok(Date.now() - started < 2000, 'did not sit out the connect timeout');
  } finally {
    peer.close();
  }
});

test('connecting to a peer that never answers times out with a timeout code', async () => {
  const peer = await tcpServer(() => { /* accept and say nothing, like a stopped browser */ });
  try {
    await assert.rejects(BidiConnection.connect(peer.url, { timeout: 150 }), (err) => err.code === 'timeout');
  } finally {
    peer.close();
  }
});
