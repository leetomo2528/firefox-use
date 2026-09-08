'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  batch, tools, TOOL, NESTED,
  planBatch, knownTool, contentBlocks, itemBlocks, resultError,
} = require('../src/batch');

// The Chrome reference is generated locally by `npm run spec` and never committed,
// so the parity checks below skip when it is absent. See test/parity.test.js.
const SPEC_PATH = path.join(__dirname, '..', '.spec', 'chrome-tool-spec.json');
const ALL = fs.existsSync(SPEC_PATH) ? JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) : null;
const SPEC = ALL ? ALL.find((t) => t.name === 'browser_batch') : null;
const skipSpec = SPEC ? false : 'run `npm run spec` to generate .spec/chrome-tool-spec.json';

// Schema shape without any prose: the structure interoperates, the wording is ours.
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

const PNG = Buffer.from('fake-png').toString('base64');
const image = (data = PNG) => ({ type: 'image', data, mimeType: 'image/png' });

// A ctx that answers callTool from a table and refuses to open a session:
// browser_batch is pure orchestration and must never touch Firefox itself.
function stubCtx(answers = {}, extra = {}) {
  const ctx = {
    calls: [],
    config: { downloadDir: '/tmp/ffuse-test' },
    session: async () => { throw new Error('browser_batch must not open a session'); },
    callTool: async (name, input) => {
      ctx.calls.push({ name, input });
      const canned = typeof answers === 'function' ? answers(name, input, ctx.calls.length) : answers[name];
      const value = typeof canned === 'function' ? await canned(input, ctx.calls.length) : canned;
      if (value instanceof Error) throw value;
      return value;
    },
    ...extra,
  };
  return ctx;
}

const texts = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text);
const kinds = (result) => result.content.map((b) => b.type);

test('the tool is declared with the shape a batch caller needs', () => {
  const [tool] = tools(stubCtx());
  assert.equal(tool.name, 'browser_batch');
  assert.equal(typeof tool.handler, 'function');
  assert.equal(TOOL.inputSchema.properties.actions.minItems, 1);
  assert.deepStrictEqual(TOOL.inputSchema.required, ['actions']);
  assert.deepStrictEqual(TOOL.inputSchema.properties.actions.items.required, ['name', 'input']);
  for (const prop of ['name', 'input']) {
    const text = TOOL.inputSchema.properties.actions.items.properties[prop].description;
    assert.ok(typeof text === 'string' && text.trim().length >= 10, `actions[].${prop} needs a description`);
  }
});

// The three things a caller gets wrong if the prose omits them.
test('the description carries the gotchas', () => {
  const [tool] = tools(stubCtx());
  assert.ok(tool.description.length >= 60, 'description is too thin to be useful');
  assert.match(tool.description, /screenshot taken BEFORE the call/,
    'must say coordinates come from the screenshot preceding the batch');
  assert.match(tool.description, /\btabId\b/, 'must say page tools need an explicit tabId');
  assert.match(tool.description, /firefox_dialog/, 'must point at the dialog escape hatch');
  assert.match(tool.description, /browser_batch inside itself/, 'must say batches do not nest');
  assert.match(tool.description, /no per-site permission check/i,
    'the Chrome permission gate does not exist here, and the prose should say so');
});

test('the browser_batch schema keeps the Chrome shape', { skip: skipSpec }, () => {
  const [tool] = tools(stubCtx());
  assert.deepStrictEqual(
    schemaShape(tool.inputSchema),
    schemaShape(SPEC.inputSchema),
    'properties, types, required and limits must match'
  );
});

// Anthropic's wording stays Anthropic's; ours has to be written here.
test('the browser_batch prose is our own', { skip: skipSpec }, () => {
  const [tool] = tools(stubCtx());
  assert.notEqual(
    tool.description.trim(), SPEC.description.trim(),
    'the description is copied verbatim - write it in our own words'
  );
  const refItems = SPEC.inputSchema.properties.actions.items.properties;
  const ourItems = TOOL.inputSchema.properties.actions.items.properties;
  assert.notEqual(
    TOOL.inputSchema.properties.actions.description.trim(),
    SPEC.inputSchema.properties.actions.description.trim(),
    'actions: parameter text is copied verbatim - rewrite it'
  );
  for (const [prop, ref] of Object.entries(refItems)) {
    if (!ref.description) continue;
    assert.notEqual(
      ourItems[prop].description.trim(), ref.description.trim(),
      `actions[].${prop}: parameter text is copied verbatim - rewrite it`
    );
  }
});

test('the source stays ASCII', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'batch.js'), 'latin1');
  const bad = src.split('\n').findIndex((line) => /[^\t\x20-\x7e]/.test(line));
  assert.equal(bad, -1, `line ${bad + 1} has a non-ASCII or control character`);
});

test('actions run one after another, never overlapping', async () => {
  const order = [];
  const ctx = stubCtx(async (name) => {
    order.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, name === 'navigate' ? 20 : 1));
    order.push(`end:${name}`);
    return `${name} ok`;
  });
  const result = await batch(ctx, {
    actions: [
      { name: 'navigate', input: { url: 'https://example.com' } },
      { name: 'find', input: { query: 'search box' } },
      { name: 'computer', input: { action: 'type', text: 'hi' } },
    ],
  });
  assert.deepEqual(order, [
    'start:navigate', 'end:navigate',
    'start:find', 'end:find',
    'start:computer', 'end:computer',
  ]);
  assert.deepEqual(ctx.calls.map((c) => c.name), ['navigate', 'find', 'computer']);
  assert.deepEqual(ctx.calls[0].input, { url: 'https://example.com', __inBatch: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(texts(result), [
    '[1] navigate\nnavigate ok',
    '[2] find\nfind ok',
    '[3] computer\ncomputer ok',
    'Completed all 3 actions.',
  ]);
});

test('a throwing action stops the batch and keeps what already ran', async () => {
  const ctx = stubCtx({
    navigate: 'Navigated to https://example.com/.',
    computer: new Error('Element ref_9 was not found on the page. Call read_page or find again to get fresh refs.'),
    find: 'never reached',
  });
  const result = await batch(ctx, {
    actions: [
      { name: 'navigate', input: { url: 'https://example.com' } },
      { name: 'computer', input: { action: 'left_click', ref: 'ref_9' } },
      { name: 'find', input: { query: 'anything' } },
    ],
  });
  assert.equal(result.isError, true);
  assert.deepEqual(ctx.calls.map((c) => c.name), ['navigate', 'computer'], 'nothing runs after the failure');
  assert.deepEqual(texts(result), [
    '[1] navigate\nNavigated to https://example.com/.',
    'Action 2 (computer) failed: Element ref_9 was not found on the page. Call read_page or find again to get fresh refs.\n'
      + 'Stopped: 1 of 3 actions completed, 1 not run.',
  ]);
});

test('an isError result ends the batch the same way a throw does', async () => {
  const ctx = stubCtx({
    javascript_tool: { content: [{ type: 'text', text: 'Error: ReferenceError: foo is not defined' }], isError: true },
    navigate: 'Navigated.',
  });
  const result = await batch(ctx, {
    actions: [
      { name: 'javascript_tool', input: { code: 'foo()' } },
      { name: 'navigate', input: { url: 'https://example.com' } },
    ],
  });
  assert.equal(result.isError, true);
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(texts(result), [
    'Action 1 (javascript_tool) failed: ReferenceError: foo is not defined\n'
      + 'Stopped: 0 of 2 actions completed, 1 not run.',
  ]);
});

test('a nested browser_batch is rejected before anything runs', async () => {
  const ctx = stubCtx({ navigate: 'Navigated.' });
  await assert.rejects(
    batch(ctx, {
      actions: [
        { name: 'navigate', input: { url: 'https://example.com' } },
        { name: 'browser_batch', input: { actions: [{ name: 'navigate', input: {} }] } },
      ],
    }),
    (err) => {
      assert.equal(err.message, `Action 2: ${NESTED}`);
      assert.ok(err.message.includes('browser_batch cannot be nested.'));
      return true;
    }
  );
  assert.deepEqual(ctx.calls, [], 'validation runs before the first action');
});

test('an unknown tool name is rejected up front when ctx exposes its registry', async () => {
  const registry = new Map([['navigate', {}], ['computer', {}]]);
  for (const shape of [
    { registry },
    { toolNames: ['navigate', 'computer'] },
    { toolNames: () => new Set(['navigate', 'computer']) },
    { hasTool: (name) => registry.has(name) },
    { tools: () => [{ name: 'navigate' }, { name: 'computer' }] },
  ]) {
    const ctx = stubCtx({ navigate: 'Navigated.' }, shape);
    await assert.rejects(
      batch(ctx, {
        actions: [
          { name: 'navigate', input: {} },
          { name: 'navigat', input: {} },
        ],
      }),
      /Action 2 names an unknown tool: navigat/
    );
    assert.deepEqual(ctx.calls, [], `${Object.keys(shape)[0]}: nothing should run`);
  }
});

test('without a registry the callTool error is surfaced as the failing item', async () => {
  const ctx = stubCtx((name) => {
    if (name === 'nope') return new Error('unknown tool: nope');
    return `${name} ok`;
  });
  const result = await batch(ctx, {
    actions: [{ name: 'navigate', input: {} }, { name: 'nope', input: {} }],
  });
  assert.equal(result.isError, true);
  assert.equal(knownTool(ctx, 'nope'), null, 'this ctx cannot answer the question');
  assert.deepEqual(ctx.calls.map((c) => c.name), ['navigate', 'nope']);
  assert.match(texts(result).at(-1), /^Action 2 \(nope\) failed: unknown tool: nope$/m);
});

test('images are passed through in order, each labelled with the action that made it', async () => {
  const ctx = stubCtx({
    navigate: 'Navigated to https://example.com/.',
    computer: { content: [image('shot-1'), { type: 'text', text: 'Took a screenshot (1280x800).' }] },
    read_page: 'button "Search" [ref_3]',
  });
  const result = await batch(ctx, {
    actions: [
      { name: 'navigate', input: { url: 'https://example.com' } },
      { name: 'computer', input: { action: 'screenshot' } },
      { name: 'read_page', input: {} },
    ],
  });
  assert.deepEqual(kinds(result), ['text', 'text', 'image', 'text', 'text', 'text']);
  assert.equal(result.content[1].text, '[2] computer image:');
  assert.deepEqual(result.content[2], { type: 'image', data: 'shot-1', mimeType: 'image/png' });
  assert.equal(result.content[3].text, 'Took a screenshot (1280x800).');
  assert.equal(result.content[4].text, '[3] read_page\nbutton "Search" [ref_3]');
  assert.equal(result.content[5].text, 'Completed all 3 actions.');
});

test('several images inside one action get numbered labels', async () => {
  const ctx = stubCtx({
    gif_creator: { content: [{ type: 'text', text: 'Exported 2 frames.' }, image('a'), image('b')] },
  });
  const result = await batch(ctx, { actions: [{ name: 'gif_creator', input: { action: 'export' } }] });
  assert.deepEqual(kinds(result), ['text', 'text', 'image', 'text', 'image', 'text']);
  assert.deepEqual(texts(result), [
    '[1] gif_creator\nExported 2 frames.',
    '[1] gif_creator image 1:',
    '[1] gif_creator image 2:',
    'Completed all 1 action.',
  ]);
  assert.equal(result.content[2].data, 'a');
  assert.equal(result.content[4].data, 'b');
});

test('an empty or missing actions list is an error', async () => {
  const ctx = stubCtx();
  for (const args of [{ actions: [] }, {}, { actions: null }, { actions: 'navigate' }, undefined]) {
    await assert.rejects(
      batch(ctx, args),
      /browser_batch needs at least one action in "actions"\./,
      `actions=${JSON.stringify(args)} should be rejected`
    );
  }
  assert.deepEqual(ctx.calls, []);
});

test('malformed items are rejected before the batch starts', async () => {
  const ctx = stubCtx({ navigate: 'Navigated.' });
  const cases = [
    [[{ name: 'navigate', input: {} }, { input: {} }], /Action 2 is missing a tool name\./],
    [[{ name: '   ', input: {} }], /Action 1 is missing a tool name\./],
    [[null], /Action 1 must be an object of the form \{name, input\}\./],
    [[['navigate', {}]], /Action 1 must be an object of the form \{name, input\}\./],
    [[{ name: 'navigate', input: 'https://example.com' }], /Action 1 \(navigate\): input must be an object, not string\./],
    [[{ name: 'navigate', input: [1, 2] }], /Action 1 \(navigate\): input must be an object, not an array\./],
  ];
  for (const [actions, expected] of cases) {
    await assert.rejects(batch(ctx, { actions }), expected);
  }
  assert.deepEqual(ctx.calls, [], 'no action runs when the plan is malformed');
});

test('a missing input is forwarded as an empty object, and a plain object result is JSON text', async () => {
  const ctx = stubCtx({ tabs_context_mcp: { tabs: [{ tabId: 1, url: 'https://example.com/' }] } });
  const result = await batch(ctx, { actions: [{ name: 'tabs_context_mcp' }] });
  assert.deepEqual(ctx.calls, [{ name: 'tabs_context_mcp', input: { __inBatch: true } }]);
  assert.equal(
    texts(result)[0],
    `[1] tabs_context_mcp\n${JSON.stringify({ tabs: [{ tabId: 1, url: 'https://example.com/' }] }, null, 2)}`
  );
});

test('an action that returns nothing still reports which action ran', async () => {
  const ctx = stubCtx({ computer: undefined, navigate: '' });
  const result = await batch(ctx, {
    actions: [{ name: 'computer', input: { action: 'wait', duration: 1 } }, { name: 'navigate', input: {} }],
  });
  assert.deepEqual(texts(result), [
    '[1] computer\n(no output)',
    '[2] navigate\n(no output)',
    'Completed all 2 actions.',
  ]);
});

test('the handler from tools(ctx) drives the same path', async () => {
  const ctx = stubCtx({ find: 'link "Docs" [ref_1]' });
  const [tool] = tools(ctx);
  const result = await tool.handler({ actions: [{ name: 'find', input: { query: 'docs link' } }] });
  assert.deepEqual(texts(result), ['[1] find\nlink "Docs" [ref_1]', 'Completed all 1 action.']);
  await assert.rejects(tool.handler(), /browser_batch needs at least one action/);
});

test('the helpers behave on their own', () => {
  assert.deepEqual(contentBlocks('hi'), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(contentBlocks(''), []);
  assert.deepEqual(contentBlocks(null), []);
  assert.deepEqual(contentBlocks({ content: [null, { type: 'text', text: 'a' }] }), [{ type: 'text', text: 'a' }]);
  assert.equal(resultError('all good'), null);
  assert.equal(resultError({ content: [], isError: true }), 'the tool reported an error');
  assert.equal(resultError({ content: [{ type: 'text', text: 'Error: boom' }], isError: true }), 'boom');
  assert.deepEqual(planBatch({}, [{ name: 'find', input: { query: 'x' } }]), [
    { index: 1, name: 'find', input: { query: 'x' } },
  ]);
  // Unknown block types are handed through untouched, after the pending text.
  assert.deepEqual(
    itemBlocks(4, 'javascript_tool', { content: [{ type: 'text', text: 'ok' }, { type: 'resource', uri: 'file:///x' }] }),
    [{ type: 'text', text: '[4] javascript_tool\nok' }, { type: 'resource', uri: 'file:///x' }]
  );
});

test('a registry reached through a method keeps its receiver', async () => {
  // ToolHost exposes tools() on the prototype; calling it detached used to throw
  // a TypeError out of the pre-flight check and kill an otherwise valid batch.
  class Host {
    constructor() { this.reg = new Map([['navigate', {}], ['find', {}]]); }
    tools() { return [...this.reg.keys()]; }
  }
  const host = new Host();
  const ctx = stubCtx({ navigate: 'Navigated.' }, { tools: host.tools, reg: host.reg });
  assert.equal(knownTool(ctx, 'navigate'), true);
  assert.equal(knownTool(ctx, 'navigat'), false);
  await assert.rejects(
    batch(ctx, { actions: [{ name: 'navigate', input: {} }, { name: 'navigat', input: {} }] }),
    /Action 2 names an unknown tool: navigat/
  );
  assert.deepEqual(ctx.calls, []);
});

test('a registry that cannot answer never fails the batch by itself', async () => {
  const broken = stubCtx({ navigate: 'Navigated.' }, {
    toolNames: () => { throw new Error('registry not built yet'); },
  });
  assert.equal(knownTool(broken, 'navigate'), null, 'unusable registry means "cannot tell"');
  const result = await batch(broken, { actions: [{ name: 'navigate', input: {} }] });
  assert.deepEqual(texts(result), ['[1] navigate\nNavigated.', 'Completed all 1 action.']);

  for (const shape of [{ toolNames: {} }, { registry: 'nope' }, { tools: 7 }, {}]) {
    assert.equal(knownTool(stubCtx({}, shape), 'navigate'), null, JSON.stringify(shape));
  }
  assert.equal(knownTool(null, 'navigate'), null);
});

test('a non-text, non-image block is still attributed to its action', async () => {
  const ctx = stubCtx({ javascript_tool: { content: [{ type: 'resource', uri: 'file:///out.json' }] } });
  const result = await batch(ctx, { actions: [{ name: 'javascript_tool', input: { code: '1' } }] });
  assert.deepEqual(kinds(result), ['text', 'resource', 'text']);
  assert.equal(result.content[0].text, '[1] javascript_tool');
  assert.deepEqual(result.content[1], { type: 'resource', uri: 'file:///out.json' });
});

test('a structured text payload is serialized, not stringified', async () => {
  const ctx = stubCtx({
    read_page: { content: [{ type: 'text', text: { tree: ['button "OK"'] } }] },
    tabs_context_mcp: { content: [{ type: 'text', text: 'Error: no tab' }], isError: true },
  });
  const result = await batch(ctx, { actions: [{ name: 'read_page', input: {} }] });
  assert.equal(texts(result)[0], `[1] read_page\n${JSON.stringify({ tree: ['button "OK"'] }, null, 2)}`);
  assert.ok(!/\[object Object\]/.test(texts(result).join('\n')));
  assert.equal(resultError({ content: [{ type: 'text', text: { code: 42 } }], isError: true }), '{\n  "code": 42\n}');
});

test('page tools are told they are inside a batch', async () => {
  const seen = [];
  const ctx = {
    callTool: async (name, input) => {
      seen.push({ name, input });
      return { content: [{ type: 'text', text: `${name} ok` }] };
    },
    config: {},
  };
  await batch(ctx, {
    actions: [
      { name: 'navigate', input: { url: 'https://example.com', tabId: 7 } },
      { name: 'computer', input: { action: 'screenshot', tabId: 7 } },
    ],
  });
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.input.__inBatch, true, `${call.name} must know it is in a batch`);
  }
  assert.equal(seen[0].input.url, 'https://example.com', 'the caller input is preserved');
});

test('the batch marker does not leak back into the caller-supplied object', async () => {
  const input = { url: 'https://example.com', tabId: 3 };
  const ctx = { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }), config: {} };
  await batch(ctx, { actions: [{ name: 'navigate', input }] });
  assert.equal(input.__inBatch, undefined, 'the original input object is untouched');
});
