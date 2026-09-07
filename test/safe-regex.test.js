'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { matchIndices, compile, looksRisky } = require('../src/safe-regex');

test('ordinary patterns match on the fast path', async () => {
  const lines = ['[MyApp] ready', 'network error', 'MyApp warning'];
  assert.deepEqual(await matchIndices('myapp', lines), [0, 2]);
  assert.deepEqual(await matchIndices('^network', lines), [1]);
  assert.deepEqual(await matchIndices('error|warning', lines), [1, 2]);
});

test('an invalid pattern is a clear error, not a crash', () => {
  assert.throws(() => compile('([a-z'), /Invalid regex pattern/);
});

test('nested quantifiers are recognised as risky', () => {
  assert.equal(looksRisky('(\\w+\\s*)+ERROR'), true);
  assert.equal(looksRisky('(a|aa)+$'), true);
  assert.equal(looksRisky('[MyApp]'), false);
  assert.equal(looksRisky('error|warning'), false);
});

test('catastrophic backtracking is stopped instead of hanging the server', async () => {
  const line = 'Failed to load resource the server responded with a status of 404 Not Found for url';
  const started = Date.now();
  await assert.rejects(
    () => matchIndices('(\\w+\\s*)+ERROR', [line], { timeoutMs: 700 }),
    /catastrophic backtracking/
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `gave up in ${elapsed}ms instead of hanging`);
});

test('a risky-looking pattern that is actually fast still returns its matches', async () => {
  const lines = ['aaa bbb ERROR', 'nothing here'];
  assert.deepEqual(await matchIndices('(\\w+\\s*)+ERROR', lines, { timeoutMs: 2000 }), [0]);
});
