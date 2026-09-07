'use strict';
// High-level browser control on top of WebDriver BiDi: tabs, navigation,
// screenshots, snapshots and synthesized mouse/keyboard input.

const { BidiConnection } = require('./bidi');
const launcher = require('./launcher');
const { SNAPSHOT_FN, RESOLVE_FN, TEXT_FN } = require('./snapshot');
const { comboActions, typeActions, keyValue } = require('./keys');

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MAX_CONSOLE = 200;
const EVENTS = [
  'browsingContext.load',
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
  'browsingContext.userPromptOpened',
  'log.entryAdded',
];

// JS value -> BiDi LocalValue, so page functions can take plain arguments.
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

// BiDi RemoteValue -> readable JS for tool output.
function fromRemoteValue(remote, depth = 0) {
  if (!remote || typeof remote !== 'object') return remote;
  switch (remote.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return remote.value;
    case 'number':
      return typeof remote.value === 'string' ? Number(remote.value) : remote.value;
    case 'bigint': return `${remote.value}n`;
    case 'array': case 'set':
      return depth > 3 ? '[...]' : (remote.value || []).map((v) => fromRemoteValue(v, depth + 1));
    case 'object': case 'map': {
      if (depth > 3) return '{...}';
      const out = {};
      for (const [k, v] of remote.value || []) {
        out[typeof k === 'object' ? JSON.stringify(fromRemoteValue(k, depth + 1)) : k] = fromRemoteValue(v, depth + 1);
      }
      return out;
    }
    case 'node':
      return `<${remote.value?.localName || 'node'}>`;
    case 'function': return '[function]';
    case 'promise': return '[promise]';
    default:
      return remote.value !== undefined ? remote.value : `[${remote.type}]`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FirefoxBrowser {
  constructor(conn, { viewport = DEFAULT_VIEWPORT } = {}) {
    this.conn = conn;
    this.viewport = viewport;
    this.platform = 'mac';
    this.context = null;
    this.console = [];
    this.pendingPrompt = null;
    this._sizedContexts = new Set();

    conn.on('log.entryAdded', (p) => {
      this.console.push({
        level: p.level,
        text: p.text || (p.args || []).map((a) => JSON.stringify(fromRemoteValue(a))).join(' '),
        source: p.source?.context,
        at: new Date(p.timestamp || Date.now()).toISOString(),
      });
      if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE);
    });
    conn.on('browsingContext.userPromptOpened', (p) => { this.pendingPrompt = p; });
    conn.on('browsingContext.contextDestroyed', (p) => {
      this._sizedContexts.delete(p.context);
      if (this.context === p.context) this.context = null;
    });
  }

  static async open(opts = {}) {
    const allowRestart = opts.autoRestart ?? process.env.FIREFOX_USE_AUTO_RESTART !== '0';
    let state = await launcher.ensureRunning(opts);
    let attempt = 0;
    for (;;) {
      const conn = await BidiConnection.connect(launcher.sessionUrl(state.url));
      try {
        const browser = await FirefoxBrowser._startSession(conn, opts, state);
        return browser;
      } catch (err) {
        conn.close();
        // Firefox allows a single BiDi session; one left behind by a crashed
        // client blocks every new one until the browser restarts.
        const orphaned = err.code === 'session not created';
        if (!orphaned) throw err;
        attempt += 1;
        if (attempt === 1) {
          await sleep(1000); // the orphan may still be getting reaped
          continue;
        }
        if (attempt === 2 && allowRestart) {
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

  static async _startSession(conn, opts, state) {
    const browser = new FirefoxBrowser(conn, opts);
    browser.state = state;
    try {
      const session = await conn.send('session.new', { capabilities: {} });
      browser.platform = session?.capabilities?.platformName || 'mac';
      browser.sessionId = session?.sessionId;
    } catch (err) {
      // "invalid argument"/"unsupported operation" here means this connection
      // already carries a session, which is fine; anything else is fatal.
      if (err.code === 'session not created') throw err;
    }
    await conn.send('session.subscribe', { events: EVENTS });
    await browser.ensureContext();
    return browser;
  }

  // Ending the session is what frees Firefox's single session slot, so it runs
  // before the socket goes away.
  async close({ endSession = true } = {}) {
    if (endSession && !this.conn.closed) {
      try {
        await this.conn.send('session.end', {}, { timeout: 5000 });
      } catch { /* session already gone */ }
    }
    this.conn.close();
    await sleep(50);
  }

  get modifier() {
    return this.platform === 'mac' ? 'meta' : 'ctrl';
  }

  async listContexts() {
    const { contexts } = await this.conn.send('browsingContext.getTree', {});
    return contexts || [];
  }

  async ensureContext() {
    const contexts = await this.listContexts();
    if (!contexts.length) {
      const created = await this.conn.send('browsingContext.create', { type: 'tab' });
      this.context = created.context;
    } else if (!this.context || !contexts.some((c) => c.context === this.context)) {
      this.context = contexts[0].context;
    }
    await this.applyViewport(this.context);
    return this.context;
  }

  // A fixed viewport keeps screenshot pixels and click coordinates in the same
  // space no matter how the window was sized.
  async applyViewport(context) {
    if (!this.viewport || this._sizedContexts.has(context)) return;
    try {
      await this.conn.send('browsingContext.setViewport', {
        context,
        viewport: { width: this.viewport.width, height: this.viewport.height },
        devicePixelRatio: 1,
      });
      this._sizedContexts.add(context);
    } catch (err) {
      this._sizedContexts.add(context); // don't retry on every call
      this.lastViewportError = err.message;
    }
  }

  async selectContext(idOrIndex) {
    const contexts = await this.listContexts();
    let target = contexts.find((c) => c.context === idOrIndex);
    if (!target && Number.isInteger(idOrIndex)) target = contexts[idOrIndex];
    if (!target) throw new Error(`no such tab: ${idOrIndex}`);
    this.context = target.context;
    await this.applyViewport(this.context);
    await this.conn.send('browsingContext.activate', { context: this.context });
    return target;
  }

  async newTab(url) {
    const { context } = await this.conn.send('browsingContext.create', { type: 'tab', focus: true });
    this.context = context;
    await this.applyViewport(context);
    if (url) await this.navigate(url);
    return context;
  }

  async closeTab(id) {
    const context = id || (await this.ensureContext());
    await this.conn.send('browsingContext.close', { context });
    if (this.context === context) this.context = null;
    return this.ensureContext();
  }

  async navigate(url, wait = 'complete') {
    const context = await this.ensureContext();
    let target = String(url).trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
    return this.conn.send('browsingContext.navigate', { context, url: target, wait }, { timeout: 90000 });
  }

  async traverse(delta) {
    const context = await this.ensureContext();
    return this.conn.send('browsingContext.traverseHistory', { context, delta });
  }

  async reload(ignoreCache = false) {
    const context = await this.ensureContext();
    return this.conn.send('browsingContext.reload', { context, ignoreCache, wait: 'complete' }, { timeout: 90000 });
  }

  async screenshot({ fullPage = false, format = 'png', quality } = {}) {
    const context = await this.ensureContext();
    const params = {
      context,
      origin: fullPage ? 'document' : 'viewport',
      format: { type: format === 'jpeg' ? 'image/jpeg' : 'image/png' },
    };
    if (format === 'jpeg') params.format.quality = quality ?? 0.8;
    const res = await this.conn.send('browsingContext.captureScreenshot', params, { timeout: 90000 });
    return { data: res.data, mimeType: params.format.type };
  }

  async callPageFunction(fn, args = [], { timeout = 30000 } = {}) {
    const context = await this.ensureContext();
    const res = await this.conn.send('script.callFunction', {
      functionDeclaration: fn,
      arguments: args.map(toLocalValue),
      target: { context },
      awaitPromise: true,
      userActivation: true,
    }, { timeout });
    if (res.type === 'exception') {
      throw new Error(`page script failed: ${res.exceptionDetails?.text || 'unknown error'}`);
    }
    return fromRemoteValue(res.result);
  }

  async snapshot({ max = 200, includeOffscreen = false } = {}) {
    const json = await this.callPageFunction(SNAPSHOT_FN, [{ max, includeOffscreen }]);
    const data = JSON.parse(json);
    this.refs = new Map();
    data.elements.forEach((el, i) => {
      el.ref = `e${i + 1}`;
      this.refs.set(el.ref, { selector: el.selector, context: this.context });
    });
    return data;
  }

  async resolveRef(ref, { scroll = true } = {}) {
    const entry = this.refs?.get(ref);
    if (!entry) throw new Error(`unknown ref "${ref}" - run firefox_snapshot first`);
    const json = await this.callPageFunction(RESOLVE_FN, [entry.selector, scroll]);
    const info = JSON.parse(json);
    if (!info.found) throw new Error(`ref ${ref} is gone from the page - take a new snapshot`);
    if (!info.visible) throw new Error(`ref ${ref} is not visible`);
    return info;
  }

  async pointTo({ ref, x, y }) {
    if (ref) {
      const info = await this.resolveRef(ref);
      return { x: info.x, y: info.y };
    }
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error('give either ref or both x and y');
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  async performActions(actions) {
    const context = await this.ensureContext();
    return this.conn.send('input.performActions', { context, actions });
  }

  mouseSource(actions) {
    return [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }];
  }

  keySource(actions) {
    return [{ type: 'key', id: 'keyboard', actions }];
  }

  async click({ ref, x, y, button = 'left', clicks = 1 } = {}) {
    const point = await this.pointTo({ ref, x, y });
    const buttonId = { left: 0, middle: 1, right: 2 }[button];
    if (buttonId === undefined) throw new Error(`unknown button: ${button}`);
    const actions = [{ type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport', duration: 40 }];
    for (let i = 0; i < clicks; i++) {
      actions.push(
        { type: 'pointerDown', button: buttonId },
        { type: 'pause', duration: 30 },
        { type: 'pointerUp', button: buttonId }
      );
      if (i < clicks - 1) actions.push({ type: 'pause', duration: 60 });
    }
    await this.performActions(this.mouseSource(actions));
    return point;
  }

  async hover({ ref, x, y } = {}) {
    const point = await this.pointTo({ ref, x, y });
    await this.performActions(this.mouseSource([
      { type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport', duration: 60 },
    ]));
    return point;
  }

  async drag({ fromX, fromY, toX, toY }) {
    await this.performActions(this.mouseSource([
      { type: 'pointerMove', x: Math.round(fromX), y: Math.round(fromY), origin: 'viewport', duration: 40 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerMove', x: Math.round(toX), y: Math.round(toY), origin: 'viewport', duration: 300 },
      { type: 'pause', duration: 60 },
      { type: 'pointerUp', button: 0 },
    ]));
    return { fromX, fromY, toX, toY };
  }

  async scroll({ x, y, deltaX = 0, deltaY = 0 } = {}) {
    const px = Math.round(x ?? this.viewport.width / 2);
    const py = Math.round(y ?? this.viewport.height / 2);
    const context = await this.ensureContext();
    await this.conn.send('input.performActions', {
      context,
      actions: [{
        type: 'wheel',
        id: 'wheel',
        actions: [{
          type: 'scroll', x: px, y: py,
          deltaX: Math.round(deltaX), deltaY: Math.round(deltaY),
          origin: 'viewport', duration: 100,
        }],
      }],
    });
    return { x: px, y: py, deltaX, deltaY };
  }

  async type({ text, ref, x, y, clear = false, submit = false } = {}) {
    if (ref || typeof x === 'number') await this.click({ ref, x, y });
    const actions = [];
    if (clear) {
      actions.push(...comboActions(`${this.modifier}+a`));
      actions.push({ type: 'keyDown', value: keyValue('backspace') }, { type: 'keyUp', value: keyValue('backspace') });
    }
    if (text) actions.push(...typeActions(text));
    if (submit) actions.push({ type: 'keyDown', value: keyValue('enter') }, { type: 'keyUp', value: keyValue('enter') });
    if (!actions.length) return { typed: 0 };
    await this.performActions(this.keySource(actions));
    return { typed: text ? String(text).length : 0, cleared: clear, submitted: submit };
  }

  async pressKey(combo) {
    await this.performActions(this.keySource(comboActions(combo)));
    return { key: combo };
  }

  async evaluate(expression) {
    const context = await this.ensureContext();
    const res = await this.conn.send('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      userActivation: true,
    }, { timeout: 30000 });
    if (res.type === 'exception') {
      throw new Error(res.exceptionDetails?.text || 'script threw');
    }
    return fromRemoteValue(res.result);
  }

  async readText({ offset = 0, limit = 8000 } = {}) {
    return JSON.parse(await this.callPageFunction(TEXT_FN, [{ offset, limit }]));
  }

  async waitForText(text, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    const needle = JSON.stringify(String(text));
    while (Date.now() < deadline) {
      const found = await this.evaluate(
        `!!(document.body && (document.body.innerText || '').includes(${needle}))`
      );
      if (found) return true;
      await sleep(300);
    }
    return false;
  }

  async handleDialog(accept = true, userText) {
    const context = await this.ensureContext();
    const params = { context, accept };
    if (userText !== undefined) params.userText = String(userText);
    await this.conn.send('browsingContext.handleUserPrompt', params);
    const handled = this.pendingPrompt;
    this.pendingPrompt = null;
    return handled;
  }

  async pageInfo() {
    const contexts = await this.listContexts();
    const current = contexts.find((c) => c.context === this.context) || contexts[0];
    return {
      url: current?.url,
      context: current?.context,
      tabs: contexts.map((c, i) => ({ index: i, context: c.context, url: c.url, current: c.context === this.context })),
    };
  }
}

module.exports = { FirefoxBrowser, toLocalValue, fromRemoteValue, DEFAULT_VIEWPORT };
