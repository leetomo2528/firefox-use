'use strict';
// Navigation, tabs, page scripting and form filling.
//
// This is where a task starts: tabs_context_mcp hands out the numeric tab ids
// every other tool takes, navigate drives the page, javascript_tool runs code
// with REPL semantics and form_input sets a field by ref.
//
// browser_batch handshake: src/batch.js copies `__inBatch: true` into the input
// of every item it runs. It is a private flag - no inputSchema declares it, the
// handlers below drop it by destructuring, and it never reaches the page. All
// it does is switch off the "an omitted tabId means the group's first tab"
// fallback, which the spec allows for a standalone call and forbids in a batch.

const { NO_TAB, NO_REF, sleep } = require('./session');

const MAX_RESULT_CHARS = 10000;
const MAX_VALUE_CHARS = 200;

// --- page-side functions --------------------------------------------------

const PAGE_INFO_FN = `(function () {
  return JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    focused: document.hasFocus(),
    width: window.innerWidth,
    height: window.innerHeight
  });
})`;

// Values are set through the prototype's native setter: frameworks such as
// React install their own "value" property on the element and only notice a
// change that goes around it.
const FORM_INPUT_FN = `(function (ref, value) {
  var store = window.__ffuse && window.__ffuse.refs;
  var el = store && store.get(ref);
  if (!el || !el.isConnected) return JSON.stringify({ found: false });

  var tag = el.localName;
  var type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
  var describe = '<' + tag
    + (type ? ' type="' + type + '"' : '')
    + (el.name ? ' name="' + el.name + '"' : '')
    + (!el.name && el.id ? ' id="' + el.id + '"' : '')
    + '>';

  function nativeSetter(target, prop) {
    var proto = Object.getPrototypeOf(target);
    while (proto) {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.set) return desc.set;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }
  function assign(target, prop, v) {
    var set = nativeSetter(target, prop);
    if (set) set.call(target, v); else target[prop] = v;
  }
  function fire(target) {
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    var s = String(v).trim().toLowerCase();
    return !(s === '' || s === 'false' || s === '0' || s === 'off' || s === 'no' || s === 'unchecked');
  }
  function fail(reason, extra) {
    var out = { found: true, ok: false, describe: describe, error: reason };
    if (extra) out.options = extra;
    return JSON.stringify(out);
  }

  if (el.disabled) return fail('the element is disabled');
  try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }

  var result = { found: true, ok: true, tag: tag, type: type, describe: describe };

  if (tag === 'select') {
    var wanted = String(value);
    var options = Array.prototype.slice.call(el.options || []);
    var match = null;
    for (var i = 0; i < options.length && !match; i++) if (options[i].value === wanted) match = options[i];
    for (var j = 0; j < options.length && !match; j++) if (String(options[j].text || '').trim() === wanted.trim()) match = options[j];
    for (var k = 0; k < options.length && !match; k++) {
      if (String(options[k].text || '').trim().toLowerCase() === wanted.trim().toLowerCase()) match = options[k];
    }
    if (!match) {
      return fail('no option matches ' + JSON.stringify(wanted), options.slice(0, 25).map(function (o) {
        return { value: o.value, text: String(o.text || '').trim() };
      }));
    }
    assign(el, 'value', match.value);
    if (el.value !== match.value && typeof match.index === 'number') el.selectedIndex = match.index;
    fire(el);
    var chosen = el.options[el.selectedIndex];
    result.kind = 'select';
    result.value = el.value;
    result.text = chosen ? String(chosen.text || '').trim() : '';
    return JSON.stringify(result);
  }

  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    var want = truthy(value);
    // React and friends listen for click on checkboxes, not input/change, so a
    // native-setter write leaves their state stale. Toggle it the way a person
    // would, and fall back to the setter if the click was intercepted.
    if (el.checked !== want && typeof el.click === 'function') {
      try { el.click(); } catch (e) { /* fall through to the setter */ }
    }
    if (el.checked !== want) {
      assign(el, 'checked', want);
      fire(el);
    }
    result.kind = type;
    result.value = el.checked === true;
    if (el.checked !== want) return fail('the page reset the control after it was set');
    return JSON.stringify(result);
  }

  if (tag === 'input' && type === 'file') {
    return fail('a file input cannot be set from script; use file_upload or upload_image');
  }

  if (tag === 'input' || tag === 'textarea') {
    assign(el, 'value', String(value));
    fire(el);
    result.kind = 'text';
    result.value = el.value;
    return JSON.stringify(result);
  }

  if (el.isContentEditable) {
    el.textContent = String(value);
    fire(el);
    result.kind = 'contenteditable';
    result.value = String(el.textContent == null ? '' : el.textContent);
    return JSON.stringify(result);
  }

  if ('value' in el) {
    assign(el, 'value', String(value));
    fire(el);
    result.kind = 'text';
    result.value = el.value;
    return JSON.stringify(result);
  }

  return fail('form_input works on <input>, <textarea>, <select> and contenteditable elements');
})`;

// --- shared helpers -------------------------------------------------------

function cleanMessage(err) {
  return String((err && err.message) || err || 'unknown error').split('\n')[0].trim();
}

function truncate(text, limit) {
  const str = String(text);
  return str.length <= limit ? str : `${str.slice(0, limit)}...`;
}

function missingTabId(tabId) {
  return tabId === undefined || tabId === null || tabId === '';
}

// Inside browser_batch a tool that acts on a page may not guess its tab: a
// batch of [tabs_create_mcp, navigate, computer{tabId:new}] would otherwise
// drive the tab that existed before the batch and screenshot the wrong page.
// The caller is src/batch.js, through the `__inBatch` flag described above.
function requireExplicitTab(tool, tabId, inBatch) {
  if (!inBatch || !missingTabId(tabId)) return;
  throw new Error(
    `${tool}: this call needs an explicit tabId. A batched item never inherits a tab, because the batch `
    + 'itself may have opened one; take the id from tabs_context_mcp, or from the tabs_create_mcp that ran '
    + 'earlier in the same batch, and put it on every item that touches a page.'
  );
}

async function resolveTab(session, tabId) {
  if (missingTabId(tabId)) {
    return session.defaultTabId({ createIfEmpty: true });
  }
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error(NO_TAB(tabId));
  session.requireContext(id);
  return id;
}

async function pageInfo(session, tabId) {
  try {
    const info = await session.callJson(tabId, PAGE_INFO_FN, []);
    return info && typeof info === 'object' ? info : {};
  } catch {
    return {}; // an about: page or a document that refuses script is still navigable
  }
}

function describePage(info, fallbackUrl) {
  const url = (info && info.url) || fallbackUrl || '(unknown url)';
  const title = info && info.title ? ` - "${info.title}"` : '';
  return `${url}${title}`;
}

async function tabUrl(session, tabId) {
  const tabs = await session.listTabs();
  const tab = tabs.find((t) => t.tabId === Number(tabId));
  return tab ? tab.url : undefined;
}

// History traversal resolves before the new document is in place.
async function settle(session, tabId, beforeUrl) {
  let info = await pageInfo(session, tabId);
  for (let i = 0; i < 5 && info.url && info.url === beforeUrl; i++) {
    await sleep(100);
    info = await pageInfo(session, tabId);
  }
  return info;
}

// --- navigate -------------------------------------------------------------

// "example.com" -> https://, "localhost:3000" -> host:port not a scheme.
function normalizeUrl(raw) {
  const url = String(raw).trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (scheme && !/^\d+($|[/?#])/.test(url.slice(scheme[0].length))) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `https://${url}`;
}

async function navigate(session, { url, tabId, __inBatch: inBatch = false } = {}) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) throw new Error('navigate: url is required (a URL, or "back"/"forward").');

  const direction = raw.toLowerCase();
  if (direction === 'back' || direction === 'forward') {
    if (missingTabId(tabId)) {
      throw new Error('navigate: tabId is required for url:"back"/"forward". Call tabs_context_mcp to get valid tab ids.');
    }
    const id = await resolveTab(session, tabId);
    const context = session.requireContext(id);
    const before = await tabUrl(session, id);
    try {
      await session.send('browsingContext.traverseHistory', { context, delta: direction === 'back' ? -1 : 1 });
    } catch (err) {
      throw new Error(`Cannot go ${direction} in tab ${id}: ${cleanMessage(err)}`);
    }
    const info = await settle(session, id, before);
    return `Went ${direction} in tab ${id}. Now at ${describePage(info, before)}`;
  }

  requireExplicitTab('navigate', tabId, inBatch);

  const target = normalizeUrl(raw);
  let id;
  let standalone = false;
  let created = false;
  if (missingTabId(tabId)) {
    // Standalone call: the spec says to run tabs_context_mcp{createIfEmpty:true}
    // for the model and hand back its listing along with the result.
    const group = await openGroup(session, true);
    if (!group.tabs.length) throw new Error('No tabs available. Call tabs_context_mcp with createIfEmpty: true.');
    id = group.tabs[0].tabId;
    created = group.created;
    standalone = true;
  } else {
    id = await resolveTab(session, tabId);
  }

  try {
    await session.navigate(id, target, 'complete');
  } catch (err) {
    throw new Error(`Navigation to ${target} failed: ${cleanMessage(err)}`);
  }
  const info = await pageInfo(session, id);
  const head = `Navigated tab ${id} to ${describePage(info, target)}`;
  // The listing is taken after the navigation, so the tab it names is not
  // still showing the url it had before this call.
  if (!standalone) return head;
  return `${head}\n\n${await groupListing(session, await session.listTabs(), created)}`;
}

// --- tabs -----------------------------------------------------------------

// Opens the group when it is empty, so navigate can reuse the same steps.
async function openGroup(session, createIfEmpty) {
  let tabs = await session.listTabs();
  if (tabs.length || !createIfEmpty) return { tabs, created: false };
  await session.createTab();
  tabs = await session.listTabs();
  return { tabs, created: tabs.length > 0 };
}

async function tabsContext(session, { createIfEmpty = false } = {}) {
  const { tabs, created } = await openGroup(session, createIfEmpty);
  if (!tabs.length) {
    return 'No tab group exists yet. Call tabs_context_mcp with createIfEmpty: true to open a window with an empty tab.';
  }
  return groupListing(session, tabs, created);
}

async function groupListing(session, tabs, created) {
  const rows = [];
  for (const tab of tabs) {
    const info = await pageInfo(session, tab.tabId);
    rows.push({
      tabId: tab.tabId,
      url: info.url || tab.url || 'about:blank',
      title: info.title || '',
      focused: info.focused === true,
    });
  }
  const active = rows.find((r) => r.focused) || rows[0];
  const lines = [created
    ? `Created a new tab group: ${plural(rows.length, 'tab')} in a new window.`
    : `Tab group: ${plural(rows.length, 'tab')}.`];
  for (const row of rows) {
    lines.push(`  [${row.tabId}]${row === active ? ' (active)' : ''} ${row.url}${row.title ? ` - "${row.title}"` : ''}`);
  }
  return lines.join('\n');
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

async function tabsCreate(session) {
  const tabId = await session.createTab();
  const tabs = await session.listTabs();
  const ids = tabs.map((t) => t.tabId).join(', ');
  return `Created tab ${tabId} (about:blank). The group now holds ${plural(tabs.length, 'tab')}: ${ids}. `
    + 'Tabs you create are yours to clean up - close this one with tabs_close_mcp when you no longer need it.';
}

async function tabsClose(session, { tabId } = {}) {
  if (missingTabId(tabId)) {
    throw new Error('tabs_close_mcp: tabId is required. Call tabs_context_mcp to get valid tab ids.');
  }
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error(NO_TAB(tabId));
  session.requireContext(id); // NO_TAB for anything outside this session's group
  const closed = await session.closeTab(id);
  // Firefox never closes its own last tab; the session blanked it instead.
  const kept = closed && closed.kept
    ? ' It was the last tab in Firefox, which keeps that one open, so it was blanked to about:blank and will be reused by the next tab you open.'
    : '';
  const tabs = await session.listTabs();
  if (!tabs.length) {
    return `Closed tab ${id}.${kept} The group is now empty - call tabs_context_mcp with createIfEmpty: true (or tabs_create_mcp) to start a fresh one.`;
  }
  return `Closed tab ${id}. ${plural(tabs.length, 'tab')} left in the group: ${tabs.map((t) => t.tabId).join(', ')}.`;
}

// --- javascript_tool ------------------------------------------------------

const CONTINUE_BEFORE = new Set(['+', '-', '*', '/', '%', '=', '<', '>', '&', '|', '^', '!', '~', '?', ':', ',', '.', '(', '[', '{', ';']);
const CONTINUE_AFTER = new Set(['.', '?', ':', ',', ')', ']', '}', '+', '-', '*', '/', '%', '=', '<', '>', '&', '|', '^']);
const STATEMENT_KEYWORD = /^(return|const|let|var|if|for|while|do|switch|try|throw|class|function|import|export|break|continue|debugger|with)\b/;

function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const k = src[i];
        if (k === '\\') { i += 2; continue; }
        if (k === '"' || k === "'" || k === '`') { i = skipString(src, i); continue; }
        if (k === '{') depth++;
        else if (k === '}') depth--;
        i++;
      }
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

// A newline only ends a statement when neither side is mid-expression.
function breaksHere(src, nl) {
  let a = nl - 1;
  while (a >= 0 && (src[a] === ' ' || src[a] === '\t' || src[a] === '\r')) a--;
  if (a < 0 || CONTINUE_BEFORE.has(src[a])) return false;
  let b = nl + 1;
  while (b < src.length && /\s/.test(src[b])) b++;
  if (b >= src.length || CONTINUE_AFTER.has(src[b])) return false;
  return true;
}

// Bracket-depth scan, not a parser: it finds top-level statement ends and a
// top-level `await`. Regex literals holding brackets or quotes can fool it,
// which costs at most a wrap we would not have needed.
function scanSource(src) {
  const ident = /[A-Za-z0-9_$]/;
  const breaks = [];
  let depth = 0;
  let topAwait = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
    if (depth === 0) {
      if (c === ';') { breaks.push(i + 1); i++; continue; }
      if (c === '\n') { if (breaksHere(src, i)) breaks.push(i + 1); i++; continue; }
      if (c === 'a' && src.startsWith('await', i) && !ident.test(src[i - 1] || ' ') && !ident.test(src[i + 5] || ' ')) {
        topAwait = true;
        i += 5;
        continue;
      }
    }
    i++;
  }
  return { breaks, topAwait };
}

// Trailing comments are not code: left in place they become the "last
// statement" and `return ( // done );` would not even compile.
function stripTrailingComments(source) {
  const src = String(source);
  let i = 0;
  let end = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const stop = src.indexOf('*/', i + 2); i = stop === -1 ? src.length : stop + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); end = i; continue; }
    i++;
    if (!/\s/.test(c)) end = i;
  }
  return src.slice(0, end);
}

function splitLastStatement(source) {
  const src = stripTrailingComments(source).replace(/\s+$/, '');
  const { breaks, topAwait } = scanSource(src);
  let cut = 0;
  for (const at of breaks) if (src.slice(at).trim()) cut = at;
  return { head: src.slice(0, cut), tail: src.slice(cut).trim(), topAwait };
}

function isExpression(tail) {
  if (!tail || tail.startsWith('{')) return false;
  return !STATEMENT_KEYWORD.test(tail);
}

// Top-level await needs an async function around it; the last expression keeps
// being the result, so it becomes the return value. returnLast:false is the
// fallback for when the statement scanner cuts in the wrong place: the code
// still runs, it just has no result.
function wrapForAwait(source, { returnLast = true } = {}) {
  const { head, tail } = splitLastStatement(source);
  const body = returnLast && isExpression(tail)
    ? `${head}\nreturn (\n${tail.replace(/;+$/, '')}\n);`
    : `${head}\n${tail}`;
  return `(async function () {\n${body}\n})()`;
}

function looksLikeAwaitSyntaxError(message) {
  return /await is only valid|await is not allowed|await outside|unexpected reserved word|syntaxerror/i.test(String(message));
}

// Page errors carry their stack in the exception text; keep the message and the
// frame that names the offending line.
function formatPageException(message) {
  const lines = String(message).split('\n').map((l) => l.trim()).filter(Boolean);
  const head = lines[0] || 'script threw';
  const frame = lines.slice(1).find((l) => /@|^at\s/.test(l));
  return frame ? `${head}\n    ${frame}` : head;
}

function stringifyValue(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value === '' ? '""' : value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function formatResult(value) {
  const text = stringifyValue(value);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: showing the first ${MAX_RESULT_CHARS} of ${text.length} characters]`;
}

async function runScript(session, tabId, source) {
  try {
    return { ok: true, value: await session.evaluate(tabId, source) };
  } catch (err) {
    if (err && err.isPageException) return { ok: false, error: err };
    throw err; // transport or protocol failure: not the page's fault
  }
}

async function javascriptTool(session, { action, text, tabId, __inBatch: inBatch = false } = {}) {
  if (action !== 'javascript_exec') {
    throw new Error(`javascript_tool: action must be "javascript_exec"${action ? `, got "${action}"` : ''}.`);
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('javascript_tool: text is required (the JavaScript to run).');
  }
  requireExplicitTab('javascript_tool', tabId, inBatch);
  const id = await resolveTab(session, tabId);
  const { topAwait } = scanSource(text);

  // A retry is only ever reached through a SyntaxError, and a script that fails
  // to compile has not run, so nothing can be applied to the page twice.
  let res = await runScript(session, id, topAwait ? wrapForAwait(text) : text);
  if (!res.ok && !topAwait && /\bawait\b/.test(text) && looksLikeAwaitSyntaxError(res.error.message)) {
    const retry = await runScript(session, id, wrapForAwait(text));
    if (retry.ok) res = retry;
  } else if (!res.ok && topAwait && /syntaxerror/i.test(res.error.message)) {
    const plain = await runScript(session, id, wrapForAwait(text, { returnLast: false }));
    if (plain.ok) res = plain;
  }
  if (!res.ok) throw new Error(`JavaScript error: ${formatPageException(res.error.message)}`);
  return formatResult(res.value);
}

// --- resize_window --------------------------------------------------------

async function clientWindowFor(session, tabId) {
  const tabs = await session.listTabs();
  const tab = tabs.find((t) => t.tabId === Number(tabId));
  if (tab && tab.clientWindow) return tab.clientWindow;
  try {
    const res = await session.send('browser.getClientWindows', {});
    const windows = (res && res.clientWindows) || [];
    const found = windows.find((w) => w.active) || windows[0];
    return found ? found.clientWindow : null;
  } catch {
    return null;
  }
}

async function resizeWindow(session, { width, height, tabId, __inBatch: inBatch = false } = {}) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error('resize_window: width and height must be positive numbers.');
  }
  requireExplicitTab('resize_window', tabId, inBatch);
  const id = await resolveTab(session, tabId);

  const clientWindow = await clientWindowFor(session, id);
  let how = null;
  let rejected = 'the tab reports no client window';
  if (clientWindow) {
    // A tab that already ran a script carries the session's pinned viewport,
    // and a pinned viewport ignores the window size - the page would keep
    // reporting the old innerWidth/innerHeight after a successful resize. Let
    // the one-shot pin happen, then release it so the window size wins.
    const context = session.requireContext(id);
    try {
      if (typeof session.applyViewport === 'function') await session.applyViewport(context);
      await session.send('browsingContext.setViewport', { context, viewport: null });
    } catch { /* older builds have no viewport override to clear */ }
    try {
      await session.send('browser.setClientWindowState', { clientWindow, state: 'normal', width: w, height: h });
      how = 'window';
    } catch (err) {
      rejected = cleanMessage(err);
    }
  }
  if (!how) {
    // Headless Firefox and older builds reject window state changes; the tab
    // viewport gets the page to the same size.
    await session.setViewport(id, { width: w, height: h });
    how = 'viewport';
  }

  const info = await pageInfo(session, id);
  // Screenshot geometry comes from session.viewportFor(tabId), and releasing
  // the override above left this tab's record holding the size it had before
  // the resize. Pin this tab - and only this tab - at the size the page now
  // reports, so it reads back true while every other tab keeps rendering at the
  // size it already had. session.viewportSize is the session default: writing
  // to it would silently move every tab that this call never touched.
  if (how === 'window' && info.width > 0 && info.height > 0) {
    try {
      await session.setViewport(id, { width: info.width, height: info.height });
    } catch { /* a busy tab can refuse; the report below still describes it */ }
  }
  const head = how === 'window'
    ? `Resized the window holding tab ${id} to ${w}x${h} via browser.setClientWindowState.`
    : `Resized tab ${id} to ${w}x${h} via the tab viewport (browser.setClientWindowState was rejected: ${rejected}).`;
  const size = info.width && info.height
    ? `Page reports innerWidth x innerHeight = ${info.width}x${info.height}.`
    : 'The page did not report innerWidth/innerHeight.';
  return `${head} ${size}`;
}

// --- form_input -----------------------------------------------------------

async function formInput(session, { ref, value, tabId, __inBatch: inBatch = false } = {}) {
  if (!ref || typeof ref !== 'string') {
    throw new Error('form_input: ref is required (an element id from read_page, e.g. "ref_1").');
  }
  if (value === undefined || value === null) {
    throw new Error('form_input: value is required (string, number or boolean).');
  }
  // An object would land in the field as "[object Object]"; say so instead.
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error(`form_input: value must be a string, number or boolean (got ${Array.isArray(value) ? 'array' : typeof value}).`);
  }
  requireExplicitTab('form_input', tabId, inBatch);
  const id = await resolveTab(session, tabId);
  await session.ensureRefStore(id);

  const res = await session.callJson(id, FORM_INPUT_FN, [String(ref), value]);
  if (!res || typeof res !== 'object' || res.found === false) throw new Error(NO_REF(ref));

  const label = `${ref}${res.describe ? ` ${res.describe}` : ''}`;
  if (res.ok === false) {
    const parts = [`Cannot set ${label}: ${res.error || 'unsupported element'}.`];
    if (Array.isArray(res.options) && res.options.length) {
      parts.push(`Available options: ${res.options.map((o) => `"${o.value}" (${o.text})`).join(', ')}.`);
    }
    throw new Error(parts.join(' '));
  }

  if (res.kind === 'checkbox' || res.kind === 'radio') {
    return `Set ${label} to ${res.value ? 'checked' : 'unchecked'}.`;
  }
  if (res.kind === 'select') {
    return `Set ${label} to "${res.value}"${res.text ? ` (${res.text})` : ''}.`;
  }
  const got = truncate(res.value === undefined ? '' : res.value, MAX_VALUE_CHARS);
  const wanted = String(value);
  const note = String(res.value === undefined ? '' : res.value) === wanted
    ? ''
    : ` (requested "${truncate(wanted, MAX_VALUE_CHARS)}")`;
  return `Set ${label} to "${got}"${note}.`;
}

// --- tool definitions -----------------------------------------------------

function tools(ctx) {
  return [
    {
      name: 'navigate',
      description:
        'Send a tab to an address, or walk that tab through the history it has already built. Only url is '
        + 'always required. For an ordinary address you may leave tabId out when navigate is called on its own: '
        + "the session's tab group is opened or reused for you (the work tabs_context_mcp{createIfEmpty:true} "
        + "does), the group's first tab is driven, and the refreshed listing is printed under the result so the "
        + 'ids are in front of you for the next call. Two cases have no fallback and fail without a tabId: url '
        + 'set to "back" or "forward", and any navigate running inside browser_batch, where a guessed tab would '
        + 'be the one that existed before the batch opened its own. Name the tab yourself whenever the group '
        + 'holds several pages and the others are mid-task. The call returns after loading settles, which '
        + 'retires every ref_N an earlier read_page handed out - read the page again before using refs. In '
        + 'Firefox the page opens in the automation profile this server launched, apart from your everyday '
        + 'windows and with no per-site approval step; a load parked behind an alert or a beforeunload prompt '
        + 'is cleared with firefox_dialog instead of ending the session.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'Where to go: a full address, or a bare one such as example.com or localhost:3000, which gets '
              + 'https:// put in front of it when no scheme is present. The two literal words "back" and '
              + '"forward" (case ignored) load nothing new and move one entry through this tab\'s own history '
              + 'instead.',
          },
          tabId: {
            type: 'number',
            description:
              "Which tab of this session's group does the navigating; ids come from tabs_context_mcp. Omit it "
              + "only for a plain address in a standalone call, where the group's first tab is used and a group "
              + 'is opened if none exists yet. It is mandatory for "back" and "forward", mandatory for every '
              + 'navigate inside browser_batch, and worth passing whenever one particular page has to be the one '
              + 'that moves.',
          },
        },
        required: ['url'],
      },
      // src/batch.js adds `__inBatch: true` to the input of every item it runs;
      // navigate then requires an explicit tabId instead of taking the group's
      // first tab. The flag is private to that handshake - it is not in the
      // schema above and is dropped where navigate() destructures its argument.
      handler: async (args) => {
        const session = await ctx.session();
        return navigate(session, args || {});
      },
    },
    {
      name: 'resize_window',
      description:
        'Change the size of the Firefox window a tab lives in, so a layout can be checked at phone, tablet or '
        + 'desktop width and so screenshots taken afterwards come out at that geometry. width, height and tabId '
        + 'are all required; there is no implicit tab here. The real window is resized when Firefox allows that; '
        + "headless runs and older builds refuse that, and the tab's viewport is stretched instead, which puts "
        + 'the page at the same size. The reply names whichever path ran and quotes the innerWidth x '
        + 'innerHeight the page ended up reporting - expect it to fall short of the numbers you asked for, '
        + 'since toolbars come out of the window box and the browser clamps sizes it thinks are too small. Only '
        + 'the tab you name is affected; the rest of the group keeps rendering as it was.',
      inputSchema: {
        type: 'object',
        properties: {
          width: {
            type: 'number',
            description:
              'How wide to make the window, in pixels; must be positive. Browser chrome takes part of it, so '
              + 'the page area lands narrower than this - the reply says what the page actually measured.',
          },
          height: {
            type: 'number',
            description:
              'How tall to make the window, in pixels; must be positive. The tab strip and toolbar are '
              + 'subtracted from it, so the visible page is shorter; the reply quotes the innerHeight it settled '
              + 'on.',
          },
          tabId: {
            type: 'number',
            description:
              'The tab whose window gets resized; required, with nothing guessed for you. Take the id from '
              + "tabs_context_mcp. If Firefox turns the window resize down, only this tab's viewport is changed "
              + 'and the other tabs are left alone.',
          },
        },
        required: ['width', 'height', 'tabId'],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return resizeWindow(session, args || {});
      },
    },
    {
      name: 'javascript_tool',
      description:
        'Evaluate JavaScript inside a page and hand back what its final expression produced. All three fields '
        + 'are required: action pinned to javascript_exec, text carrying the source, and tabId naming the page. '
        + "The snippet runs in the page's own world, so the document, window, and whatever globals the site "
        + 'defined are all within reach, and anything it changes is really changed. It behaves like a console '
        + 'rather than a function body: top-level await is allowed, and the value of the last expression comes '
        + 'back by itself, so finish with the expression instead of a return statement. Results are stringified '
        + '(objects as indented JSON) and cut off at 10000 characters, with a line saying how long the full '
        + 'text was. A throw from the page fails the call with its message and the frame that raised it. Two '
        + 'things script cannot do here: fill a file input, which needs file_upload or upload_image, and get '
        + 'past its own alert or confirm - that parks the page until firefox_dialog answers it, which in '
        + 'Firefox is recoverable rather than the end of the session.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'Fixed string: send javascript_exec, spelled exactly that way. Any other value is turned away '
              + 'before the page is touched.',
          },
          text: {
            type: 'string',
            description:
              'The source to evaluate. Console semantics: top-level await works, and the last expression is '
              + "the result, so write `document.title` or `await fetch('/api/status').then(r => r.json())` and "
              + 'skip the return; statements ahead of it run normally. It executes in the page context, with '
              + 'the DOM, window and page globals available and its writes sticking to the live document. '
              + 'Anything past 10000 characters of output is trimmed.',
          },
          tabId: {
            type: 'number',
            description:
              'The page to run in; required, never guessed. Use an id tabs_context_mcp listed for this '
              + 'session - a tab outside the group, or one already closed, is refused.',
          },
        },
        required: ['action', 'text', 'tabId'],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return javascriptTool(session, args || {});
      },
    },
    {
      name: 'form_input',
      description:
        'Fill one form control that read_page has already tagged with a ref, without aiming a click at it. '
        + 'ref, value and tabId are all required. Text boxes, textareas, number and date fields, '
        + 'contenteditable regions, checkboxes, radios and dropdowns are covered; a file input is not, and goes '
        + 'through file_upload or upload_image, which read only from the directories this server is allowed to '
        + "open. The write goes through the element's native setter and is followed by input and change events, "
        + 'while checkboxes and radios are toggled with a real click, so React and its relatives notice the '
        + 'change. A dropdown is matched against option values first, then against the labels shown to the '
        + 'user, ignoring case on a last pass; when nothing matches, the error lists the options that exist. '
        + 'Disabled controls are turned down. A ref lives only as long as the node behind it, so after a '
        + 'navigation, a reload, or a re-render that swaps the element out, run read_page again or this fails '
        + 'with an unknown-ref error.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description:
              'The element id read_page handed out, shaped like ref_1 or ref_2. It names one live node, so '
              + 'take it from the most recent read of this page; older ids are usually stale.',
          },
          value: {
            type: ['string', 'boolean', 'number'],
            description:
              'What the control should end up holding. Text-like fields take a string or a number. Checkboxes '
              + 'and radios take true or false (an empty string, or "false", "no", "0", "off", also reads as '
              + "unchecked). A dropdown takes either the option's value attribute or the label the user sees. "
              + 'Arrays and objects are rejected instead of being stringified into the field.',
          },
          tabId: {
            type: 'number',
            description:
              'The tab holding the element; required. Ids come from tabs_context_mcp, and the ref has to '
              + "belong to that same tab's document.",
          },
        },
        required: ['ref', 'value', 'tabId'],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return formInput(session, args || {});
      },
    },
    {
      name: 'tabs_context_mcp',
      title: 'Tabs Context',
      description:
        'List the tabs this session owns - numeric id, current address, page title, and which one holds focus. '
        + 'Run it before any other browser tool, because they all address a page by an id from this list, and '
        + 'run it again after tabs open or close. The group only ever holds tabs this server opened in the '
        + 'Firefox profile it launched, so the windows you browse in yourself are neither listed nor driven, '
        + 'and no site has to grant automation permission first. When no group exists yet the reply says so and '
        + 'points at createIfEmpty. Give a new conversation a tab of its own with tabs_create_mcp rather than '
        + 'taking over one that is already busy, unless the user asked you to work in the tab that is open.',
      inputSchema: {
        type: 'object',
        properties: {
          createIfEmpty: {
            type: 'boolean',
            description:
              'Pass true to have an empty group opened for you when the session has none: a new window with '
              + 'one blank tab, listed in the reply and ready to navigate. Left out it counts as false, and a '
              + 'session with no group is only told it has none. It does nothing once a group exists and never '
              + 'appends a second tab - that is what tabs_create_mcp is for.',
          },
        },
        required: [],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return tabsContext(session, args || {});
      },
    },
    {
      name: 'tabs_create_mcp',
      title: 'Tabs Create',
      description:
        'Open one more blank tab (about:blank) in the session tab group and report its id together with what the '
        + 'group now holds. It takes no arguments. The tab joins whichever Firefox window the group already '
        + 'occupies, or brings one of its own when the group is empty. Call tabs_context_mcp once first, so you '
        + 'know the group you are adding to, then put the id you were just given on a navigate to load '
        + 'something into it. Whatever you open is yours to clear away: close it with tabs_close_mcp the moment it stops '
        + 'being useful, and leave none of your own tabs behind when the task ends - keep one only when the '
        + 'user wants to look at it.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const session = await ctx.session();
        return tabsCreate(session);
      },
    },
    {
      name: 'tabs_close_mcp',
      title: 'Tabs Close',
      description:
        'Shut one tab out of the session tab group, addressed by id - the way you tidy up once a page has served its '
        + 'purpose. tabId is required, and has to be an id tabs_context_mcp reported: a tab from one of your '
        + 'own windows, or one that is already gone, is refused rather than quietly ignored. Ids are handed out '
        + 'in sequence and never reused, so a closed one stays invalid for the rest of the session. Shutting '
        + 'the last remaining tab empties the group; a later tabs_context_mcp that passes createIfEmpty, or any '
        + 'tabs_create_mcp, builds a fresh one. Firefox never closes its own final tab, so that one is blanked '
        + 'to about:blank instead and reused for the next tab you ask for.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'integer',
            description:
              'Id of the tab to close, an integer taken from tabs_context_mcp. It has to be one of the tabs '
              + 'this session opened for itself.',
          },
        },
        required: ['tabId'],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return tabsClose(session, args || {});
      },
    },
  ];
}

module.exports = {
  navigate, tabsContext, tabsCreate, tabsClose,
  javascriptTool, resizeWindow, formInput,
  normalizeUrl, scanSource, splitLastStatement, stripTrailingComments, wrapForAwait,
  formatPageException, formatResult, stringifyValue,
  missingTabId, requireExplicitTab,
  PAGE_INFO_FN, FORM_INPUT_FN, MAX_RESULT_CHARS,
  tools,
};
