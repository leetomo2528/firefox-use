'use strict';
// Drives a real headless Firefox. Opt in with FIREFOX_USE_IT=1 so the plain
// unit run never launches a browser.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FirefoxBrowser } = require('../src/browser');
const launcher = require('../src/launcher');

const enabled = process.env.FIREFOX_USE_IT === '1' && !!launcher.findFirefox();
const PAGE = `file://${path.join(__dirname, 'fixtures', 'page.html')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('browser control against a real page', { skip: enabled ? false : 'set FIREFOX_USE_IT=1' }, async (t) => {
  const browser = await FirefoxBrowser.open({ headless: true });
  t.after(() => browser.close());

  await t.test('navigates and normalizes the viewport', async () => {
    await browser.navigate(PAGE);
    const snap = await browser.snapshot();
    assert.equal(snap.url, PAGE);
    assert.deepEqual(snap.viewport, { width: 1280, height: 800 });
  });

  await t.test('snapshot refs survive a click and a type', async () => {
    const snap = await browser.snapshot();
    const field = snap.elements.find((e) => e.role.startsWith('input'));
    const button = snap.elements.find((e) => e.role === 'button');
    assert.ok(field && button, 'field and button are listed');
    await browser.type({ ref: field.ref, text: 'yunje', clear: true });
    await browser.click({ ref: button.ref });
    await sleep(200);
    const text = await browser.readText();
    assert.match(text.text, /HELLO YUNJE/);
  });

  await t.test('clicking by coordinate hits the same target', async () => {
    const snap = await browser.snapshot();
    const field = snap.elements.find((e) => e.role.startsWith('input'));
    await browser.click({ x: field.x, y: field.y });
    await browser.type({ text: 'coords', clear: true });
    const value = await browser.evaluate('document.getElementById("name").value');
    assert.equal(value, 'coords');
  });

  await t.test('captures png and jpeg screenshots', async () => {
    const png = Buffer.from((await browser.screenshot()).data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const jpeg = Buffer.from((await browser.screenshot({ format: 'jpeg' })).data, 'base64');
    assert.equal(jpeg[0], 0xff);
    const full = Buffer.from((await browser.screenshot({ fullPage: true })).data, 'base64');
    assert.ok(full.length > png.length / 2, 'full-page capture returns an image');
  });

  await t.test('wheel scrolling moves the document', async () => {
    await browser.evaluate('window.scrollTo(0, 0)');
    await browser.scroll({ deltaY: 600 });
    await sleep(400);
    assert.ok((await browser.evaluate('window.scrollY')) > 100);
  });

  await t.test('console messages are collected', async () => {
    assert.ok(browser.console.some((e) => (e.text || '').includes('page loaded ok')));
  });

  await t.test('tabs open, list and close', async () => {
    const before = (await browser.pageInfo()).tabs.length;
    const tab = await browser.newTab('about:blank');
    assert.equal((await browser.pageInfo()).tabs.length, before + 1);
    await browser.closeTab(tab);
    assert.equal((await browser.pageInfo()).tabs.length, before);
  });

  await t.test('a stale ref fails loudly', async () => {
    await browser.snapshot();
    browser.refs.set('e404', { selector: '#definitely-not-here', context: browser.context });
    await assert.rejects(() => browser.click({ ref: 'e404' }), /is gone from the page/);
  });
});

test('the session slot is released for the next client', { skip: enabled ? false : 'set FIREFOX_USE_IT=1' }, async () => {
  const first = await FirefoxBrowser.open({ headless: true });
  await first.close();
  const second = await FirefoxBrowser.open({ headless: true, autoRestart: false });
  assert.ok(second.context);
  await second.close();
});

test('the MCP server answers a full tool call over stdio', { skip: enabled ? false : 'set FIREFOX_USE_IT=1' }, async () => {
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
    const nav = await rpc('tools/call', { name: 'firefox_navigate', arguments: { url: PAGE } });
    assert.match(nav.result.content[0].text, /page\.html/);
    const shot = await rpc('tools/call', { name: 'firefox_screenshot', arguments: {} });
    const image = shot.result.content.find((c) => c.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.data.length > 1000);
  } finally {
    proc.stdin.end();
    await new Promise((resolve) => proc.on('exit', resolve));
  }
});
