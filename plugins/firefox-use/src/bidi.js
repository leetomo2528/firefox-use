'use strict';
// WebDriver BiDi command/event transport over the minimal WebSocket client.

const { EventEmitter } = require('events');
const { WebSocket } = require('./ws');

// A command or a connect attempt that ran out of time. Callers tell it apart
// from a protocol error by err.code, and decide whether the browser is gone.
class BidiTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BidiTimeoutError';
    this.code = 'timeout';
  }
}

class BidiError extends Error {
  constructor(payload) {
    super(payload.message || payload.error || 'BiDi error');
    this.name = 'BidiError';
    this.code = payload.error;
    this.stacktrace = payload.stacktrace;
  }
}

class BidiConnection extends EventEmitter {
  constructor(ws) {
    super();
    this._ws = ws;
    this._nextId = 1;
    this._pending = new Map();
    this._closed = false;
    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => this._onClose(new Error('BiDi connection closed')));
    ws.on('error', (err) => this._onClose(err));
  }

  static connect(url, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        settle(reject, new BidiTimeoutError(`timed out connecting to ${url} after ${timeout}ms`));
        ws.close();
      }, timeout);
      ws.once('open', () => settle(resolve, new BidiConnection(ws)));
      // Swallow late errors: a socket that failed after the timeout must not
      // surface as an unhandled 'error' event.
      ws.on('error', (err) => settle(reject, err));
      // A peer that hangs up during the handshake sends neither 'open' nor
      // 'error'; without this the caller sat out the whole timeout.
      ws.once('close', () => settle(reject, new Error(`${url} closed the connection during the handshake`)));
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === 'event') {
      this.emit('event', msg.method, msg.params);
      this.emit(msg.method, msg.params);
      return;
    }
    const entry = this._pending.get(msg.id);
    if (!entry) return;
    this._pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.type === 'error') entry.reject(new BidiError(msg));
    else entry.resolve(msg.result);
  }

  _onClose(err) {
    if (this._closed) return;
    this._closed = true;
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
    this.emit('close', err);
  }

  get closed() {
    return this._closed;
  }

  send(method, params = {}, { timeout = 60000 } = {}) {
    if (this._closed) return Promise.reject(new Error('BiDi connection is closed'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new BidiTimeoutError(`BiDi command timed out after ${timeout}ms: ${method}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
        // A socket that cannot take a command is gone; say so, so the owner
        // reconnects instead of failing every call on a dead connection.
        this._onClose(new Error(`BiDi connection closed (${err.message})`));
      }
    });
  }

  close() {
    // Reject what is still in flight first: a caller waiting on a 90s
    // screenshot would otherwise hang until its own timeout.
    this._onClose(new Error('BiDi connection is closed'));
    this._ws.close();
  }
}

module.exports = { BidiConnection, BidiError, BidiTimeoutError };
