'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toLocalValue, fromRemoteValue } = require('../src/browser');
const { SNAPSHOT_FN, RESOLVE_FN, TEXT_FN } = require('../src/snapshot');

test('JS values convert to BiDi LocalValues', () => {
  assert.deepEqual(toLocalValue('hi'), { type: 'string', value: 'hi' });
  assert.deepEqual(toLocalValue(true), { type: 'boolean', value: true });
  assert.deepEqual(toLocalValue(null), { type: 'null' });
  assert.deepEqual(toLocalValue(3), { type: 'number', value: 3 });
  assert.deepEqual(toLocalValue(NaN), { type: 'number', value: 'NaN' });
  assert.deepEqual(toLocalValue([1]), { type: 'array', value: [{ type: 'number', value: 1 }] });
  assert.deepEqual(toLocalValue({ max: 5 }), { type: 'object', value: [['max', { type: 'number', value: 5 }]] });
});

test('unsupported values are refused rather than silently dropped', () => {
  assert.throws(() => toLocalValue(() => {}), /cannot pass function/);
});

test('RemoteValues convert back to plain JS', () => {
  assert.equal(fromRemoteValue({ type: 'string', value: 'x' }), 'x');
  assert.equal(fromRemoteValue({ type: 'number', value: 'Infinity' }), Infinity);
  assert.equal(fromRemoteValue({ type: 'undefined' }), undefined);
  assert.deepEqual(
    fromRemoteValue({ type: 'object', value: [['a', { type: 'number', value: 1 }]] }),
    { a: 1 }
  );
  assert.deepEqual(
    fromRemoteValue({ type: 'array', value: [{ type: 'boolean', value: false }] }),
    [false]
  );
  assert.equal(fromRemoteValue({ type: 'node', value: { localName: 'div' } }), '<div>');
});

test('deeply nested RemoteValues stop instead of recursing forever', () => {
  let deep = { type: 'number', value: 1 };
  for (let i = 0; i < 10; i++) deep = { type: 'array', value: [deep] };
  const out = fromRemoteValue(deep);
  assert.equal(JSON.stringify(out).includes('...'), true);
});

test('page scripts are syntactically valid functions', () => {
  for (const [name, src] of Object.entries({ SNAPSHOT_FN, RESOLVE_FN, TEXT_FN })) {
    const fn = new Function(`return ${src}`)();
    assert.equal(typeof fn, 'function', name);
  }
});

test('the snapshot script is ASCII so it survives transport as-is', () => {
  for (const src of [SNAPSHOT_FN, RESOLVE_FN, TEXT_FN]) {
    assert.ok(!/[^\x20-\x7e\n\r\t]/.test(src), 'no raw control or non-ASCII characters');
  }
});
