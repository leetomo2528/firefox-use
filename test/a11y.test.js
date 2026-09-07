'use strict';
// Unit tests for the page-understanding tools. No browser is launched: the
// handlers run against FakeSession and the page scripts run against a tiny DOM
// shim that implements only the APIs they touch.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const a11y = require('../src/a11y');
const { NO_REF, NO_TAB } = require('../src/session');
const { FakeSession, fakeCtx } = require('./helpers/fake-session');

const SPEC = require('../docs/chrome-tool-spec.json');

// --- DOM shim --------------------------------------------------------------

const r = (left, top, width, height) => ({ left, top, width, height });
const E = (tag, opts = {}, kids = []) => ({ tag, ...opts, kids });

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  let out = '';
  for (const kid of node._kids || []) out += textOf(kid);
  return out;
}

function buildNode(spec, parent, byId) {
  if (typeof spec === 'string') {
    return { nodeType: 3, nodeValue: spec, parentElement: parent, nextSibling: null, firstChild: null };
  }
  const attrs = spec.attrs || {};
  const node = {
    nodeType: 1,
    localName: spec.tag,
    parentElement: parent,
    isConnected: true,
    nextSibling: null,
    _attrs: attrs,
    _rect: spec.rect || r(0, 0, 0, 0),
    _style: spec.style || { display: 'block', visibility: 'visible', opacity: '1' },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? String(this._attrs[name]) : null;
    },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); },
    getBoundingClientRect() { return { ...this._rect }; },
    getElementsByTagName(tag) {
      const out = [];
      const walk = (n) => { for (const k of n._kids || []) { if (k.nodeType === 1) { if (k.localName === tag) out.push(k); walk(k); } } };
      walk(this);
      return out;
    },
    get textContent() { return textOf(this); },
    get isContentEditable() {
      const v = this.getAttribute('contenteditable');
      return v !== null && v !== 'false';
    },
  };
  Object.assign(node, spec.props || {});
  node._kids = (spec.kids || []).map((kid) => buildNode(kid, node, byId));
  node.firstChild = node._kids[0] || null;
  for (let i = 0; i < node._kids.length; i++) node._kids[i].nextSibling = node._kids[i + 1] || null;
  if (attrs.id) byId.set(String(attrs.id), node);
  return node;
}

// Supports exactly the selector shapes the page scripts use: comma separated
// tag names and [attr=value] predicates.
function matches(el, selector) {
  return selector.split(',').map((s) => s.trim()).filter(Boolean).some((part) => {
    const m = /^([a-z0-9]*)(?:\[([a-z-]+)(?:=([^\]]+))?\])?$/i.exec(part);
    if (!m) return false;
    const [, tag, attr, value] = m;
    if (tag && el.localName !== tag) return false;
    if (attr) {
      const actual = el.getAttribute(attr);
      if (actual === null) return false;
      if (value !== undefined && actual !== value.replace(/^["']|["']$/g, '')) return false;
    }
    return true;
  });
}

function makeDom({ title = 'Test page', url = 'https://example.com/', body }) {
  const byId = new Map();
  const bodyEl = buildNode(body, null, byId);
  const all = [];
  const collect = (n) => { for (const k of n._kids || []) { if (k.nodeType === 1) { all.push(k); collect(k); } } };
  collect(bodyEl);
  const document = {
    title,
    body: bodyEl,
    getElementById: (id) => byId.get(String(id)) || null,
    querySelector: (sel) => all.find((el) => matches(el, sel)) || null,
    querySelectorAll: (sel) => all.filter((el) => matches(el, sel)),
  };
  const window = { getComputedStyle: (el) => el._style };
  return { window, document, location: { href: url }, all };
}

const runPageFn = (dom, src, arg) => {
  const fn = new Function('window', 'document', 'location', `return ${src}`)(dom.window, dom.document, dom.location);
  return JSON.parse(fn(arg));
};

function shopDom() {
  return makeDom({
    title: 'Shop',
    url: 'https://shop.test/',
    body: E('body', {}, [
      E('h1', { rect: r(0, 0, 300, 40) }, ['Welcome']),
      E('div', { attrs: { id: 'panel' }, rect: r(0, 50, 300, 200) }, [
        E('button', { attrs: { 'aria-label': 'Sign in' }, rect: r(120, 340, 80, 32) }, ['Sign in']),
        E('input', { attrs: { type: 'search', name: 'q', placeholder: 'Search' }, rect: r(0, 100, 200, 30) }),
        E('span', { attrs: { 'aria-hidden': 'true' } }, ['offscreen note']),
      ]),
      E('script', {}, ['var x = 1;']),
    ]),
  });
}

// --- formatting ------------------------------------------------------------

test('formatNodeLine renders ref, role, name, value, flags and box', () => {
  const line = a11y.formatNodeLine({
    ref: 'ref_12', role: 'textbox', name: 'Email', value: 'a@b.c',
    required: true, disabled: true, visible: true, box: { x: 120, y: 340, w: 80, h: 32 },
  });
  assert.strictEqual(line, '[ref_12] textbox "Email" value="a@b.c" disabled required (120,340) 80x32');
});

test('formatNodeLine indents, marks invisible elements and omits a missing box', () => {
  const line = a11y.formatNodeLine({ ref: 'ref_3', role: 'StaticText', name: 'Hi', visible: false }, 2);
  assert.strictEqual(line, '    [ref_3] StaticText "Hi" (not visible)');
});

test('renderTree heads the output with title and url and indents children', () => {
  const out = a11y.renderTree({
    url: 'https://shop.test/', title: 'Shop', filter: 'all', count: 2,
    nodes: [{
      ref: 'ref_12', role: 'button', name: 'Sign in', visible: true, box: { x: 120, y: 340, w: 80, h: 32 },
      children: [{ ref: 'ref_13', role: 'StaticText', name: 'Sign in', visible: true, children: [] }],
    }],
  });
  assert.deepStrictEqual(out.split('\n'), [
    'Shop - https://shop.test/',
    '',
    '[ref_12] button "Sign in" (120,340) 80x32',
    '  [ref_13] StaticText "Sign in"',
  ]);
});

test('renderTree reports a depth-clipped tree', () => {
  const out = a11y.renderTree({
    url: 'u', title: 't', filter: 'all', depth: 3, count: 1, clipped: true,
    nodes: [{ ref: 'ref_1', role: 'generic', visible: true, children: [] }],
  });
  assert.match(out, /\[depth limit 3 reached: elements deeper than that were not listed - pass a larger depth/);
});

test('renderTree keeps the limit notes when max_chars truncates the body', () => {
  const nodes = [];
  for (let i = 1; i <= 40; i++) {
    nodes.push({ ref: `ref_${i}`, role: 'button', name: `Item ${i}`, visible: true, children: [] });
  }
  const out = a11y.renderTree(
    { url: 'u', title: 't', filter: 'all', depth: 15, count: 40, capped: true, clipped: true, nodes },
    { maxChars: 120 },
  );
  assert.match(out, /\[Output truncated at \d+ of \d+ characters\./, 'body was truncated');
  assert.match(out, /depth limit 15 reached/, 'depth note survives truncation');
  assert.match(out, /element limit reached: only the first 40 elements are listed/, 'cap note survives truncation');
});

test('renderTree reports an empty tree and the element cap', () => {
  const empty = a11y.renderTree({ url: 'u', title: 't', filter: 'interactive', nodes: [] });
  assert.match(empty, /\(no interactive elements found\)/);
  const capped = a11y.renderTree({ url: 'u', title: 't', nodes: [{ ref: 'ref_1', role: 'generic', visible: true, children: [] }], capped: true, count: 5000 });
  assert.match(capped, /element limit reached: only the first 5000 elements are listed/);
});

// --- truncation ------------------------------------------------------------

test('truncateAtLine leaves short output alone', () => {
  const text = 'line one\nline two';
  assert.strictEqual(a11y.truncateAtLine(text, 100), text);
  assert.strictEqual(a11y.truncateAtLine(text, 0), text); // 0 falls back to the default
});

test('truncateAtLine cuts at a line boundary and reports the full size', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`[ref_${i}] button "Item ${i}"`);
  const text = lines.join('\n');
  const out = a11y.truncateAtLine(text, 100);
  const body = out.split('\n\n[Output truncated')[0];
  assert.ok(body.length <= 100, 'kept body within the limit');
  assert.ok(!body.endsWith('\n'), 'no trailing newline');
  for (const line of body.split('\n')) assert.match(line, /^\[ref_\d+\] button "Item \d+"$/, 'only whole lines survive');
  assert.match(out, new RegExp(`\\[Output truncated at ${body.length} of ${text.length} characters\\.`));
  assert.match(out, /larger max_chars, or narrow the tree with depth or ref_id/);
});

// --- read_page -------------------------------------------------------------

const treeResponse = (nodes, extra = {}) => ({
  url: 'https://shop.test/', title: 'Shop', filter: 'all', depth: 15, count: nodes.length,
  capped: false, nodes, ...extra,
});

test('read_page installs the ref store and sends the default walk options', async () => {
  const session = new FakeSession({ responses: { callJson: [treeResponse([])] } });
  await a11y.readPage(session, { tabId: 1 });
  assert.deepStrictEqual(session.callsOf('ensureRefStore')[0].args, { tabId: 1 });
  const call = session.callsOf('callJson')[0];
  assert.strictEqual(call.args.tabId, 1);
  assert.strictEqual(call.args.fn, a11y.TREE_FN);
  assert.deepStrictEqual(call.args.args, [{ filter: 'all', depth: 15, refId: '', cap: 5000 }]);
});

test('read_page passes filter, depth and ref_id through, and rejects nonsense values', async () => {
  const session = new FakeSession({ responses: { callJson: [treeResponse([]), treeResponse([])] } });
  await a11y.readPage(session, { tabId: 1, filter: 'interactive', depth: 3, ref_id: 'ref_9' });
  assert.deepStrictEqual(session.callsOf('callJson')[0].args.args, [{ filter: 'interactive', depth: 3, refId: 'ref_9', cap: 5000 }]);
  await a11y.readPage(session, { tabId: 1, filter: 'visible', depth: -4, ref_id: '' });
  assert.deepStrictEqual(session.callsOf('callJson')[1].args.args, [{ filter: 'all', depth: 15, refId: '', cap: 5000 }]);
});

test('read_page truncates at a line boundary when max_chars is small', async () => {
  const nodes = [];
  for (let i = 1; i <= 30; i++) {
    nodes.push({ ref: `ref_${i}`, role: 'button', name: `Item ${i}`, visible: true, box: { x: 0, y: i, w: 10, h: 10 }, children: [] });
  }
  const session = new FakeSession({ responses: { callJson: [treeResponse(nodes)] } });
  const out = await a11y.readPage(session, { tabId: 1, max_chars: 120 });
  const [body, note] = out.split('\n\n[Output truncated');
  assert.ok(body.length <= 120);
  assert.ok(body.startsWith('Shop - https://shop.test/'));
  assert.ok(note, 'truncation note present');
  assert.ok(!out.includes('ref_30'), 'later lines dropped');
});

test('read_page reports a stale ref_id with the Chrome wording', async () => {
  const session = new FakeSession({ responses: { callJson: [{ error: 'no-ref', ref: 'ref_42' }] } });
  await assert.rejects(() => a11y.readPage(session, { tabId: 1, ref_id: 'ref_42' }), { message: NO_REF('ref_42') });
});

test('read_page falls back to the default tab, and surfaces an unknown tab id', async () => {
  const session = new FakeSession({ responses: { callJson: [treeResponse([])] } });
  await a11y.readPage(session, {});
  assert.strictEqual(session.callsOf('callJson')[0].args.tabId, 1);
  await assert.rejects(() => a11y.readPage(session, { tabId: 99 }), { message: NO_TAB(99) });
});

// --- find ------------------------------------------------------------------

const node = (ref, props) => ({ ref, visible: true, children: [], ...props });

test('find ranks a sign-in button first for "login button"', () => {
  const nodes = [
    node('ref_1', { role: 'link', tag: 'a', name: 'Home', interactive: true }),
    node('ref_2', { role: 'button', tag: 'button', name: 'Sign in', interactive: true }),
    node('ref_3', { role: 'button', tag: 'button', name: 'Create account', interactive: true }),
    node('ref_4', { role: 'generic', tag: 'div', dtext: 'Please log in to continue' }),
  ];
  const ranked = a11y.rankNodes(nodes, 'login button');
  assert.strictEqual(ranked[0].ref, 'ref_2');
  assert.ok(ranked.length >= 2 && ranked.length < nodes.length, 'unrelated link is not a match');
  assert.ok(!ranked.some((n) => n.ref === 'ref_1'));
});

test('find prefers a real search input over any text field for "search bar"', () => {
  const nodes = [
    node('ref_1', { role: 'textbox', tag: 'input', interactive: true, attrs: { type: 'text', name: 'email', placeholder: 'Email' } }),
    node('ref_2', { role: 'searchbox', tag: 'input', interactive: true, attrs: { type: 'search', name: 'q', placeholder: 'Search products' } }),
    node('ref_3', { role: 'generic', tag: 'div', dtext: 'Search results' }),
  ];
  const ranked = a11y.rankNodes(nodes, 'search bar');
  assert.strictEqual(ranked[0].ref, 'ref_2');
});

test('find matches free text and add-to-cart phrasing', () => {
  const nodes = [
    node('ref_1', { role: 'heading', tag: 'h2', name: 'Organic mango 1kg' }),
    node('ref_2', { role: 'button', tag: 'button', name: 'Add to cart', interactive: true }),
    node('ref_3', { role: 'button', tag: 'button', name: 'Add to wishlist', interactive: true }),
  ];
  assert.strictEqual(a11y.rankNodes(nodes, 'organic mango product')[0].ref, 'ref_1');
  assert.strictEqual(a11y.rankNodes(nodes, 'add to cart button')[0].ref, 'ref_2');
});

test('find skips StaticText nodes so every hit is an element ref', async () => {
  const nodes = [node('ref_1', {
    role: 'button', tag: 'button', name: 'Buy now', interactive: true,
    children: [node('ref_2', { role: 'StaticText', name: 'Buy now' })],
  })];
  const session = new FakeSession({ responses: { callJson: [treeResponse(nodes)] } });
  const out = await a11y.find(session, { query: 'buy now', tabId: 1 });
  assert.match(out, /\[ref_1\] button "Buy now"/);
  assert.ok(!out.includes('ref_2'), 'StaticText child is not listed');
  assert.match(out, /^Shop - https:\/\/shop\.test\/$/m);
  assert.match(out, /1 match for "buy now":/);
});

test('find caps the list at 20 and asks for a narrower query', async () => {
  const nodes = [];
  for (let i = 1; i <= 25; i++) nodes.push(node(`ref_${i}`, { role: 'button', tag: 'button', name: `Item ${i}`, interactive: true }));
  const session = new FakeSession({ responses: { callJson: [treeResponse(nodes)] } });
  const out = await a11y.find(session, { query: 'item', tabId: 1 });
  assert.match(out, /25 matches for "item", showing the best 20:/);
  assert.match(out, /More than 20 elements matched\. Use a more specific query to narrow it down\./);
  assert.strictEqual(out.split('\n').filter((l) => l.startsWith('[ref_')).length, 20);
  assert.ok(!out.includes('[ref_21]'));
});

test('find says so plainly when nothing matches', async () => {
  const nodes = [node('ref_1', { role: 'button', tag: 'button', name: 'Sign in', interactive: true })];
  const session = new FakeSession({ responses: { callJson: [treeResponse(nodes)] } });
  const out = await a11y.find(session, { query: 'zebra', tabId: 1 });
  assert.match(out, /No elements matched "zebra"\./);
  assert.match(out, /call read_page to see what is on the page/);
  assert.ok(!out.includes('ref_1'));
});

test('find needs a query and walks the whole tree', async () => {
  const session = new FakeSession({ responses: { callJson: [treeResponse([])] } });
  await assert.rejects(() => a11y.find(session, { tabId: 1, query: '   ' }), /find requires a query/);
  await a11y.find(session, { query: 'anything', tabId: 1 });
  assert.deepStrictEqual(session.callsOf('callJson')[0].args.args, [{ filter: 'all', depth: 30, refId: '', cap: 5000 }]);
  assert.strictEqual(session.callsOf('ensureRefStore').length, 1, 'refs are registered so hits are usable');
});

// --- get_page_text ---------------------------------------------------------

test('get_page_text prepends title and url and needs no ref store', async () => {
  const session = new FakeSession({
    responses: { callJson: [{ url: 'https://blog.test/p', title: 'A post', source: 'article', text: 'One.\n\nTwo.' }] },
  });
  const out = await a11y.getPageText(session, { tabId: 1 });
  assert.strictEqual(out, 'A post - https://blog.test/p\n\nOne.\n\nTwo.');
  assert.strictEqual(session.callsOf('ensureRefStore').length, 0);
  assert.strictEqual(session.callsOf('callJson')[0].args.fn, a11y.TEXT_FN);
});

test('get_page_text handles a page with no text', async () => {
  const session = new FakeSession({ responses: { callJson: [{ url: 'https://x.test/', title: '', text: '   ' }] } });
  assert.strictEqual(await a11y.getPageText(session, { tabId: 1 }), '(untitled) - https://x.test/\n\n(no readable text on this page)');
});

test('get_page_text caps a pathologically large page and says that it did', async () => {
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(`Line ${i} of a page that never ends.`);
  const text = lines.join('\n');
  assert.ok(text.length > a11y.MAX_TEXT_CHARS, 'fixture is over the cap');
  const session = new FakeSession({ responses: { callJson: [{ url: 'https://huge.test/', title: 'Huge', text }] } });
  const out = await a11y.getPageText(session, { tabId: 1 });
  const body = out.split('\n\n[Page text truncated')[0];
  assert.ok(body.length <= a11y.MAX_TEXT_CHARS + 'Huge - https://huge.test/\n\n'.length);
  assert.ok(body.endsWith('never ends.'), 'cut on a line boundary');
  assert.match(out, new RegExp(`\\[Page text truncated at \\d+ of ${text.length} characters\\.\\]$`));
});

// --- page scripts ----------------------------------------------------------

test('TREE_FN walks the DOM, registers refs and emits StaticText', () => {
  const dom = shopDom();
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 5000 });
  assert.strictEqual(data.url, 'https://shop.test/');
  assert.strictEqual(data.title, 'Shop');

  const [h1, panel] = data.nodes;
  assert.strictEqual(data.nodes.length, 2, 'script tags are skipped');
  assert.strictEqual(h1.role, 'heading');
  assert.strictEqual(h1.name, 'Welcome');
  assert.deepStrictEqual(h1.box, { x: 0, y: 0, w: 300, h: 40 });
  assert.strictEqual(h1.children[0].role, 'StaticText');
  assert.strictEqual(h1.children[0].name, 'Welcome');

  const [button, input, span] = panel.children;
  assert.strictEqual(panel.role, 'generic');
  assert.strictEqual(button.role, 'button');
  assert.strictEqual(button.name, 'Sign in');
  assert.strictEqual(button.interactive, true);
  assert.deepStrictEqual(button.box, { x: 120, y: 340, w: 80, h: 32 });
  assert.strictEqual(input.role, 'searchbox');
  assert.strictEqual(input.name, 'Search');
  assert.strictEqual(input.attrs.name, 'q');
  assert.strictEqual(span.visible, false, 'a zero-size element is reported as not visible');
  assert.strictEqual(span.box, undefined);

  // every emitted element is resolvable through the shared ref store
  const refs = dom.window.__ffuse.refs;
  assert.strictEqual(refs.get(button.ref).localName, 'button');
  assert.strictEqual(refs.get(input.ref).localName, 'input');
  assert.strictEqual(refs.get(button.children[0].ref).localName, 'button', 'StaticText resolves to its element');
  assert.strictEqual(dom.window.__ffuse.next, refs.size + 1);
  assert.match(a11y.renderTree(data), /^ {2}\[ref_\d+\] button "Sign in" \(120,340\) 80x32$/m);
});

test('TREE_FN interactive filter keeps only actionable elements', () => {
  const dom = shopDom();
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'interactive', depth: 15, refId: '', cap: 5000 });
  assert.deepStrictEqual(data.nodes.map((n) => n.role), ['button', 'searchbox']);
  assert.deepStrictEqual(data.nodes.map((n) => n.children.length), [0, 0]);
  assert.strictEqual(data.count, 2);
});

test('TREE_FN honours depth and ref_id, and reports a stale ref', () => {
  const dom = shopDom();
  const shallow = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 1, refId: '', cap: 5000 });
  assert.deepStrictEqual(shallow.nodes.map((n) => n.children.length), [0, 0]);

  const full = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 5000 });
  const panelRef = full.nodes[1].ref;
  const scoped = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: panelRef, cap: 5000 });
  assert.strictEqual(scoped.nodes.length, 1, 'the ref itself is the root of the walk');
  assert.strictEqual(scoped.nodes[0].role, 'generic');
  assert.deepStrictEqual(scoped.nodes[0].children.map((n) => n.role), ['button', 'searchbox', 'generic']);

  assert.deepStrictEqual(runPageFn(dom, a11y.TREE_FN, { refId: 'ref_999' }), { error: 'no-ref', ref: 'ref_999' });
});

test('TREE_FN flags a depth-clipped walk so read_page can say so', () => {
  const dom = shopDom();
  assert.strictEqual(runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 1, refId: '', cap: 5000 }).clipped, true);
  assert.strictEqual(runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 5000 }).clipped, false);
  const out = a11y.renderTree(runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 1, refId: '', cap: 5000 }));
  assert.match(out, /\[depth limit 1 reached/);
});

test('TREE_FN emits an svg as one node instead of its path/g internals', () => {
  const dom = makeDom({
    body: E('body', {}, [
      E('button', { rect: r(0, 0, 60, 20) }, [
        E('svg', { rect: r(0, 0, 16, 16) }, [
          E('title', {}, ['icon']),
          E('g', {}, [E('path', { attrs: { d: 'M0 0' } }), E('path', { attrs: { d: 'M1 1' } })]),
        ]),
        'Save',
      ]),
    ]),
  });
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 5000 });
  const button = data.nodes[0];
  assert.deepStrictEqual(button.children.map((n) => n.role), ['graphic', 'StaticText']);
  assert.strictEqual(button.children[0].children.length, 0, 'svg internals are not walked');
  assert.strictEqual(button.name, 'icon Save', 'the svg title is separated from the label, not glued to it');
  assert.strictEqual(data.count, 3);
});

test('TREE_FN separates name-from-content across block children but not inline ones', () => {
  const dom = makeDom({
    body: E('body', {}, [
      E('a', { attrs: { href: '/p/1' }, rect: r(0, 0, 200, 60) }, [
        E('div', {}, ['Organic mango']),
        E('div', {}, [E('span', {}, ['$5']), E('span', {}, ['.00'])]),
      ]),
    ]),
  });
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 5000 });
  assert.strictEqual(data.nodes[0].name, 'Organic mango $5.00');
  assert.strictEqual(a11y.rankNodes(a11y.flattenNodes(data.nodes), 'organic mango')[0].ref, data.nodes[0].ref);
});

test('TREE_FN lower-cases an explicit role so roles are comparable', () => {
  const dom = makeDom({ body: E('body', {}, [E('div', { attrs: { role: 'BUTTON' }, rect: r(0, 0, 40, 20) }, ['Go'])]) });
  const all = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 5000 });
  assert.strictEqual(all.nodes[0].role, 'button');
  const interactive = runPageFn(dom, a11y.TREE_FN, { filter: 'interactive', depth: 15, refId: '', cap: 5000 });
  assert.deepStrictEqual(interactive.nodes.map((n) => n.role), ['button']);
});

test('TREE_FN marks a clipped name rather than cutting it silently', () => {
  const long = 'x'.repeat(400);
  const dom = makeDom({ body: E('body', {}, [E('button', { rect: r(0, 0, 40, 20) }, [long])]) });
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 5000 });
  assert.strictEqual(data.nodes[0].name, `${'x'.repeat(150)}...`);
  assert.strictEqual(data.nodes[0].children[0].name, `${'x'.repeat(200)}...`);
});

test('TREE_FN walks an open shadow root so web components are visible', () => {
  const dom = makeDom({ body: E('body', {}, [E('my-card', { rect: r(0, 0, 100, 50) }, ['Slotted'])]) });
  const host = dom.all.find((el) => el.localName === 'my-card');
  host.shadowRoot = buildNode(E('div', {}, [E('button', { rect: r(0, 0, 40, 20) }, ['Open'])]), null, new Map());
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'interactive', depth: 15, refId: '', cap: 5000 });
  assert.deepStrictEqual(data.nodes.map((n) => n.name), ['Open']);
  assert.strictEqual(dom.window.__ffuse.refs.get(data.nodes[0].ref).localName, 'button');
});

test('TREE_FN guards DOM nesting that the depth limit does not bound', () => {
  // filter=interactive counts only emitted levels, so nothing stops the walk from
  // recursing as deep as the DOM goes; the raw guard has to.
  let nest = E('button', { rect: r(0, 0, 40, 20) }, ['Deep']);
  for (let i = 0; i < 1200; i++) nest = E('div', {}, [nest]);
  const dom = makeDom({ body: E('body', {}, [nest]) });
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'interactive', depth: 15, refId: '', cap: 5000 });
  assert.strictEqual(data.clipped, true);
  assert.deepStrictEqual(data.nodes, []);
});

test('TREE_FN respects the element cap', () => {
  const dom = shopDom();
  const data = runPageFn(dom, a11y.TREE_FN, { filter: 'all', depth: 15, refId: '', cap: 2 });
  assert.strictEqual(data.capped, true);
  assert.strictEqual(data.count, 2);
});

test('TEXT_FN prefers the article and strips navigation and scripts', () => {
  const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ';
  const dom = makeDom({
    title: 'A post',
    url: 'https://blog.test/p',
    body: E('body', {}, [
      E('nav', {}, ['Home Products About']),
      E('article', {}, [
        E('h1', {}, ['The Title']),
        E('p', {}, [`First paragraph. ${filler}`]),
        E('p', {}, [`Second paragraph. ${filler}`]),
        E('script', {}, ['var tracker = 1;']),
        E('div', { attrs: { 'aria-hidden': 'true' } }, ['screen reader only']),
      ]),
      E('footer', {}, ['Copyright 2026']),
    ]),
  });
  const data = runPageFn(dom, a11y.TEXT_FN);
  assert.strictEqual(data.source, 'article');
  assert.strictEqual(data.title, 'A post');
  assert.match(data.text, /^The Title\n\nFirst paragraph\./);
  assert.match(data.text, /\n\nSecond paragraph\./);
  for (const noise of ['Home Products', 'Copyright 2026', 'var tracker', 'screen reader only']) {
    assert.ok(!data.text.includes(noise), `stripped: ${noise}`);
  }
  assert.ok(!/\n{3,}/.test(data.text), 'paragraph breaks collapsed');
});

// --- tool definitions ------------------------------------------------------

test('tool definitions match the Chrome spec verbatim', () => {
  const defs = a11y.tools(fakeCtx(new FakeSession()));
  assert.deepStrictEqual(defs.map((d) => d.name), ['read_page', 'find', 'get_page_text']);
  for (const def of defs) {
    const spec = SPEC.find((s) => s.name === def.name);
    assert.ok(spec, `${def.name} exists in ${path.basename('chrome-tool-spec.json')}`);
    assert.strictEqual(def.description, spec.description, `${def.name} description`);
    assert.deepStrictEqual(def.inputSchema, spec.inputSchema, `${def.name} inputSchema`);
    assert.deepStrictEqual(Object.keys(def.inputSchema.properties), Object.keys(spec.inputSchema.properties));
    assert.deepStrictEqual(def.inputSchema.required, spec.inputSchema.required);
    assert.strictEqual(typeof def.handler, 'function');
  }
  const readPage = defs[0].inputSchema.properties;
  assert.deepStrictEqual(readPage.filter.enum, ['interactive', 'all']);
  assert.deepStrictEqual(Object.keys(readPage), ['filter', 'tabId', 'depth', 'ref_id', 'max_chars']);
});

test('handlers take the session from ctx and return text', async () => {
  const session = new FakeSession({
    responses: {
      callJson: [
        treeResponse([node('ref_1', { role: 'button', tag: 'button', name: 'Go', interactive: true })]),
        treeResponse([node('ref_1', { role: 'button', tag: 'button', name: 'Go', interactive: true })]),
        { url: 'https://shop.test/', title: 'Shop', text: 'Body text' },
      ],
    },
  });
  const defs = a11y.tools(fakeCtx(session));
  assert.match(await defs[0].handler({ tabId: 1, filter: 'interactive' }), /\[ref_1\] button "Go"/);
  assert.match(await defs[1].handler({ query: 'go', tabId: 1 }), /1 match for "go":/);
  assert.strictEqual(await defs[2].handler({ tabId: 1 }), 'Shop - https://shop.test/\n\nBody text');
});
