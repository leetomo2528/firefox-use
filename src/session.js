'use strict';
// Session: the shared runtime every tool module builds on.
//
// It owns the BiDi connection, the numeric tab ids of this session's tab group,
// the page-side element ref registry (ref_1, ref_2, ...) and the screenshot
// store that upload_image reads from. Tool modules receive a Session and never
// talk to the transport directly.

const { BidiConnection } = require('./bidi');
const launcher = require('./launcher');

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const EVENTS = [
  'browsingContext.load',
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
  'browsingContext.userPromptOpened',
  'browsingContext.navigationStarted',
  'log.entryAdded',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome's wording, so failures read the same on either browser.
const NO_TAB = (tabId) => `Tab ${tabId} no longer exists. Call tabs_context_mcp to get valid tab ids.`;
const NO_REF = (ref) => `Element ${ref} was not found on the page. Call read_page or find again to get fresh refs.`;

// Installed in the page realm; refs live here so the DOM is never mutated.
const REF_STORE_FN = `(function () {
  if (!window.__ffuse) {
    window.__ffuse = { refs: new Map(), next: 1, clicks: [] };
  }
  return window.__ffuse.next;
})`;

const RESOLVE_REF_FN = `(function (ref, scroll) {
  var store = window.__ffuse && window.__ffuse.refs;
  var el = store && store.get(ref);
  if (!el || !el.isConnected) return JSON.stringify({ found: false });
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var r = el.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    visible: r.width > 0 && r.height > 0,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    left: Math.round(r.left), top: Math.round(r.top),
    width: Math.round(r.width), height: Math.round(r.height),
    inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
    tag: el.localName,
    type: el.getAttribute && el.getAttribute('type')
  });
})`;

const NODE_FOR_REF_FN = `(function (ref) {
  var store = window.__ffuse && window.__ffuse.refs;
  var el = store && store.get(ref);
  return el && el.isConnected ? el : null;
})`;

// JS value -> BiDi LocalValue.
function toLocalValue(value) {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  switch (typeof value) {
    case 'string': return { type: 'string', value };
    case 'boolean': return { type: 'boolean', value };
    case 'number':
      if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
      if (value === Infinity) return { type: 'number', value: 'Infinity' };
      if (value === -Infinity) return { type: 'number', value: '-Infinity' };
      return { type: 'number', value };
    case 'object':
      if (Array.isArray(value)) return { type: 'array', value: value.map(toLocalValue) };
      return { type: 'object', value: Object.entries(value).map(([k, v]) => [k, toLocalValue(v)]) };
    default:
      throw new Error(`cannot pass ${typeof value} to the page`);
  }
}

// BiDi RemoteValue -> readable JS.
function fromRemoteValue(remote, depth = 0) {
  if (!remote || typeof remote !== 'object') return remote;
  switch (remote.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return remote.value;
    case 'number': return typeof remote.value === 'string' ? Number(remote.value) : remote.value;
    case 'bigint': return `${remote.value}n`;
    case 'array': case 'set':
      return depth > 4 ? '[...]' : (remote.value || []).map((v) => fromRemoteValue(v, depth + 1));
    case 'object': case 'map': {
      if (depth > 4) return '{...}';
      const out = {};
      for (const [k, v] of remote.value || []) {
        out[typeof k === 'object' ? JSON.stringify(fromRemoteValue(k, depth + 1)) : k] = fromRemoteValue(v, depth + 1);
      }
      return out;
    }
    case 'node': return `<${remote.value?.localName || 'node'}>`;
    case 'function': return '[function]';
    case 'promise': return '[promise]';
    case 'window': return '[window]';
    case 'error': return `[error: ${remote.value?.message || ''}]`;
    default: return remote.value !== undefined ? remote.value : `[${remote.type}]`;
  }
}

// Numeric tab ids for a session-owned group of tabs, mirroring Chrome's model.
class TabRegistry {
  constructor() {
    this.byTabId = new Map(); // tabId -> context
    this.byContext = new Map(); // context -> tabId
    this.next = 1;
    this.windowContext = null; // clientWindow the group lives in
  }

  add(context) {
    if (this.byContext.has(context)) return this.byContext.get(context);
    const tabId = this.next++;
    this.byTabId.set(tabId, context);
    this.byContext.set(context, tabId);
    return tabId;
  }

  remove(context) {
    const tabId = this.byContext.get(context);
    if (tabId === undefined) return;
    this.byContext.delete(context);
    this.byTabId.delete(tabId);
  }

  contextFor(tabId) {
    return this.byTabId.get(Number(tabId));
  }

  tabIdFor(context) {
    return this.byContext.get(context);
  }

  get size() {
    return this.byTabId.size;
  }

  ids() {
    return [...this.byTabId.keys()];
  }
}

// Screenshots the model can hand to upload_image, keyed like Chrome's imageId.
class ImageStore {
  constructor(limit = 20) {
    this.limit = limit;
    this.images = new Map();
    this.next = 1;
  }

  put({ data, mimeType, path = null, width = null, height = null }) {
    const id = `img_${this.next++}`;
    this.images.set(id, { id, data, mimeType, path, width, height });
    while (this.images.size > this.limit) this.images.delete(this.images.keys().next().value);
    return id;
  }

  get(id) {
    return this.images.get(id) || null;
  }

  get lastId() {
    let last = null;
    for (const id of this.images.keys()) last = id;
    return last;
  }
}

class Session {
  constructor(conn, opts = {}) {
    this.conn = conn;
    this.opts = opts;
    this.viewportSize = opts.viewport || DEFAULT_VIEWPORT;
    this.platform = 'mac';
    this.tabs = new TabRegistry();
    this.images = new ImageStore();
    this.listeners = new Map(); // eventName -> Set(handler)
    this._sized = new Set();
    this._booted = new Set();
    this.pendingPrompt = null;

    conn.on('event', (method, params) => this._dispatch(method, params));
    conn.on('browsingContext.contextDestroyed', (p) => {
      this.tabs.remove(p.context);
      this._sized.delete(p.context);
      this._booted.delete(p.context);
    });
    conn.on('browsingContext.userPromptOpened', (p) => { this.pendingPrompt = p; });
    // A fresh document drops the page-side ref store.
    conn.on('browsingContext.load', (p) => this._booted.delete(p.context));
  }

  static async open(opts = {}) {
    const allowRestart = opts.autoRestart ?? process.env.FIREFOX_USE_AUTO_RESTART !== '0';
    let state = await launcher.ensureRunning(opts);
    for (let attempt = 0; ; attempt++) {
      const conn = await BidiConnection.connect(launcher.sessionUrl(state.url));
      try {
        const session = new Session(conn, opts);
        session.state = state;
        try {
          const created = await conn.send('session.new', { capabilities: {} });
          session.platform = created?.capabilities?.platformName || 'mac';
          session.sessionId = created?.sessionId;
        } catch (err) {
          if (err.code === 'session not created') throw err;
        }
        await conn.send('session.subscribe', { events: EVENTS });
        await session.adoptExistingTabs();
        return session;
      } catch (err) {
        conn.close();
        if (err.code !== 'session not created') throw err;
        if (attempt === 0) { await sleep(1000); continue; }
        if (attempt === 1 && allowRestart) {
          await launcher.stop();
          await sleep(1000);
          state = await launcher.launch(opts);
          continue;
        }
        throw new Error(
          'Firefox already has an active WebDriver BiDi session that is not ours. ' +
          'Run `firefox-use restart` (or close Firefox) and try again.'
        );
      }
    }
  }

  async close({ endSession = true } = {}) {
    if (endSession && !this.conn.closed) {
      try { await this.conn.send('session.end', {}, { timeout: 5000 }); } catch { /* gone */ }
    }
    this.conn.close();
    await sleep(50);
  }

  get modifier() {
    return this.platform === 'mac' ? 'meta' : 'ctrl';
  }

  // --- events -------------------------------------------------------------

  _dispatch(method, params) {
    const handlers = this.listeners.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(params); } catch { /* a listener must not break the stream */ }
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  async subscribe(events) {
    const wanted = events.filter((e) => !EVENTS.includes(e));
    if (!wanted.length) return;
    await this.conn.send('session.subscribe', { events: wanted });
    EVENTS.push(...wanted);
  }

  send(method, params, opts) {
    return this.conn.send(method, params, opts);
  }

  // --- tabs ---------------------------------------------------------------

  async topLevelContexts() {
    const { contexts } = await this.conn.send('browsingContext.getTree', {});
    return contexts || [];
  }

  // Tabs that already exist when the session opens belong to the group too, so
  // a user who started Firefox by hand still sees their tab.
  async adoptExistingTabs() {
    const contexts = await this.topLevelContexts();
    for (const c of contexts) this.tabs.add(c.context);
    if (contexts.length) this.tabs.windowContext = contexts[0].clientWindow || null;
    return this.tabs.ids();
  }

  async listTabs() {
    const contexts = await this.topLevelContexts();
    const live = new Set(contexts.map((c) => c.context));
    for (const context of [...this.tabs.byContext.keys()]) {
      if (!live.has(context)) this.tabs.remove(context);
    }
    const out = [];
    for (const c of contexts) {
      const tabId = this.tabs.tabIdFor(c.context);
      if (tabId === undefined) continue; // not part of this session's group
      out.push({ tabId, context: c.context, url: c.url, clientWindow: c.clientWindow });
    }
    return out;
  }

  async createTab({ type, url } = {}) {
    // With every window closed there is no tab strip to add to, so the first
    // tab has to bring its own window.
    const existing = await this.topLevelContexts();
    const kind = type || (existing.length ? 'tab' : 'window');
    const params = { type: kind, focus: true };
    if (kind === 'tab') {
      const anchor = [...this.tabs.byContext.keys()].find((c) => existing.some((e) => e.context === c))
        || existing[0]?.context;
      if (anchor) params.referenceContext = anchor;
    }
    const { context } = await this.conn.send('browsingContext.create', params);
    const tabId = this.tabs.add(context);
    if (!this.tabs.windowContext) {
      const info = (await this.topLevelContexts()).find((c) => c.context === context);
      this.tabs.windowContext = info?.clientWindow || null;
    }
    await this.applyViewport(context);
    if (url) await this.navigate(tabId, url);
    return tabId;
  }

  async closeTab(tabId) {
    const context = this.requireContext(tabId);
    await this.conn.send('browsingContext.close', { context });
    this.tabs.remove(context);
  }

  requireContext(tabId) {
    if (tabId === undefined || tabId === null) throw new Error('tabId is required');
    const context = this.tabs.contextFor(tabId);
    if (!context) throw new Error(NO_TAB(tabId));
    return context;
  }

  // The tab a standalone call acts on when tabId is omitted.
  async defaultTabId({ createIfEmpty = true } = {}) {
    const tabs = await this.listTabs();
    if (tabs.length) return tabs[0].tabId;
    if (!createIfEmpty) throw new Error('No tabs available. Call tabs_context_mcp with createIfEmpty.');
    return this.createTab();
  }

  async activate(tabId) {
    await this.conn.send('browsingContext.activate', { context: this.requireContext(tabId) });
  }

  async navigate(tabId, url, wait = 'complete') {
    const context = this.requireContext(tabId);
    return this.conn.send('browsingContext.navigate', { context, url, wait }, { timeout: 90000 });
  }

  // --- page primitives ----------------------------------------------------

  async applyViewport(context) {
    if (!this.viewportSize || this._sized.has(context)) return;
    this._sized.add(context);
    try {
      await this.conn.send('browsingContext.setViewport', {
        context,
        viewport: { width: this.viewportSize.width, height: this.viewportSize.height },
        devicePixelRatio: 1,
      });
    } catch (err) {
      this.lastViewportError = err.message;
    }
  }

  async setViewport(tabId, { width, height, devicePixelRatio = 1 }) {
    const context = this.requireContext(tabId);
    await this.conn.send('browsingContext.setViewport', {
      context,
      viewport: { width: Math.round(width), height: Math.round(height) },
      devicePixelRatio,
    });
    this.viewportSize = { width: Math.round(width), height: Math.round(height) };
    this._sized.add(context);
    return this.viewportSize;
  }

  async callFunction(tabId, functionDeclaration, args = [], { timeout = 30000, ownership = 'none', awaitPromise = true } = {}) {
    const context = this.requireContext(tabId);
    await this.applyViewport(context);
    const res = await this.conn.send('script.callFunction', {
      functionDeclaration,
      arguments: args.map(toLocalValue),
      target: { context },
      awaitPromise,
      userActivation: true,
      resultOwnership: ownership,
    }, { timeout });
    if (res.type === 'exception') {
      throw new Error(`page script failed: ${res.exceptionDetails?.text || 'unknown error'}`);
    }
    return ownership === 'root' ? res.result : fromRemoteValue(res.result);
  }

  async callJson(tabId, functionDeclaration, args = [], opts) {
    const value = await this.callFunction(tabId, functionDeclaration, args, opts);
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }

  async evaluate(tabId, expression, { timeout = 30000, awaitPromise = true } = {}) {
    const context = this.requireContext(tabId);
    const res = await this.conn.send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise,
      userActivation: true,
    }, { timeout });
    if (res.type === 'exception') {
      const err = new Error(res.exceptionDetails?.text || 'script threw');
      err.isPageException = true;
      throw err;
    }
    return fromRemoteValue(res.result);
  }

  // Makes sure window.__ffuse exists in this document before refs are used.
  async ensureRefStore(tabId) {
    const context = this.requireContext(tabId);
    if (this._booted.has(context)) return;
    await this.callFunction(tabId, REF_STORE_FN, []);
    this._booted.add(context);
  }

  async resolveRef(tabId, ref, { scroll = true } = {}) {
    const info = await this.callJson(tabId, RESOLVE_REF_FN, [String(ref), scroll]);
    if (!info || !info.found) throw new Error(NO_REF(ref));
    return info;
  }

  // RemoteValue node (carries sharedId) for BiDi commands that need an element.
  async refNode(tabId, ref) {
    const node = await this.callFunction(tabId, NODE_FOR_REF_FN, [String(ref)], { ownership: 'root' });
    if (!node || node.type !== 'node' || !node.sharedId) throw new Error(NO_REF(ref));
    return node;
  }

  async screenshot(tabId, { clip = null, format = 'png', quality, fullPage = false } = {}) {
    const context = this.requireContext(tabId);
    await this.applyViewport(context);
    const params = {
      context,
      origin: fullPage ? 'document' : 'viewport',
      format: { type: format === 'jpeg' ? 'image/jpeg' : 'image/png' },
    };
    if (format === 'jpeg') params.format.quality = quality ?? 0.8;
    if (clip) {
      params.clip = {
        type: 'box',
        x: Math.round(clip.x), y: Math.round(clip.y),
        width: Math.round(clip.width), height: Math.round(clip.height),
      };
    }
    const res = await this.conn.send('browsingContext.captureScreenshot', params, { timeout: 90000 });
    return { data: res.data, mimeType: params.format.type };
  }

  performActions(tabId, actions) {
    return this.conn.send('input.performActions', { context: this.requireContext(tabId), actions });
  }

  async handleUserPrompt(tabId, accept = true, userText) {
    const params = { context: this.requireContext(tabId), accept };
    if (userText !== undefined) params.userText = String(userText);
    await this.conn.send('browsingContext.handleUserPrompt', params);
    const prompt = this.pendingPrompt;
    this.pendingPrompt = null;
    return prompt;
  }

  async pageInfo(tabId) {
    const tabs = await this.listTabs();
    const tab = tabs.find((t) => t.tabId === Number(tabId));
    if (!tab) throw new Error(NO_TAB(tabId));
    return tab;
  }
}

module.exports = {
  Session, TabRegistry, ImageStore,
  toLocalValue, fromRemoteValue,
  DEFAULT_VIEWPORT, REF_STORE_FN, RESOLVE_REF_FN, NODE_FOR_REF_FN,
  NO_TAB, NO_REF, sleep,
};
