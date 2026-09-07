'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseArgs } = require('../src/cliargs');

test('the first bare word is the command, mcp is the default', () => {
  assert.equal(parseArgs(['status']).command, 'status');
  assert.equal(parseArgs([]).command, 'mcp');
  assert.equal(parseArgs(['--headless']).command, 'mcp');
});

test('value flags consume their value instead of leaking into positionals', () => {
  const { positionals, flag } = parseArgs(['shot', 'page.png', '--port', '9333']);
  assert.deepEqual(positionals, ['page.png'], 'the port is not mistaken for a URL');
  assert.equal(flag('port'), '9333');
});

test('a profile path stays a flag value, not the start URL', () => {
  const { positionals, flag } = parseArgs(['start', '--profile', '/Users/me/work-profile']);
  assert.deepEqual(positionals, []);
  assert.equal(flag('profile'), '/Users/me/work-profile');
});

test('boolean flags stay boolean and do not swallow the next word', () => {
  const { positionals, flag } = parseArgs(['shot', 'out.png', '--full', 'https://example.com']);
  assert.equal(flag('full'), true);
  assert.deepEqual(positionals, ['out.png', 'https://example.com']);
});

test('a value flag at the end of the line is a boolean', () => {
  assert.equal(parseArgs(['start', '--port']).flag('port'), true);
});

test('a value flag followed by another flag does not eat it', () => {
  const { flag } = parseArgs(['start', '--port', '--headless']);
  assert.equal(flag('port'), true);
  assert.equal(flag('headless'), true);
});

test('order does not matter', () => {
  const { command, positionals, flag } = parseArgs(['open', '--headless', 'example.com', '--port', '9999']);
  assert.equal(command, 'open');
  assert.deepEqual(positionals, ['example.com']);
  assert.equal(flag('headless'), true);
  assert.equal(flag('port'), '9999');
});
