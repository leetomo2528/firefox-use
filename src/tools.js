'use strict';
// MCP tool surface: what the model can do to Firefox.

const { FirefoxBrowser } = require('./browser');
const launcher = require('./launcher');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One browser connection per server process, opened on first use so that
// starting the MCP server never launches Firefox on its own.
class BrowserHandle {
  constructor(opts = {}) {
    this.opts = opts;
    this.browser = null;
    this._opening = null;
  }

  async get() {
    if (this.browser && !this.browser.conn.closed) return this.browser;
    if (!this._opening) {
      this._opening = FirefoxBrowser.open(this.opts)
        .then((b) => {
          this.browser = b;
          b.conn.on('close', () => { if (this.browser === b) this.browser = null; });
          return b;
        })
        .finally(() => { this._opening = null; });
    }
    return this._opening;
  }

  async close() {
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await b.close();
    }
  }

  async restart() {
    await this.close();
    await launcher.stop();
    await sleep(1000);
    await launcher.launch(this.opts);
    return this.get();
  }
}

function formatSnapshot(data) {
  const lines = [
    `${data.title || '(untitled)'} - ${data.url}`,
    `viewport ${data.viewport.width}x${data.viewport.height} | scroll ${data.scroll.x},${data.scroll.y} of ${data.documentHeight}px${data.truncated ? ' | list truncated' : ''}`,
    '',
  ];
  if (!data.elements.length) lines.push('(no interactive elements in view)');
  for (const el of data.elements) {
    const bits = [`[${el.ref}]`, el.role];
    if (el.name) bits.push(JSON.stringify(el.name));
    if (el.value) bits.push(`value=${JSON.stringify(el.value)}`);
    if (el.checked) bits.push('checked');
    if (el.disabled) bits.push('disabled');
    bits.push(`@(${el.x},${el.y}) ${el.w}x${el.h}`);
    if (el.href) bits.push(`-> ${el.href}`);
    lines.push(bits.join(' '));
  }
  return lines.join('\n');
}

async function where(browser) {
  const info = await browser.pageInfo();
  return `url: ${info.url}`;
}

function buildTools(handle) {
  const use = () => handle.get();

  return [
    {
      name: 'firefox_navigate',
      description:
        'Open a URL in the current Firefox tab and wait for it to load. Firefox launches automatically on first use.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open; a bare host gets https://' },
          wait: { type: 'string', enum: ['none', 'interactive', 'complete'], description: 'How long to wait (default complete)' },
        },
        required: ['url'],
      },
      handler: async ({ url, wait }) => {
        const b = await use();
        const res = await b.navigate(url, wait || 'complete');
        return `Loaded ${res.url}`;
      },
    },
    {
      name: 'firefox_snapshot',
      description:
        'List the interactive elements currently in view with refs (e1, e2, ...) and viewport coordinates. Take this before clicking or typing; refs go stale after the page changes.',
      inputSchema: {
        type: 'object',
        properties: {
          max: { type: 'integer', description: 'Maximum elements to list (default 200)' },
          include_offscreen: { type: 'boolean', description: 'Also list elements outside the viewport' },
        },
      },
      handler: async ({ max, include_offscreen }) => {
        const b = await use();
        const data = await b.snapshot({ max: max || 200, includeOffscreen: !!include_offscreen });
        return formatSnapshot(data);
      },
    },
    {
      name: 'firefox_screenshot',
      description: 'Capture the current page as an image. Use it to see layout, rendering or anything the snapshot cannot describe.',
      inputSchema: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture the whole document instead of the viewport' },
          format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png)' },
        },
      },
      handler: async ({ full_page, format }) => {
        const b = await use();
        const shot = await b.screenshot({ fullPage: !!full_page, format: format || 'png' });
        const info = await b.pageInfo();
        return {
          content: [
            { type: 'image', data: shot.data, mimeType: shot.mimeType },
            { type: 'text', text: `${info.url} (${full_page ? 'full page' : `viewport ${b.viewport.width}x${b.viewport.height}`})` },
          ],
        };
      },
    },
    {
      name: 'firefox_click',
      description: 'Click in the page, either on a snapshot ref or at viewport coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from firefox_snapshot, e.g. "e3"' },
          x: { type: 'number', description: 'Viewport x, when no ref is given' },
          y: { type: 'number', description: 'Viewport y, when no ref is given' },
          button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button (default left)' },
          clicks: { type: 'integer', description: '1 for a single click, 2 for a double click' },
        },
      },
      handler: async ({ ref, x, y, button, clicks }) => {
        const b = await use();
        const point = await b.click({ ref, x, y, button: button || 'left', clicks: clicks || 1 });
        await sleep(150);
        return `Clicked ${ref ? `${ref} ` : ''}at (${point.x},${point.y})\n${await where(b)}`;
      },
    },
    {
      name: 'firefox_type',
      description: 'Type text, optionally clicking a field first, clearing it, and pressing Enter afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type ("\\n" presses Enter)' },
          ref: { type: 'string', description: 'Field to focus first (snapshot ref)' },
          x: { type: 'number', description: 'Viewport x to click first, when no ref is given' },
          y: { type: 'number', description: 'Viewport y to click first, when no ref is given' },
          clear: { type: 'boolean', description: 'Select all and delete before typing' },
          submit: { type: 'boolean', description: 'Press Enter after typing' },
        },
        required: ['text'],
      },
      handler: async ({ text, ref, x, y, clear, submit }) => {
        const b = await use();
        const res = await b.type({ text, ref, x, y, clear: !!clear, submit: !!submit });
        await sleep(150);
        return `Typed ${res.typed} chars${res.cleared ? ' (field cleared)' : ''}${res.submitted ? ' and pressed Enter' : ''}\n${await where(b)}`;
      },
    },
    {
      name: 'firefox_press_key',
      description: 'Press a key or a combination, e.g. "Enter", "Escape", "Tab", "cmd+a", "ctrl+shift+r".',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key or combo' } },
        required: ['key'],
      },
      handler: async ({ key }) => {
        const b = await use();
        await b.pressKey(key);
        await sleep(150);
        return `Pressed ${key}\n${await where(b)}`;
      },
    },
    {
      name: 'firefox_scroll',
      description: 'Scroll the page with the mouse wheel. Positive delta_y scrolls down.',
      inputSchema: {
        type: 'object',
        properties: {
          delta_y: { type: 'number', description: 'Vertical scroll amount in pixels (default 600)' },
          delta_x: { type: 'number', description: 'Horizontal scroll amount in pixels' },
          x: { type: 'number', description: 'Viewport x the wheel acts on (default center)' },
          y: { type: 'number', description: 'Viewport y the wheel acts on (default center)' },
        },
      },
      handler: async ({ delta_y, delta_x, x, y }) => {
        const b = await use();
        const res = await b.scroll({ x, y, deltaX: delta_x || 0, deltaY: delta_y === undefined ? 600 : delta_y });
        await sleep(250);
        const pos = await b.evaluate('[Math.round(window.scrollX), Math.round(window.scrollY)]');
        return `Scrolled ${res.deltaX},${res.deltaY} - page is now at ${pos[0]},${pos[1]}`;
      },
    },
    {
      name: 'firefox_hover',
      description: 'Move the mouse over an element or coordinate, to reveal menus and tooltips.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from firefox_snapshot' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
      handler: async ({ ref, x, y }) => {
        const b = await use();
        const point = await b.hover({ ref, x, y });
        await sleep(200);
        return `Hovering (${point.x},${point.y})`;
      },
    },
    {
      name: 'firefox_drag',
      description: 'Press the left button at one point, move to another, and release.',
      inputSchema: {
        type: 'object',
        properties: {
          from_x: { type: 'number' }, from_y: { type: 'number' },
          to_x: { type: 'number' }, to_y: { type: 'number' },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
      handler: async ({ from_x, from_y, to_x, to_y }) => {
        const b = await use();
        await b.drag({ fromX: from_x, fromY: from_y, toX: to_x, toY: to_y });
        return `Dragged (${from_x},${from_y}) -> (${to_x},${to_y})`;
      },
    },
    {
      name: 'firefox_read_page',
      description: 'Read the visible text of the page. Use offset to page through long documents.',
      inputSchema: {
        type: 'object',
        properties: {
          offset: { type: 'integer', description: 'Character offset to start from' },
          limit: { type: 'integer', description: 'Characters to return (default 8000)' },
        },
      },
      handler: async ({ offset, limit }) => {
        const b = await use();
        const res = await b.readText({ offset: offset || 0, limit: limit || 8000 });
        const end = res.offset + res.text.length;
        const more = end < res.total ? `\n\n[${end}/${res.total} chars shown - call again with offset=${end}]` : '';
        return `${res.title} - ${res.url}\n\n${res.text}${more}`;
      },
    },
    {
      name: 'firefox_evaluate',
      description: 'Run a JavaScript expression in the page and return its value. Async expressions are awaited.',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'JavaScript expression' } },
        required: ['expression'],
      },
      handler: async ({ expression }) => {
        const b = await use();
        const value = await b.evaluate(expression);
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined';
      },
    },
    {
      name: 'firefox_tabs',
      description: 'List, open, switch or close tabs.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'What to do (default list)' },
          index: { type: 'integer', description: 'Tab index for select/close' },
          url: { type: 'string', description: 'URL for a new tab' },
        },
      },
      handler: async ({ action = 'list', index, url }) => {
        const b = await use();
        if (action === 'new') await b.newTab(url);
        else if (action === 'select') await b.selectContext(index);
        else if (action === 'close') {
          const contexts = await b.listContexts();
          const target = index === undefined ? b.context : contexts[index]?.context;
          if (!target) throw new Error(`no tab at index ${index}`);
          await b.closeTab(target);
        }
        const info = await b.pageInfo();
        return info.tabs.map((t) => `${t.current ? '*' : ' '} [${t.index}] ${t.url}`).join('\n');
      },
    },
    {
      name: 'firefox_history',
      description: 'Go back, go forward, or reload the current tab.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['back', 'forward', 'reload'] },
          ignore_cache: { type: 'boolean', description: 'Bypass the cache when reloading' },
        },
        required: ['action'],
      },
      handler: async ({ action, ignore_cache }) => {
        const b = await use();
        if (action === 'reload') await b.reload(!!ignore_cache);
        else await b.traverse(action === 'back' ? -1 : 1);
        await sleep(300);
        return `${action} done\n${await where(b)}`;
      },
    },
    {
      name: 'firefox_wait',
      description: 'Wait for text to appear on the page, or simply wait a number of seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to wait for' },
          seconds: { type: 'number', description: 'Seconds to wait (default 15 when text is given, otherwise the pause length)' },
        },
      },
      handler: async ({ text, seconds }) => {
        const b = await use();
        if (text) {
          const found = await b.waitForText(text, (seconds || 15) * 1000);
          if (!found) throw new Error(`"${text}" did not appear within ${seconds || 15}s`);
          return `Found "${text}"\n${await where(b)}`;
        }
        await sleep(Math.min((seconds || 1) * 1000, 60000));
        return `Waited ${seconds || 1}s\n${await where(b)}`;
      },
    },
    {
      name: 'firefox_console',
      description: 'Show console messages and page errors collected since the session started.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many of the most recent messages to show (default 50)' },
          clear: { type: 'boolean', description: 'Clear the buffer after reading' },
        },
      },
      handler: async ({ limit, clear }) => {
        const b = await use();
        const entries = b.console.slice(-(limit || 50));
        if (clear) b.console.length = 0;
        if (!entries.length) return 'No console messages.';
        return entries.map((e) => `${e.at} [${e.level}] ${e.text}`).join('\n');
      },
    },
    {
      name: 'firefox_dialog',
      description: 'Accept or dismiss a native dialog (alert, confirm, prompt, beforeunload) that is blocking the page.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['accept', 'dismiss'], description: 'Default accept' },
          text: { type: 'string', description: 'Text to enter into a prompt' },
        },
      },
      handler: async ({ action, text }) => {
        const b = await use();
        const handled = await b.handleDialog(action !== 'dismiss', text);
        return handled ? `${action || 'accept'}ed dialog: ${handled.type} ${handled.message || ''}` : `${action || 'accept'}ed dialog`;
      },
    },
    {
      name: 'firefox_status',
      description: 'Report whether Firefox is running, which profile and port it uses, and which tabs are open.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const st = await launcher.status();
        const lines = [
          `firefox: ${st.reachable ? 'running' : 'not running'} (pid ${st.pid ?? '-'}, port ${st.port})`,
          `profile: ${st.profile}${st.headless ? ' [headless]' : ''}`,
          `log: ${st.logFile}`,
        ];
        if (st.reachable) {
          const b = await use();
          const info = await b.pageInfo();
          lines.push(`viewport: ${b.viewport.width}x${b.viewport.height}`, 'tabs:');
          lines.push(...info.tabs.map((t) => `${t.current ? '*' : ' '} [${t.index}] ${t.url}`));
        }
        return lines.join('\n');
      },
    },
    {
      name: 'firefox_restart',
      description: 'Restart Firefox. Use this if the browser stops responding or reports a stale automation session.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        await handle.restart();
        const st = await launcher.status();
        return `Firefox restarted (pid ${st.pid}, port ${st.port}).`;
      },
    },
  ];
}

module.exports = { BrowserHandle, buildTools, formatSnapshot };
