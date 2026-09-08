'use strict';
// Minimal RFC 6455 WebSocket client (no dependencies).
// Only what the WebDriver BiDi transport needs: text frames, fragmentation,
// ping/pong, close, and payloads large enough for base64 screenshots.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocket extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    const u = new URL(url);
    this.url = url;
    this.readyState = 'connecting';
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOp = null;
    this._handshakeDone = false;
    this._key = crypto.randomBytes(16).toString('base64');
    this._maxPayload = opts.maxPayload || 256 * 1024 * 1024;

    const secure = u.protocol === 'wss:';
    const port = u.port ? Number(u.port) : secure ? 443 : 80;
    const connect = secure ? tls.connect : net.connect;
    this._socket = connect({ host: u.hostname, port, servername: secure ? u.hostname : undefined }, () => {
      const path = (u.pathname || '/') + (u.search || '');
      const head =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${this._key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n';
      this._socket.write(head);
    });
    this._socket.setNoDelay(true);
    this._socket.on('data', (chunk) => this._onData(chunk));
    this._socket.on('error', (err) => this._fail(err));
    this._socket.on('close', () => {
      const wasOpen = this.readyState === 'open';
      this.readyState = 'closed';
      if (wasOpen || !this._handshakeDone) this.emit('close');
    });
  }

  _fail(err) {
    this.readyState = 'closed';
    this.emit('error', err);
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    if (!this._handshakeDone && !this._readHandshake()) return;
    this._readFrames();
  }

  _readHandshake() {
    const end = this._buf.indexOf('\r\n\r\n');
    if (end === -1) return false;
    const head = this._buf.subarray(0, end).toString('latin1');
    this._buf = this._buf.subarray(end + 4);
    const [statusLine, ...lines] = head.split('\r\n');
    if (!/^HTTP\/1\.1 101/.test(statusLine)) {
      this._fail(new Error(`WebSocket handshake failed: ${statusLine}`));
      this._socket.destroy();
      return false;
    }
    const headers = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const expected = crypto.createHash('sha1').update(this._key + GUID).digest('base64');
    if (headers['sec-websocket-accept'] !== expected) {
      this._fail(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
      this._socket.destroy();
      return false;
    }
    this._handshakeDone = true;
    this.readyState = 'open';
    this.emit('open');
    return true;
  }

  _readFrames() {
    for (;;) {
      const frame = decodeFrame(this._buf, this._maxPayload);
      if (frame === null) return;
      if (frame instanceof Error) {
        this._fail(frame);
        this._socket.destroy();
        return;
      }
      this._buf = this._buf.subarray(frame.size);
      this._handleFrame(frame);
      if (this.readyState === 'closed') return;
    }
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case OP.PING:
        this._send(OP.PONG, frame.payload);
        return;
      case OP.PONG:
        return;
      case OP.CLOSE:
        this.readyState = 'closing';
        this._send(OP.CLOSE, frame.payload.subarray(0, 2));
        this._socket.end();
        return;
      case OP.CONT: {
        if (this._fragOp === null) return this._fail(new Error('continuation frame without start'));
        this._frags.push(frame.payload);
        if (!frame.fin) return;
        const op = this._fragOp;
        const payload = Buffer.concat(this._frags);
        this._frags = [];
        this._fragOp = null;
        this._emitMessage(op, payload);
        return;
      }
      case OP.TEXT:
      case OP.BINARY:
        if (!frame.fin) {
          this._fragOp = frame.opcode;
          this._frags = [frame.payload];
          return;
        }
        this._emitMessage(frame.opcode, frame.payload);
        return;
      default:
        this._fail(new Error(`unsupported opcode 0x${frame.opcode.toString(16)}`));
    }
  }

  _emitMessage(opcode, payload) {
    this.emit('message', opcode === OP.TEXT ? payload.toString('utf8') : payload, opcode === OP.BINARY);
  }

  _send(opcode, payload) {
    if (this.readyState === 'closed') return;
    this._socket.write(encodeFrame(opcode, payload));
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('WebSocket is not open');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._send(Buffer.isBuffer(data) ? OP.BINARY : OP.TEXT, buf);
  }

  close(code = 1000) {
    if (this.readyState !== 'open') {
      this._socket.destroy();
      return;
    }
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.readyState = 'closing';
    this._send(OP.CLOSE, payload);
    this._socket.end();
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let offset;
  let header;
  if (len < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | len;
    offset = 2;
  } else if (len < 65536) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
    offset = 10;
  }
  header[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  mask.copy(header, offset);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}

// Returns null when more bytes are needed, an Error on protocol violation,
// otherwise { fin, opcode, payload, size }.
function decodeFrame(buf, maxPayload) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  if (buf[0] & 0x70) return new Error('reserved bits set (compression is not negotiated)');
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    len = hi * 2 ** 32 + lo;
    offset += 8;
  }
  if (len > maxPayload) return new Error(`frame too large: ${len} bytes`);
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const mask = buf.subarray(offset - 4, offset);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, size: offset + len };
}

module.exports = { WebSocket, encodeFrame, decodeFrame, OP };
