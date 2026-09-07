'use strict';
// A Session stand-in for unit tests: records calls, replays canned results.
// Modules must be testable without launching Firefox.

const { NO_TAB, NO_REF } = require('../../src/session');

class FakeSession {
  constructor({ tabs = [{ tabId: 1, context: 'ctx-1', url: 'https://example.com/' }], responses = {} } = {}) {
    this.tabs = tabs;
    this.responses = responses; // { callJson: [...], evaluate: [...], screenshot: [...], send: [...] }
    this.calls = [];
    this.images = new (require('../../src/session').ImageStore)();
    this.viewportSize = { width: 1280, height: 800 };
    this.viewports = new Map();
    this.blockedTabId = null;
    this.platform = 'mac';
    this.listeners = new Map();
  }

  get modifier() { return this.platform === 'mac' ? 'meta' : 'ctrl'; }

  _record(name, args) { this.calls.push({ name, args }); }

  _next(kind, fallback) {
    const queue = this.responses[kind];
    if (Array.isArray(queue) && queue.length) return queue.shift();
    if (typeof queue === 'function') return queue();
    if (queue !== undefined) return queue;
    return fallback;
  }

  async listTabs() { this._record('listTabs', {}); return this.tabs; }
  async createTab(opts = {}) { this._record('createTab', opts); const tabId = this.tabs.length + 1; this.tabs.push({ tabId, context: `ctx-${tabId}`, url: 'about:blank' }); return tabId; }
  async closeTab(tabId) { this._record('closeTab', { tabId }); this.requireContext(tabId); this.tabs = this.tabs.filter((t) => t.tabId !== Number(tabId)); }
  requireContext(tabId) {
    const tab = this.tabs.find((t) => t.tabId === Number(tabId));
    if (!tab) throw new Error(NO_TAB(tabId));
    return tab.context;
  }
  async defaultTabId() { return this.tabs[0]?.tabId ?? this.createTab(); }
  async pageInfo(tabId) { const t = this.tabs.find((x) => x.tabId === Number(tabId)); if (!t) throw new Error(NO_TAB(tabId)); return t; }
  async activate(tabId) { this._record('activate', { tabId }); this.requireContext(tabId); }
  async navigate(tabId, url, wait) { this._record('navigate', { tabId, url, wait }); this.requireContext(tabId); const t = this.tabs.find((x) => x.tabId === Number(tabId)); t.url = url; return { url }; }
  async callFunction(tabId, fn, args, opts) { this._record('callFunction', { tabId, fn, args, opts }); this.requireContext(tabId); return this._next('callFunction', undefined); }
  async callJson(tabId, fn, args, opts) { this._record('callJson', { tabId, fn, args, opts }); this.requireContext(tabId); return this._next('callJson', {}); }
  async evaluate(tabId, expression, opts) { this._record('evaluate', { tabId, expression, opts }); this.requireContext(tabId); return this._next('evaluate', undefined); }
  async ensureRefStore(tabId) { this._record('ensureRefStore', { tabId }); this.requireContext(tabId); }
  async resolveRef(tabId, ref, opts) {
    this._record('resolveRef', { tabId, ref, opts });
    this.requireContext(tabId);
    const canned = this._next('resolveRef', undefined);
    if (canned) return canned;
    if (String(ref).startsWith('ref_')) return { found: true, visible: true, x: 100, y: 200, left: 80, top: 190, width: 40, height: 20, inViewport: true, tag: 'button' };
    throw new Error(NO_REF(ref));
  }
  async refNode(tabId, ref) { this._record('refNode', { tabId, ref }); this.requireContext(tabId); return this._next('refNode', { type: 'node', sharedId: 'shared-1' }); }
  async screenshot(tabId, opts = {}) {
    this._record('screenshot', { tabId, ...opts });
    this.requireContext(tabId);
    return this._next('screenshot', { data: Buffer.from('fake-png').toString('base64'), mimeType: opts.format === 'jpeg' ? 'image/jpeg' : 'image/png' });
  }
  async performActions(tabId, actions) { this._record('performActions', { tabId, actions }); this.requireContext(tabId); return {}; }
  async setViewport(tabId, size) {
    this._record('setViewport', { tabId, ...size });
    this.requireContext(tabId);
    const applied = { width: size.width, height: size.height };
    this.viewports.set(Number(tabId), applied);
    return applied;
  }
  // Each tab renders at its own size once resize_window touches one.
  viewportFor(tabId) { return this.viewports.get(Number(tabId)) || this.viewportSize; }
  promptTabId() { return this.blockedTabId ?? null; }
  async send(method, params, opts) { this._record('send', { method, params, opts }); return this._next('send', {}); }
  async subscribe(events) { this._record('subscribe', { events }); }
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event).delete(handler);
  }
  emit(event, params) { for (const h of this.listeners.get(event) || []) h(params); }
  callsOf(name) { return this.calls.filter((c) => c.name === name); }
}

function fakeCtx(session) {
  return {
    session: async () => session,
    callTool: async () => { throw new Error('callTool not stubbed'); },
    config: { downloadDir: '/tmp/ffuse-test' },
  };
}

module.exports = { FakeSession, fakeCtx };
