'use strict';
// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, tools only.

const PROTOCOL_VERSION = '2025-06-18';

class McpServer {
  constructor({ name, version, tools, onShutdown }) {
    this.name = name;
    this.version = version;
    this.tools = tools; // [{ name, description, inputSchema, handler }]
    this.onShutdown = onShutdown;
    this._buf = '';
    this._closing = false;
  }

  log(...args) {
    process.stderr.write(`[${this.name}] ${args.join(' ')}\n`);
  }

  start(input = process.stdin, output = process.stdout) {
    this.output = output;
    input.setEncoding('utf8');
    input.on('data', (chunk) => this._onData(chunk));
    input.on('end', () => this.shutdown(0));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(signal, () => this.shutdown(0));
    }
  }

  _onData(chunk) {
    this._buf += chunk;
    let index;
    while ((index = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, index).trim();
      this._buf = this._buf.slice(index + 1);
      if (line) this._handleLine(line);
    }
  }

  async _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this._send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined || msg.id === null) return this._handleNotification(msg);
    try {
      const result = await this._dispatch(msg);
      this._send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: err.rpcCode || -32603, message: err.message || String(err) },
      });
    }
  }

  _handleNotification(msg) {
    if (msg.method === 'notifications/cancelled') return;
    // initialized and anything else needs no reply.
  }

  async _dispatch(msg) {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
      case 'tools/call':
        return this._callTool(msg.params || {});
      default: {
        const err = new Error(`method not found: ${msg.method}`);
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  async _callTool({ name, arguments: args = {} }) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      const err = new Error(`unknown tool: ${name}`);
      err.rpcCode = -32602;
      throw err;
    }
    try {
      const result = await tool.handler(args || {});
      return normalizeToolResult(result);
    } catch (err) {
      this.log(`${name} failed: ${err.message}`);
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  _send(msg) {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  async shutdown(code = 0) {
    if (this._closing) return;
    this._closing = true;
    try {
      if (this.onShutdown) await this.onShutdown();
    } catch (err) {
      this.log(`shutdown error: ${err.message}`);
    }
    process.exit(code);
  }
}

function normalizeToolResult(result) {
  if (result && Array.isArray(result.content)) return result;
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

module.exports = { McpServer, normalizeToolResult, PROTOCOL_VERSION };
