'use strict';
// gif_creator: per-tab screen recording and animated-GIF export.
//
// Recording is a self-scheduling screenshot loop. Each frame carries the
// click/drag entries the computer tool pushed into window.__ffuse.clicks since
// the previous frame, so overlays land on the frame that shows their effect.
// Export decodes, downscales, draws overlays, quantizes and encodes through
// src/gifenc.js, which is injectable so this module unit-tests on its own.

const path = require('path');
const nodeFs = require('fs');

const DEFAULTS = {
  intervalMs: 700,
  maxFrames: 120,
  maxWidth: 800,
  quality: 10,
};

const ORANGE = '#ff8c00';
const RED = '#ff0000';
const BLACK = '#000000';
const WHITE = '#ffffff';
const WATERMARK = 'firefox-use';

// Drains window.__ffuse.clicks. `from` is how many entries were already taken;
// a huge value primes the cursor. The computer tool caps the log at 200 and
// trims its front, so the index cursor cannot be trusted on its own: once the
// log is exactly full its length stops changing, and `from` keeps matching the
// length while entries scroll off the front. An entry is therefore new if the
// index says so OR if its timestamp is past the previous frame's.
const CLICKS_FN = `(function (from, sinceAt) {
  var store = (window.__ffuse && window.__ffuse.clicks) || [];
  var trimmed = from > store.length;
  var newest = 0;
  var out = [];
  for (var i = 0; i < store.length; i++) {
    var e = store[i] || {};
    var at = typeof e.at === 'number' ? e.at : 0;
    if (at > newest) newest = at;
    // Entries below the cursor in an untrimmed log were reported already, and
    // they cannot be newer than sinceAt, so the two rules never double-count.
    var byIndex = !trimmed && i >= from;
    var byTime = sinceAt > 0 ? at > sinceAt : trimmed;
    if (!byIndex && !byTime) continue;
    out.push({
      type: e.type || 'click',
      x: typeof e.x === 'number' ? e.x : null,
      y: typeof e.y === 'number' ? e.y : null,
      x2: typeof e.x2 === 'number' ? e.x2 : null,
      y2: typeof e.y2 === 'number' ? e.y2 : null,
      label: e.label || e.action || e.text || null,
      at: at || null
    });
  }
  return JSON.stringify({ total: store.length, last: newest, events: out });
})`;

function normalizeTabId(tabId) {
  if (tabId === undefined || tabId === null || tabId === '') throw new Error('tabId is required');
  const n = Number(tabId);
  if (!Number.isFinite(n)) throw new Error(`tabId must be a number, got ${JSON.stringify(tabId)}`);
  return n;
}

// Overlay switches default to on; only an explicit false (or "false") is off.
function flag(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.toLowerCase() !== 'false';
  return Boolean(value);
}

function mergeOptions(options) {
  const o = options && typeof options === 'object' ? options : {};
  const raw = o.quality === undefined || o.quality === null ? DEFAULTS.quality : Number(o.quality);
  if (!Number.isFinite(raw) || raw < 1 || raw > 30) {
    throw new Error(`quality must be a number between 1 and 30, got ${JSON.stringify(o.quality)}`);
  }
  return {
    showClickIndicators: flag(o.showClickIndicators),
    showDragPaths: flag(o.showDragPaths),
    showActionLabels: flag(o.showActionLabels),
    showProgressBar: flag(o.showProgressBar),
    showWatermark: flag(o.showWatermark),
    quality: Math.round(raw),
  };
}

// quality 1..30, lower is better: fewer palette colors as it climbs.
function paletteSize(quality) {
  if (quality <= 5) return 256;
  if (quality <= 10) return 128;
  if (quality <= 16) return 64;
  if (quality <= 23) return 32;
  return 16;
}

// Dithering costs time, so it is only worth it at the better half of the range.
function ditherFor(quality) {
  return quality <= 10;
}

function isDrag(e) {
  return !!e && (e.type === 'drag' || (typeof e.x2 === 'number' && typeof e.y2 === 'number'));
}

function hasPoint(e) {
  return !!e && typeof e.x === 'number' && typeof e.y === 'number';
}

// Labels come out of the page, so they are neither trusted nor unbounded: the
// bitmap font has no glyph for a control character and a long one would run off
// the frame behind a full-width background.
const MAX_LABEL = 48;

function cleanLabel(value) {
  if (value === undefined || value === null) return '';
  const text = stripControl(value).trim();
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 3)}...` : text;
}

// gifenc's 5x7 bitmap font: text ops carry a top-left origin and no alignment,
// so anything right-aligned has to be measured here.
const LABEL_SCALE = 2;
const MARK_SCALE = 1;

function textBox(text, scale) {
  const cols = String(text).length;
  return { width: cols ? cols * 6 * scale - scale : 0, height: 8 * scale - scale };
}

// Ops speak gifenc.drawOverlays' vocabulary exactly: it throws on any other type.
function overlayOps({ width, height, events = [], index = 0, total = 1, options, scale = 1, measure = textBox }) {
  const ops = [];
  const at = (v) => Math.round(v * scale);
  const stroke = Math.max(2, Math.round(3 * scale));
  const barHeight = Math.max(3, Math.round(height * 0.01));
  if (options.showDragPaths) {
    for (const e of events) {
      if (!isDrag(e) || !hasPoint(e) || typeof e.x2 !== 'number' || typeof e.y2 !== 'number') continue;
      ops.push({ type: 'arrow', x1: at(e.x), y1: at(e.y), x2: at(e.x2), y2: at(e.y2), color: RED, width: stroke });
    }
  }
  if (options.showClickIndicators) {
    for (const e of events) {
      if (isDrag(e) || !hasPoint(e)) continue;
      // A ring, not a disc: the click target has to stay visible.
      ops.push({ type: 'circle', x: at(e.x), y: at(e.y), r: Math.max(8, Math.round(22 * scale)), color: ORANGE, fill: false, lineWidth: stroke });
    }
  }
  if (options.showActionLabels) {
    const labels = events.map((e) => cleanLabel(e && e.label)).filter(Boolean).slice(0, 2);
    if (labels.length) {
      const text = labels.join(' / ');
      const box = measure(text, LABEL_SCALE);
      ops.push({
        type: 'text', text, x: 8, y: Math.max(4, height - barHeight - box.height - 8),
        color: BLACK, background: WHITE, scale: LABEL_SCALE,
      });
    }
  }
  if (options.showProgressBar) {
    ops.push({
      type: 'progress',
      ratio: total > 1 ? (index + 1) / total : 1,
      height: barHeight,
      color: ORANGE,
      background: '#00000080',
    });
  }
  if (options.showWatermark) {
    // Top right: labels and the progress bar own the bottom edge.
    const box = measure(WATERMARK, MARK_SCALE);
    ops.push({
      type: 'text', text: WATERMARK, x: Math.max(4, width - box.width - 8), y: 8,
      color: BLACK, background: WHITE, scale: MARK_SCALE,
    });
  }
  return ops;
}

// GIF delays have 10ms granularity; use the measured cadence when there is one.
function frameDelay(frames, fallback) {
  if (!frames || frames.length < 2) return fallback;
  const span = frames[frames.length - 1].at - frames[0].at;
  const avg = span / (frames.length - 1);
  if (!Number.isFinite(avg) || avg <= 0) return fallback;
  return Math.min(2000, Math.max(60, Math.round(avg / 10) * 10));
}

// Drops control characters without needing non-ASCII escapes in this source.
function stripControl(value) {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

function safeFilename(name) {
  const base = path.basename(stripControl(name).replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..') throw new Error(`Invalid filename: ${JSON.stringify(name)}`);
  return /\.gif$/i.test(base) ? base : `${base}.gif`;
}

class GifRecorder {
  constructor({
    gifenc = null,
    fs = nodeFs,
    downloadDir = process.cwd(),
    intervalMs = DEFAULTS.intervalMs,
    maxFrames = DEFAULTS.maxFrames,
    maxWidth = DEFAULTS.maxWidth,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = Date.now,
  } = {}) {
    this._gifenc = gifenc;
    this.fs = fs;
    this._downloadDir = typeof downloadDir === 'function' ? downloadDir : () => downloadDir;
    this.intervalMs = intervalMs;
    this.maxFrames = maxFrames;
    this.maxWidth = maxWidth;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.now = now;
    this.byTab = new Map(); // tabId -> recording state
    this.exports = 0;
  }

  // Resolved late so a test with an injected encoder never loads the real one.
  get gifenc() {
    if (!this._gifenc) this._gifenc = require('./gifenc');
    return this._gifenc;
  }

  stateFor(tabId) {
    return this.byTab.get(Number(tabId)) || null;
  }

  async run(session, args = {}) {
    const action = args.action;
    const tabId = normalizeTabId(args.tabId);
    switch (action) {
      case 'start_recording': return this.start(session, tabId);
      case 'stop_recording': return this.stop(session, tabId);
      case 'export': return this.export(session, tabId, args);
      case 'clear': return this.clear(tabId);
      default:
        throw new Error(`Unknown action ${JSON.stringify(action)}. Use start_recording, stop_recording, export or clear.`);
    }
  }

  // --- recording ----------------------------------------------------------

  async start(session, tabId) {
    session.requireContext(tabId);
    const existing = this.byTab.get(tabId);
    if (existing && existing.recording) {
      return `Already recording tab ${tabId}. Frames: ${existing.frames.length}.`;
    }
    // Resuming must not walk past the cap the loop already enforced.
    if (existing && existing.frames.length >= this.maxFrames) {
      return `Frame cap of ${this.maxFrames} reached for tab ${tabId}. Frames: ${existing.frames.length}. `
        + `Call gif_creator with action "export" or "clear" before recording again.`;
    }
    const rec = existing || this._create(tabId);
    const resumed = rec.frames.length > 0;
    rec.recording = true;
    rec.note = null;
    try {
      // Clicks from before the recording started belong to no frame.
      await this._capture(session, rec, { dropEvents: !resumed });
    } catch (err) {
      rec.recording = false;
      if (!resumed) this.byTab.delete(tabId);
      throw err;
    }
    this._schedule(session, rec);
    return `Recording tab ${tabId}${resumed ? ' (resumed)' : ''}. Frames: ${rec.frames.length}. `
      + `Capturing every ${this.intervalMs}ms, up to ${this.maxFrames} frames.`;
  }

  async stop(session, tabId) {
    const rec = this.byTab.get(tabId);
    if (!rec || !rec.recording) {
      const frames = rec ? rec.frames.length : 0;
      const note = rec && rec.note ? ` ${rec.note}` : '';
      return `Not recording tab ${tabId}. Frames: ${frames}.${note}`;
    }
    this._stopLoop(rec);
    let note = '';
    try {
      await this._capture(session, rec);
    } catch (err) {
      note = ` Final frame was not captured: ${err.message}`;
    }
    return `Stopped recording tab ${tabId}. Frames: ${rec.frames.length}.${note}`;
  }

  clear(tabId) {
    const rec = this.byTab.get(tabId);
    if (!rec) return `Nothing to clear for tab ${tabId}. Frames: 0.`;
    this._stopLoop(rec);
    const count = rec.frames.length;
    this.byTab.delete(tabId);
    return `Cleared ${count} frame(s) for tab ${tabId}. Frames: 0.`;
  }

  _create(tabId) {
    const rec = { tabId, frames: [], recording: false, seen: 0, lastAt: 0, timer: null, note: null, gen: 0 };
    this.byTab.set(tabId, rec);
    return rec;
  }

  _schedule(session, rec) {
    rec.timer = this.setTimeoutFn(() => {
      rec.timer = null;
      return this._tick(session, rec);
    }, this.intervalMs);
    // The capture loop must never hold the process open.
    if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref();
  }

  _stopLoop(rec) {
    if (rec.timer) {
      try { this.clearTimeoutFn(rec.timer); } catch { /* already fired */ }
      rec.timer = null;
    }
    rec.recording = false;
    // Anything already in flight belongs to the run that just ended.
    rec.gen = (rec.gen || 0) + 1;
  }

  async _tick(session, rec) {
    if (!rec.recording) return;
    // A screenshot takes real time, and stop / clear / export can land while it
    // is in flight. Without this guard the finished tick would append a frame to
    // a discarded recording and arm a fresh timer nobody can cancel.
    const gen = rec.gen;
    const live = () => rec.recording && rec.gen === gen;
    try {
      await this._capture(session, rec, { keepIf: live });
    } catch (err) {
      if (!live()) return;
      // A closed tab must not leave the loop spinning on a dead context.
      this._stopLoop(rec);
      rec.note = `Recording stopped: ${err.message}`;
      return;
    }
    if (!live()) return;
    if (rec.frames.length >= this.maxFrames) {
      this._stopLoop(rec);
      rec.note = `Frame cap of ${this.maxFrames} reached; recording stopped.`;
      return;
    }
    this._schedule(session, rec);
  }

  async _capture(session, rec, { dropEvents = false, keepIf = null } = {}) {
    let events = [];
    try {
      events = await this._syncEvents(session, rec, dropEvents);
    } catch {
      events = []; // overlays are optional; the pixels are not
    }
    const shot = await session.screenshot(rec.tabId, { format: 'png' });
    if (keepIf && !keepIf()) {
      // stop / clear / export took over while the screenshot was in flight, so
      // this frame is unwanted - but the clicks it drained are already off the
      // page's log, so hand them to the frame that ended the run.
      const last = rec.frames[rec.frames.length - 1];
      if (last && events.length) last.events = (last.events || []).concat(events);
      return rec.frames.length;
    }
    rec.frames.push({
      data: Buffer.from(String((shot && shot.data) || ''), 'base64'),
      mimeType: (shot && shot.mimeType) || 'image/png',
      at: this.now(),
      events,
    });
    return rec.frames.length;
  }

  async _syncEvents(session, rec, drop) {
    await session.ensureRefStore(rec.tabId);
    const from = drop ? Number.MAX_SAFE_INTEGER : rec.seen;
    const res = await session.callJson(rec.tabId, CLICKS_FN, [from, rec.lastAt]);
    const total = Number(res && res.total);
    if (Number.isFinite(total)) rec.seen = total;
    const last = Number(res && res.last);
    if (Number.isFinite(last) && last > rec.lastAt) rec.lastAt = last;
    if (drop) return [];
    return res && Array.isArray(res.events) ? res.events : [];
  }

  // --- export -------------------------------------------------------------

  async export(session, tabId, args = {}) {
    const options = mergeOptions(args.options);
    const rec = this.byTab.get(tabId);
    if (!rec || !rec.frames.length) {
      throw new Error(`No frames recorded for tab ${tabId}. Call gif_creator with action "start_recording" first.`);
    }
    let note = '';
    if (rec.recording) {
      this._stopLoop(rec);
      note += ' Recording was still running and has been stopped.';
    }

    const gifenc = this.gifenc;
    const decoded = rec.frames.map((frame, i) => {
      let out;
      try {
        out = gifenc.decodePng(frame.data);
      } catch (err) {
        throw new Error(`Frame ${i + 1} of tab ${tabId} could not be decoded: ${err.message}`);
      }
      if (!out || !out.width || !out.height) throw new Error(`Frame ${i + 1} of tab ${tabId} could not be decoded.`);
      return out;
    });

    const targetWidth = Math.min(this.maxWidth, decoded[0].width);
    const sized = decoded.map((frame) => (frame.width === targetWidth ? frame : gifenc.resizeRgba(frame, targetWidth)));
    const width = sized[0].width;
    const height = sized[0].height;

    const kept = [];
    let skipped = 0;
    for (let i = 0; i < sized.length; i++) {
      const frame = sized[i];
      // A viewport resize mid-recording yields a frame the GIF canvas cannot hold.
      if (!frame || frame.width !== width || frame.height !== height) { skipped++; continue; }
      kept.push({ frame, events: rec.frames[i].events || [], scale: targetWidth / decoded[i].width });
    }
    if (!kept.length) throw new Error(`No frames of tab ${tabId} match ${width}x${height}; nothing to encode.`);

    const measure = typeof gifenc.textSize === 'function' ? gifenc.textSize : undefined;
    const drawn = kept.map((entry, i) => {
      const ops = overlayOps({ width, height, events: entry.events, index: i, total: kept.length, options, scale: entry.scale, measure });
      if (!ops.length) return entry.frame;
      return gifenc.drawOverlays(entry.frame, ops) || entry.frame;
    });

    const maxColors = paletteSize(options.quality);
    const quantized = gifenc.quantize(drawn, maxColors, { dither: ditherFor(options.quality) });
    if (!quantized || !quantized.palette || !quantized.indexed || !quantized.indexed.length) {
      throw new Error('Color quantization returned no frames.');
    }
    const delayMs = frameDelay(rec.frames, this.intervalMs);
    const buf = gifenc.encodeGif({
      frames: quantized.indexed,
      palette: quantized.palette,
      width,
      height,
      delayMs,
      loop: 0,
    });
    if (!buf || !buf.length) throw new Error('GIF encoding produced no data.');

    const dir = this._downloadDir() || process.cwd();
    this.fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, this._resolveName(args.filename, dir));
    this.fs.writeFileSync(file, buf);

    const skipNote = skipped ? ` Skipped ${skipped} frame(s) that did not match ${width}x${height}.` : '';
    return `Exported ${kept.length} frame(s) of tab ${tabId} to ${file} `
      + `(${width}x${height}, ${(buf.length / 1024).toFixed(1)} KB, ${maxColors} colors, ${delayMs}ms per frame, quality ${options.quality}). `
      + `Frames kept: ${rec.frames.length}; call gif_creator with action "clear" to discard them.${skipNote}${note}`;
  }

  _resolveName(filename, dir) {
    if (filename !== undefined && filename !== null && String(filename).trim() !== '') return safeFilename(filename);
    for (let i = 0; i < 1000; i++) {
      const name = `recording-${++this.exports}.gif`;
      if (!this._exists(path.join(dir, name))) return name;
    }
    return `recording-${++this.exports}.gif`;
  }

  _exists(file) {
    try { return this.fs.existsSync ? this.fs.existsSync(file) : false; } catch { return false; }
  }
}

const DESCRIPTION = 'Manage GIF recording and export for browser automation sessions. '
  + 'Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF '
  + "with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. "
  + 'When starting recording, take a screenshot immediately after to capture the initial state as the first frame. '
  + 'When stopping recording, take a screenshot immediately before to capture the final state as the last frame. '
  + "For export, set 'download: true' to download the GIF.";

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start_recording', 'stop_recording', 'export', 'clear'],
      description: "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)",
    },
    tabId: {
      type: 'number',
      description: 'Tab ID to identify which tab group this operation applies to',
    },
    download: {
      type: 'boolean',
      description: "Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser.",
    },
    filename: {
      type: 'string',
      description: "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only.",
    },
    options: {
      type: 'object',
      description: "Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10).",
      properties: {
        showClickIndicators: { type: 'boolean', description: 'Show orange circles at click locations (default: true)' },
        showDragPaths: { type: 'boolean', description: 'Show red arrows for drag actions (default: true)' },
        showActionLabels: { type: 'boolean', description: 'Show black labels describing actions (default: true)' },
        showProgressBar: { type: 'boolean', description: 'Show orange progress bar at bottom (default: true)' },
        showWatermark: { type: 'boolean', description: 'Show Claude logo watermark (default: true)' },
        quality: { type: 'number', description: 'GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10' },
      },
    },
  },
  required: ['action', 'tabId'],
};

function tools(ctx, recorder) {
  const gif = recorder || new GifRecorder({
    downloadDir: () => (ctx && ctx.config && ctx.config.downloadDir) || process.cwd(),
  });
  return [{
    name: 'gif_creator',
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    handler: async (args = {}) => {
      const session = await ctx.session();
      return gif.run(session, args);
    },
  }];
}

module.exports = {
  GifRecorder, tools,
  mergeOptions, paletteSize, ditherFor, overlayOps, frameDelay, safeFilename, normalizeTabId, cleanLabel,
  CLICKS_FN, DEFAULTS, DESCRIPTION, INPUT_SCHEMA,
};
