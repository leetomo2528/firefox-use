'use strict';
// End-to-end run of the parity surface against a real headless Firefox.
// Opt in with FIREFOX_USE_IT=1 - Firefox allows one BiDi session at a time, so
// this suite must never run alongside another live test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const launcher = require('../src/launcher');

const enabled = process.env.FIREFOX_USE_IT === '1' && !!launcher.findFirefox();
const skip = enabled ? false : 'set FIREFOX_USE_IT=1';
const FIXTURES = path.join(__dirname, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serveFixtures() {
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'parity.html';
    const file = path.join(FIXTURES, path.basename(name));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('nope');
      return;
    }
    const type = file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const textOf = (result) => (result?.content || [])
  .filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const imagesOf = (result) => (result?.content || []).filter((c) => c.type === 'image');
const asText = (result) => (typeof result === 'string' ? result : textOf(result));

test('the parity surface drives a real page', { skip }, async (t) => {
  const { ToolHost } = require('../src/tools');
  const { server, port } = await serveFixtures();
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-it-'));
  const host = new ToolHost({ headless: true, downloadDir });
  const call = (name, input) => host.callTool(name, input);
  const base = `http://127.0.0.1:${port}`;
  let tabId;
  let inputRef;
  let buttonRef;

  t.after(async () => {
    await host.close();
    server.close();
    fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  await t.test('tabs_context_mcp reports the group, tabs_create_mcp adds to it', async () => {
    const context = asText(await call('tabs_context_mcp', { createIfEmpty: true }));
    assert.match(context, /\d/, 'lists at least one tab id');
    const created = asText(await call('tabs_create_mcp', {}));
    const id = Number((created.match(/\b(\d+)\b/) || [])[1]);
    assert.ok(Number.isInteger(id), `tabs_create_mcp should report a numeric tab id, got: ${created}`);
    tabId = id;
  });

  await t.test('navigate loads the fixture', async () => {
    const out = asText(await call('navigate', { url: `${base}/parity.html`, tabId }));
    assert.match(out, /parity\.html/);
  });

  await t.test('read_page hands out refs for the interactive elements', async () => {
    const tree = asText(await call('read_page', { tabId, filter: 'interactive' }));
    assert.match(tree, /ref_\d+/);
    const inputLine = tree.split('\n').find((l) => /ref_\d+/.test(l) && /your name/i.test(l));
    const buttonLine = tree.split('\n').find((l) => /ref_\d+/.test(l) && /greet/i.test(l));
    assert.ok(inputLine, `no input line in:\n${tree.slice(0, 800)}`);
    assert.ok(buttonLine, `no button line in:\n${tree.slice(0, 800)}`);
    inputRef = inputLine.match(/ref_\d+/)[0];
    buttonRef = buttonLine.match(/ref_\d+/)[0];
  });

  await t.test('find locates an element by purpose', async () => {
    const out = asText(await call('find', { query: 'greet button', tabId }));
    assert.match(out, /ref_\d+/);
    assert.match(out, /greet/i);
  });

  await t.test('form_input then computer click updates the page', async () => {
    await call('form_input', { ref: inputRef, value: 'yunje', tabId });
    await call('computer', { action: 'left_click', ref: buttonRef, tabId });
    await sleep(300);
    const text = asText(await call('get_page_text', { tabId }));
    assert.match(text, /HELLO YUNJE/);
  });

  await t.test('form_input handles selects and checkboxes', async () => {
    await call('form_input', { ref: inputRef, value: 'second', tabId });
    const tree = asText(await call('read_page', { tabId, filter: 'interactive' }));
    const selectRef = (tree.split('\n').find((l) => /combobox|select/i.test(l)) || '').match(/ref_\d+/);
    const checkRef = (tree.split('\n').find((l) => /checkbox|agree/i.test(l)) || '').match(/ref_\d+/);
    if (selectRef) {
      await call('form_input', { ref: selectRef[0], value: 'Cherry', tabId });
      const value = asText(await call('javascript_tool', { action: 'javascript_exec', text: 'document.getElementById("fruit").value', tabId }));
      assert.match(value, /c/);
    }
    if (checkRef) {
      await call('form_input', { ref: checkRef[0], value: true, tabId });
      const checked = asText(await call('javascript_tool', { action: 'javascript_exec', text: 'document.getElementById("agree").checked', tabId }));
      assert.match(checked, /true/);
    }
  });

  await t.test('computer screenshots, zooms and scrolls', async () => {
    const shot = await call('computer', { action: 'screenshot', tabId });
    const [image] = imagesOf(shot);
    assert.ok(image && image.data.length > 1000, 'screenshot returns image content');
    assert.equal(image.mimeType, 'image/png');

    const zoom = await call('computer', { action: 'zoom', region: [0, 0, 300, 200], tabId });
    assert.ok(imagesOf(zoom).length === 1, 'zoom returns one image');

    await call('computer', { action: 'scroll', coordinate: [640, 400], scroll_direction: 'down', scroll_amount: 5, tabId });
    await sleep(400);
    const y = asText(await call('javascript_tool', { action: 'javascript_exec', text: 'Math.round(window.scrollY)', tabId }));
    assert.ok(Number(y.match(/\d+/)?.[0]) > 100, `page scrolled, scrollY=${y}`);
  });

  await t.test('computer types and presses keys', async () => {
    await call('computer', { action: 'left_click', ref: inputRef, tabId });
    await call('computer', { action: 'key', text: `${process.platform === 'darwin' ? 'cmd' : 'ctrl'}+a`, tabId });
    await call('computer', { action: 'type', text: 'typed-by-computer', tabId });
    const value = asText(await call('javascript_tool', { action: 'javascript_exec', text: 'document.getElementById("name").value', tabId }));
    assert.match(value, /typed-by-computer/);
  });

  await t.test('read_console_messages filters by pattern', async () => {
    const out = asText(await call('read_console_messages', { tabId, pattern: 'fixture' }));
    assert.match(out, /page loaded ok/);
    const errorsOnly = asText(await call('read_console_messages', { tabId, pattern: 'fixture', onlyErrors: true }));
    assert.ok(!/page loaded ok/.test(errorsOnly), 'onlyErrors drops the info line');
  });

  await t.test('read_network_requests sees the page traffic', async () => {
    await call('navigate', { url: `${base}/parity.html`, tabId });
    await sleep(800);
    const out = asText(await call('read_network_requests', { tabId, urlPattern: 'ping.json' }));
    assert.match(out, /ping\.json/);
  });

  await t.test('browser_batch runs several tools in one call', async () => {
    const result = await call('browser_batch', {
      actions: [
        { name: 'navigate', input: { url: `${base}/parity.html`, tabId } },
        { name: 'computer', input: { action: 'screenshot', tabId } },
      ],
    });
    assert.ok(imagesOf(result).length >= 1, 'images come back interleaved');
    assert.match(textOf(result), /parity\.html/);
  });

  await t.test('browser_batch stops at the first failure', async () => {
    const result = await call('browser_batch', {
      actions: [
        { name: 'computer', input: { action: 'left_click', ref: 'ref_99999', tabId } },
        { name: 'computer', input: { action: 'screenshot', tabId } },
      ],
    }).catch((err) => ({ content: [{ type: 'text', text: err.message }], isError: true }));
    const out = asText(result);
    assert.match(out, /ref_99999|not found|failed/i);
    assert.equal(imagesOf(result).length, 0, 'the second item never ran');
  });

  await t.test('a batch demands an explicit tabId, as Chrome does', async () => {
    const result = await call('browser_batch', {
      actions: [{ name: 'navigate', input: { url: `${base}/parity.html` } }],
    }).catch((err) => ({ content: [{ type: 'text', text: err.message }], isError: true }));
    assert.match(asText(result), /tabId/i, 'the batch says an explicit tabId is required');
  });

  await t.test('file_upload attaches a real file', async () => {
    const tree = asText(await call('read_page', { tabId, filter: 'interactive' }));
    const fileLine = tree.split('\n').find((l) => /file/i.test(l) && /ref_\d+/.test(l));
    assert.ok(fileLine, 'the file input is in the tree');
    const fileRef = fileLine.match(/ref_\d+/)[0];
    const tmp = path.join(downloadDir, 'upload-me.txt');
    fs.writeFileSync(tmp, 'hello upload');
    await call('file_upload', { paths: [tmp], ref: fileRef, tabId });
    await sleep(200);
    const count = asText(await call('javascript_tool', { action: 'javascript_exec', text: 'document.getElementById("upload").files.length', tabId }));
    assert.match(count, /1/);
  });

  await t.test('gif_creator records and exports a real GIF', async () => {
    await call('gif_creator', { action: 'start_recording', tabId });
    await call('computer', { action: 'screenshot', tabId });
    await call('computer', { action: 'scroll', coordinate: [640, 400], scroll_direction: 'down', scroll_amount: 3, tabId });
    await sleep(1500);
    await call('gif_creator', { action: 'stop_recording', tabId });
    const out = asText(await call('gif_creator', { action: 'export', tabId, download: true, filename: 'parity-run.gif' }));
    const file = (out.match(/\S+\.gif/) || [])[0];
    assert.ok(file && fs.existsSync(file), `export should report a written file, got: ${out}`);
    const head = fs.readFileSync(file).subarray(0, 6).toString('latin1');
    assert.equal(head, 'GIF89a');
    await call('gif_creator', { action: 'clear', tabId });
  });

  await t.test('resize_window changes the viewport', async () => {
    await call('resize_window', { width: 900, height: 700, tabId });
    await sleep(300);
    const width = asText(await call('javascript_tool', { action: 'javascript_exec', text: 'window.innerWidth', tabId }));
    assert.ok(Number(width.match(/\d+/)?.[0]) <= 950, `viewport narrowed: ${width}`);
  });

  await t.test('navigate back and forward', async () => {
    await call('navigate', { url: `${base}/ping.json`, tabId });
    await sleep(300);
    await call('navigate', { url: 'back', tabId });
    await sleep(500);
    const out = asText(await call('tabs_context_mcp', {}));
    assert.match(out, /parity\.html/);
  });

  await t.test('tabs_close_mcp removes the tab from the group', async () => {
    await call('tabs_close_mcp', { tabId });
    const out = asText(await call('tabs_context_mcp', {}));
    assert.ok(!new RegExp(`\\[${tabId}\\]`).test(out), 'closed tab is gone');
  });
});

// The 2026-10 hang: Firefox outlived its last window, every tab request failed
// inside Firefox, and firefox_restart then waited on itself forever. Each step
// here must come back with an answer, never a hang.
test('a closed window, a killed browser and a restart never wedge the server', { skip, timeout: 300000 }, async (t) => {
  const { ToolHost } = require('../src/tools');
  const { server, port } = await serveFixtures();
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-it-'));
  // The pref lets page script close the last window, the way a person would.
  await launcher.stop();
  const host = new ToolHost({ headless: true, downloadDir, prefs: { 'dom.allow_scripts_to_close_windows': true } });
  const call = (name, input) => host.callTool(name, input);
  const firstTab = (text) => Number((text.match(/\[(\d+)\]/) || [])[1]);

  t.after(async () => {
    await host.close();
    await launcher.stop();
    server.close();
    fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  await t.test('closing the browser\'s last tab blanks it, and the next tab reuses it', async () => {
    const tabId = firstTab(asText(await call('tabs_context_mcp', { createIfEmpty: true })));
    await call('navigate', { tabId, url: `http://127.0.0.1:${port}/parity.html` });
    const session = await host.session();
    assert.equal((await session.topLevelContexts()).length, 1, 'starts with the one tab Firefox opened');

    const closed = asText(await call('tabs_close_mcp', { tabId }));
    assert.match(closed, /blanked to about:blank/);
    const left = await session.topLevelContexts();
    assert.equal(left.length, 1);
    assert.equal(left[0].url, 'about:blank', 'the page is no longer running');

    const again = asText(await call('tabs_context_mcp', { createIfEmpty: true }));
    assert.match(again, /about:blank/);
    assert.equal((await session.topLevelContexts()).length, 1, 'reused, not a second tab');
  });

  await t.test('a window closed from outside does not break the next tab request', async () => {
    const tabId = firstTab(asText(await call('tabs_context_mcp', { createIfEmpty: true })));
    await call('javascript_tool', { action: 'javascript_exec', tabId, text: 'setTimeout(() => window.close(), 50); "closing"' });
    await sleep(1500);
    // macOS keeps Firefox running with no window (the TypeError case); Linux
    // may quit it instead. Either way the call has to end with a usable tab.
    const out = asText(await call('tabs_context_mcp', { createIfEmpty: true }));
    assert.ok(Number.isInteger(firstTab(out)), out);
    assert.match(asText(await call('navigate', { tabId: firstTab(out), url: `http://127.0.0.1:${port}/parity.html` })), /parity\.html/);
  });

  await t.test('a browser that quits on its own is relaunched by the next call', async () => {
    // A quitting Firefox sends its close frame and may keep the socket open a
    // while; the connection has to count as gone from the close frame on.
    const session = await host.session();
    await session.send('browser.close', {}, { timeout: 10000 }).catch(() => {});
    // No pause: the next call may meet Firefox mid-quit - its close frame
    // still on the way, or its port refusing the WebSocket upgrade. One fast,
    // explained failure is allowed; the call after it has to work.
    const started = Date.now();
    let out;
    try {
      out = asText(await call('tabs_context_mcp', { createIfEmpty: true }));
    } catch (err) {
      assert.match(err.message, /Firefox went away during this call/);
      assert.ok(Date.now() - started < 15000, 'failed fast');
      out = asText(await call('tabs_context_mcp', { createIfEmpty: true }));
    }
    assert.ok(Number.isInteger(firstTab(out)), out);
  });

  await t.test('a browser killed mid-session is relaunched by the next call', async () => {
    assert.equal(await launcher.stop({ force: true }), true);
    const out = asText(await call('tabs_context_mcp', { createIfEmpty: true }));
    assert.ok(Number.isInteger(firstTab(out)), out);
  });

  await t.test('firefox_restart finishes and the server keeps answering', async () => {
    assert.match(asText(await call('firefox_restart', {})), /Firefox restarted/);
    assert.match(asText(await call('firefox_status', {})), /firefox: running/);
    const out = asText(await call('tabs_context_mcp', { createIfEmpty: true }));
    assert.ok(Number.isInteger(firstTab(out)), out);
  });
});

test('the MCP server exposes the parity surface over stdio', { skip }, async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'firefox-use'), 'mcp'], {
    env: { ...process.env, FIREFOX_USE_HEADLESS: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  const waiters = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && waiters.length) waiters.shift()(JSON.parse(line));
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    waiters.push(resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
  });

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'firefox-use');
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const expected of ['computer', 'read_page', 'find', 'navigate', 'tabs_context_mcp', 'browser_batch', 'gif_creator']) {
      assert.ok(names.includes(expected), `${expected} is exposed`);
    }
    const nav = await rpc('tools/call', { name: 'tabs_context_mcp', arguments: { createIfEmpty: true } });
    assert.ok(!nav.result.isError, JSON.stringify(nav.result).slice(0, 200));
  } finally {
    proc.stdin.end();
    await new Promise((resolve) => proc.on('exit', resolve));
  }
});
