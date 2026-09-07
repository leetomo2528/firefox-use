'use strict';
// Console and network capture.
//
// BiDi pushes log.entryAdded and the network.* events for every tab in the
// session's group; this module keeps them in per-tab ring buffers so
// read_console_messages / read_network_requests answer without touching the
// page. Capture starts the first time either tool runs (attach is lazy and
// idempotent), which mirrors Chrome: what happened before the first read is
// simply not there.

const { fromRemoteValue } = require('./session');
const { matchIndices } = require('./safe-regex');

const NETWORK_EVENTS = ['network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError'];
const BUFFER_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const ERROR_LEVELS = new Set(['error', 'exception', 'assert', 'severe', 'critical']);

// Per-session state, so a Session never carries our fields.
const STATES = new WeakMap();

// --- ingestion ------------------------------------------------------------

function stateFor(session) {
  let state = STATES.get(session);
  if (state) return state;
  state = { tabs: new Map(), parents: new Map(), contexts: new Map(), ready: null };
  STATES.set(session, state);
  // Registered synchronously: events that arrive while session.subscribe is in
  // flight still land in a buffer.
  session.on('log.entryAdded', (p) => onLogEntry(state, session, p));
  session.on('network.beforeRequestSent', (p) => onRequestSent(state, session, p));
  session.on('network.responseCompleted', (p) => onResponse(state, session, p));
  session.on('network.fetchError', (p) => onFetchError(state, session, p));
  session.on('browsingContext.navigationStarted', (p) => onNavigation(state, session, p));
  session.on('browsingContext.contextCreated', (p) => { if (p && p.parent) state.parents.set(p.context, p.parent); });
  session.on('browsingContext.contextDestroyed', (p) => {
    if (!p) return;
    state.parents.delete(p.context);
    // Drop the buffers of a closed tab; its id is never handed out again.
    const tabId = state.contexts.get(p.context);
    if (tabId !== undefined) {
      state.contexts.delete(p.context);
      state.tabs.delete(tabId);
    }
  });
  return state;
}

function attach(session) {
  const state = stateFor(session);
  if (!state.ready) {
    state.ready = Promise.resolve()
      .then(() => session.subscribe(NETWORK_EVENTS))
      .catch((err) => { state.ready = null; throw err; }); // a failed subscribe retries next call
  }
  return state.ready.then(() => state);
}

// Works with the real TabRegistry and with any {tabId, context} list.
function tabIdForContext(session, context) {
  if (!context) return undefined;
  const tabs = session.tabs;
  if (tabs && typeof tabs.tabIdFor === 'function') return tabs.tabIdFor(context);
  if (Array.isArray(tabs)) {
    const tab = tabs.find((t) => t && t.context === context);
    return tab ? tab.tabId : undefined;
  }
  return undefined;
}

// A frame belongs to the tab that contains it, so iframe logs and requests are
// not lost. Only contexts under one of the group's tabs resolve.
function resolveTabId(state, session, context) {
  let current = context;
  for (let depth = 0; current && depth < 10; depth++) {
    const tabId = tabIdForContext(session, current);
    if (tabId !== undefined) {
      if (current === context) state.contexts.set(context, tabId);
      return tabId;
    }
    current = state.parents.get(current);
  }
  return undefined;
}

function bufferFor(state, tabId) {
  let buf = state.tabs.get(tabId);
  if (!buf) {
    buf = { console: [], network: [], origin: null, dropped: { console: 0, network: 0 } };
    state.tabs.set(tabId, buf);
  }
  return buf;
}

// Ring push. What falls off the front is counted, so a read reports the loss
// instead of truncating silently.
function push(buf, kind, entry) {
  const list = buf[kind];
  list.push(entry);
  if (list.length > BUFFER_LIMIT) buf.dropped[kind] += list.splice(0, list.length - BUFFER_LIMIT).length;
  return entry;
}

function emptyBuffer(buf, kind) {
  buf[kind].length = 0;
  buf.dropped[kind] = 0;
}

function numberOr(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function originOf(url) {
  try {
    const origin = new URL(String(url)).origin;
    return origin && origin !== 'null' ? origin : null;
  } catch { return null; }
}

// console.error -> 'error', a page exception -> 'exception'.
function consoleLevel(params) {
  if (params.type === 'javascript') return 'exception';
  const level = typeof params.level === 'string' ? params.level.toLowerCase() : 'info';
  const method = typeof params.method === 'string' ? params.method.toLowerCase() : '';
  if (!method) return level;
  if (level === 'error' && !ERROR_LEVELS.has(method)) return level; // never hide an error behind console.table
  return method;
}

function isErrorLevel(level) {
  return ERROR_LEVELS.has(String(level).toLowerCase());
}

function stackFrames(stackTrace) {
  const frames = stackTrace && Array.isArray(stackTrace.callFrames) ? stackTrace.callFrames : null;
  if (!frames || !frames.length) return null;
  return frames.map((f) => ({
    functionName: (f && f.functionName) || '',
    url: (f && f.url) || '',
    lineNumber: numberOr(f && f.lineNumber, null),
    columnNumber: numberOr(f && f.columnNumber, null),
  }));
}

function preview(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function onLogEntry(state, session, params) {
  if (!params) return;
  const tabId = resolveTabId(state, session, params.source && params.source.context);
  if (tabId === undefined) return;
  const args = Array.isArray(params.args) ? params.args.map((a) => fromRemoteValue(a)) : [];
  const text = typeof params.text === 'string' && params.text.length
    ? params.text
    : args.map(preview).join(' ');
  const entry = {
    level: consoleLevel(params),
    text,
    args,
    timestamp: numberOr(params.timestamp, Date.now()),
  };
  const frames = stackFrames(params.stackTrace);
  if (frames) entry.stackTrace = frames;
  push(bufferFor(state, tabId), 'console', entry);
}

const DESTINATION_TYPES = {
  document: 'document', iframe: 'document', frame: 'document', embed: 'document', object: 'document',
  script: 'script', worker: 'script', sharedworker: 'script', serviceworker: 'script',
  audioworklet: 'script', paintworklet: 'script',
  style: 'stylesheet', image: 'image', font: 'font',
  audio: 'media', video: 'media', track: 'media',
  manifest: 'manifest', websocket: 'websocket', report: 'other',
};

const INITIATOR_TYPES = {
  xmlhttprequest: 'xhr', fetch: 'fetch', img: 'image', image: 'image', input: 'image',
  css: 'stylesheet', link: 'stylesheet', script: 'script',
  iframe: 'document', frame: 'document', navigation: 'document', parser: 'document',
  video: 'media', audio: 'media', beacon: 'other', ping: 'other', other: 'other',
};

// Chrome's resource types, from the fetch destination with initiatorType as backup.
function resourceType(req) {
  const dest = String((req && req.destination) || '').toLowerCase();
  const init = String((req && req.initiatorType) || '').toLowerCase();
  if (dest && dest !== 'empty' && DESTINATION_TYPES[dest]) return DESTINATION_TYPES[dest];
  if (init && INITIATOR_TYPES[init]) return INITIATOR_TYPES[init];
  if (dest === 'empty') return 'fetch';
  return 'other';
}

function newNetworkEntry(params) {
  const req = params.request || {};
  return {
    requestId: req.request === undefined || req.request === null ? null : String(req.request),
    method: String(req.method || 'GET').toUpperCase(),
    url: req.url || '',
    resourceType: resourceType(req),
    status: null,
    statusText: '',
    mimeType: '',
    bytes: null,
    startedAt: numberOr(params.timestamp, Date.now()),
    durationMs: null,
    error: null,
  };
}

// Newest still-open request with this id: redirects reuse the id, and the
// earlier hop already carries its 3xx status.
function findOpen(list, requestId) {
  if (requestId === undefined || requestId === null) return null;
  const id = String(requestId);
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (entry.requestId === id && entry.status === null && entry.error === null) return entry;
  }
  return null;
}

function settle(state, session, params) {
  const tabId = resolveTabId(state, session, params && params.context);
  if (tabId === undefined) return null;
  const buf = bufferFor(state, tabId);
  const req = params.request || {};
  const entry = findOpen(buf.network, req.request);
  // Attached mid-flight: the request was never seen, so how long it took is
  // unknown - reporting 0ms would be a lie.
  if (!entry) return push(buf, 'network', newNetworkEntry(params));
  const done = numberOr(params.timestamp, null);
  if (done !== null && entry.startedAt !== null) entry.durationMs = Math.max(0, Math.round(done - entry.startedAt));
  return entry;
}

function onRequestSent(state, session, params) {
  if (!params) return;
  const tabId = resolveTabId(state, session, params.context);
  if (tabId === undefined) return;
  push(bufferFor(state, tabId), 'network', newNetworkEntry(params));
}

function onResponse(state, session, params) {
  if (!params) return;
  const entry = settle(state, session, params);
  if (!entry) return;
  const res = params.response || {};
  entry.status = numberOr(res.status, null);
  entry.statusText = res.statusText || '';
  entry.mimeType = res.mimeType || '';
  entry.bytes = numberOr(res.bytesReceived, numberOr(res.content && res.content.size, numberOr(res.bodySize, null)));
  if (!entry.url && res.url) entry.url = res.url;
}

function onFetchError(state, session, params) {
  if (!params) return;
  const entry = settle(state, session, params);
  if (!entry) return;
  entry.error = params.errorText || 'request failed';
}

// Chrome drops the network log when the tab leaves the domain; do the same.
function onNavigation(state, session, params) {
  if (!params) return;
  const tabId = tabIdForContext(session, params.context); // top-level only: an iframe leaving the origin is not a page change
  if (tabId === undefined) return;
  state.contexts.set(params.context, tabId);
  const origin = originOf(params.url);
  if (!origin) return;
  const buf = bufferFor(state, tabId);
  if (buf.origin && buf.origin !== origin) {
    emptyBuffer(buf, 'network');
    emptyBuffer(buf, 'console');
  }
  buf.origin = origin;
}

// --- formatting -----------------------------------------------------------

function requireTabId(session, tabId) {
  if (tabId === undefined || tabId === null || tabId === '') throw new Error('tabId is required');
  session.requireContext(tabId); // throws Chrome's NO_TAB wording
  return Number(tabId);
}

function compilePattern(pattern) {
  if (pattern === undefined || pattern === null || pattern === '') return null;
  try {
    return new RegExp(String(pattern), 'i');
  } catch (err) {
    throw new Error(`Invalid regex pattern ${JSON.stringify(String(pattern))}: ${err.message}`);
  }
}

function normalizeLimit(limit) {
  const n = Number(limit);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LIMIT;
}

function plural(n, word, many) {
  return `${n} ${n === 1 ? word : (many || `${word}s`)}`;
}

function iso(timestamp) {
  const n = numberOr(timestamp, null);
  if (n === null) return '(no timestamp)';
  try { return new Date(n).toISOString(); } catch { return String(timestamp); }
}

function indentBody(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\r?\n/g, '\n    ');
}

function formatBytes(bytes) {
  const n = numberOr(bytes, null);
  if (n === null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms) {
  const n = numberOr(ms, null);
  if (n === null) return '-';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function consoleFilterDesc(pattern, onlyErrors) {
  const parts = [];
  if (pattern) parts.push(`pattern /${pattern}/i`);
  if (onlyErrors) parts.push('onlyErrors');
  return parts.join(' + ');
}

function header(base, notes) {
  const kept = notes.filter(Boolean);
  return kept.length ? `${base} (${kept.join('; ')})` : base;
}

// Same, for a full sentence: the note belongs inside, before the full stop.
function sentence(base, notes) {
  return `${header(base, notes)}.`;
}

function consoleLine(entry) {
  let line = `${iso(entry.timestamp)} [${entry.level}] ${indentBody(entry.text)}`;
  const frame = entry.stackTrace && entry.stackTrace[0];
  if (frame && isErrorLevel(entry.level) && frame.url && !String(entry.text).includes(frame.url)) {
    const where = [frame.url, frame.lineNumber, frame.columnNumber].filter((p) => p !== null && p !== undefined).join(':');
    line += `\n    at ${frame.functionName || '(anonymous)'} (${where})`;
  }
  return line;
}

// One line per request; the header below is padded from the same widths.
const NETWORK_COLUMNS = [
  ['method', 6, 'end'], ['status', 6, 'start'], ['type', 10, 'end'],
  ['duration', 8, 'start'], ['size', 9, 'start'],
];

const NETWORK_HEADER = NETWORK_COLUMNS
  .map(([label, width, side]) => (side === 'end' ? label.padEnd(width) : label.padStart(width)))
  .concat('url').join(' ');

function pad(value, [, width, side]) {
  return side === 'end' ? String(value).padEnd(width) : String(value).padStart(width);
}

function networkLine(entry) {
  const cols = [
    pad(entry.method || '', NETWORK_COLUMNS[0]),
    pad(entry.status === null ? '-' : entry.status, NETWORK_COLUMNS[1]),
    pad(entry.resourceType || 'other', NETWORK_COLUMNS[2]),
    pad(formatDuration(entry.durationMs), NETWORK_COLUMNS[3]),
    pad(formatBytes(entry.bytes), NETWORK_COLUMNS[4]),
    entry.url || '(unknown url)',
  ];
  let line = cols.join(' ');
  if (entry.error) line += `  [${entry.error}]`;
  else if (entry.status === null) line += '  [pending]';
  else if (entry.status >= 400 && entry.statusText) line += `  [${entry.statusText}]`;
  return line;
}

// --- tool bodies ----------------------------------------------------------

async function readConsoleMessages(session, { tabId, onlyErrors = false, clear = false, pattern, limit } = {}) {
  const id = requireTabId(session, tabId);
  const re = compilePattern(pattern); // before attach: a bad pattern is a plain error
  // log.entryAdded rides the session's own subscription, so a console read must
  // not fail just because the extra network subscribe did.
  const state = await attach(session).catch(() => stateFor(session));
  const buf = bufferFor(state, id);

  const total = buf.console.length;
  // Text or level, kept apart so an anchored pattern ('^MyApp') still matches
  // the message while 'error|warning' still matches the level. Matching runs
  // under a time budget: the pattern comes from the model.
  let hits = null;
  if (re) {
    const texts = buf.console.map((e) => String(e.text || ''));
    const levels = buf.console.map((e) => String(e.level || ''));
    const found = await matchIndices(pattern, [...texts, ...levels]);
    hits = new Set(found.map((i) => i % Math.max(texts.length, 1)));
  }
  const matched = buf.console.filter((e, i) =>
    (!onlyErrors || isErrorLevel(e.level)) && (!hits || hits.has(i)));
  const cap = normalizeLimit(limit);
  const shown = matched.slice(-cap);
  const filteredOut = total - matched.length;
  const hidden = matched.length - shown.length;
  const overflowed = buf.dropped.console;
  if (clear) emptyBuffer(buf, 'console');

  const cleared = clear ? `buffer cleared, ${plural(total, 'message')} dropped` : null;
  const overflow = overflowed
    ? `${plural(overflowed, 'older message')} already dropped by the ${BUFFER_LIMIT}-entry cap`
    : null;
  if (!total) {
    return `No console messages captured for tab ${id}.` +
      '\nCapture begins the first time this tool runs, and the log is cleared when the tab navigates to a different domain. Reload the page to collect messages.';
  }
  if (!shown.length) {
    const desc = consoleFilterDesc(pattern, onlyErrors);
    return sentence(
      `No console messages in tab ${id} matched ${desc || 'the filter'}`,
      [`${plural(filteredOut, 'message')} filtered out of ${total} captured`, overflow, cleared],
    );
  }
  const head = header(`${plural(shown.length, 'console message')} from tab ${id}`, [
    `${total} captured`,
    filteredOut ? `${plural(filteredOut, 'message')} filtered out by ${consoleFilterDesc(pattern, onlyErrors)}` : null,
    hidden ? `${plural(hidden, 'older match', 'older matches')} hidden by limit ${cap}` : null,
    overflow,
    cleared,
  ]);
  return [head, ...shown.map(consoleLine)].join('\n');
}

async function readNetworkRequests(session, { tabId, urlPattern, clear = false, limit } = {}) {
  const id = requireTabId(session, tabId);
  const state = await attach(session);
  const buf = bufferFor(state, id);

  const needle = urlPattern === undefined || urlPattern === null || urlPattern === '' ? null : String(urlPattern).toLowerCase();
  const total = buf.network.length;
  const matched = needle ? buf.network.filter((e) => String(e.url).toLowerCase().includes(needle)) : buf.network.slice();
  const cap = normalizeLimit(limit);
  const shown = matched.slice(-cap);
  const filteredOut = total - matched.length;
  const hidden = matched.length - shown.length;
  const overflowed = buf.dropped.network;
  if (clear) emptyBuffer(buf, 'network');

  const cleared = clear ? `buffer cleared, ${plural(total, 'request')} dropped` : null;
  const overflow = overflowed
    ? `${plural(overflowed, 'older request')} already dropped by the ${BUFFER_LIMIT}-entry cap`
    : null;
  if (!total) {
    return `No network requests captured for tab ${id}.` +
      '\nCapture begins the first time this tool runs, and the log is cleared when the tab navigates to a different domain. Reload the page to collect requests.';
  }
  if (!shown.length) {
    return sentence(
      `No network requests in tab ${id} matched url pattern ${JSON.stringify(String(urlPattern))}`,
      [`${plural(filteredOut, 'request')} filtered out of ${total} captured`, overflow, cleared],
    );
  }
  const head = header(`${plural(shown.length, 'network request')} from tab ${id}`, [
    `${total} captured`,
    filteredOut ? `${plural(filteredOut, 'request')} filtered out by url pattern ${JSON.stringify(String(urlPattern))}` : null,
    hidden ? `${plural(hidden, 'older match', 'older matches')} hidden by limit ${cap}` : null,
    overflow,
    cleared,
  ]);
  return [head, NETWORK_HEADER, ...shown.map(networkLine)].join('\n');
}

// Live buffers for a tab; inspection helper for tests.
function buffersFor(session, tabId) {
  return bufferFor(stateFor(session), Number(tabId));
}

// --- tool definitions (verbatim from docs/chrome-tool-spec.json) ----------

function tools(ctx) {
  return [
    {
      name: 'read_console_messages',
      description:
        "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. " +
        "Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. " +
        "Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. " +
        "IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: "Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
          },
          onlyErrors: {
            type: 'boolean',
            description: 'If true, only return error and exception messages. Default is false (return all message types).',
          },
          clear: {
            type: 'boolean',
            description: 'If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false.',
          },
          pattern: {
            type: 'string',
            description: "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages.",
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return. Defaults to 100. Increase only if you need more results.',
          },
        },
        required: ['tabId'],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return readConsoleMessages(session, args || {});
      },
    },
    {
      name: 'read_network_requests',
      description:
        'Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. ' +
        'Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. ' +
        'Returns all network requests made by the current page, including cross-origin requests. ' +
        "Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: "Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
          },
          urlPattern: {
            type: 'string',
            description: "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain).",
          },
          clear: {
            type: 'boolean',
            description: 'If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of requests to return. Defaults to 100. Increase only if you need more results.',
          },
        },
        required: ['tabId'],
      },
      handler: async (args) => {
        const session = await ctx.session();
        return readNetworkRequests(session, args || {});
      },
    },
  ];
}

module.exports = {
  attach, readConsoleMessages, readNetworkRequests, buffersFor, tools,
  resourceType, compilePattern, formatBytes, formatDuration,
  NETWORK_EVENTS, BUFFER_LIMIT, DEFAULT_LIMIT,
};
