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
