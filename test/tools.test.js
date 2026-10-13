'use strict';
// ToolHost lifecycle: restart, per-call deadlines, and recovery from a Firefox
// that has no window. The launcher and the BiDi transport are stubbed, so no
// browser is started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const launcher = require('../src/launcher');
const { Session, NO_WINDOW } = require('../src/session');
const { BidiError } = require('../src/bidi');
const { ToolHost } = require('../src/tools');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (result) => (typeof result === 'string'
  ? result
  : (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));

// A BidiConnection stand-in: canned replies per method; a reply that is a
// function runs with the params, and a pending promise models a hung browser.
class FakeConn extends EventEmitter {
  constructor(replies = {}) {
    super();
    this.replies = replies;
    this.sent = [];
    this.closed = false;
  }
  async send(method, params, opts) {
    if (this.closed) throw new Error('BiDi connection is closed');
    this.sent.push({ method, params, opts });
    const reply = this.replies[method];
    if (typeof reply === 'function') return reply(params);
    return reply === undefined ? {} : reply;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', new Error('BiDi connection is closed'));
  }
  count(method) { return this.sent.filter((c) => c.method === method).length; }
}

// What Firefox 157 answers to browsingContext.create when no window is open.
const WINDOWLESS = () => {
  throw new BidiError({
    error: 'unknown error',
    message: 'TypeError: can\'t access property "selectedTab", lazy.TabManager.getTabBrowser(...) is null',
  });
};

const tree = (...contexts) => () => ({ contexts: contexts.map((c) => ({ context: c, url: 'about:blank', clientWindow: 'w1', children: [] })) });

// Swaps the launcher and Session.open for stubs and returns a log of what ran.
function stubBrowser(t, conns) {
  const saved = {
    stop: launcher.stop, launch: launcher.launch, status: launcher.status, open: Session.open,
  };
  const log = { stop: 0, launch: 0, open: 0, sessions: [] };
  launcher.stop = async () => { log.stop++; return true; };
  launcher.launch = async () => { log.launch++; return { pid: 4242, port: 9999 }; };
  launcher.status = async () => ({ reachable: true, pid: 4242, port: 9999, profile: '/tmp/p', logFile: '/tmp/l' });
  Session.open = async (opts) => {
    const next = conns[Math.min(log.open, conns.length - 1)];
    log.open++;
    const conn = typeof next === 'function' ? next() : next;
    const session = new Session(conn, opts);
    await session.adoptExistingTabs();
    log.sessions.push(session);
    return session;
  };
  t.after(() => Object.assign(launcher, { stop: saved.stop, launch: saved.launch, status: saved.status }));
  t.after(() => { Session.open = saved.open; });
  return log;
}

function host(t, opts = {}) {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-tools-'));
  t.after(() => fs.rmSync(downloadDir, { recursive: true, force: true }));
  return new ToolHost({ downloadDir, ...opts });
}

// Fails the test instead of hanging the run when a promise never settles.
function within(ms, promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

test('firefox_restart finishes, and later calls use the new browser', async (t) => {
  const first = new FakeConn({ 'browsingContext.getTree': tree('ctx-a') });
  const second = new FakeConn({ 'browsingContext.getTree': tree('ctx-b') });
  const log = stubBrowser(t, [first, second]);
  const h = host(t);

  await h.session();
  // It used to call this.session() from inside the restart, which handed back
  // the restart's own promise: firefox_restart waited on itself forever, and
  // every later call queued behind it.
  const out = await within(2000, h.callTool('firefox_restart', {}), 'firefox_restart');
  assert.match(textOf(out), /Firefox restarted \(pid 4242, port 9999\)/);
  assert.equal(log.stop, 1);
  assert.equal(log.launch, 1);
  assert.equal(first.closed, true, 'the old connection was dropped');
  assert.equal(h._restarting, null, 'nothing is left waiting on the restart');

  const status = await within(2000, h.callTool('firefox_status', {}), 'firefox_status after restart');
  assert.match(textOf(status), /firefox: running/);
  assert.equal((await h.session()).conn, second);
});

test('a restart that cannot finish rejects within its budget', async (t) => {
  stubBrowser(t, [() => new FakeConn({ 'browsingContext.getTree': tree('ctx-a') })]);
  let reached;
  let abandon;
  const launching = new Promise((r) => { reached = r; });
  launcher.launch = () => {
    reached();
    return new Promise((_, reject) => { abandon = reject; });
  };
  const h = host(t, { restartTimeout: 150 });

  await assert.rejects(
    within(2000, h.callTool('firefox_restart', {}), 'firefox_restart'),
    /Restarting Firefox did not finish within/
  );
  assert.equal(h._restarting, null, 'a failed restart is not left in place for others to join');
  // The next call opens a session normally instead of joining the dead restart.
  const session = await within(2000, h.session(), 'session after a failed restart');
  assert.ok(session);
  // Let the abandoned restart reach its launch and fail there, so it cannot
  // run on into the next test's stubs.
  await within(3000, launching, 'the abandoned launch');
  abandon(new Error('test over'));
  await sleep(10);
});

test('a call that hangs comes back as an error once its deadline passes', async (t) => {
  const hung = new FakeConn({
    'browsingContext.getTree': tree('ctx-a'),
    'script.evaluate': () => new Promise(() => {}),
  });
  stubBrowser(t, [hung]);
  const h = host(t, { callTimeout: 150, healthTimeout: 100 });
  await h.session();

  const started = Date.now();
  await assert.rejects(
    within(3000, h.callTool('javascript_tool', { action: 'javascript_exec', tabId: 1, text: '1' }), 'javascript_tool'),
    (err) => {
      assert.equal(err.code, 'timeout');
      assert.match(err.message, /javascript_tool did not finish within 150ms\./);
      // session.status answered, so the browser is alive and stays connected.
      assert.match(err.message, /Firefox still answers/);
      return true;
    }
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(h.current?.conn, hung);
});

test('a browser that misses the health check too is dropped, and the next call reconnects', async (t) => {
  const dead = new FakeConn({
    'browsingContext.getTree': tree('ctx-a'),
    'script.evaluate': () => new Promise(() => {}),
    'session.status': () => new Promise(() => {}),
  });
  const fresh = new FakeConn({ 'browsingContext.getTree': tree('ctx-b') });
  const log = stubBrowser(t, [dead, fresh]);
  const h = host(t, { callTimeout: 150, healthTimeout: 100 });
  // The health check is bounded by the connection's own timeout, which the
  // fake does not implement; give it a real one.
  const send = dead.send.bind(dead);
  dead.send = (method, params, opts) => (method === 'session.status'
    ? Promise.race([send(method, params, opts), sleep(opts.timeout).then(() => { throw new Error('timed out'); })])
    : send(method, params, opts));
  await h.session();

  await assert.rejects(
    within(3000, h.callTool('javascript_tool', { action: 'javascript_exec', tabId: 1, text: '1' }), 'javascript_tool'),
    /did not answer a health check either, so the connection was dropped/
  );
  assert.equal(dead.closed, true);
  assert.equal(dead.count('session.end'), 0, 'no polite session.end to a browser that is not answering');
  assert.equal(h.current, null);
  assert.equal((await h.session()).conn, fresh);
  assert.equal(log.open, 2);
});

test('a Firefox with no window is restarted and the call runs again', async (t) => {
  const windowless = new FakeConn({
    'browsingContext.getTree': tree(),
    'browsingContext.create': WINDOWLESS,
  });
  const relaunched = new FakeConn({ 'browsingContext.getTree': tree('ctx-new') });
  const log = stubBrowser(t, [windowless, relaunched]);
  const h = host(t);

  const out = await within(3000, h.callTool('tabs_context_mcp', { createIfEmpty: true }), 'tabs_context_mcp');
  const text = textOf(out);
  assert.match(text, /^Firefox was running without any window, so it was restarted first\./);
  assert.match(text, /Tab group: 1 tab\./);
  assert.equal(log.stop, 1);
  assert.equal(log.launch, 1);
  assert.equal(windowless.closed, true);
});

test('with auto-restart off, a windowless Firefox is a clear error', async (t) => {
  const windowless = new FakeConn({
    'browsingContext.getTree': tree(),
    'browsingContext.create': WINDOWLESS,
  });
  const log = stubBrowser(t, [windowless]);
  const h = host(t, { autoRestart: false });

  await assert.rejects(
    within(2000, h.callTool('tabs_create_mcp', {}), 'tabs_create_mcp'),
    (err) => {
      assert.equal(err.code, NO_WINDOW);
      assert.match(err.message, /running without any browser window/);
      assert.match(err.message, /firefox_restart/);
      return true;
    }
  );
  assert.equal(log.launch, 0);

  const status = textOf(await h.callTool('firefox_status', {}));
  assert.match(status, /windows: none - .*call firefox_restart/);
});

test('two calls that meet the same windowless browser restart it once', async (t) => {
  const windowless = new FakeConn({
    'browsingContext.getTree': tree(),
    'browsingContext.create': WINDOWLESS,
  });
  const relaunched = new FakeConn({
    'browsingContext.getTree': tree('ctx-new'),
    'browsingContext.create': () => ({ context: 'ctx-extra' }),
  });
  const log = stubBrowser(t, [windowless, relaunched]);
  const h = host(t);
  await h.session();

  const results = await within(3000, Promise.all([
    h.callTool('tabs_context_mcp', { createIfEmpty: true }),
    h.callTool('tabs_create_mcp', {}),
  ]), 'parallel calls');
  assert.equal(results.length, 2);
  assert.equal(log.launch, 1, 'one relaunch serves both calls');
});

test('a windowless retry happens once, then the error stands', async (t) => {
  const conn = () => new FakeConn({
    'browsingContext.getTree': tree(),
    'browsingContext.create': WINDOWLESS,
  });
  const log = stubBrowser(t, [conn, conn]);
  const h = host(t);

  await assert.rejects(
    within(3000, h.callTool('tabs_create_mcp', {}), 'tabs_create_mcp'),
    (err) => err.code === NO_WINDOW
  );
  assert.equal(log.launch, 1, 'no restart loop');
});

test('browser_batch items recover on their own, and the batch has no outer deadline', async (t) => {
  const windowless = new FakeConn({
    'browsingContext.getTree': tree(),
    'browsingContext.create': WINDOWLESS,
  });
  const relaunched = new FakeConn({ 'browsingContext.getTree': tree('ctx-new') });
  stubBrowser(t, [windowless, relaunched]);
  const h = host(t, { callTimeout: 2000 });

  const out = await within(3000, h.callTool('browser_batch', {
    actions: [{ name: 'tabs_context_mcp', input: { createIfEmpty: true } }],
  }), 'browser_batch');
  assert.equal(out.isError, undefined, textOf(out));
  assert.match(textOf(out), /restarted first/);
});

test('a call cut off by the browser going away says what happened and is not re-run', async (t) => {
  let evaluations = 0;
  const conn = new FakeConn({
    'browsingContext.getTree': tree('ctx-a'),
    'script.evaluate': () => {
      evaluations++;
      throw new Error('BiDi connection closed');
    },
  });
  stubBrowser(t, [conn]);
  const h = host(t);
  await h.session();
  await assert.rejects(
    h.callTool('javascript_tool', { action: 'javascript_exec', tabId: 1, text: '1' }),
    /Error: BiDi connection closed\. Firefox went away during this call .* the next call reconnects/
  );
  assert.equal(evaluations, 1, 'not retried - it may already have had an effect');
});
