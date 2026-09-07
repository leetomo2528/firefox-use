'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { McpServer, normalizeToolResult } = require('../src/mcp');

function startServer(tools) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpServer({ name: 'test-server', version: '9.9.9', tools });
  server.start(input, output);
  const replies = [];
  const waiters = [];
  let buf = '';
  output.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(msg);
      else replies.push(msg);
    }
  });
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((r) => waiters.push(r)));
  const send = (msg) => input.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  const call = async (method, params, id = Math.floor(Math.random() * 1e6)) => {
    send({ jsonrpc: '2.0', id, method, params });
    return next();
  };
  return { server, send, call, next };
}

const echoTool = {
  name: 'echo',
  description: 'echo back',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  handler: async ({ value }) => `echo:${value}`,
};

const angryTool = {
  name: 'angry',
  description: 'always throws',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => { throw new Error('boom'); },
};

test('initialize advertises tools and echoes the protocol version', async () => {
  const { call } = startServer([echoTool]);
  const res = await call('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(res.result.protocolVersion, '2025-03-26');
  assert.equal(res.result.serverInfo.name, 'test-server');
  assert.ok(res.result.capabilities.tools);
});

test('tools/list returns schemas without handlers', async () => {
  const { call } = startServer([echoTool, angryTool]);
  const res = await call('tools/list', {});
  assert.equal(res.result.tools.length, 2);
  assert.equal(res.result.tools[0].handler, undefined);
  assert.equal(res.result.tools[0].inputSchema.type, 'object');
});

test('tools/call wraps a plain string result as text content', async () => {
  const { call } = startServer([echoTool]);
  const res = await call('tools/call', { name: 'echo', arguments: { value: 'hi' } });
  assert.deepEqual(res.result.content, [{ type: 'text', text: 'echo:hi' }]);
  assert.ok(!res.result.isError);
});

test('a throwing tool reports isError instead of killing the server', async () => {
  const { call } = startServer([echoTool, angryTool]);
  const bad = await call('tools/call', { name: 'angry', arguments: {} });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /boom/);
  const good = await call('tools/call', { name: 'echo', arguments: { value: 'still here' } });
  assert.equal(good.result.content[0].text, 'echo:still here');
});

test('unknown tools and methods return JSON-RPC errors', async () => {
  const { call } = startServer([echoTool]);
  const tool = await call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(tool.error.code, -32602);
  const method = await call('resources/list', {});
  assert.equal(method.error.code, -32601);
});

test('malformed input gets a parse error and does not desync the stream', async () => {
  const { send, next, call } = startServer([echoTool]);
  send('not json');
  const err = await next();
  assert.equal(err.error.code, -32700);
  const res = await call('ping', {});
  assert.deepEqual(res.result, {});
});

test('notifications get no reply', async () => {
  const { send, call } = startServer([echoTool]);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const res = await call('ping', {}, 42);
  assert.equal(res.id, 42, 'the next reply belongs to the next request');
});

test('normalizeToolResult passes structured content through', () => {
  const image = { content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }] };
  assert.strictEqual(normalizeToolResult(image), image);
  assert.equal(normalizeToolResult({ a: 1 }).content[0].type, 'text');
});
