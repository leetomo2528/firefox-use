'use strict';
// read_page / find / get_page_text: the page-understanding tools.
//
// The page scripts do one thing only - walk the DOM and hand back structured
// JSON (registering every element they emit in window.__ffuse.refs). All the
// rendering, truncation and natural-language ranking happens here in Node so
// it can be unit tested without a browser.

const { NO_REF } = require('./session');

const DEFAULT_MAX_CHARS = 50000;
const MAX_TEXT_CHARS = 200000;
const DEFAULT_DEPTH = 15;
const FIND_DEPTH = 30;
const FIND_LIMIT = 20;
const NODE_CAP = 5000;
// window.__ffuse.refs pins every element it holds, so it must not grow forever on
// a long-lived SPA document. At NODE_CAP nodes per read this keeps four full page
// reads resolvable and drops the oldest refs beyond that. Ids are never reused:
// store.next only ever climbs, so an evicted ref reads as stale, not as a hit on
// some other element.
const REF_CAP = 20000;

// Walks the DOM, registers a ref for every emitted element and returns the
// tree as JSON. Text nodes become StaticText entries whose ref points at the
// containing element, so a ref from any line is always actionable.
const TREE_FN = `(function (opts) {
  opts = opts || {};
  var filter = opts.filter === 'interactive' ? 'interactive' : 'all';
  var maxDepth = opts.depth > 0 ? Math.floor(opts.depth) : 15;
  var cap = opts.cap > 0 ? Math.floor(opts.cap) : 5000;
  var refCap = opts.refCap > 0 ? Math.floor(opts.refCap) : ${REF_CAP};
  // Repair a partial store rather than replacing it: session.ensureRefStore seeds
  // next with this document's id block, and resetting it to 1 would hand out ids
  // the model is still holding from the previous document.
  var store = window.__ffuse;
  if (!store) { store = window.__ffuse = { clicks: [] }; }
  if (!store.refs || typeof store.refs.get !== 'function') store.refs = new Map();
  if (!(store.next > 0)) store.next = 1;
  if (!store.clicks) store.clicks = [];

  // Refs minted by this walk are the newest entries in the Map, so eviction from
  // the front can never take one of them.
  var minted = 0;
  function register(el) {
    var ref = 'ref_' + store.next++;
    store.refs.set(ref, el);
    minted++;
    var over = store.refs.size - refCap;
    var older = store.refs.size - minted;
    if (over > older) over = older;
    if (over > 0) {
      var keys = store.refs.keys();
      var doomed = [];
      for (var d = 0; d < over; d++) {
        var step = keys.next();
        if (step.done) break;
        doomed.push(step.value);
      }
      for (var x = 0; x < doomed.length; x++) store.refs['delete'](doomed[x]);
    }
    return ref;
  }

  var SKIP = { script: 1, style: 1, noscript: 1, template: 1, link: 1, meta: 1, head: 1, title: 1, base: 1 };
  // Emitted as one node, never walked into: their internals (path/g/defs, canvas
  // fallback, MathML) are not in the accessibility tree and would flood the output.
  var NO_DESCEND = { svg: 1, canvas: 1, math: 1 };
  // Name-from-content ignores these, but keeps svg <title> (it names the graphic).
  var NAME_SKIP = { script: 1, style: 1, noscript: 1, template: 1, head: 1, meta: 1, link: 1, base: 1 };
  var INLINE = {
    a: 1, b: 1, i: 1, em: 1, strong: 1, span: 1, u: 1, s: 1, small: 1, sub: 1, sup: 1,
    code: 1, kbd: 1, samp: 1, mark: 1, abbr: 1, time: 1, bdi: 1, bdo: 1, wbr: 1,
    'var': 1, cite: 1, q: 1, del: 1, ins: 1, big: 1, tt: 1, nobr: 1, ruby: 1, rt: 1,
    rp: 1, font: 1, output: 1, data: 1, dfn: 1
  };
  var INTERACTIVE_TAGS = { button: 1, input: 1, select: 1, textarea: 1 };
  var INTERACTIVE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1,
    option: 1, 'switch': 1, combobox: 1, textbox: 1, searchbox: 1
  };
  var FROM_CONTENT = {
    button: 1, link: 1, heading: 1, option: 1, menuitem: 1, menuitemcheckbox: 1,
    tab: 1, checkbox: 1, radio: 1, 'switch': 1, summary: 1, label: 1,
    columnheader: 1, rowheader: 1, cell: 1, gridcell: 1, treeitem: 1
  };
  var BUTTONISH = { submit: 1, button: 1, reset: 1, image: 1 };
  var INPUT_ROLES = {
    submit: 'button', button: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    text: 'textbox', password: 'textbox', file: 'button', hidden: 'hidden'
  };
  var TAG_ROLES = {
    a: 'link', button: 'button', textarea: 'textbox', img: 'img', form: 'form',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    ul: 'list', ol: 'list', li: 'listitem', dl: 'list', table: 'table', tr: 'row',
    td: 'cell', th: 'columnheader', thead: 'rowgroup', tbody: 'rowgroup',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', article: 'article', section: 'region', p: 'paragraph',
    label: 'label', option: 'option', optgroup: 'group', fieldset: 'group',
    legend: 'legend', summary: 'summary', details: 'group', dialog: 'dialog',
    iframe: 'iframe', svg: 'graphic', video: 'video', audio: 'audio',
    blockquote: 'blockquote', code: 'code', pre: 'pre', figure: 'figure',
    figcaption: 'caption', progress: 'progressbar', meter: 'meter', hr: 'separator'
  };

  function collapse(value) {
    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  }

  // Every cut is marked so the caller can tell a short value from a clipped one.
  function clip(text, max) {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  // textContent runs words together across block boundaries ("Product$5"), which
  // ruins both the rendered name and find's matching. Separate on non-inline tags.
  function contentText(el) {
    var parts = [];
    (function walk(node) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { parts.push(n.nodeValue); continue; }
        if (n.nodeType !== 1 || NAME_SKIP[n.localName]) continue;
        var inline = INLINE[n.localName];
        if (!inline) parts.push(' ');
        walk(n);
        if (!inline) parts.push(' ');
      }
    })(el);
    return collapse(parts.join(''));
  }

  function attrOf(el, name) {
    return el.getAttribute ? collapse(el.getAttribute(name)) : '';
  }

  function typeOf(el) {
    return String(el.getAttribute('type') || '').toLowerCase();
  }

  function roleFor(el) {
    var explicit = attrOf(el, 'role');
    if (explicit) return explicit.split(' ')[0].toLowerCase();
    var tag = el.localName;
    if (tag === 'input') {
      var t = typeOf(el) || 'text';
      return INPUT_ROLES[t] || 'input:' + t;
    }
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (el.isContentEditable) return 'textbox';
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (tag === 'div' || tag === 'span') return 'generic';
    return tag;
  }

  function isInteractive(el) {
    var tag = el.localName;
    if (tag === 'a') return el.hasAttribute('href');
    if (INTERACTIVE_TAGS[tag]) return !(tag === 'input' && typeOf(el) === 'hidden');
    var role = attrOf(el, 'role').toLowerCase();
    if (role && INTERACTIVE_ROLES[role]) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex')) return true;
    return false;
  }

  function labelledBy(el) {
    var ids = attrOf(el, 'aria-labelledby');
    if (!ids) return '';
    var parts = ids.split(' ');
    var acc = [];
    for (var i = 0; i < parts.length; i++) {
      var target = parts[i] && document.getElementById(parts[i]);
      if (target) acc.push(contentText(target));
    }
    return collapse(acc.join(' '));
  }

  function directText(el) {
    var out = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return clip(collapse(out), 200);
  }

  function accName(el, role) {
    var name = attrOf(el, 'aria-label');
    if (!name) name = labelledBy(el);
    if (!name && el.labels && el.labels.length) name = contentText(el.labels[0]);
    if (!name) name = attrOf(el, 'alt');
    if (!name) name = attrOf(el, 'placeholder');
    if (!name) name = attrOf(el, 'title');
    if (!name && el.localName === 'input' && BUTTONISH[typeOf(el)]) name = collapse(el.value);
    if (!name && FROM_CONTENT[role]) name = contentText(el);
    return clip(name, 150);
  }

  function valueOf(el) {
    var tag = el.localName;
    if (tag === 'input') {
      var t = typeOf(el) || 'text';
      if (t === 'password' || t === 'checkbox' || t === 'radio' || t === 'hidden' || t === 'file' || BUTTONISH[t]) return '';
      return clip(collapse(el.value), 120);
    }
    if (tag === 'textarea') return clip(collapse(el.value), 120);
    if (tag === 'select') {
      var opt = el.options && el.options[el.selectedIndex];
      return opt ? clip(collapse(opt.textContent), 120) : '';
    }
    return clip(attrOf(el, 'aria-valuenow'), 120);
  }

  var out = [];
  var count = 0;
  var capped = false;
  var clipped = false;

  function describe(el) {
    var role = roleFor(el);
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    var box = null;
    var visible = false;
    if (rect && (rect.width > 0 || rect.height > 0)) {
      box = {
        x: Math.round(rect.left), y: Math.round(rect.top),
        w: Math.round(rect.width), h: Math.round(rect.height)
      };
      var style = window.getComputedStyle(el);
      visible = style.display !== 'none' && style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' && Number(style.opacity) > 0.01 &&
        rect.width > 0 && rect.height > 0;
    }
    var node = { ref: register(el), role: role, tag: el.localName, visible: visible, children: [] };
    if (box) node.box = box;
    var name = accName(el, role);
    if (name) node.name = name;
    var value = valueOf(el);
    if (value) node.value = value;
    var text = directText(el);
    if (text && text !== name) node.dtext = text;
    if (isInteractive(el)) node.interactive = true;
    if (el.disabled === true || attrOf(el, 'aria-disabled') === 'true') node.disabled = true;
    if (el.checked === true || attrOf(el, 'aria-checked') === 'true') node.checked = true;
    if (attrOf(el, 'aria-expanded') === 'true') node.expanded = true;
    if (el.selected === true || attrOf(el, 'aria-selected') === 'true') node.selected = true;
    if (el.required === true || attrOf(el, 'aria-required') === 'true') node.required = true;
    if (el.localName === 'input') node.itype = typeOf(el) || 'text';
    var attrs = {};
    var keys = ['id', 'name', 'placeholder', 'title', 'type', 'aria-label'];
    for (var i = 0; i < keys.length; i++) {
      var v = attrOf(el, keys[i]);
      if (v) attrs[keys[i] === 'aria-label' ? 'ariaLabel' : keys[i]] = clip(v, 120);
    }
    var href = attrOf(el, 'href');
    if (href) attrs.href = clip(href, 120);
    for (var unused in attrs) { node.attrs = attrs; break; }
    return node;
  }

  // depth counts DOM levels descended, not levels emitted, so it bounds an
  // interactive read the same way it bounds a full one - a button buried 20 divs
  // deep is out of reach at depth 15 either way. Levels past the limit are still
  // walked but nothing there is listed, so clipped is set only when something
  // that would have been emitted was really dropped. raw is the separate DOM
  // nesting guard that keeps a pathological page from overflowing the page-side
  // stack.
  function visit(node, list, depth, force, raw) {
    if (count >= cap) { capped = true; return; }
    if (raw > 1000) { clipped = true; return; }
    if (node.nodeType === 3) {
      if (filter !== 'all') return;
      var text = collapse(node.nodeValue);
      if (!text) return;
      // Text the depth limit cut is a cut like any other; whitespace is not.
      if (depth >= maxDepth) { clipped = true; return; }
      var parent = node.parentElement;
      if (!parent) return;
      list.push({ ref: register(parent), role: 'StaticText', tag: '#text', name: clip(text, 200), visible: true, children: [] });
      count++;
      return;
    }
    if (node.nodeType !== 1) return;
    if (SKIP[node.localName]) return;
    var keep = force || filter === 'all' || isInteractive(node);
    var childList = list;
    var childDepth = depth + 1;
    if (keep) {
      if (depth >= maxDepth) { clipped = true; return; }
      var entry = describe(node);
      list.push(entry);
      count++;
      childList = entry.children;
    }
    if (NO_DESCEND[node.localName]) return;
    var shadow = node.shadowRoot;
    if (shadow) {
      for (var sc = shadow.firstChild; sc; sc = sc.nextSibling) visit(sc, childList, childDepth, false, raw + 1);
    }
    for (var child = node.firstChild; child; child = child.nextSibling) {
      visit(child, childList, childDepth, false, raw + 1);
    }
  }

  var root = document.body;
  if (opts.refId) {
    var target = store.refs.get(String(opts.refId));
    if (!target || !target.isConnected) return JSON.stringify({ error: 'no-ref', ref: String(opts.refId) });
    root = target;
  }
  if (root && opts.refId) {
    visit(root, out, 0, true, 0);
  } else if (root) {
    for (var c = root.firstChild; c; c = c.nextSibling) visit(c, out, 0, false, 0);
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    filter: filter,
    depth: maxDepth,
    count: count,
    capped: capped,
    clipped: clipped,
    nodes: out
  });
})`;

// Article-first plain text. Built from the DOM by hand rather than innerText so
// paragraph structure survives without depending on layout.
const TEXT_FN = `(function () {
  var DROP = {
    script: 1, style: 1, noscript: 1, template: 1, svg: 1, canvas: 1, iframe: 1,
    nav: 1, header: 1, footer: 1, aside: 1, select: 1
  };
  var DROP_ROLES = { navigation: 1, banner: 1, contentinfo: 1, complementary: 1, search: 1, menu: 1, menubar: 1, toolbar: 1 };
  var BLOCK = {
    p: 1, div: 1, section: 1, article: 1, main: 1, li: 1, br: 1, tr: 1, td: 1, th: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, blockquote: 1, pre: 1, figure: 1,
    figcaption: 1, dt: 1, dd: 1, ul: 1, ol: 1, table: 1, hr: 1, form: 1, header: 1, footer: 1
  };

  function collapseLen(el) {
    return String(el.textContent || '').replace(/\\s+/g, ' ').trim().length;
  }

  function extract(root) {
    var parts = [];
    (function walk(node) {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      var tag = node.localName;
      if (DROP[tag] && node !== root) return;
      if (node.getAttribute) {
        var role = String(node.getAttribute('role') || '').toLowerCase();
        if (role && DROP_ROLES[role] && node !== root) return;
        if (node.getAttribute('aria-hidden') === 'true') return;
        if (node.hasAttribute('hidden')) return;
      }
      var block = BLOCK[tag];
      if (block) parts.push('\\n');
      for (var child = node.firstChild; child; child = child.nextSibling) walk(child);
      if (block) parts.push('\\n');
    })(root);
    return parts.join('');
  }

  // extract's own rules, measured instead of joined. The ratio test below asks
  // how much of the page's readable text the articles hold, and body.textContent
  // is the wrong denominator for that: it counts text no reader ever sees, and a
  // framework hydration blob in a <script> is routinely larger than the prose -
  // big enough to make a whole page of articles look like a sliver of itself.
  function readableLen(el) {
    return extract(el).replace(/\\s+/g, ' ').trim().length;
  }

  // Text over markup, weighted by how many paragraphs the block holds. Used for
  // both the article candidates and the div fallback so they rank alike.
  function scoreOf(el, len) {
    var html = el.innerHTML ? el.innerHTML.length : len;
    var density = len / (html > 0 ? html : 1);
    var paragraphs = el.getElementsByTagName ? el.getElementsByTagName('p').length : 0;
    return len * (0.3 + density) * (1 + (paragraphs > 20 ? 20 : paragraphs) / 20);
  }

  // A blog index or news homepage wraps every teaser card in its own <article>,
  // so the first one is a single card, not the page. Rank the candidates, keep
  // the ones of comparable size, and abandon the article path when what is left
  // is a sliver of the page - main/density will read it better.
  function articleRoots() {
    var nodes = document.querySelectorAll('article');
    var cands = [];
    for (var i = 0; i < nodes.length && i < 1000; i++) {
      var el = nodes[i];
      var nested = false;
      // An article inside an article would have its text counted twice.
      for (var p = el.parentElement; p; p = p.parentElement) {
        if (p.localName === 'article') { nested = true; break; }
      }
      if (nested) continue;
      var len = collapseLen(el);
      if (len <= 200) continue;
      cands.push({ el: el, len: len, score: scoreOf(el, len), order: i });
    }
    if (!cands.length) return null;
    var best = cands[0];
    for (var j = 1; j < cands.length; j++) if (cands[j].score > best.score) best = cands[j];
    var chosen = [];
    var total = 0;
    for (var k = 0; k < cands.length; k++) {
      if (cands[k] === best || cands[k].len * 2 >= best.len) { chosen.push(cands[k]); total += cands[k].len; }
    }
    // Measured last: a page with no article of its own never pays for it.
    if (total * 4 < readableLen(document.body)) return null;
    chosen.sort(function (a, b) { return a.order - b.order; });
    var els = [];
    for (var m = 0; m < chosen.length; m++) els.push(chosen[m].el);
    return els;
  }

  function pick() {
    var articles = articleRoots();
    if (articles) return { els: articles, source: articles.length > 1 ? 'articles' : 'article' };
    var main = document.querySelector('main, [role=main]');
    if (main && collapseLen(main) > 200) return { els: [main], source: 'main' };
    var nodes = document.querySelectorAll('div, section, td, article, main');
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < nodes.length && i < 4000; i++) {
      var el = nodes[i];
      var len = collapseLen(el);
      if (len < 300) continue;
      var score = scoreOf(el, len);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (best) return { els: [best], source: 'density' };
    return { els: [document.body], source: 'body' };
  }

  var chosen = document.body ? pick() : { els: [], source: 'none' };
  var raw = '';
  for (var ri = 0; ri < chosen.els.length; ri++) {
    raw += (ri ? '\\n\\n' : '') + extract(chosen.els[ri]);
  }
  var text = raw
    .replace(/\\r/g, '')
    .replace(/[ \\t\\f\\v\\u00a0]+/g, ' ')
    .replace(/ *\\n */g, '\\n')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  return JSON.stringify({ url: location.href, title: document.title, source: chosen.source, text: text });
})`;

const FLAGS = ['disabled', 'checked', 'expanded', 'selected', 'required'];

function formatNodeLine(node, indent = 0) {
  const bits = [`[${node.ref}]`, node.role || 'generic'];
  if (node.name) bits.push(JSON.stringify(node.name));
  if (node.itype && node.itype !== 'text') bits.push(`type=${node.itype}`);
  if (node.value) bits.push(`value=${JSON.stringify(node.value)}`);
  for (const flag of FLAGS) if (node[flag]) bits.push(flag);
  if (node.box) bits.push(`(${node.box.x},${node.box.y}) ${node.box.w}x${node.box.h}`);
  if (!node.visible) bits.push('(not visible)');
  return '  '.repeat(indent) + bits.join(' ');
}

function pageHeader(data) {
  return `${data.title || '(untitled)'} - ${data.url || ''}`.trim();
}

// Cut on the last newline at or before the limit so no ref is ever split. A
// first line longer than the limit is the one case that has to cut mid-line.
function cutAtLine(text, limit) {
  let cut = text.lastIndexOf('\n', limit);
  if (cut <= 0) cut = limit;
  return text.slice(0, cut);
}

function truncateAtLine(text, maxChars = DEFAULT_MAX_CHARS) {
  const limit = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : DEFAULT_MAX_CHARS;
  if (text.length <= limit) return text;
  const head = cutAtLine(text, limit);
  return `${head}\n\n[Output truncated at ${head.length} of ${text.length} characters. ` +
    'Pass a larger max_chars, or narrow the tree with depth or ref_id.]';
}

function renderTree(data, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const lines = [pageHeader(data), ''];
  const nodes = data.nodes || [];
  if (!nodes.length) {
    lines.push(data.filter === 'interactive' ? '(no interactive elements found)' : '(no elements found)');
  }
  const walk = (list, indent) => {
    for (const node of list) {
      lines.push(formatNodeLine(node, indent));
      if (node.children && node.children.length) walk(node.children, indent + 1);
    }
  };
  walk(nodes, 0);
  // Notes go on after truncation: a dropped subtree is exactly what the reader
  // needs to know about, and it must not be the thing max_chars cuts off.
  const notes = [];
  if (data.clipped) {
    notes.push(`[depth limit ${data.depth} reached: elements deeper than that were not listed - ` +
      'pass a larger depth, or use ref_id to read that part of the page]');
  }
  if (data.capped) {
    notes.push(`[element limit reached: only the first ${data.count} elements are listed - ` +
      'use ref_id or a smaller depth to read part of the page]');
  }
  const body = truncateAtLine(lines.join('\n'), maxChars);
  return notes.length ? `${body}\n\n${notes.join('\n')}` : body;
}

async function resolveTab(session, tabId) {
  if (tabId === undefined || tabId === null || tabId === '') return session.defaultTabId();
  return tabId;
}

async function readTree(session, tabId, { filter, depth, refId }) {
  await session.ensureRefStore(tabId);
  const data = await session.callJson(tabId, TREE_FN, [{
    filter: filter === 'interactive' ? 'interactive' : 'all',
    depth: Number(depth) > 0 ? Math.floor(Number(depth)) : DEFAULT_DEPTH,
    refId: refId ? String(refId) : '',
    cap: NODE_CAP,
  }]);
  if (!data || typeof data !== 'object') throw new Error('The page returned no accessibility tree.');
  if (data.error === 'no-ref') throw new Error(NO_REF(refId));
  return data;
}

async function readPage(session, { tabId, filter, depth, ref_id, max_chars } = {}) {
  const id = await resolveTab(session, tabId);
  const data = await readTree(session, id, { filter, depth, refId: ref_id });
  return renderTree(data, { maxChars: max_chars });
}

// --- find ------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'with',
  'my', 'me', 'it', 'is', 'are', 'that', 'this', 'please', 'any', 'some',
  'find', 'click', 'show', 'get', 'go',
]);

function tokenize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function queryTokens(query) {
  const all = tokenize(query);
  const kept = all.filter((t) => !STOP_WORDS.has(t));
  return kept.length ? kept : all;
}

// Purpose-level shortcuts: what a person means by "search bar" or "login button"
// rarely appears verbatim in the accessible name.
const SYNONYMS = [
  {
    test: /\b(search|searchbar|magnifier)\b/,
    bonus(f) {
      if (f.tag === 'input' && f.type === 'search') return 30;
      if (f.role === 'searchbox') return 30;
      if (/(^|\s)(q|s|query|search|keyword|term)(\s|$)/.test(`${f.attrs.name || ''} ${f.attrs.id || ''}`)) return 24;
      if (/search/.test(`${f.attrs.placeholder || ''} ${f.attrs.ariaLabel || ''}`)) return 20;
      if (f.role === 'combobox' || (f.tag === 'input' && (f.type || 'text') === 'text')) return 8;
      return 0;
    },
  },
  {
    test: /\b(login|log ?in|logon|sign ?in|signin)\b/,
    bonus(f) {
      const label = `${f.name} ${f.text}`;
      if (/\b(sign ?in|log ?in|login|log ?on)\b/.test(label)) return 32;
      if (f.type === 'submit' && (f.role === 'button' || f.tag === 'input')) return 12;
      if (/\b(sign ?in|log ?in|login)\b/.test(f.attrText)) return 14;
      return 0;
    },
  },
  {
    test: /\badd to (cart|bag|basket)\b|\b(cart|basket)\b/,
    bonus(f) {
      if (/\badd to (cart|bag|basket)\b/.test(`${f.name} ${f.text}`)) return 35;
      if (f.interactive && /\b(cart|bag|basket)\b/.test(`${f.name} ${f.text} ${f.attrText}`)) return 14;
      return 0;
    },
  },
  {
    test: /\b(menu|hamburger|nav|navigation)\b/,
    bonus(f) {
      if (/^(menu|menubar|menuitem|navigation)$/.test(f.role)) return 20;
      if (/\b(menu|navigation|hamburger)\b/.test(`${f.name} ${f.attrText}`)) return 14;
      return 0;
    },
  },
  {
    test: /\b(close|dismiss)\b/,
    bonus(f) {
      if (/^(close|dismiss|x|\u00d7|\u2715)$/.test(f.name.trim())) return 30;
      if (/\b(close|dismiss)\b/.test(`${f.name} ${f.attrText}`)) return 18;
      return 0;
    },
  },
  {
    test: /\bsubmit\b/,
    bonus(f) { return f.type === 'submit' ? 20 : (/\bsubmit\b/.test(`${f.name} ${f.text}`) ? 12 : 0); },
  },
  {
    test: /\bbutton\b/,
    bonus(f) { return f.role === 'button' || f.tag === 'button' ? 12 : 0; },
  },
  {
    test: /\blink\b/,
    bonus(f) { return f.role === 'link' ? 12 : 0; },
  },
  {
    test: /\b(checkbox|check ?box|toggle|switch)\b/,
    bonus(f) { return /^(checkbox|switch)$/.test(f.role) ? 15 : 0; },
  },
  {
    test: /\b(dropdown|drop ?down|select|combo ?box|picker)\b/,
    bonus(f) { return f.tag === 'select' || /^(combobox|listbox)$/.test(f.role) ? 15 : 0; },
  },
  {
    test: /\b(field|input|textbox|text ?box|text ?field|text ?area|box)\b/,
    bonus(f) { return /^(textbox|searchbox|spinbutton)$/.test(f.role) || f.tag === 'textarea' ? 12 : 0; },
  },
  {
    test: /\b(image|picture|photo|img|icon)\b/,
    bonus(f) { return f.role === 'img' ? 12 : 0; },
  },
  {
    test: /\b(heading|headline|title)\b/,
    bonus(f) { return f.role === 'heading' ? 12 : 0; },
  },
];

function nodeFields(node) {
  const attrs = node.attrs || {};
  return {
    name: String(node.name || '').toLowerCase(),
    text: String(node.dtext || '').toLowerCase(),
    role: String(node.role || '').toLowerCase(),
    tag: String(node.tag || '').toLowerCase(),
    type: String(node.itype || attrs.type || '').toLowerCase(),
    attrs,
    attrText: [attrs.id, attrs.name, attrs.placeholder, attrs.title, attrs.type, attrs.href, attrs.ariaLabel]
      .filter(Boolean).join(' ').toLowerCase(),
    interactive: !!node.interactive,
    visible: !!node.visible,
  };
}

function scoreNode(node, ctx) {
  const f = nodeFields(node);
  let score = 0;
  if (f.name && f.name === ctx.query) score += 100;
  else if (f.name && f.name.startsWith(ctx.query)) score += 60;
  if (ctx.query.length > 2) {
    if (f.name.includes(ctx.query)) score += 40;
    else if (f.text.includes(ctx.query)) score += 30;
    else if (f.attrText.includes(ctx.query)) score += 15;
  }
  for (const token of ctx.tokens) {
    if (f.name.includes(token)) score += 12;
    else if (f.text.includes(token)) score += 8;
    else if (f.attrText.includes(token)) score += 6;
    if (f.role === token || f.tag === token) score += 6;
    if (f.type && f.type === token) score += 14;
  }
  for (const syn of ctx.synonyms) score += syn.bonus(f);
  if (score > 0) {
    if (f.interactive) score += 3;
    if (f.visible) score += 2;
  }
  return score;
}

function flattenNodes(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.role !== 'StaticText') out.push(node);
    if (node.children && node.children.length) flattenNodes(node.children, out);
  }
  return out;
}

// Ranked best-first; document order breaks ties so repeated calls are stable.
function rankNodes(nodes, query) {
  const q = String(query || '').toLowerCase().trim();
  const ctx = {
    query: q,
    tokens: queryTokens(q),
    synonyms: SYNONYMS.filter((s) => s.test.test(q)),
  };
  const scored = [];
  nodes.forEach((node, index) => {
    const score = scoreNode(node, ctx);
    if (score > 0) scored.push({ node, score, index });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map((s) => s.node);
}

// find searches the tree the page handed back, which may be a cut-down version
// of the page. Saying "no elements matched" about a tree that stopped short is
// the wrong answer, so every cut travels with the result.
function searchNotes(data) {
  const notes = [];
  if (data && data.clipped) {
    notes.push(`[the tree was cut at depth ${data.depth}: elements deeper than that were not searched - ` +
      'use read_page with a larger depth, or with ref_id, to reach that part of the page]');
  }
  if (data && data.capped) {
    notes.push(`[element limit reached: only the first ${data.count} elements were searched - ` +
      'use read_page with ref_id to look at the rest of the page]');
  }
  return notes;
}

function formatMatches(data, query, matches) {
  const header = pageHeader(data);
  const notes = searchNotes(data);
  const trailer = notes.length ? `\n\n${notes.join('\n')}` : '';
  if (!matches.length) {
    const where = notes.length ? ' in the part of the page that was searched' : '';
    return `${header}\n\nNo elements matched "${query}"${where}. ` +
      'Try different wording, or call read_page to see what is on the page.' + trailer;
  }
  const shown = matches.slice(0, FIND_LIMIT);
  const plural = matches.length === 1 ? 'match' : 'matches';
  const capped = matches.length > FIND_LIMIT ? `, showing the best ${FIND_LIMIT}` : '';
  const lines = [header, `${matches.length} ${plural} for "${query}"${capped}:`, ''];
  for (const node of shown) lines.push(formatNodeLine(node, 0));
  if (matches.length > FIND_LIMIT) {
    lines.push('', `More than ${FIND_LIMIT} elements matched. Use a more specific query to narrow it down.`);
  }
  return lines.join('\n') + trailer;
}

async function find(session, { query, tabId } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) throw new Error('find requires a query describing the element to look for.');
  const id = await resolveTab(session, tabId);
  const data = await readTree(session, id, { filter: 'all', depth: FIND_DEPTH, refId: '' });
  const matches = rankNodes(flattenNodes(data.nodes || []), q);
  return formatMatches(data, q, matches);
}

// --- get_page_text ---------------------------------------------------------

async function getPageText(session, { tabId } = {}) {
  const id = await resolveTab(session, tabId);
  const data = await session.callJson(id, TEXT_FN, []);
  if (!data || typeof data !== 'object') throw new Error('The page returned no text.');
  const header = pageHeader(data);
  const text = String(data.text || '').trim();
  if (!text) return `${header}\n\n(no readable text on this page)`;
  // Long articles come back whole; this only catches a pathological page that
  // would otherwise hand the client megabytes, and it says when it fired.
  if (text.length > MAX_TEXT_CHARS) {
    const head = cutAtLine(text, MAX_TEXT_CHARS);
    return `${header}\n\n${head}\n\n[Page text truncated at ${head.length} of ${text.length} characters.]`;
  }
  return `${header}\n\n${text}`;
}

function tools(ctx) {
  return [
    {
      name: 'read_page',
      description:
        'Get an accessibility tree representation of elements on the page. By default returns all ' +
        'elements including non-visible ones. Output is limited to 50000 characters by default. If ' +
        'the output exceeds this limit it is truncated at a line boundary, with a note giving the ' +
        'full size \u2014 pass a larger max_chars, or use depth/ref_id to focus on part of the page. ' +
        'Optionally filter for only interactive elements. If you don\'t have a valid tab ID, use ' +
        'tabs_context_mcp first to get available tabs.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['interactive', 'all'],
            description: 'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
          },
          depth: {
            type: 'number',
            description: 'Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large.',
          },
          ref_id: {
            type: 'string',
            description: 'Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large.',
          },
          max_chars: {
            type: 'number',
            description: 'Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs.',
          },
        },
        required: ['tabId'],
      },
      handler: async (args) => readPage(await ctx.session(), args || {}),
    },
    {
      name: 'find',
      description:
        'Find elements on the page using natural language. Can search for elements by their purpose ' +
        '(e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). ' +
        'Returns up to 20 matching elements with references that can be used with other tools. If ' +
        'more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t ' +
        'have a valid tab ID, use tabs_context_mcp first to get available tabs.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
          },
        },
        required: ['query', 'tabId'],
      },
      handler: async (args) => find(await ctx.session(), args || {}),
    },
    {
      name: 'get_page_text',
      description:
        'Extract raw text content from the page, prioritizing article content. Ideal for reading ' +
        'articles, blog posts, or other text-heavy pages. Returns plain text without HTML ' +
        'formatting. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: 'Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don\'t have a valid tab ID.',
          },
        },
        required: ['tabId'],
      },
      handler: async (args) => getPageText(await ctx.session(), args || {}),
    },
  ];
}

module.exports = {
  readPage, find, getPageText, tools,
  renderTree, formatNodeLine, formatMatches, truncateAtLine, rankNodes, flattenNodes, tokenize, queryTokens,
  TREE_FN, TEXT_FN,
  DEFAULT_MAX_CHARS, MAX_TEXT_CHARS, DEFAULT_DEPTH, FIND_DEPTH, FIND_LIMIT, NODE_CAP, REF_CAP,
};
