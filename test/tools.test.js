'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatSnapshot, buildTools, BrowserHandle } = require('../src/tools');

const sample = {
  title: 'Example', url: 'https://example.com/',
  viewport: { width: 1280, height: 800 },
  scroll: { x: 0, y: 120 }, documentHeight: 2400, truncated: false,
  elements: [
    { ref: 'e1', role: 'input:text', name: 'Search', value: 'kn', x: 100, y: 50, w: 200, h: 30 },
    { ref: 'e2', role: 'button', name: 'Go', x: 320, y: 50, w: 60, h: 30, disabled: true },
    { ref: 'e3', role: 'link', name: 'Docs', x: 40, y: 200, w: 50, h: 20, href: 'https://example.com/docs' },
  ],
};

test('snapshot text keeps refs, roles, names and coordinates', () => {
  const out = formatSnapshot(sample);
  assert.match(out, /Example - https:\/\/example\.com\//);
  assert.match(out, /viewport 1280x800 \| scroll 0,120 of 2400px/);
  assert.match(out, /\[e1\] input:text "Search" value="kn" @\(100,50\) 200x30/);
  assert.match(out, /\[e2\] button "Go" disabled/);
  assert.match(out, /\[e3\] link "Docs" @\(40,200\) 50x20 -> https:\/\/example\.com\/docs/);
});

test('an empty page says so instead of printing a bare header', () => {
  const out = formatSnapshot({ ...sample, elements: [] });
  assert.match(out, /no interactive elements in view/);
});

test('truncation is reported so the model knows the list is partial', () => {
  assert.match(formatSnapshot({ ...sample, truncated: true }), /list truncated/);
});

test('every tool has a name, a description and an object schema', () => {
  const tools = buildTools(new BrowserHandle());
  assert.ok(tools.length >= 15);
  const names = new Set();
  for (const t of tools) {
    assert.match(t.name, /^firefox_[a-z_]+$/, t.name);
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(typeof t.handler, 'function', t.name);
    for (const required of t.inputSchema.required || []) {
      assert.ok(t.inputSchema.properties[required], `${t.name} requires undeclared "${required}"`);
    }
  }
});

test('tools that need a browser do not open one at build time', async () => {
  let opened = false;
  const handle = { get: async () => { opened = true; throw new Error('should not be called'); } };
  buildTools(handle);
  assert.equal(opened, false);
});
