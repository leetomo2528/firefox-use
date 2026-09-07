'use strict';
// Parity acceptance: our tools must match the Chrome integration's definitions.
// docs/chrome-tool-spec.json is the verbatim Chrome surface extracted from the
// Claude Code bundle.
const test = require('node:test');
const assert = require('node:assert');
const SPEC = require('../docs/chrome-tool-spec.json');

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

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/chrome|firefox|browser extension|the extension/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function overlap(a, b) {
  const A = new Set(normalize(a).split(' ').filter((w) => w.length > 3));
  const B = new Set(normalize(b).split(' ').filter((w) => w.length > 3));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / A.size;
}

// Compares JSON Schema structure while allowing prose (description) to differ.
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

const implemented = SPEC.filter((t) => !NOT_APPLICABLE.has(t.name));

test('every applicable Chrome tool exists here', () => {
  const mine = ours();
  const missing = implemented.map((t) => t.name).filter((name) => !mine.has(name));
  assert.deepEqual(missing, [], `missing tools: ${missing.join(', ')}`);
});

test('no unexpected extra tools', () => {
  const mine = ours();
  const specNames = new Set(SPEC.map((t) => t.name));
  const extras = [...mine.keys()].filter((name) => !specNames.has(name) && !EXTRAS.has(name));
  assert.deepEqual(extras, [], `unexpected tools: ${extras.join(', ')}`);
});

for (const spec of implemented) {
  test(`${spec.name}: input schema matches the Chrome definition`, () => {
    const mine = ours().get(spec.name);
    assert.ok(mine, `${spec.name} is missing`);
    assert.deepEqual(
      schemaShape(mine.inputSchema),
      schemaShape(spec.inputSchema),
      `${spec.name} schema differs (properties, enums, required, limits must match)`
    );
  });

  test(`${spec.name}: every parameter is documented`, () => {
    const mine = ours().get(spec.name);
    for (const [prop, def] of Object.entries(spec.inputSchema.properties || {})) {
      const ourProp = mine.inputSchema.properties[prop];
      assert.ok(ourProp, `${spec.name}.${prop} missing`);
      if (def.description) {
        assert.ok(
          typeof ourProp.description === 'string' && ourProp.description.length > 0,
          `${spec.name}.${prop} needs a description`
        );
      }
    }
  });

  test(`${spec.name}: description says the same thing`, () => {
    const mine = ours().get(spec.name);
    const score = overlap(spec.description, mine.description);
    assert.ok(score >= 0.5, `${spec.name} description drifted from the Chrome wording (overlap ${score.toFixed(2)})`);
  });
}

test('handlers are wired for every tool', () => {
  for (const [name, tool] of ours()) {
    assert.equal(typeof tool.handler, 'function', `${name} has no handler`);
    assert.equal(tool.inputSchema.type, 'object', `${name} schema must be an object`);
  }
});
