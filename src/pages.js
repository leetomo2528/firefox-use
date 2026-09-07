'use strict';
// Navigation, tabs, page scripting and form filling.
//
// This is where a task starts: tabs_context_mcp hands out the numeric tab ids
// every other tool takes, navigate drives the page, javascript_tool runs code
// with REPL semantics and form_input sets a field by ref.

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
    assign(el, 'checked', truthy(value));
    fire(el);
    result.kind = type;
    result.value = el.checked === true;
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

async function resolveTab(session, tabId) {
  if (tabId === undefined || tabId === null || tabId === '') {
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

async function navigate(session, { url, tabId } = {}) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) throw new Error('navigate: url is required (a URL, or "back"/"forward").');

  const direction = raw.toLowerCase();
  if (direction === 'back' || direction === 'forward') {
    if (tabId === undefined || tabId === null || tabId === '') {
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

  const target = normalizeUrl(raw);
  let id;
  let standalone = false;
  let created = false;
  if (tabId === undefined || tabId === null || tabId === '') {
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
  if (tabId === undefined || tabId === null || tabId === '') {
    throw new Error('tabs_close_mcp: tabId is required. Call tabs_context_mcp to get valid tab ids.');
  }
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error(NO_TAB(tabId));
  session.requireContext(id); // NO_TAB for anything outside this session's group
  await session.closeTab(id);
  const tabs = await session.listTabs();
  if (!tabs.length) {
    return `Closed tab ${id}. The group is now empty - call tabs_context_mcp with createIfEmpty: true (or tabs_create_mcp) to start a fresh one.`;
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

async function javascriptTool(session, { action, text, tabId } = {}) {
  if (action !== 'javascript_exec') {
    throw new Error(`javascript_tool: action must be "javascript_exec"${action ? `, got "${action}"` : ''}.`);
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('javascript_tool: text is required (the JavaScript to run).');
  }
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

async function resizeWindow(session, { width, height, tabId } = {}) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error('resize_window: width and height must be positive numbers.');
  }
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
  // Screenshot coordinates come from session.viewportSize; keep it honest when
  // the window path left the page a different size than it asked for.
  if (how === 'window' && info.width > 0 && info.height > 0) {
    session.viewportSize = { width: info.width, height: info.height };
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

async function formInput(session, { ref, value, tabId } = {}) {
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
        "Navigate to a URL, or go forward/back in browser history. tabId may be omitted for URL navigation when calling navigate STANDALONE (not inside browser_batch): tabs_context_mcp{createIfEmpty:true} is called for you and the first tab in the session's group is navigated \u2014 its result is appended to this call's output so you have the tab list and ids for subsequent calls. Inside browser_batch, navigate (and other tools that act on a page) requires an explicit tabId. Pass an explicit tabId when you need a specific tab or when the session's group has multiple tabs whose state you must preserve. tabId is required for url:\"back\"/\"forward\".",
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to navigate. Must be a tab in the current group. If omitted for URL navigation when calling navigate standalone, tabs_context_mcp{createIfEmpty:true} is called for you. Required for url:"back"/"forward" and for navigate (and other tools that act on a page) inside browser_batch.',
          },
        },
        required: ['url'],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return navigate(session, args || {});
      },
    },
    {
      name: 'resize_window',
      description:
        "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
      inputSchema: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'Target window width in pixels' },
          height: { type: 'number', description: 'Target window height in pixels' },
          tabId: {
            type: 'number',
            description: "Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
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
        "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: "Must be set to 'javascript_exec'" },
          text: {
            type: 'string',
            description: 'The JavaScript code to execute. Evaluated in the page context with REPL semantics: top-level `await` works, and the result of the last expression is returned automatically \u2014 write the expression you want (e.g. `window.myData.value`, or `await fetch(url).then(r=>r.json())`) rather than `return ...`. You can access and modify the DOM, call page functions, and interact with page variables.',
          },
          tabId: {
            type: 'number',
            description: "Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
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
        "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")' },
          value: {
            type: ['string', 'boolean', 'number'],
            description: 'The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number',
          },
          tabId: {
            type: 'number',
            description: "Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
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
        'Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.',
      inputSchema: {
        type: 'object',
        properties: {
          createIfEmpty: {
            type: 'boolean',
            description: 'Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.',
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
        'Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist. Tabs you create are yours to clean up: close each one with tabs_close_mcp as soon as you no longer need it, and close any that remain before finishing your task. Leave a tab open only if the user asked to see it or wants it kept open.',
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
        "Close a tab in the MCP tab group by its ID. Use to clean up tabs you're done with. Only tabs in this session's group are closable; call tabs_context_mcp first to get valid IDs. If you close the group's last tab, Firefox auto-removes the group \u2014 the next tabs_context_mcp with createIfEmpty starts fresh.",
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'integer',
            description: 'The ID of the tab to close. Must be in this session\'s tab group. Get valid IDs from tabs_context_mcp.',
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
  PAGE_INFO_FN, FORM_INPUT_FN, MAX_RESULT_CHARS,
  tools,
};
