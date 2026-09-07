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
