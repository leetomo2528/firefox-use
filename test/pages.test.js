'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FakeSession, fakeCtx } = require('./helpers/fake-session');
const spec = require('../docs/chrome-tool-spec.json');
const pages = require('../src/pages');
const {
  navigate, tabsContext, tabsCreate, tabsClose, javascriptTool, resizeWindow, formInput,
  normalizeUrl, splitLastStatement, stripTrailingComments, wrapForAwait, scanSource,
  formatPageException, formatResult,
  FORM_INPUT_FN, MAX_RESULT_CHARS, tools,
} = pages;

const MY_TOOLS = ['navigate', 'resize_window', 'javascript_tool', 'form_input', 'tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp'];

function sessionWith(tabs, responses) {
  return new FakeSession({ tabs: tabs.map((t) => ({ ...t })), responses });
}

function pageError(message) {
  const err = new Error(message);
  err.isPageException = true;
  return err;
}

// A session whose evaluate is driven by a callback, so page exceptions and
// retries can be exercised without a browser.
class ScriptSession extends FakeSession {
  constructor(handler, opts) {
    super(opts);
    this.handler = handler;
    this.sources = [];
  }

  async evaluate(tabId, expression) {
    this.requireContext(tabId);
    this.sources.push(expression);
    return this.handler(expression, this.sources.length);
  }
}

// --- tool definitions -----------------------------------------------------

test('tool definitions match the Chrome spec, with Chrome renamed to Firefox', () => {
  const defs = tools(fakeCtx(new FakeSession()));
  assert.deepEqual(defs.map((d) => d.name), MY_TOOLS);
  for (const def of defs) {
    const target = spec.find((t) => t.name === def.name);
    assert.ok(target, `${def.name} missing from the spec`);
    assert.equal(def.description, target.description.replace(/Chrome/g, 'Firefox'));
    assert.deepEqual(def.inputSchema, target.inputSchema);
    assert.equal(def.title, target.title); // the three tabs_* tools carry one
    assert.equal(typeof def.handler, 'function');
  }
});

test('no description still advertises Chrome', () => {
  for (const def of tools(fakeCtx(new FakeSession()))) {
    assert.ok(!/Chrome/.test(def.description), `${def.name} still mentions Chrome`);
    for (const prop of Object.values(def.inputSchema.properties || {})) {
      assert.ok(!/Chrome/.test(prop.description || ''), `${def.name} property still mentions Chrome`);
    }
  }
});

test('handlers reach the module functions through ctx.session()', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }]);
  const create = tools(fakeCtx(session)).find((d) => d.name === 'tabs_create_mcp');
  const out = await create.handler({});
  assert.match(out, /^Created tab 2 \(about:blank\)\. The group now holds 2 tabs: 1, 2\./);
});

// --- navigate -------------------------------------------------------------

test('back and forward require an explicit tabId', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }]);
  await assert.rejects(() => navigate(session, { url: 'Back' }), /tabId is required for url:"back"\/"forward"/);
  await assert.rejects(() => navigate(session, { url: 'forward' }), /tabId is required/);
  assert.equal(session.callsOf('send').length, 0);
});

test('back traverses history by -1 and reports where the tab landed', async () => {
  const session = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/two' }],
    { callJson: [{ url: 'https://a.test/one', title: 'One' }] }
  );
  const out = await navigate(session, { url: 'back', tabId: 1 });
  const sent = session.callsOf('send')[0].args;
  assert.equal(sent.method, 'browsingContext.traverseHistory');
  assert.deepEqual(sent.params, { context: 'ctx-1', delta: -1 });
  assert.equal(out, 'Went back in tab 1. Now at https://a.test/one - "One"');
});

test('forward traverses by +1 and a refused traversal reads clearly', async () => {
  const forward = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/one' }],
    { callJson: [{ url: 'https://a.test/two', title: '' }] }
  );
  await navigate(forward, { url: 'forward', tabId: 1 });
  assert.equal(forward.callsOf('send')[0].args.params.delta, 1);

  const stuck = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/one' }],
    { send: () => { throw new Error('no such history entry\n  at foo'); } }
  );
  await assert.rejects(
    () => navigate(stuck, { url: 'back', tabId: 1 }),
    /Cannot go back in tab 1: no such history entry$/
  );
});

test('a bare host gets https:// and real schemes are left alone', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('  example.com/a?b=1  '), 'https://example.com/a?b=1');
  assert.equal(normalizeUrl('localhost:3000/app'), 'https://localhost:3000/app');
  assert.equal(normalizeUrl('127.0.0.1:8080'), 'https://127.0.0.1:8080');
  assert.equal(normalizeUrl('http://x.test/a'), 'http://x.test/a');
  assert.equal(normalizeUrl('https://x.test'), 'https://x.test');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.equal(normalizeUrl('file:///tmp/a.html'), 'file:///tmp/a.html');
  assert.equal(normalizeUrl('data:text/html,hi'), 'data:text/html,hi');
  assert.equal(normalizeUrl('//cdn.test/x'), 'https://cdn.test/x');
});

test('navigate with a tabId reports the final url and title only', async () => {
  const session = sessionWith(
    [{ tabId: 2, context: 'ctx-2', url: 'about:blank' }],
    { callJson: [{ url: 'https://example.org/', title: 'Example' }] }
  );
  const out = await navigate(session, { url: 'example.org', tabId: 2 });
  assert.deepEqual(session.callsOf('navigate')[0].args, { tabId: 2, url: 'https://example.org', wait: 'complete' });
  assert.equal(out, 'Navigated tab 2 to https://example.org/ - "Example"');
});

test('an omitted tabId navigates the first tab and lists the group afterwards', async () => {
  const session = sessionWith(
    [
      { tabId: 1, context: 'ctx-1', url: 'https://a.test/' },
      { tabId: 2, context: 'ctx-2', url: 'https://b.test/' },
    ],
    {
      callJson: [
        { url: 'https://target.test/', title: 'Target' },                  // the navigated page
        { url: 'https://target.test/', title: 'Target', focused: false },  // listing, tab 1
        { url: 'https://b.test/', title: 'B', focused: true },             // listing, tab 2
      ],
    }
  );
  const out = await navigate(session, { url: 'target.test' });
  assert.equal(session.callsOf('navigate')[0].args.tabId, 1);
  const [head, blank, ...listing] = out.split('\n');
  assert.equal(head, 'Navigated tab 1 to https://target.test/ - "Target"');
  assert.equal(blank, '');
  assert.equal(listing[0], 'Tab group: 2 tabs.');
  // the listing is taken after the navigation, so tab 1 is not still on a.test
  assert.equal(listing[1], '  [1] https://target.test/ - "Target"');
  assert.equal(listing[2], '  [2] (active) https://b.test/ - "B"');
});

test('an omitted tabId on an empty group creates the window first', async () => {
  const session = sessionWith([], {
    callJson: [
      { url: 'https://new.test/', title: 'New' },
      { url: 'https://new.test/', title: 'New', focused: true },
    ],
  });
  const out = await navigate(session, { url: 'new.test' });
  assert.equal(session.callsOf('createTab').length, 1);
  assert.equal(session.callsOf('navigate')[0].args.tabId, 1);
  assert.match(out, /^Navigated tab 1 to https:\/\/new\.test\/ - "New"/);
  assert.match(out, /Created a new tab group: 1 tab in a new window\.\n {2}\[1\] \(active\) https:\/\/new\.test\/ - "New"$/);
});

test('a failed navigation names the url it tried', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'about:blank' }]);
  session.navigate = async () => { throw new Error('NS_ERROR_UNKNOWN_HOST\n  stack line'); };
  await assert.rejects(
    () => navigate(session, { url: 'nope.invalid', tabId: 1 }),
    /Navigation to https:\/\/nope\.invalid failed: NS_ERROR_UNKNOWN_HOST$/
  );
});

test('navigate rejects an empty url', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'about:blank' }]);
  await assert.rejects(() => navigate(session, { url: '   ' }), /url is required/);
  await assert.rejects(() => navigate(session, {}), /url is required/);
});

// --- tabs -----------------------------------------------------------------

test('tabs_context_mcp on an empty group says how to start one', async () => {
  const session = sessionWith([]);
  const out = await tabsContext(session, {});
  assert.equal(session.callsOf('createTab').length, 0);
  assert.match(out, /No tab group exists yet\. Call tabs_context_mcp with createIfEmpty: true/);
});

test('createIfEmpty opens a window with one tab, and is a no-op once tabs exist', async () => {
  const empty = sessionWith([], { callJson: [{ url: 'about:blank', title: '' }] });
  const created = await tabsContext(empty, { createIfEmpty: true });
  assert.equal(empty.callsOf('createTab').length, 1);
  assert.equal(created, 'Created a new tab group: 1 tab in a new window.\n  [1] (active) about:blank');

  const existing = sessionWith(
    [{ tabId: 7, context: 'ctx-7', url: 'https://a.test/' }],
    { callJson: [{ url: 'https://a.test/', title: 'A', focused: true }] }
  );
  const listed = await tabsContext(existing, { createIfEmpty: true });
  assert.equal(existing.callsOf('createTab').length, 0);
  assert.equal(listed, 'Tab group: 1 tab.\n  [7] (active) https://a.test/ - "A"');
});

test('a tab the page cannot be scripted in still lists with its known url', async () => {
  const session = sessionWith([{ tabId: 3, context: 'ctx-3', url: 'about:config' }]);
  session.callJson = async () => { throw new Error('cannot access'); };
  const out = await tabsContext(session, {});
  assert.equal(out, 'Tab group: 1 tab.\n  [3] (active) about:config');
});

test('tabs_create_mcp returns the new id and the clean-up reminder', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }]);
  const out = await tabsCreate(session);
  assert.match(out, /^Created tab 2 \(about:blank\)\. The group now holds 2 tabs: 1, 2\./);
  assert.match(out, /Tabs you create are yours to clean up - close this one with tabs_close_mcp/);
});

test('tabs_close_mcp closes a tab and notes when the group empties', async () => {
  const session = sessionWith([
    { tabId: 1, context: 'ctx-1', url: 'https://a.test/' },
    { tabId: 2, context: 'ctx-2', url: 'https://b.test/' },
  ]);
  assert.equal(await tabsClose(session, { tabId: 2 }), 'Closed tab 2. 1 tab left in the group: 1.');
  const last = await tabsClose(session, { tabId: 1 });
  assert.match(last, /^Closed tab 1\. The group is now empty - call tabs_context_mcp with createIfEmpty: true/);
  assert.deepEqual(session.callsOf('closeTab').map((c) => c.args.tabId), [2, 1]);
});

test('closing a tab outside the group uses the shared no-such-tab wording', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }]);
  await assert.rejects(
    () => tabsClose(session, { tabId: 99 }),
    /^Error: Tab 99 no longer exists\. Call tabs_context_mcp to get valid tab ids\.$/
  );
  await assert.rejects(() => tabsClose(session, {}), /tabId is required/);
  assert.equal(session.callsOf('closeTab').length, 0);
});

// --- javascript_tool ------------------------------------------------------

test('javascript_tool only accepts action javascript_exec', async () => {
  const session = new ScriptSession(() => 1);
  await assert.rejects(
    () => javascriptTool(session, { action: 'eval', text: '1', tabId: 1 }),
    /action must be "javascript_exec", got "eval"/
  );
  await assert.rejects(() => javascriptTool(session, { text: '1', tabId: 1 }), /action must be "javascript_exec"\./);
  await assert.rejects(
    () => javascriptTool(session, { action: 'javascript_exec', text: '  ', tabId: 1 }),
    /text is required/
  );
  assert.equal(session.sources.length, 0);
});

test('the last expression is the result, and values print readably', async () => {
  const values = [42, 'hello', { a: [1, 2] }, undefined, null, ''];
  const session = new ScriptSession((_src, nth) => values[nth - 1]);
  const run = (text) => javascriptTool(session, { action: 'javascript_exec', text, tabId: 1 });
  assert.equal(await run('1 + 41'), '42');
  assert.equal(await run('"hello"'), 'hello');
  assert.equal(await run('({a:[1,2]})'), '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(await run('void 0'), 'undefined');
  assert.equal(await run('null'), 'null');
  assert.equal(await run('""'), '""');
  assert.equal(session.sources[0], '1 + 41'); // plain source, no wrapping
});

test('a large result is truncated with a note', async () => {
  const big = 'x'.repeat(MAX_RESULT_CHARS + 500);
  const session = new ScriptSession(() => big);
  const out = await javascriptTool(session, { action: 'javascript_exec', text: 'big', tabId: 1 });
  assert.equal(out.length, MAX_RESULT_CHARS + `\n\n[truncated: showing the first ${MAX_RESULT_CHARS} of ${big.length} characters]`.length);
  assert.ok(out.endsWith(`[truncated: showing the first ${MAX_RESULT_CHARS} of ${big.length} characters]`));
});

test('a page exception comes back as a readable error with its first frame', async () => {
  const session = new ScriptSession(() => {
    throw pageError('TypeError: x.go is not a function\n    doThing@https://a.test/app.js:12:5\n    onclick@https://a.test/:1:1');
  });
  await assert.rejects(
    () => javascriptTool(session, { action: 'javascript_exec', text: 'x.go()', tabId: 1 }),
    (err) => {
      assert.equal(err.message, 'JavaScript error: TypeError: x.go is not a function\n    doThing@https://a.test/app.js:12:5');
      assert.ok(!err.isPageException);
      return true;
    }
  );
});

test('a transport failure is not dressed up as a page error', async () => {
  const session = new ScriptSession(() => { throw new Error('websocket closed'); });
  await assert.rejects(
    () => javascriptTool(session, { action: 'javascript_exec', text: '1', tabId: 1 }),
    /^Error: websocket closed$/
  );
});

test('top-level await is wrapped so the last expression is still the result', async () => {
  const session = new ScriptSession(() => ({ ok: true }));
  const text = 'const r = await fetch("/x");\nawait r.json()';
  const out = await javascriptTool(session, { action: 'javascript_exec', text, tabId: 1 });
  const src = session.sources[0];
  assert.ok(src.startsWith('(async function () {'), src);
  assert.ok(src.includes('const r = await fetch("/x");'), src);
  assert.ok(src.includes('return (\nawait r.json()\n);'), src);
  assert.equal(out, '{\n  "ok": true\n}');
});

test('await hidden inside a block is retried wrapped after the syntax error', async () => {
  const session = new ScriptSession((src, nth) => {
    if (nth === 1) throw pageError('SyntaxError: await is only valid in async functions');
    assert.ok(src.startsWith('(async function () {'));
    return 7;
  });
  const out = await javascriptTool(session, { action: 'javascript_exec', text: 'if (true) { await go() }', tabId: 1 });
  assert.equal(session.sources.length, 2);
  assert.equal(out, '7');
});

test('a syntax error with no await is reported, not retried', async () => {
  const session = new ScriptSession(() => { throw pageError('SyntaxError: unexpected token }'); });
  await assert.rejects(
    () => javascriptTool(session, { action: 'javascript_exec', text: 'foo(}', tabId: 1 }),
    /JavaScript error: SyntaxError: unexpected token \}/
  );
  assert.equal(session.sources.length, 1);
});

test('statement splitting keeps multi-line expressions together', () => {
  assert.deepEqual(splitLastStatement('document.title'), { head: '', tail: 'document.title', topAwait: false });
  const chained = splitLastStatement('await fetch(u)\n  .then(r => r.json())');
  assert.equal(chained.head, '');
  assert.equal(chained.topAwait, true);
  const two = splitLastStatement('let a = 1;\nawait f(a)');
  assert.equal(two.head.trim(), 'let a = 1;');
  assert.equal(two.tail, 'await f(a)');
  // `await` inside a function body is not top level.
  assert.equal(scanSource('const f = async () => { await g(); };').topAwait, false);
  // ...nor is one inside a string or a comment.
  assert.equal(scanSource('"await x"').topAwait, false);
  assert.equal(scanSource('// await x').topAwait, false);
  assert.equal(scanSource('`${1} await`').topAwait, false);
});

test('a trailing statement keeps its own semantics when it is not an expression', () => {
  const wrapped = wrapForAwait('await a();\nif (x) { y() }');
  assert.ok(!wrapped.includes('return ('), wrapped);
  assert.ok(wrapped.includes('if (x) { y() }'), wrapped);
});

// Anything we hand to the page has to parse: a trailing comment used to land
// inside `return ( ... )` and turn valid code into a SyntaxError.
test('the async wrapper compiles whatever the comments look like', () => {
  const sources = [
    'await go();\n// done',
    'await go()\n/* trailing */',
    '// lead\nawait go()',
    'await a() // done',
    'const r = await fetch("/x");\nawait r.json()',
    'await f(`a ${await g()} b`)',
    'if (true) { await go() }',
    'await a()\n[1, 2].map((n) => n)',
    'await a();\nfor (const x of y) { z(x) }',
  ];
  for (const src of sources) {
    assert.doesNotThrow(() => new Function(wrapForAwait(src)), `${src} -> ${wrapForAwait(src)}`);
    assert.doesNotThrow(() => new Function(wrapForAwait(src, { returnLast: false })), src);
  }
  // the last real statement is still the result, the comment is just dropped
  assert.ok(wrapForAwait('await go();\n// done').includes('return (\nawait go()\n);'));
  assert.equal(stripTrailingComments('a() // x'), 'a()');
  assert.equal(stripTrailingComments('a() /* x */  '), 'a()');
  assert.equal(stripTrailingComments('"// not a comment"'), '"// not a comment"');
  assert.equal(stripTrailingComments('// only a comment'), '');
});

test('a mis-cut wrap is retried without the return conversion', async () => {
  const session = new ScriptSession((src, nth) => {
    if (nth === 1) throw pageError('SyntaxError: expected expression, got \')\'');
    return undefined;
  });
  const out = await javascriptTool(session, { action: 'javascript_exec', text: 'await go()\n// note', tabId: 1 });
  assert.equal(session.sources.length, 2);
  assert.ok(!session.sources[1].includes('return ('), session.sources[1]);
  assert.equal(out, 'undefined');
});

test('formatPageException falls back to the message when there is no frame', () => {
  assert.equal(formatPageException('Error: boom'), 'Error: boom');
  assert.equal(formatPageException(''), 'script threw');
  assert.equal(formatResult('plain'), 'plain');
});

// --- resize_window --------------------------------------------------------

test('resize_window prefers browser.setClientWindowState', async () => {
  const session = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/', clientWindow: 'win-1' }],
    { callJson: [{ width: 1024, height: 700 }] }
  );
  const out = await resizeWindow(session, { width: 1024.4, height: 768, tabId: 1 });
  const sent = session.callsOf('send').map((c) => c.args);
  // A pinned viewport survives a window resize and the page would keep
  // reporting the old size, so the override has to be released first.
  assert.equal(sent[0].method, 'browsingContext.setViewport');
  assert.deepEqual(sent[0].params, { context: 'ctx-1', viewport: null });
  assert.equal(sent[1].method, 'browser.setClientWindowState');
  assert.deepEqual(sent[1].params, { clientWindow: 'win-1', state: 'normal', width: 1024, height: 768 });
  assert.equal(out, 'Resized the window holding tab 1 to 1024x768 via browser.setClientWindowState. Page reports innerWidth x innerHeight = 1024x700.');
  // Screenshot geometry follows the page, not the number we asked for - and it
  // is recorded on the tab that was resized, never on the session default.
  assert.deepEqual(session.callsOf('setViewport').map((c) => c.args), [{ tabId: 1, width: 1024, height: 700 }]);
  assert.deepEqual(session.viewportFor(1), { width: 1024, height: 700 });
  assert.deepEqual(session.viewportSize, { width: 1280, height: 800 });
});

test('resize_window sizes the tab it was given and leaves the other tabs alone', async () => {
  const session = sessionWith(
    [
      { tabId: 1, context: 'ctx-1', url: 'https://a.test/', clientWindow: 'win-1' },
      { tabId: 2, context: 'ctx-2', url: 'https://b.test/', clientWindow: 'win-2' },
    ],
    { callJson: [{ width: 1024, height: 700 }] }
  );
  const before = session.viewportFor(1);
  await resizeWindow(session, { width: 1024, height: 768, tabId: 2 });
  assert.deepEqual(session.viewportFor(2), { width: 1024, height: 700 });
  // The session default is every untouched tab's size: moving it here would
  // silently reframe tab 1's screenshots and coordinates.
  assert.deepEqual(session.viewportSize, { width: 1280, height: 800 });
  assert.deepEqual(session.viewportFor(1), before);
});

test('resize_window with an unreadable page reports it and records nothing', async () => {
  const session = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'about:blank', clientWindow: 'win-1' }],
    { callJson: () => { throw new Error('no script for about: pages'); } }
  );
  const out = await resizeWindow(session, { width: 900, height: 700, tabId: 1 });
  assert.match(out, /The page did not report innerWidth\/innerHeight\.$/);
  assert.equal(session.callsOf('setViewport').length, 0);
  assert.deepEqual(session.viewportSize, { width: 1280, height: 800 });
});

test('a re-pin the tab refuses still reports the resize that happened', async () => {
  // The window resize already succeeded; a context that is busy navigating can
  // reject the viewport call that records the new size, and that must not turn
  // a completed resize into an error.
  class StubbornViewport extends FakeSession {
    async setViewport(tabId, size) {
      this._record('setViewport', { tabId, ...size });
      throw new Error('browsing context is navigating');
    }
  }
  const session = new StubbornViewport({
    tabs: [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/', clientWindow: 'win-1' }],
    responses: { callJson: [{ width: 1024, height: 700 }] },
  });
  const out = await resizeWindow(session, { width: 1024, height: 768, tabId: 1, __inBatch: true });
  assert.equal(out, 'Resized the window holding tab 1 to 1024x768 via browser.setClientWindowState. Page reports innerWidth x innerHeight = 1024x700.');
  assert.deepEqual(session.callsOf('setViewport').map((c) => c.args), [{ tabId: 1, width: 1024, height: 700 }]);
  // Nothing global moved on the way out, and the tab keeps the size the
  // session already had for it - a refused record leaves a stale one, never a
  // wrong one on some other tab.
  assert.deepEqual(session.viewportSize, { width: 1280, height: 800 });
  assert.deepEqual(session.viewportFor(1), { width: 1280, height: 800 });
});

test('resize_window falls back to the viewport when the browser refuses', async () => {
  const session = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/', clientWindow: 'win-1' }],
    {
      send: () => { throw new Error('unsupported operation: setClientWindowState\n  at bidi'); },
      callJson: [{ width: 800, height: 600 }],
    }
  );
  const out = await resizeWindow(session, { width: 800, height: 600, tabId: 1 });
  assert.deepEqual(session.callsOf('setViewport')[0].args, { tabId: 1, width: 800, height: 600 });
  assert.equal(out, 'Resized tab 1 to 800x600 via the tab viewport (browser.setClientWindowState was rejected: unsupported operation: setClientWindowState). Page reports innerWidth x innerHeight = 800x600.');
  assert.deepEqual(session.viewportFor(1), { width: 800, height: 600 });
  assert.deepEqual(session.viewportSize, { width: 1280, height: 800 });
});

test('resize_window without a client window goes straight to the viewport', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }], { send: { clientWindows: [] }, callJson: [{}] });
  const out = await resizeWindow(session, { width: 500, height: 400, tabId: 1 });
  assert.equal(session.callsOf('send')[0].args.method, 'browser.getClientWindows');
  assert.match(out, /via the tab viewport \(browser\.setClientWindowState was rejected: the tab reports no client window\)/);
  assert.match(out, /The page did not report innerWidth\/innerHeight\.$/);
});

test('resize_window validates its dimensions and its tab', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }]);
  await assert.rejects(() => resizeWindow(session, { width: 0, height: 600, tabId: 1 }), /must be positive numbers/);
  await assert.rejects(() => resizeWindow(session, { width: 'wide', height: 600, tabId: 1 }), /must be positive numbers/);
  await assert.rejects(() => resizeWindow(session, { width: 800, height: -1, tabId: 1 }), /must be positive numbers/);
  await assert.rejects(() => resizeWindow(session, { width: 800, height: 600, tabId: 42 }), /Tab 42 no longer exists/);
});

// --- form_input -----------------------------------------------------------

test('form_input reports the element and the value that stuck', async () => {
  const session = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }],
    { callJson: [{ found: true, ok: true, kind: 'text', describe: '<input type="text" name="q">', value: 'hello' }] }
  );
  const out = await formInput(session, { ref: 'ref_3', value: 'hello', tabId: 1 });
  assert.equal(session.callsOf('ensureRefStore').length, 1);
  assert.deepEqual(session.callsOf('callJson')[0].args.args, ['ref_3', 'hello']);
  assert.equal(out, 'Set ref_3 <input type="text" name="q"> to "hello".');
});

test('form_input flags a value the page changed on the way in', async () => {
  const session = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }],
    { callJson: [{ found: true, ok: true, kind: 'text', describe: '<input type="number">', value: '5' }] }
  );
  const out = await formInput(session, { ref: 'ref_1', value: 5.7, tabId: 1 });
  assert.equal(out, 'Set ref_1 <input type="number"> to "5" (requested "5.7").');
});

test('form_input describes checkboxes and selects in their own terms', async () => {
  const checkbox = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }],
    { callJson: [{ found: true, ok: true, kind: 'checkbox', describe: '<input type="checkbox" name="agree">', value: false }] }
  );
  assert.equal(
    await formInput(checkbox, { ref: 'ref_2', value: 'false', tabId: 1 }),
    'Set ref_2 <input type="checkbox" name="agree"> to unchecked.'
  );

  const select = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }],
    { callJson: [{ found: true, ok: true, kind: 'select', describe: '<select name="country">', value: 'kr', text: 'South Korea' }] }
  );
  assert.equal(
    await formInput(select, { ref: 'ref_5', value: 'South Korea', tabId: 1 }),
    'Set ref_5 <select name="country"> to "kr" (South Korea).'
  );
});

test('form_input surfaces a stale ref and an unsettable element', async () => {
  const stale = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }], { callJson: [{ found: false }] });
  await assert.rejects(
    () => formInput(stale, { ref: 'ref_9', value: 'x', tabId: 1 }),
    /^Error: Element ref_9 was not found on the page\. Call read_page or find again to get fresh refs\.$/
  );

  const noMatch = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }],
    {
      callJson: [{
        found: true, ok: false, describe: '<select name="country">',
        error: 'no option matches "Mars"',
        options: [{ value: 'kr', text: 'South Korea' }, { value: 'us', text: 'United States' }],
      }],
    }
  );
  await assert.rejects(
    () => formInput(noMatch, { ref: 'ref_5', value: 'Mars', tabId: 1 }),
    /Cannot set ref_5 <select name="country">: no option matches "Mars"\. Available options: "kr" \(South Korea\), "us" \(United States\)\./
  );

  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }]);
  await assert.rejects(() => formInput(session, { ref: '', value: 'x', tabId: 1 }), /ref is required/);
  await assert.rejects(() => formInput(session, { ref: 'ref_1', tabId: 1 }), /value is required/);
  // an object would otherwise be typed into the field as "[object Object]"
  await assert.rejects(
    () => formInput(session, { ref: 'ref_1', value: { a: 1 }, tabId: 1 }),
    /value must be a string, number or boolean \(got object\)/
  );
  await assert.rejects(
    () => formInput(session, { ref: 'ref_1', value: ['a'], tabId: 1 }),
    /value must be a string, number or boolean \(got array\)/
  );
  assert.equal(session.callsOf('callJson').length, 0);
});

// --- the page-side setter, run against a stand-in DOM ----------------------

function pageFn(src, globals) {
  const names = Object.keys(globals);
  return new Function(...names, `return (${src});`)(...names.map((n) => globals[n]));
}

class FakeEvent {
  constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); }
}

class FakeElement {
  constructor(localName, attrs = {}) {
    this.localName = localName;
    this.attrs = attrs;
    this.name = attrs.name || '';
    this.id = attrs.id || '';
    this.disabled = !!attrs.disabled;
    this.isContentEditable = !!attrs.contenteditable;
    this.isConnected = true;
    this.events = [];
  }

  getAttribute(key) { return this.attrs[key] === undefined ? null : this.attrs[key]; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  focus() { this.focused = true; }
}

class FakeInput extends FakeElement {
  constructor(attrs = {}) {
    super('input', attrs);
    this._value = attrs.value || '';
    this._checked = !!attrs.checked;
  }
}
Object.defineProperty(FakeInput.prototype, 'value', {
  configurable: true,
  get() { return this._value; },
  set(v) { this._value = String(v); },
});
Object.defineProperty(FakeInput.prototype, 'checked', {
  configurable: true,
  get() { return this._checked; },
  set(v) { this._checked = !!v; },
});

class FakeSelect extends FakeElement {
  constructor(options, attrs = {}) {
    super('select', attrs);
    this.options = options.map((o, index) => Object.assign({ index }, o));
    this.selectedIndex = 0;
  }
}
Object.defineProperty(FakeSelect.prototype, 'value', {
  configurable: true,
  get() { const o = this.options[this.selectedIndex]; return o ? o.value : ''; },
  set(v) { const i = this.options.findIndex((o) => o.value === String(v)); if (i >= 0) this.selectedIndex = i; },
});

function runFormInput(el, value, ref = 'ref_1') {
  const window = { __ffuse: { refs: new Map([[ref, el]]) }, HTMLInputElement: { prototype: FakeInput.prototype } };
  const fn = pageFn(FORM_INPUT_FN, { window, Event: FakeEvent });
  return JSON.parse(fn(ref, value));
}

test('the page setter goes around a framework-installed value property', () => {
  const el = new FakeInput({ type: 'text', name: 'q' });
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return this._value; },
    set() { el.ownSetterUsed = true; this._value = 'mangled-by-framework'; },
  });
  const res = runFormInput(el, 'hello');
  assert.equal(el.ownSetterUsed, undefined);
  assert.equal(res.value, 'hello');
  assert.deepEqual(el.events, ['input', 'change']);
  assert.equal(el.focused, true);
});

test('checkboxes coerce their value and radios follow the same rule', () => {
  for (const [value, expected] of [[true, true], ['true', true], [1, true], ['on', true], ['x', true],
    [false, false], ['false', false], [0, false], ['', false], ['off', false], ['no', false]]) {
    const box = new FakeInput({ type: 'checkbox', name: 'agree', checked: !expected });
    const res = runFormInput(box, value);
    assert.equal(res.kind, 'checkbox');
    assert.equal(res.value, expected, `value ${JSON.stringify(value)} should set checked=${expected}`);
    assert.deepEqual(box.events, ['input', 'change']);
  }
  const radio = new FakeInput({ type: 'radio', name: 'plan' });
  assert.equal(runFormInput(radio, true).kind, 'radio');
  assert.equal(radio.checked, true);
});

test('a select matches by option value first, then by visible text', () => {
  const options = [{ value: '', text: 'Choose' }, { value: 'kr', text: 'South Korea' }, { value: 'us', text: 'United States' }];
  const byValue = runFormInput(new FakeSelect(options), 'us');
  assert.deepEqual([byValue.value, byValue.text], ['us', 'United States']);

  const byText = runFormInput(new FakeSelect(options), ' south korea ');
  assert.deepEqual([byText.value, byText.text], ['kr', 'South Korea']);

  const missing = runFormInput(new FakeSelect(options), 'Mars');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no option matches "Mars"/);
  assert.deepEqual(missing.options.map((o) => o.value), ['', 'kr', 'us']);
});

test('contenteditable takes text, and a plain element is refused', () => {
  const editable = new FakeElement('div', { contenteditable: 'true' });
  const res = runFormInput(editable, 'typed text');
  assert.equal(res.kind, 'contenteditable');
  assert.equal(res.value, 'typed text');
  assert.equal(editable.textContent, 'typed text');
  assert.deepEqual(editable.events, ['input', 'change']);

  const div = new FakeElement('div');
  const refused = runFormInput(div, 'x');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /form_input works on <input>, <textarea>, <select> and contenteditable elements/);
  assert.deepEqual(div.events, []);
});

test('the page setter refuses disabled fields, file inputs and detached refs', () => {
  const disabled = runFormInput(new FakeInput({ type: 'text', disabled: true }), 'x');
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /disabled/);

  const file = runFormInput(new FakeInput({ type: 'file' }), '/tmp/a.png');
  assert.equal(file.ok, false);
  assert.match(file.error, /use file_upload or upload_image/);

  const gone = new FakeInput({ type: 'text' });
  gone.isConnected = false;
  assert.deepEqual(runFormInput(gone, 'x'), { found: false });

  const window = { __ffuse: { refs: new Map() } };
  const fn = pageFn(FORM_INPUT_FN, { window, Event: FakeEvent });
  assert.deepEqual(JSON.parse(fn('ref_404', 'x')), { found: false });
});

test('a textarea and a number input round-trip through the native setter', () => {
  class FakeTextarea extends FakeInput {
    constructor(attrs) { super(attrs); this.localName = 'textarea'; }
  }
  const area = new FakeTextarea({ name: 'bio', value: 'old' });
  const res = runFormInput(area, 'line one\nline two');
  assert.equal(res.kind, 'text');
  assert.equal(res.value, 'line one\nline two');
  assert.equal(res.describe, '<textarea name="bio">');

  const number = runFormInput(new FakeInput({ type: 'number', id: 'age' }), 42);
  assert.equal(number.value, '42');
  assert.equal(number.describe, '<input type="number" id="age">');
});


// --- browser_batch handshake ----------------------------------------------
//
// src/batch.js stamps `__inBatch: true` onto each item's input. The spec makes
// a tab implicit only for a standalone call, so inside a batch a page tool that
// guesses drives the tab that existed BEFORE the batch created its own.

test('navigate inside a batch refuses to guess a tab', async () => {
  const session = sessionWith([
    { tabId: 1, context: 'ctx-1', url: 'https://old.test/' },
    { tabId: 2, context: 'ctx-2', url: 'about:blank' },
  ]);
  await assert.rejects(
    () => navigate(session, { url: 'https://new.test/', __inBatch: true }),
    /Inside browser_batch, navigate \(and other tools that act on a page\) requires an explicit tabId/
  );
  // Nothing was driven: the old tab is still showing the url it had.
  assert.equal(session.callsOf('navigate').length, 0);
  assert.equal(session.tabs[0].url, 'https://old.test/');
});

test('navigate inside a batch runs normally once it is given a tabId', async () => {
  const session = sessionWith(
    [
      { tabId: 1, context: 'ctx-1', url: 'https://old.test/' },
      { tabId: 2, context: 'ctx-2', url: 'about:blank' },
    ],
    { callJson: [{ url: 'https://new.test/', title: 'New' }] }
  );
  const out = await navigate(session, { url: 'https://new.test/', tabId: 2, __inBatch: true });
  // The private flag drives the tabId rule and nothing else: it reaches
  // neither the session call nor the page.
  assert.deepEqual(session.callsOf('navigate')[0].args, { tabId: 2, url: 'https://new.test/', wait: 'complete' });
  assert.equal(out, 'Navigated tab 2 to https://new.test/ - "New"');
  assert.equal(session.tabs[0].url, 'https://old.test/');
});

test('a standalone navigate still falls back to the first tab and lists the group', async () => {
  const session = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'about:blank' }],
    { callJson: [{ url: 'https://new.test/', title: 'New' }, { url: 'https://new.test/', title: 'New', focused: true }] }
  );
  const out = await navigate(session, { url: 'https://new.test/' });
  assert.equal(session.callsOf('navigate')[0].args.tabId, 1);
  assert.match(out, /^Navigated tab 1 to https:\/\/new\.test\/ - "New"\n\nTab group: 1 tab\./);
});

test('back and forward keep their own message inside a batch', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://a.test/two' }]);
  await assert.rejects(
    () => navigate(session, { url: 'back', __inBatch: true }),
    /tabId is required for url:"back"\/"forward"/
  );
  assert.equal(session.callsOf('send').length, 0);
});

test('the other page tools refuse to guess a tab inside a batch too', async () => {
  const tabs = [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }];
  const spec_ = /Inside browser_batch, navigate \(and other tools that act on a page\) requires an explicit tabId/;

  const js = sessionWith(tabs);
  await assert.rejects(() => javascriptTool(js, { action: 'javascript_exec', text: '1 + 1', __inBatch: true }), spec_);
  assert.equal(js.callsOf('evaluate').length, 0);

  const form = sessionWith(tabs);
  await assert.rejects(() => formInput(form, { ref: 'ref_1', value: 'x', __inBatch: true }), spec_);
  assert.equal(form.callsOf('callJson').length, 0);

  const win = sessionWith(tabs);
  await assert.rejects(() => resizeWindow(win, { width: 800, height: 600, __inBatch: true }), spec_);
  assert.equal(win.callsOf('send').length, 0);
  assert.equal(win.callsOf('setViewport').length, 0);
});

test('the flag never reaches the page or the tool arguments', async () => {
  const form = sessionWith(
    [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }],
    { callJson: [{ found: true, ok: true, kind: 'text', describe: '<input>', value: 'x' }] }
  );
  await formInput(form, { ref: 'ref_1', value: 'x', tabId: 1, __inBatch: true });
  assert.deepEqual(form.callsOf('callJson')[0].args.args, ['ref_1', 'x']);

  const js = new ScriptSession(() => 2, { tabs: [{ tabId: 1, context: 'ctx-1', url: 'https://a.test/' }] });
  await javascriptTool(js, { action: 'javascript_exec', text: '1 + 1', tabId: 1, __inBatch: true });
  assert.deepEqual(js.sources, ['1 + 1']);
});

test('the batch runner reaches the same rule through the tool handler', async () => {
  const session = sessionWith([{ tabId: 1, context: 'ctx-1', url: 'https://old.test/' }]);
  const ctx = fakeCtx(session);
  // Exactly what src/batch.js does: ctx.callTool(name, {...input, __inBatch:true}).
  const def = tools(ctx).find((d) => d.name === 'navigate');
  await assert.rejects(
    () => def.handler({ url: 'https://new.test/', __inBatch: true }),
    /Inside browser_batch, navigate \(and other tools that act on a page\) requires an explicit tabId/
  );
  assert.equal(session.callsOf('navigate').length, 0);
});
