'use strict';
// Tool registry: the Chrome integration's surface, wired to Firefox modules.
//
// Every module exports tools(ctx); this file owns the shared ctx (lazy session,
// batch re-entry, download directory) and the two Firefox-only management tools.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Session, ImageStore, NO_WINDOW, sleep } = require('./session');
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

// No tool call may outlive this. Every BiDi command and launch step has a
// bound of its own; this one catches whatever slips past them, so a stuck call
// comes back as an error instead of holding the client for its full timeout.
const CALL_TIMEOUT_MS = Number(process.env.FIREFOX_USE_CALL_TIMEOUT_MS) || 150000;
const RESTART_TIMEOUT_MS = 120000;
const HEALTH_TIMEOUT_MS = 5000;
// browser_batch runs other tools, and each of those carries its own deadline.
const SELF_BOUNDED = new Set(['browser_batch']);

function timeoutError(message) {
  const err = new Error(message);
  err.code = 'timeout';
  return err;
}

function withDeadline(promise, ms, label) {
  let timer;
  const span = ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(`${label} did not finish within ${span}.`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function withNote(result, note) {
  if (typeof result === 'string') return `${note}\n${result}`;
  if (result && Array.isArray(result.content)) {
    return { ...result, content: [...result.content, { type: 'text', text: note }] };
  }
  return result;
}

// One browser session per server process, opened on first tool call so that
// starting the MCP server never launches Firefox on its own.
class ToolHost {
  constructor(opts = {}) {
    this.opts = opts;
    this.current = null;
    this._opening = null;
    this._restarting = null;
    this.callTimeout = opts.callTimeout ?? CALL_TIMEOUT_MS;
    this.restartTimeout = opts.restartTimeout ?? RESTART_TIMEOUT_MS;
    this.healthTimeout = opts.healthTimeout ?? HEALTH_TIMEOUT_MS;
    this.autoRestart = opts.autoRestart ?? process.env.FIREFOX_USE_AUTO_RESTART !== '0';
    // Screenshot ids and tab ids outlive a single BiDi connection: the model
    // may hold an imageId or tabId from before a reconnect.
    this.images = new ImageStore();
    this.tabIds = [];
    this.config = { downloadDir: opts.downloadDir || DOWNLOAD_DIR };
    fs.mkdirSync(this.config.downloadDir, { recursive: true });
    this.registry = new Map();
    this.ctx = {
      session: () => this.session(),
      callTool: (name, input) => this.callTool(name, input),
      config: this.config,
    };
    for (const mod of MODULES) {
      for (const tool of mod.tools(this.ctx)) this._register(tool);
    }
    for (const tool of this.managementTools()) this._register(tool);
  }

  _register(tool) {
    if (this.registry.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    const handler = tool.handler;
    this.registry.set(tool.name, { ...tool, handler: (input) => this._run(tool.name, handler, input || {}) });
  }

  // Every tool call passes through here: bounded in time, and given one retry
  // on a freshly started browser when Firefox turns out to have no window.
  async _run(name, handler, input) {
    try {
      return await this._bounded(name, handler, input);
    } catch (err) {
      if (err && err.code === NO_WINDOW && this.autoRestart) {
        // Nothing has happened yet when this is thrown - the tab could not be
        // opened - so running the call again is safe. Two calls can meet the
        // same windowless browser; only the first restarts it.
        if (this._restarting) await this._restarting;
        else if (!err.session || !this.current || err.session === this.current) await this.restart();
        const result = await this._bounded(name, handler, input);
        return withNote(result, 'Firefox was running without any window, so it was restarted first.');
      }
      if (err && err.code === 'timeout') err.message += await this._afterTimeout();
      throw err;
    }
  }

  _bounded(name, handler, input) {
    const work = Promise.resolve().then(() => handler(input));
    if (SELF_BOUNDED.has(name) || !(this.callTimeout > 0)) return work;
    return withDeadline(work, this.callTimeout, name);
  }

  // A timeout alone does not say whether the browser is alive, so ask it
  // something trivial. If that goes unanswered too, drop the connection: the
  // next call reconnects, and relaunches Firefox if it has to.
  async _afterTimeout() {
    const session = this.current;
    if (!session || session.conn.closed) {
      return ' Firefox was still starting or reconnecting. Call the tool again, or firefox_restart if this repeats.';
    }
    try {
      await session.conn.send('session.status', {}, { timeout: this.healthTimeout });
      return ' Firefox still answers, so the page or the command was slow; try again, or in smaller steps.';
    } catch {
      if (this.current === session) await this._drop({ endSession: false });
      return ' Firefox did not answer a health check either, so the connection was dropped; '
        + 'the next call reconnects, and relaunches Firefox if it has to.';
    }
  }

  async session() {
    // A restart is tearing the browser down; joining it beats racing it.
    // restart() itself must never come through here - see below.
    if (this._restarting) return this._restarting;
    return this._openSession();
  }

  _openSession() {
    if (this.current && !this.current.conn.closed) return Promise.resolve(this.current);
    if (this._opening) return this._opening;
    const opening = Session.open({ ...this.opts, images: this.images, tabIds: this.tabIds })
      .then(async (s) => {
        try {
          // Console and network capture has to start with the session, not
          // with the first read_* call, or the page load that matters is
          // already gone.
          await observers.attach(s);
        } catch (err) {
          await s.close().catch(() => {});
          throw err;
        }
        this.current = s;
        s.conn.on('close', () => {
          if (this.current !== s) return;
          this.tabIds = [...s.tabs.byContext.entries()];
          this.current = null;
        });
        return s;
      })
      .finally(() => {
        if (this._opening === opening) this._opening = null;
      });
    this._opening = opening;
    return opening;
  }

  async callTool(name, input) {
    const tool = this.registry.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.handler(input || {});
  }

  tools() {
    return [...this.registry.values()];
  }

  // Forgets the current session. endSession:false skips the polite
  // session.end, for a browser that has already stopped answering.
  async _drop({ endSession = true } = {}) {
    const session = this.current;
    if (!session) return;
    this.tabIds = [...session.tabs.byContext.entries()];
    this.current = null;
    await session.close({ endSession }).catch(() => {});
  }

  async close() {
    // A session that is still opening still has to be closed, or the BiDi
    // session it holds outlives the process and blocks the next client.
    if (this._restarting) await this._restarting.catch(() => {});
    if (this._opening) await this._opening.catch(() => {});
    await this._drop();
  }

  restart() {
    if (this._restarting) return this._restarting;
    const work = (async () => {
      // A connect already under way is bounded; let it finish first so it
      // cannot take the new browser's only BiDi session from under us.
      if (this._opening) await this._opening.catch(() => {});
      await this._drop();
      this.tabIds = []; // a new browser means new contexts
      await launcher.stop({ port: this.opts.port });
      await sleep(500);
      await launcher.launch(this.opts);
      // Not this.session(): while _restarting is set it hands back this very
      // promise, and a restart that waits on itself never finishes - which
      // left every later call hanging behind it.
      return this._openSession();
    })();
    this._restarting = withDeadline(work, this.restartTimeout, 'Restarting Firefox')
      .finally(() => { this._restarting = null; });
    return this._restarting;
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
            if (!(await session.topLevelContexts()).length) {
              lines.push(this.autoRestart
                ? 'windows: none - Firefox is running without a window; the next call that needs a tab restarts it'
                : 'windows: none - Firefox is running without a window; call firefox_restart before opening a tab');
            }
            const blocked = session.promptTabId();
            if (blocked) lines.push(`dialog open on tab ${blocked} - use firefox_dialog`);
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
          // Answer the tab that is actually blocked, not tab 1.
          const id = tabId ?? session.promptTabId() ?? (await session.defaultTabId());
          const handled = await session.handleUserPrompt(id, action !== 'dismiss', text);
          return handled
            ? `${action === 'dismiss' ? 'Dismissed' : 'Accepted'} ${handled.type} dialog: ${handled.message || ''}`.trim()
            : `${action === 'dismiss' ? 'Dismissed' : 'Accepted'} the dialog.`;
        },
      },
    ];
  }
}

module.exports = { ToolHost, DOWNLOAD_DIR, CALL_TIMEOUT_MS, withDeadline };
