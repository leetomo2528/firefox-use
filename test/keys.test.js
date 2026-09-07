'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { keyValue, comboActions, typeActions, KEYS } = require('../src/keys');

test('named keys map to the WebDriver code points', () => {
  assert.equal(keyValue('Enter'), '\uE007');
  assert.equal(keyValue('esc'), '\uE00C');
  assert.equal(keyValue('cmd'), '\uE03D');
  assert.equal(keyValue('a'), 'a');
});

test('unknown multi-character keys are rejected', () => {
  assert.throws(() => keyValue('Spacebarr'), /unknown key/);
});

test('combos hold modifiers around the final key', () => {
  const actions = comboActions('cmd+shift+t');
  assert.deepEqual(actions.map((a) => a.type), ['keyDown', 'keyDown', 'keyDown', 'keyUp', 'keyUp', 'keyUp']);
  assert.equal(actions[0].value, KEYS.cmd);
  assert.equal(actions[2].value, 't');
  assert.equal(actions[3].value, 't');
  assert.equal(actions[5].value, KEYS.cmd, 'modifiers release in reverse order');
});

test('a non-modifier prefix is an error, not a silent keypress', () => {
  assert.throws(() => comboActions('t+shift'), /not a modifier/);
  assert.throws(() => comboActions(''), /empty key combo/);
});

test('typing emits a down/up pair per character and maps newline to Enter', () => {
  const actions = typeActions('hi\n');
  assert.equal(actions.length, 6);
  assert.equal(actions[0].value, 'h');
  assert.equal(actions[4].value, KEYS.enter);
});

test('astral characters stay single keys', () => {
  assert.equal(typeActions('\u{1F600}').length, 2);
});
