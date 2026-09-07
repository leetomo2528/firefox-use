'use strict';
// WebDriver BiDi command/event transport over the minimal WebSocket client.

const { EventEmitter } = require('events');
const { WebSocket } = require('./ws');

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
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out connecting to ${url}`));
      }, timeout);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new BidiConnection(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
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
        reject(new Error(`BiDi command timed out: ${method}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  close() {
    this._closed = true;
    this._ws.close();
  }
}

module.exports = { BidiConnection, BidiError };
