'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FakeSession, fakeCtx } = require('./helpers/fake-session');
const observers = require('../src/observers');
const { attach, readConsoleMessages, readNetworkRequests, buffersFor, tools, BUFFER_LIMIT } = observers;
const spec = require('../docs/chrome-tool-spec.json');

const TABS = [
  { tabId: 1, context: 'ctx-1', url: 'https://example.com/' },
  { tabId: 2, context: 'ctx-2', url: 'https://other.test/' },
];

// Capture is lazy, so a session only listens once attach has run.
async function ready(tabs = TABS) {
  const session = new FakeSession({ tabs: tabs.map((t) => ({ ...t })) });
  await attach(session);
  return session;
}

function log(session, { context = 'ctx-1', level = 'info', text = 'hello', method, type = 'console', timestamp = 1700000000000, args, stackTrace } = {}) {
  session.emit('log.entryAdded', { type, level, method, text, args, stackTrace, timestamp, source: { realm: 'r1', context } });
}

function request(session, { context = 'ctx-1', id = 'req-1', method = 'GET', url = 'https://example.com/app.js', destination = 'script', initiatorType, timestamp = 1000, redirectCount = 0 } = {}) {
  session.emit('network.beforeRequestSent', {
    context, redirectCount, timestamp,
    request: { request: id, method, url, destination, initiatorType, headers: [] },
  });
}

function respond(session, { context = 'ctx-1', id = 'req-1', status = 200, statusText = 'OK', mimeType = 'text/javascript', bytesReceived = 2048, timestamp = 1150, url = 'https://example.com/app.js' } = {}) {
  session.emit('network.responseCompleted', {
    context, timestamp,
    request: { request: id, method: 'GET', url },
    response: { url, status, statusText, mimeType, bytesReceived, headers: [] },
  });
}

test('tool definitions match the Chrome spec verbatim', () => {
  const defs = tools(fakeCtx(new FakeSession()));
  assert.deepEqual(defs.map((d) => d.name), ['read_console_messages', 'read_network_requests']);
  for (const def of defs) {
    const target = spec.find((t) => t.name === def.name);
    assert.ok(target, `${def.name} missing from the spec`);
    assert.equal(def.description, target.description);
    assert.deepEqual(def.inputSchema, target.inputSchema);
    assert.equal(typeof def.handler, 'function');
  }
});

test('attach subscribes to the network events exactly once', async () => {
  const session = new FakeSession();
  await attach(session);
  await attach(session);
  await readConsoleMessages(session, { tabId: 1 });
  await readNetworkRequests(session, { tabId: 1 });
  const subs = session.callsOf('subscribe');
  assert.equal(subs.length, 1, 'attach must be idempotent');
  assert.deepEqual(subs[0].args.events, ['network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError']);
});

test('requests and responses are correlated by requestId', async () => {
  const session = await ready();
  request(session, { id: 'a', url: 'https://example.com/api/save', method: 'post', destination: 'empty', initiatorType: 'fetch', timestamp: 1000 });
  request(session, { id: 'b', url: 'https://example.com/logo.png', destination: 'image', timestamp: 1010 });
  respond(session, { id: 'b', url: 'https://example.com/logo.png', status: 200, mimeType: 'image/png', bytesReceived: 1536, timestamp: 1090 });
  respond(session, { id: 'a', url: 'https://example.com/api/save', status: 500, statusText: 'Internal Server Error', mimeType: 'application/json', bytesReceived: 40, timestamp: 1420 });

  const [saved, logo] = buffersFor(session, 1).network;
  assert.equal(saved.status, 500);
  assert.equal(saved.method, 'POST');
  assert.equal(saved.resourceType, 'fetch');
  assert.equal(saved.durationMs, 420);
  assert.equal(logo.resourceType, 'image');
  assert.equal(logo.bytes, 1536);
  assert.equal(logo.durationMs, 80);

  const out = await readNetworkRequests(session, { tabId: 1 });
  assert.match(out, /2 network requests from tab 1 \(2 captured\)/);
  assert.match(out, /POST\s+500\s+fetch\s+420ms\s+40 B https:\/\/example\.com\/api\/save\s+\[Internal Server Error\]/);
  assert.match(out, /GET\s+200\s+image\s+80ms\s+1\.5 KB https:\/\/example\.com\/logo\.png/);
});

test('a redirect keeps both hops and a fetch error settles its own request', async () => {
  const session = await ready();
  request(session, { id: 'r', url: 'https://example.com/old', destination: 'document', timestamp: 100 });
  respond(session, { id: 'r', url: 'https://example.com/old', status: 301, statusText: 'Moved', timestamp: 150 });
  request(session, { id: 'r', url: 'https://example.com/new', destination: 'document', timestamp: 160, redirectCount: 1 });
  respond(session, { id: 'r', url: 'https://example.com/new', status: 200, timestamp: 260 });
  request(session, { id: 'x', url: 'https://example.com/gone', destination: 'empty', initiatorType: 'xmlhttprequest', timestamp: 300 });
  session.emit('network.fetchError', { context: 'ctx-1', timestamp: 320, request: { request: 'x', method: 'GET', url: 'https://example.com/gone' }, errorText: 'NS_ERROR_NET_RESET' });

  const entries = buffersFor(session, 1).network;
  assert.equal(entries.length, 3, 'the redirect hop is its own row');
  assert.deepEqual(entries.map((e) => e.status), [301, 200, null]);
  assert.deepEqual(entries.map((e) => e.url), ['https://example.com/old', 'https://example.com/new', 'https://example.com/gone']);
  assert.equal(entries[2].error, 'NS_ERROR_NET_RESET');
  assert.equal(entries[2].resourceType, 'xhr');

  const out = await readNetworkRequests(session, { tabId: 1 });
  assert.match(out, /GET\s+-\s+xhr\s+20ms\s+- https:\/\/example\.com\/gone\s+\[NS_ERROR_NET_RESET\]/);
});

test('a request with no response yet reads as pending', async () => {
  const session = await ready();
  request(session, { id: 'p', url: 'https://example.com/slow' });
  const out = await readNetworkRequests(session, { tabId: 1 });
  assert.match(out, /https:\/\/example\.com\/slow\s+\[pending\]/);
});

test('buffers are per tab and events for foreign contexts are dropped', async () => {
  const session = await ready();
  log(session, { context: 'ctx-1', text: 'from tab one' });
  log(session, { context: 'ctx-2', text: 'from tab two' });
  log(session, { context: 'ctx-unknown', text: 'from another window' });
  request(session, { context: 'ctx-2', id: 'z', url: 'https://other.test/x.css', destination: 'style' });
  request(session, { context: 'ctx-unknown', id: 'q', url: 'https://elsewhere.test/y' });

  assert.equal(buffersFor(session, 1).console.length, 1);
  assert.equal(buffersFor(session, 2).console.length, 1);
  assert.equal(buffersFor(session, 1).network.length, 0);
  assert.equal(buffersFor(session, 2).network.length, 1);
  assert.equal(buffersFor(session, 2).network[0].resourceType, 'stylesheet');

  const one = await readConsoleMessages(session, { tabId: 1 });
  assert.match(one, /from tab one/);
  assert.doesNotMatch(one, /from tab two|another window/);
});

test('each buffer is a ring capped at 1000 entries', async () => {
  const session = await ready();
  for (let i = 0; i < BUFFER_LIMIT + 5; i++) {
    log(session, { text: `msg ${i}` });
    request(session, { id: `r${i}`, url: `https://example.com/${i}` });
  }
  const buf = buffersFor(session, 1);
  assert.equal(buf.console.length, BUFFER_LIMIT);
  assert.equal(buf.network.length, BUFFER_LIMIT);
  assert.equal(buf.console[0].text, 'msg 5', 'oldest entries are dropped first');
  assert.equal(buf.network[BUFFER_LIMIT - 1].url, `https://example.com/${BUFFER_LIMIT + 4}`);

  // The overflow is reported, not silently swallowed.
  assert.equal(buf.dropped.console, 5);
  const out = await readConsoleMessages(session, { tabId: 1, limit: 1 });
  assert.match(out, /5 older messages already dropped by the 1000-entry cap/);
  const net = await readNetworkRequests(session, { tabId: 1, limit: 1 });
  assert.match(net, /5 older requests already dropped by the 1000-entry cap/);
});

test('an anchored pattern matches the message text, a level pattern the level', async () => {
  const session = await ready();
  log(session, { level: 'info', method: 'log', text: 'MyApp booted' });
  log(session, { level: 'info', method: 'log', text: 'not MyApp at all' });
  log(session, { level: 'warn', method: 'warn', text: 'deprecated call' });

  const anchored = await readConsoleMessages(session, { tabId: 1, pattern: '^MyApp' });
  assert.match(anchored, /MyApp booted/);
  assert.doesNotMatch(anchored, /not MyApp at all|deprecated/);

  const warnings = await readConsoleMessages(session, { tabId: 1, pattern: '^warn$' });
  assert.match(warnings, /deprecated call/);
  assert.doesNotMatch(warnings, /MyApp booted/);
});

test('a response with no request of its own has an unknown duration', async () => {
  const session = await ready();
  respond(session, { id: 'mid', url: 'https://example.com/inflight.json', status: 200, mimeType: 'application/json', bytesReceived: 12, timestamp: 5000 });
  const [entry] = buffersFor(session, 1).network;
  assert.equal(entry.status, 200);
  assert.equal(entry.durationMs, null, 'attached mid-flight: 0ms would be a lie');
  assert.match(await readNetworkRequests(session, { tabId: 1 }), /200\s+\w+\s+-\s+12 B https:\/\/example\.com\/inflight\.json/);
});

// Both tool descriptions scope their log to the page's domain: the network one
// says requests are cleared on a cross-domain navigation, the console one says
// it returns "messages from the current domain only".
test('cross-domain navigation clears both logs, same-origin keeps them', async () => {
  const session = await ready();
  session.emit('browsingContext.navigationStarted', { context: 'ctx-1', url: 'https://example.com/', timestamp: 1 });
  request(session, { id: 'n1', url: 'https://example.com/a.js' });
  log(session, { text: 'before navigation' });

  session.emit('browsingContext.navigationStarted', { context: 'ctx-1', url: 'https://example.com/deeper/page', timestamp: 2 });
  assert.equal(buffersFor(session, 1).network.length, 1, 'same origin keeps the log');
  assert.equal(buffersFor(session, 1).console.length, 1, 'same origin keeps the messages');

  session.emit('browsingContext.navigationStarted', { context: 'ctx-1', url: 'https://elsewhere.test/landing', timestamp: 3 });
  assert.equal(buffersFor(session, 1).network.length, 0, 'a different domain clears the log');
  assert.equal(buffersFor(session, 1).console.length, 0, 'a different domain clears the messages too');

  session.emit('browsingContext.navigationStarted', { context: 'ctx-2', url: 'https://other.test/', timestamp: 4 });
  request(session, { context: 'ctx-2', id: 'n2', url: 'https://other.test/a.js' });
  session.emit('browsingContext.navigationStarted', { context: 'ctx-1', url: 'https://example.com/back', timestamp: 5 });
  assert.equal(buffersFor(session, 2).network.length, 1, 'one tab navigating never clears another');
});

test('console entries keep level, text, args, timestamp and stack frames', async () => {
  const session = await ready();
  log(session, {
    type: 'javascript', level: 'error', text: 'Uncaught TypeError: x is not a function', timestamp: 1700000000123,
    stackTrace: { callFrames: [{ functionName: 'boom', url: 'https://example.com/app.js', lineNumber: 12, columnNumber: 5 }] },
  });
  log(session, {
    level: 'info', method: 'log', text: '', timestamp: 1700000000456,
    args: [{ type: 'string', value: 'count' }, { type: 'number', value: 7 }],
  });

  const [crash, counted] = buffersFor(session, 1).console;
  assert.equal(crash.level, 'exception');
  assert.equal(crash.stackTrace[0].functionName, 'boom');
  assert.equal(counted.level, 'log');
  assert.deepEqual(counted.args, ['count', 7]);
  assert.equal(counted.text, 'count 7', 'text falls back to the stringified args');

  const out = await readConsoleMessages(session, { tabId: 1 });
  assert.match(out, /2 console messages from tab 1 \(2 captured\)/);
  assert.match(out, /2023-11-14T22:13:20\.123Z \[exception\] Uncaught TypeError/);
  assert.match(out, /\n {4}at boom \(https:\/\/example\.com\/app\.js:12:5\)/);
  assert.match(out, /2023-11-14T22:13:20\.456Z \[log\] count 7/);
});

test('pattern filters on level and text, and reports how many were filtered out', async () => {
  const session = await ready();
  log(session, { level: 'info', method: 'log', text: 'MyApp booted' });
  log(session, { level: 'warn', method: 'warn', text: 'deprecated call' });
  log(session, { level: 'error', method: 'error', text: 'MyApp exploded' });

  const app = await readConsoleMessages(session, { tabId: 1, pattern: 'myapp' });
  assert.match(app, /2 console messages from tab 1 \(3 captured; 1 message filtered out by pattern \/myapp\/i\)/);
  assert.doesNotMatch(app, /deprecated/);

  const both = await readConsoleMessages(session, { tabId: 1, pattern: 'error|warn' });
  assert.match(both, /deprecated call/);
  assert.match(both, /MyApp exploded/);
  assert.doesNotMatch(both, /booted/);
});

test('onlyErrors keeps error and exception levels', async () => {
  const session = await ready();
  log(session, { level: 'info', method: 'log', text: 'chatter' });
  log(session, { level: 'warn', method: 'warn', text: 'careful' });
  log(session, { level: 'error', method: 'error', text: 'broke' });
  log(session, { type: 'javascript', level: 'error', text: 'threw' });

  const out = await readConsoleMessages(session, { tabId: 1, onlyErrors: true });
  assert.match(out, /2 console messages from tab 1 \(4 captured; 2 messages filtered out by onlyErrors\)/);
  assert.match(out, /\[error\] broke/);
  assert.match(out, /\[exception\] threw/);
  assert.doesNotMatch(out, /chatter|careful/);
});

test('limit keeps the most recent entries and defaults to 100', async () => {
  const session = await ready();
  for (let i = 1; i <= 120; i++) log(session, { text: `line ${i}` });

  const capped = await readConsoleMessages(session, { tabId: 1, limit: 2 });
  const lines = capped.split('\n');
  assert.match(lines[0], /2 console messages from tab 1 \(120 captured; 118 older matches hidden by limit 2\)/);
  assert.match(lines[1], /line 119$/);
  assert.match(lines[2], /line 120$/);

  const dflt = await readConsoleMessages(session, { tabId: 1 });
  assert.equal(dflt.split('\n').length, 101);
  assert.match(dflt, /line 21\b/);
  assert.doesNotMatch(dflt, /line 20\b/);

  const bogus = await readConsoleMessages(session, { tabId: 1, limit: 0 });
  assert.equal(bogus.split('\n').length, 101, 'a non-positive limit falls back to the default');
});

test('clear empties the whole buffer, not just what matched', async () => {
  const session = await ready();
  log(session, { level: 'info', method: 'log', text: 'keep me?' });
  log(session, { level: 'error', method: 'error', text: 'boom' });
  request(session, { id: 'c1', url: 'https://example.com/a' });

  const out = await readConsoleMessages(session, { tabId: 1, onlyErrors: true, clear: true });
  assert.match(out, /buffer cleared, 2 messages dropped/);
  assert.match(out, /boom/);
  assert.equal(buffersFor(session, 1).console.length, 0);
  assert.equal(buffersFor(session, 1).network.length, 1, 'clearing the console leaves the network log alone');

  const again = await readConsoleMessages(session, { tabId: 1 });
  assert.match(again, /No console messages captured for tab 1\./);

  const net = await readNetworkRequests(session, { tabId: 1, clear: true });
  assert.match(net, /buffer cleared, 1 request dropped/);
  assert.equal(buffersFor(session, 1).network.length, 0);
});

test('a failed network subscribe does not take console reads down with it', async () => {
  const session = new FakeSession({ tabs: TABS.map((t) => ({ ...t })) });
  session.subscribe = async () => { throw new Error('network events unsupported'); };
  await assert.rejects(() => attach(session), /network events unsupported/);
  log(session, { level: 'error', method: 'error', text: 'still captured' });

  const out = await readConsoleMessages(session, { tabId: 1 });
  assert.match(out, /\[error\] still captured/, 'console events come from the base subscription');
  await assert.rejects(() => readNetworkRequests(session, { tabId: 1 }), /network events unsupported/);
});

test('an invalid regex is a clear error, not a crash', async () => {
  const session = await ready();
  log(session, { text: 'anything' });
  await assert.rejects(
    () => readConsoleMessages(session, { tabId: 1, pattern: '([a-z' }),
    /Invalid regex pattern "\(\[a-z":/,
  );
  const ok = await readConsoleMessages(session, { tabId: 1, pattern: '' });
  assert.match(ok, /anything/, 'an empty pattern means no filter');
});

test('empty and no-match states say so plainly', async () => {
  const session = await ready();
  const emptyConsole = await readConsoleMessages(session, { tabId: 1 });
  assert.match(emptyConsole, /^No console messages captured for tab 1\./);
  assert.match(emptyConsole, /Capture begins the first time this tool runs/);

  const emptyNet = await readNetworkRequests(session, { tabId: 2 });
  assert.match(emptyNet, /^No network requests captured for tab 2\./);
  assert.match(emptyNet, /cleared when the tab navigates to a different domain/);

  log(session, { level: 'info', method: 'log', text: 'nothing to see' });
  request(session, { id: 'm', url: 'https://example.com/app.js' });
  const noMatch = await readConsoleMessages(session, { tabId: 1, pattern: 'zzz', onlyErrors: true });
  assert.match(noMatch, /No console messages in tab 1 matched pattern \/zzz\/i \+ onlyErrors \(1 message filtered out of 1 captured\)/);
  const noUrl = await readNetworkRequests(session, { tabId: 1, urlPattern: '/api/' });
  assert.match(noUrl, /No network requests in tab 1 matched url pattern "\/api\/" \(1 request filtered out of 1 captured\)/);
});

test('urlPattern is a substring filter, not a regex', async () => {
  const session = await ready();
  request(session, { id: '1', url: 'https://example.com/api/users?q=1', destination: 'empty', initiatorType: 'fetch' });
  request(session, { id: '2', url: 'https://cdn.example.com/API/assets.js' });
  request(session, { id: '3', url: 'https://example.com/index.html', destination: 'document' });

  const api = await readNetworkRequests(session, { tabId: 1, urlPattern: '/api/' });
  assert.match(api, /2 network requests from tab 1 \(3 captured; 1 request filtered out by url pattern "\/api\/"\)/);
  assert.match(api, /assets\.js/, 'matching ignores case');
  assert.doesNotMatch(api, /index\.html/);

  const literal = await readNetworkRequests(session, { tabId: 1, urlPattern: '.*' });
  assert.match(literal, /No network requests in tab 1 matched url pattern "\.\*"/, 'the pattern is compared literally');
});

test('a bad or missing tabId fails with the Chrome wording', async () => {
  const session = await ready();
  await assert.rejects(() => readConsoleMessages(session, { tabId: 99 }), /Tab 99 no longer exists\. Call tabs_context_mcp to get valid tab ids\./);
  await assert.rejects(() => readNetworkRequests(session, { tabId: 99 }), /Tab 99 no longer exists\./);
  await assert.rejects(() => readConsoleMessages(session, {}), /tabId is required/);
  await assert.rejects(() => readNetworkRequests(session, {}), /tabId is required/);
});

test('the handlers attach lazily through ctx and read the same buffers', async () => {
  const session = new FakeSession({ tabs: TABS.map((t) => ({ ...t })) });
  const [consoleTool, networkTool] = tools(fakeCtx(session));

  const first = await consoleTool.handler({ tabId: 1 });
  assert.match(first, /No console messages captured for tab 1\./);
  assert.equal(session.callsOf('subscribe').length, 1, 'the first handler call attaches');

  log(session, { level: 'error', method: 'error', text: 'late but captured' });
  request(session, { id: 'h', url: 'https://example.com/late.js' });
  respond(session, { id: 'h', url: 'https://example.com/late.js', bytesReceived: 3 * 1024 * 1024, timestamp: 3000 });

  assert.match(await consoleTool.handler({ tabId: 1 }), /\[error\] late but captured/);
  assert.match(await networkTool.handler({ tabId: 1 }), /GET\s+200\s+script\s+2\.0s\s+3\.0 MB https:\/\/example\.com\/late\.js/);
  assert.equal(session.callsOf('subscribe').length, 1);
});

test('iframe logs and requests land in the containing tab, foreign frames do not', async () => {
  const session = await ready();
  session.emit('browsingContext.contextCreated', { context: 'frame-a', parent: 'ctx-1', url: 'https://widget.test/' });
  session.emit('browsingContext.contextCreated', { context: 'frame-a-inner', parent: 'frame-a', url: 'https://widget.test/deep' });
  session.emit('browsingContext.contextCreated', { context: 'frame-orphan', parent: 'ctx-gone', url: 'https://elsewhere.test/' });

  log(session, { context: 'frame-a-inner', level: 'error', method: 'error', text: 'widget blew up' });
  request(session, { context: 'frame-a', id: 'f1', url: 'https://widget.test/w.js' });
  log(session, { context: 'frame-orphan', text: 'not ours' });
  request(session, { context: 'frame-orphan', id: 'f2', url: 'https://elsewhere.test/w.js' });

  assert.equal(buffersFor(session, 1).console.length, 1);
  assert.equal(buffersFor(session, 1).network.length, 1);
  assert.match(await readConsoleMessages(session, { tabId: 1 }), /widget blew up/);

  // A cross-origin iframe navigating must not wipe the tab's network log.
  session.emit('browsingContext.navigationStarted', { context: 'ctx-1', url: 'https://example.com/', timestamp: 1 });
  session.emit('browsingContext.navigationStarted', { context: 'frame-a', url: 'https://widget.test/next', timestamp: 2 });
  assert.equal(buffersFor(session, 1).network.length, 1);

  session.emit('browsingContext.contextDestroyed', { context: 'frame-a' });
  request(session, { context: 'frame-a', id: 'f3', url: 'https://widget.test/late.js' });
  assert.equal(buffersFor(session, 1).network.length, 1, 'a destroyed frame stops resolving to the tab');
});

test('the network table header lines up with its rows', async () => {
  const session = await ready();
  request(session, { id: 'h1', url: 'https://example.com/', destination: 'document' });
  respond(session, { id: 'h1', url: 'https://example.com/', mimeType: 'text/html', bytesReceived: 18234, timestamp: 1320 });
  const [, header, row] = (await readNetworkRequests(session, { tabId: 1 })).split('\n');
  assert.equal(header.indexOf('url'), row.indexOf('https://example.com/'), 'url column starts in the same place');
  assert.equal(header.indexOf('type'), row.indexOf('document'));
  assert.equal(header.indexOf('status') + 'status'.length, row.indexOf('200') + 3);
});

test('closing a tab releases its buffers', async () => {
  const session = await ready();
  log(session, { context: 'ctx-1', text: 'tab one' });
  log(session, { context: 'ctx-2', text: 'tab two' });
  request(session, { context: 'ctx-2', id: 'd1', url: 'https://other.test/a' });

  session.emit('browsingContext.contextDestroyed', { context: 'ctx-2' });
  assert.equal(buffersFor(session, 2).console.length, 0);
  assert.equal(buffersFor(session, 2).network.length, 0);
  assert.equal(buffersFor(session, 1).console.length, 1, 'the surviving tab keeps its messages');
});
