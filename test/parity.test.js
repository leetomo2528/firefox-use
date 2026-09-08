'use strict';
// Parity acceptance: our tool surface must line up with Claude Code's Chrome
// integration, tool for tool and parameter for parameter.
//
// The reference is generated from YOUR OWN Claude Code install and stays local:
//   npm run spec      (writes .spec/chrome-tool-spec.json)
// Without it these checks skip; the unit and live suites do not need it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SPEC_PATH = path.join(__dirname, '..', '.spec', 'chrome-tool-spec.json');
const SPEC = fs.existsSync(SPEC_PATH) ? JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) : null;
const skip = SPEC ? false : 'run `npm run spec` to generate .spec/chrome-tool-spec.json';

// Chrome extension / side-panel features with no Firefox counterpart.
const NOT_APPLICABLE = new Set([
  'switch_browser', 'list_connected_browsers', 'select_browser',
  'shortcuts_list', 'shortcuts_execute',
]);
const EXTRAS = new Set(['firefox_status', 'firefox_restart', 'firefox_dialog']);

function ours() {
  const { ToolHost } = require('../src/tools');
  const host = new ToolHost({});
  return new Map(host.tools().map((t) => [t.name, t]));
}

// Compares JSON Schema structure while leaving prose free: the wording here is
// our own, the shape is what has to interoperate.
function schemaShape(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(schemaShape);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') continue;
    out[key] = schemaShape(value);
  }
  return out;
}

const implemented = () => SPEC.filter((t) => !NOT_APPLICABLE.has(t.name));

test('every applicable Chrome tool exists here', { skip }, () => {
  const mine = ours();
  const missing = implemented().map((t) => t.name).filter((name) => !mine.has(name));
  assert.deepEqual(missing, [], `missing tools: ${missing.join(', ')}`);
});

test('no unexpected extra tools', { skip }, () => {
  const mine = ours();
  const specNames = new Set(SPEC.map((t) => t.name));
  const extras = [...mine.keys()].filter((name) => !specNames.has(name) && !EXTRAS.has(name));
  assert.deepEqual(extras, [], `unexpected tools: ${extras.join(', ')}`);
});

test('input schemas match the Chrome definitions', { skip }, () => {
  const mine = ours();
  for (const spec of implemented()) {
    const tool = mine.get(spec.name);
    assert.ok(tool, `${spec.name} is missing`);
    assert.deepEqual(
      schemaShape(tool.inputSchema),
      schemaShape(spec.inputSchema),
      `${spec.name}: properties, enums, required and limits must match`
    );
  }
});

test('every documented parameter is documented here too', { skip }, () => {
  const mine = ours();
  for (const spec of implemented()) {
    const tool = mine.get(spec.name);
    for (const [prop, def] of Object.entries(spec.inputSchema.properties || {})) {
      const ourProp = tool.inputSchema.properties[prop];
      assert.ok(ourProp, `${spec.name}.${prop} missing`);
      if (!def.description) continue;
      assert.ok(
        typeof ourProp.description === 'string' && ourProp.description.trim().length >= 10,
        `${spec.name}.${prop} needs a description of its own`
      );
    }
  }
});

// The descriptions are written here, not copied: Anthropic's wording is theirs.
test('tool prose is our own, and says enough to use the tool', { skip }, () => {
  const mine = ours();
  for (const spec of implemented()) {
    const tool = mine.get(spec.name);
    assert.notEqual(
      tool.description.trim(), spec.description.trim(),
      `${spec.name}: the description is copied verbatim from Claude Code - write it in our own words`
    );
    assert.ok(tool.description.trim().length >= 60, `${spec.name}: description is too thin to be useful`);
    for (const [prop, def] of Object.entries(spec.inputSchema.properties || {})) {
      if (!def.description || !tool.inputSchema.properties[prop]?.description) continue;
      assert.notEqual(
        tool.inputSchema.properties[prop].description.trim(), def.description.trim(),
        `${spec.name}.${prop}: parameter text is copied verbatim - rewrite it`
      );
    }
  }
});

// These hold with or without the reference file.
test('every tool is wired and well formed', () => {
  for (const [name, tool] of ours()) {
    assert.equal(typeof tool.handler, 'function', `${name} has no handler`);
    assert.equal(tool.inputSchema.type, 'object', `${name} schema must be an object`);
    assert.ok(tool.description && tool.description.length > 20, `${name} needs a description`);
    for (const required of tool.inputSchema.required || []) {
      assert.ok(tool.inputSchema.properties[required], `${name} requires undeclared "${required}"`);
    }
  }
});

test('the surface is the one we document', () => {
  const names = [...ours().keys()].sort();
  assert.equal(names.length, 20, `expected 17 parity tools plus 3 Firefox-only ones, got ${names.length}`);
  for (const extra of EXTRAS) assert.ok(names.includes(extra), `${extra} is missing`);
});
