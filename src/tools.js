'use strict';
// Tool registry: the Chrome integration's surface, wired to Firefox modules.
//
// Every module exports tools(ctx); this file owns the shared ctx (lazy session,
// batch re-entry, download directory) and the two Firefox-only management tools.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Session, sleep } = require('./session');
const observers = require('./observers');
const launcher = require('./launcher');

const MODULES = [
  require('./pages'),
  require('./a11y'),
  require('./computer'),
  require('./observers'),
  require('./uploads'),
  require('./gif'),
  require('./batch'),
];

const DOWNLOAD_DIR = process.env.FIREFOX_USE_DOWNLOADS
  || path.join(process.env.FIREFOX_USE_HOME || path.join(os.homedir(), '.firefox-use'), 'downloads');

// One browser session per server process, opened on first tool call so that
// starting the MCP server never launches Firefox on its own.
class ToolHost {
  constructor(opts = {}) {
    this.opts = opts;
    this.current = null;
    this._opening = null;
    this.config = { downloadDir: opts.downloadDir || DOWNLOAD_DIR };
    fs.mkdirSync(this.config.downloadDir, { recursive: true });
    this.registry = new Map();
    this.ctx = {
      session: () => this.session(),
      callTool: (name, input) => this.callTool(name, input),
      config: this.config,
    };
    for (const mod of MODULES) {
      for (const tool of mod.tools(this.ctx)) {
        if (this.registry.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
        this.registry.set(tool.name, tool);
      }
    }
    for (const tool of this.managementTools()) this.registry.set(tool.name, tool);
  }

  async session() {
    if (this.current && !this.current.conn.closed) return this.current;
    if (!this._opening) {
      this._opening = Session.open(this.opts)
        .then(async (s) => {
          // Console and network capture has to start with the session, not with
          // the first read_* call, or the page load that matters is already gone.
          await observers.attach(s);
          this.current = s;
          s.conn.on('close', () => { if (this.current === s) this.current = null; });
          return s;
        })
        .finally(() => { this._opening = null; });
    }
    return this._opening;
  }

  async callTool(name, input) {
    const tool = this.registry.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.handler(input || {});
  }

  tools() {
    return [...this.registry.values()];
  }

  async close() {
    if (!this.current) return;
    const session = this.current;
    this.current = null;
    await session.close();
  }

  async restart() {
    await this.close();
    await launcher.stop();
    await sleep(1000);
    await launcher.launch(this.opts);
    return this.session();
  }

  managementTools() {
    return [
      {
        name: 'firefox_status',
        description:
          'Report whether Firefox is running, which profile, port and viewport it uses, and which tabs are in this session\'s group. Firefox-only; the Chrome integration has no equivalent.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const st = await launcher.status();
          const lines = [
            `firefox: ${st.reachable ? 'running' : 'not running'} (pid ${st.pid ?? '-'}, port ${st.port})`,
            `profile: ${st.profile}${st.headless ? ' [headless]' : ''}`,
            `downloads: ${this.config.downloadDir}`,
            `log: ${st.logFile}`,
          ];
          if (st.reachable) {
            const session = await this.session();
            const tabs = await session.listTabs();
            lines.push(`viewport: ${session.viewportSize.width}x${session.viewportSize.height}`);
            lines.push(tabs.length ? 'tabs:' : 'tabs: (none in this session\'s group)');
            for (const tab of tabs) lines.push(`  [${tab.tabId}] ${tab.url}`);
          }
          return lines.join('\n');
        },
      },
      {
        name: 'firefox_restart',
        description:
          'Restart Firefox. Use this when the browser stops responding or reports a stale automation session. Firefox-only.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          await this.restart();
          const st = await launcher.status();
          return `Firefox restarted (pid ${st.pid}, port ${st.port}).`;
        },
      },
      {
        name: 'firefox_dialog',
        description:
          'Accept or dismiss a native dialog (alert, confirm, prompt, beforeunload) that is blocking the page. Firefox-only: in Chrome a blocking dialog ends the automation session, here it can be cleared.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['accept', 'dismiss'], description: 'Default accept' },
            text: { type: 'string', description: 'Text to enter into a prompt' },
            tabId: { type: 'number', description: 'Tab showing the dialog. Use tabs_context_mcp if you do not have a valid tab id.' },
          },
        },
        handler: async ({ action, text, tabId }) => {
          const session = await this.session();
          const id = tabId ?? (await session.defaultTabId());
          const handled = await session.handleUserPrompt(id, action !== 'dismiss', text);
          return handled
            ? `${action === 'dismiss' ? 'Dismissed' : 'Accepted'} ${handled.type} dialog: ${handled.message || ''}`.trim()
            : `${action === 'dismiss' ? 'Dismissed' : 'Accepted'} the dialog.`;
        },
      },
    ];
  }
}

module.exports = { ToolHost, DOWNLOAD_DIR };
