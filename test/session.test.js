'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const {
  Session, TabRegistry, ImageStore, toLocalValue, fromRemoteValue,
  NO_TAB, NO_REF, REF_STORE_FN, RESOLVE_REF_FN, NODE_FOR_REF_FN,
} = require('../src/session');

// A BidiConnection stand-in: canned replies per method, recorded calls.
class FakeConn extends EventEmitter {
  constructor(replies = {}) {
    super();
    this.replies = replies;
    this.sent = [];
    this.closed = false;
  }
  async send(method, params, opts) {
    this.sent.push({ method, params, opts });
    const reply = this.replies[method];
    if (typeof reply === 'function') return reply(params);
    if (Array.isArray(reply)) return reply.shift();
    return reply === undefined ? {} : reply;
  }
  close() { this.closed = true; }
  lastOf(method) { return [...this.sent].reverse().find((c) => c.method === method); }
}

function sessionWith(replies = {}) {
  const conn = new FakeConn({
    'browsingContext.getTree': { contexts: [{ context: 'ctx-a', url: 'https://a.test/', clientWindow: 'win-1' }] },
    ...replies,
  });
  const session = new Session(conn, {});
  return { session, conn };
}

test('LocalValue conversion covers the types page functions receive', () => {
  assert.deepEqual(toLocalValue('x'), { type: 'string', value: 'x' });
  assert.deepEqual(toLocalValue(7), { type: 'number', value: 7 });
  assert.deepEqual(toLocalValue(NaN), { type: 'number', value: 'NaN' });
  assert.deepEqual(toLocalValue(-Infinity), { type: 'number', value: '-Infinity' });
  assert.deepEqual(toLocalValue(null), { type: 'null' });
  assert.deepEqual(toLocalValue([true]), { type: 'array', value: [{ type: 'boolean', value: true }] });
  assert.deepEqual(toLocalValue({ a: 'b' }), { type: 'object', value: [['a', { type: 'string', value: 'b' }]] });
  assert.throws(() => toLocalValue(() => {}), /cannot pass function/);
});

test('RemoteValue conversion returns plain JS and stops recursing', () => {
  assert.equal(fromRemoteValue({ type: 'number', value: 'Infinity' }), Infinity);
  assert.equal(fromRemoteValue({ type: 'node', value: { localName: 'input' } }), '<input>');
  assert.deepEqual(fromRemoteValue({ type: 'object', value: [['k', { type: 'string', value: 'v' }]] }), { k: 'v' });
  let deep = { type: 'number', value: 1 };
  for (let i = 0; i < 12; i++) deep = { type: 'array', value: [deep] };
  assert.match(JSON.stringify(fromRemoteValue(deep)), /\.\.\./);
});

test('tab ids are numeric, stable and reused for the same context', () => {
  const tabs = new TabRegistry();
  const first = tabs.add('ctx-1');
  assert.equal(tabs.add('ctx-1'), first, 'same context keeps its id');
  const second = tabs.add('ctx-2');
  assert.notEqual(second, first);
  assert.equal(tabs.contextFor(second), 'ctx-2');
  assert.equal(tabs.tabIdFor('ctx-1'), first);
  tabs.remove('ctx-1');
  assert.equal(tabs.contextFor(first), undefined);
  assert.equal(tabs.ids().length, 1);
});

test('the image store hands out ids and evicts the oldest', () => {
  const store = new ImageStore(2);
  const a = store.put({ data: 'a', mimeType: 'image/png' });
  const b = store.put({ data: 'b', mimeType: 'image/png' });
  const c = store.put({ data: 'c', mimeType: 'image/png' });
  assert.equal(store.get(a), null, 'oldest evicted');
  assert.equal(store.get(b).data, 'b');
  assert.equal(store.lastId, c);
});

test('an unknown tab fails with the Chrome wording', async () => {
  const { session } = sessionWith();
  assert.throws(() => session.requireContext(99), new RegExp(`Tab 99 no longer exists`));
  assert.match(NO_TAB(4), /tabs_context_mcp/);
  assert.match(NO_REF('ref_9'), /read_page or find/);
});

test('adopted tabs become the session group', async () => {
  const { session } = sessionWith();
  const ids = await session.adoptExistingTabs();
  assert.deepEqual(ids, [1]);
  const tabs = await session.listTabs();
  assert.equal(tabs[0].url, 'https://a.test/');
  assert.equal(session.tabs.windowContext, 'win-1');
});

test('listTabs drops contexts that disappeared', async () => {
  const { session, conn } = sessionWith();
  await session.adoptExistingTabs();
  conn.replies['browsingContext.getTree'] = { contexts: [] };
  assert.deepEqual(await session.listTabs(), []);
  assert.equal(session.tabs.size, 0);
});

test('the first tab opens a window, later tabs join it', async () => {
  const { session, conn } = sessionWith({
    'browsingContext.getTree': [{ contexts: [] }, { contexts: [{ context: 'ctx-new', url: 'about:blank', clientWindow: 'win-9' }] }],
    'browsingContext.create': { context: 'ctx-new' },
  });
  const tabId = await session.createTab();
  assert.equal(conn.lastOf('browsingContext.create').params.type, 'window');
  assert.equal(session.tabs.contextFor(tabId), 'ctx-new');

  conn.replies['browsingContext.getTree'] = { contexts: [{ context: 'ctx-new', url: 'about:blank', clientWindow: 'win-9' }] };
  conn.replies['browsingContext.create'] = { context: 'ctx-second' };
  await session.createTab();
  const create = conn.lastOf('browsingContext.create');
  assert.equal(create.params.type, 'tab');
  assert.equal(create.params.referenceContext, 'ctx-new', 'new tabs land next to the group');
});

test('screenshots pass through clip, format and origin', async () => {
  const { session, conn } = sessionWith({ 'browsingContext.captureScreenshot': { data: 'AAA' } });
  await session.adoptExistingTabs();
  await session.screenshot(1, { clip: { x: 1.4, y: 2.6, width: 30.2, height: 40.8 } });
  const clipped = conn.lastOf('browsingContext.captureScreenshot').params;
  assert.deepEqual(clipped.clip, { type: 'box', x: 1, y: 3, width: 30, height: 41 }, 'rounded box');
  assert.equal(clipped.origin, 'viewport');
  await session.screenshot(1, { fullPage: true, format: 'jpeg' });
  const full = conn.lastOf('browsingContext.captureScreenshot').params;
  assert.equal(full.origin, 'document');
  assert.equal(full.format.type, 'image/jpeg');
  assert.equal(full.format.quality, 0.8);
});

test('resolveRef reports a stale ref instead of clicking nothing', async () => {
  const { session } = sessionWith({
    'script.callFunction': { type: 'success', result: { type: 'string', value: JSON.stringify({ found: false }) } },
  });
  await session.adoptExistingTabs();
  await assert.rejects(() => session.resolveRef(1, 'ref_3'), /Element ref_3 was not found/);
});

test('refNode insists on a real node handle', async () => {
  const { session } = sessionWith({
    'script.callFunction': { type: 'success', result: { type: 'null' } },
  });
  await session.adoptExistingTabs();
  await assert.rejects(() => session.refNode(1, 'ref_3'), /was not found/);
});

test('the viewport is applied once per context', async () => {
  const { session, conn } = sessionWith({
    'script.evaluate': { type: 'success', result: { type: 'number', value: 1 } },
  });
  await session.adoptExistingTabs();
  await session.callFunction(1, '() => 1', []).catch(() => {});
  await session.callFunction(1, '() => 1', []).catch(() => {});
  const sized = conn.sent.filter((c) => c.method === 'browsingContext.setViewport');
  assert.equal(sized.length, 1, 'not re-sent on every call');
  assert.deepEqual(sized[0].params.viewport, { width: 1280, height: 800 });
  assert.equal(sized[0].params.devicePixelRatio, 1);
});

test('page scripts are ASCII and parse as functions', () => {
  for (const [name, src] of Object.entries({ REF_STORE_FN, RESOLVE_REF_FN, NODE_FOR_REF_FN })) {
    assert.ok(!/[^\x20-\x7e\n\r\t]/.test(src), `${name} is ASCII`);
    assert.equal(typeof new Function(`return ${src}`)(), 'function', name);
  }
});
