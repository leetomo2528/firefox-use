'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { FakeSession, fakeCtx } = require('./helpers/fake-session');
const {
  GifRecorder, tools, mergeOptions, paletteSize, ditherFor, overlayOps, frameDelay, safeFilename,
  cleanLabel, CLICKS_FN, DEFAULTS,
} = require('../src/gif');

const SPEC = require('../docs/chrome-tool-spec.json').find((t) => t.name === 'gif_creator');
const DIR = '/tmp/ffuse-test';

// A hand-cranked timer queue: the capture loop advances only when a test says so.
function fakeClock() {
  const queue = [];
  let time = 1000;
  return {
    queue,
    now: () => (time += 700),
    setTimeoutFn(fn) { const timer = { fn, cancelled: false }; queue.push(timer); return timer; },
    clearTimeoutFn(timer) { if (timer) timer.cancelled = true; },
    pending() { return queue.filter((t) => !t.cancelled).length; },
    async tick(n = 1) {
      let ran = 0;
      while (ran < n) {
        const timer = queue.shift();
        if (!timer) break;
        if (timer.cancelled) continue;
        await timer.fn();
        ran++;
      }
      return ran;
    },
  };
}

// Stands in for src/gifenc.js, which another module owns.
function fakeGifenc(overrides = {}) {
  const calls = { decodePng: [], resizeRgba: [], drawOverlays: [], quantize: [], encodeGif: [] };
  return Object.assign({
    calls,
    decodePng(buf) { calls.decodePng.push(buf); return { width: 1600, height: 1000, data: buf }; },
    resizeRgba(frame, targetWidth) {
      calls.resizeRgba.push({ frame, targetWidth });
      return { width: targetWidth, height: Math.round((frame.height * targetWidth) / frame.width), data: frame.data };
    },
    drawOverlays(frame, ops) { calls.drawOverlays.push({ frame, ops }); return frame; },
    quantize(frames, maxColors, opts) {
      calls.quantize.push({ frames, maxColors, opts });
      return { palette: [0, 0, 0, 255, 255, 255], indexed: frames.map(() => new Uint8Array(4)) };
    },
    encodeGif(spec) { calls.encodeGif.push(spec); return Buffer.alloc(2048, 7); },
  }, overrides);
}

function fakeFs() {
  const files = new Map();
  const dirs = [];
  return {
    files,
    dirs,
    mkdirSync(dir, opts) { dirs.push({ dir, opts }); },
    writeFileSync(file, data) { files.set(file, data); },
    existsSync(file) { return files.has(file); },
  };
}

function setup({ session, gifenc, ...opts } = {}) {
  const clock = fakeClock();
  const enc = gifenc || fakeGifenc();
  const fs = fakeFs();
  const s = session || new FakeSession();
  const recorder = new GifRecorder({
    gifenc: enc,
    fs,
    downloadDir: () => DIR,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    now: clock.now,
    ...opts,
  });
  return { recorder, clock, enc, fs, session: s };
}

test('the tool definition matches the Chrome spec', () => {
  const [def] = tools(fakeCtx(new FakeSession()));
  assert.equal(def.name, 'gif_creator');
  assert.deepStrictEqual(def.inputSchema, SPEC.inputSchema);
  // Everything up to the Chrome-only drop-target sentence is verbatim.
  assert.ok(def.description.startsWith(SPEC.description.split('For export,')[0]));
  assert.ok(!/coordinate/.test(def.description), 'the extension drop target has no Firefox equivalent');
  assert.match(def.description, /download: true/);
  assert.equal(typeof def.handler, 'function');
});

test('start_recording captures the first frame at once and arms the loop', async () => {
  const { recorder, session, clock } = setup();
  const msg = await recorder.run(session, { action: 'start_recording', tabId: 1 });
  assert.match(msg, /Recording tab 1\./);
  assert.match(msg, /Frames: 1\./);
  assert.match(msg, /up to 120 frames/);
  assert.equal(session.callsOf('screenshot').length, 1);
  assert.equal(recorder.stateFor(1).frames.length, 1);
  assert.equal(clock.pending(), 1, 'the next capture is scheduled');

  // The first frame must not inherit clicks made before recording started.
  const [primed] = session.callsOf('callJson');
  assert.equal(primed.args.fn, CLICKS_FN);
  assert.equal(primed.args.args[0], Number.MAX_SAFE_INTEGER);
  assert.deepEqual(recorder.stateFor(1).frames[0].events, []);
});

test('a second start_recording keeps the frames and does not double the loop', async () => {
  const { recorder, session, clock } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick();
  const msg = await recorder.run(session, { action: 'start_recording', tabId: 1 });
  assert.equal(msg, 'Already recording tab 1. Frames: 2.');
  assert.equal(session.callsOf('screenshot').length, 2, 'no extra capture');
  assert.equal(clock.pending(), 1, 'still exactly one timer armed');
});

test('the loop accumulates frames and stops at the 120 frame cap', async () => {
  const { recorder, session, clock } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  const ran = await clock.tick(500);
  const rec = recorder.stateFor(1);
  assert.equal(rec.frames.length, DEFAULTS.maxFrames);
  assert.equal(ran, DEFAULTS.maxFrames - 1, 'the loop stopped scheduling itself');
  assert.equal(rec.recording, false);
  assert.equal(clock.pending(), 0);
  const msg = await recorder.run(session, { action: 'stop_recording', tabId: 1 });
  assert.equal(msg, 'Not recording tab 1. Frames: 120. Frame cap of 120 reached; recording stopped.');
});

test('stop_recording takes a final frame and cancels the timer', async () => {
  const { recorder, session, clock } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick();
  const msg = await recorder.run(session, { action: 'stop_recording', tabId: 1 });
  assert.equal(msg, 'Stopped recording tab 1. Frames: 3.');
  assert.equal(clock.pending(), 0);
  assert.equal(await clock.tick(3), 0, 'a cancelled timer never captures again');
  assert.equal(session.callsOf('screenshot').length, 3);

  const again = await recorder.run(session, { action: 'stop_recording', tabId: 1 });
  assert.equal(again, 'Not recording tab 1. Frames: 3.');
  assert.equal(session.callsOf('screenshot').length, 3, 'stopping twice captures nothing');
});

test('a capture failure stops the loop and reports the reason', async () => {
  let shots = 0;
  const session = new FakeSession({
    responses: {
      screenshot: () => {
        shots += 1;
        if (shots > 1) throw new Error('Tab 1 no longer exists. Call tabs_context_mcp to get valid tab ids.');
        return { data: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
      },
    },
  });
  const { recorder, clock } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick();
  const rec = recorder.stateFor(1);
  assert.equal(rec.frames.length, 1, 'the failed frame is not stored');
  assert.equal(rec.recording, false);
  assert.match(rec.note, /Recording stopped: Tab 1 no longer exists\./);
  assert.equal(clock.pending(), 0);
});

test('clicks recorded since the previous frame ride along on that frame', async () => {
  const events = [
    { type: 'click', x: 10, y: 20, x2: null, y2: null, label: 'click Save' },
    { type: 'drag', x: 4, y: 6, x2: 40, y2: 60, label: 'drag file' },
  ];
  const session = new FakeSession({ responses: { callJson: [{ total: 2, events: [] }, { total: 4, events }] } });
  const { recorder, clock } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick();
  const rec = recorder.stateFor(1);
  assert.deepEqual(rec.frames[0].events, [], 'pre-recording clicks are dropped');
  assert.deepEqual(rec.frames[1].events, events);
  assert.equal(rec.seen, 4);
  const reads = session.callsOf('callJson');
  assert.deepEqual(reads[1].args.args, [2, 0], 'the second read resumes at the primed offset');
  assert.equal(session.callsOf('ensureRefStore').length, 2, 'window.__ffuse is installed before every read');
});

test('the page-side reader survives the computer tool trimming its click log', () => {
  // eslint-disable-next-line no-eval
  const read = eval(CLICKS_FN);
  const clicks = [];
  globalThis.window = { __ffuse: { clicks } };
  try {
    clicks.push({ type: 'click', x: 1, y: 2, at: 100 }, { type: 'click', x: 3, y: 4, at: 200 });
    let out = JSON.parse(read(Number.MAX_SAFE_INTEGER, 0));
    assert.equal(out.total, 2);
    assert.equal(out.last, 200, 'priming learns the newest timestamp');

    clicks.push({ type: 'drag', x: 5, y: 6, x2: 7, y2: 8, at: 300, label: 'drag' });
    out = JSON.parse(read(2, 200));
    assert.equal(out.events.length, 1);
    assert.deepEqual(out.events[0], { type: 'drag', x: 5, y: 6, x2: 7, y2: 8, label: 'drag', at: 300 });

    // The log is capped, so the front is dropped and the index cursor overshoots.
    clicks.splice(0, 2);
    clicks.push({ type: 'click', x: 9, y: 9, at: 400 });
    out = JSON.parse(read(3, 300));
    assert.equal(out.total, 2);
    assert.deepEqual(out.events.map((e) => e.at), [400], 'only the genuinely new entry comes back');

    globalThis.window = {};
    assert.deepEqual(JSON.parse(read(0, 0)), { total: 0, last: 0, events: [] }, 'a page without the store is not an error');
  } finally {
    delete globalThis.window;
  }
});

test('a click read that fails still yields a frame', async () => {
  const session = new FakeSession({ responses: { callJson: () => { throw new Error('page went away'); } } });
  const { recorder } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  assert.equal(recorder.stateFor(1).frames.length, 1);
  assert.deepEqual(recorder.stateFor(1).frames[0].events, []);
});

test('exporting with no frames is a clear error, not a crash', async () => {
  const { recorder, session, enc } = setup();
  await assert.rejects(
    () => recorder.run(session, { action: 'export', tabId: 1, download: true }),
    /No frames recorded for tab 1\. Call gif_creator with action "start_recording" first\./
  );
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await recorder.run(session, { action: 'clear', tabId: 1 });
  await assert.rejects(
    () => recorder.run(session, { action: 'export', tabId: 1 }),
    /No frames recorded for tab 1/
  );
  assert.equal(enc.calls.encodeGif.length, 0);
});

test('export decodes, downscales, encodes and writes recording-1.gif', async () => {
  const { recorder, session, clock, enc, fs } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick(2);
  const msg = await recorder.run(session, { action: 'stop_recording', tabId: 1 });
  assert.match(msg, /Frames: 4\./);

  const out = await recorder.run(session, { action: 'export', tabId: 1, download: true });
  assert.equal(enc.calls.decodePng.length, 4);
  assert.deepEqual(enc.calls.resizeRgba.map((c) => c.targetWidth), [800, 800, 800, 800]);
  assert.equal(enc.calls.quantize.length, 1);
  assert.equal(enc.calls.quantize[0].maxColors, 128, 'quality 10 -> 128 colors');
  assert.deepEqual(enc.calls.quantize[0].opts, { dither: true });
  const spec = enc.calls.encodeGif[0];
  assert.equal(spec.width, 800);
  assert.equal(spec.height, 500);
  assert.equal(spec.delayMs, 700);
  assert.equal(spec.loop, 0);
  assert.equal(spec.frames.length, 4);

  const file = path.join(DIR, 'recording-1.gif');
  assert.ok(fs.files.has(file), 'the GIF is written to the download dir');
  assert.deepEqual(fs.dirs[0], { dir: DIR, opts: { recursive: true } });
  assert.ok(out.includes(file), 'the absolute path comes back');
  assert.match(out, /Exported 4 frame\(s\) of tab 1/);
  assert.match(out, /Frames kept: 4/);
  assert.match(out, /800x500, 2\.0 KB, 128 colors, 700ms per frame, quality 10/);

  // Frames survive the export, and the default name counts up.
  assert.equal(recorder.stateFor(1).frames.length, 4);
  const second = await recorder.run(session, { action: 'export', tabId: 1, download: true });
  assert.ok(second.includes(path.join(DIR, 'recording-2.gif')));
});

test('an explicit filename is basenamed, suffixed and leaves the counter alone', async () => {
  const { recorder, session, fs } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  const out = await recorder.run(session, { action: 'export', tabId: 1, filename: '../../etc/report' });
  assert.ok(fs.files.has(path.join(DIR, 'report.gif')), 'no directory escape');
  assert.ok(out.includes(path.join(DIR, 'report.gif')));

  const next = await recorder.run(session, { action: 'export', tabId: 1 });
  assert.ok(next.includes(path.join(DIR, 'recording-1.gif')), 'named exports do not burn a number');

  assert.equal(safeFilename('clip.GIF'), 'clip.GIF');
  assert.equal(safeFilename('a/b/clip'), 'clip.gif');
  assert.throws(() => safeFilename('..'), /Invalid filename/);
  assert.throws(() => safeFilename('   '), /Invalid filename/);
});

test('overlay ops default to on and carry the downscale factor', async () => {
  const events = [
    { type: 'click', x: 10, y: 20, x2: null, y2: null, label: 'click Save' },
    { type: 'drag', x: 4, y: 6, x2: 40, y2: 60, label: 'drag file' },
  ];
  const session = new FakeSession({ responses: { callJson: [{ total: 0, events: [] }, { total: 2, events }] } });
  const { recorder, clock, enc } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick();
  await recorder.run(session, { action: 'export', tabId: 1, download: true });

  const second = enc.calls.drawOverlays[1].ops;
  assert.deepEqual(second.map((op) => op.type), ['arrow', 'circle', 'text', 'progress', 'text']);
  assert.deepEqual(
    second[0],
    { type: 'arrow', x1: 2, y1: 3, x2: 20, y2: 30, color: '#ff0000', width: 2 },
    'drag coordinates scale with the 1600 -> 800 downscale'
  );
  assert.deepEqual(
    second[1],
    { type: 'circle', x: 5, y: 10, r: 11, color: '#ff8c00', fill: false, lineWidth: 2 },
    'a ring, so the click target stays visible'
  );
  assert.equal(second[2].text, 'click Save / drag file');
  assert.equal(second[2].color, '#000000');
  assert.equal(second[2].y, 473, 'the label clears the progress bar');
  assert.equal(second[3].ratio, 1, 'the last frame fills the bar');
  assert.equal(second[3].height, 5);
  assert.equal(second[4].text, 'firefox-use');
  assert.equal(second[4].x, 727, 'right aligned by measuring the bitmap font');
  // drawOverlays rejects op types it does not implement.
  const KNOWN = ['circle', 'arrow', 'rect', 'text', 'progress'];
  for (const { ops } of enc.calls.drawOverlays) {
    for (const op of ops) assert.ok(KNOWN.includes(op.type), `unknown op type ${op.type}`);
  }

  // The first frame has no events, so only the chrome-level overlays show.
  assert.deepEqual(enc.calls.drawOverlays[0].ops.map((op) => op.type), ['progress', 'text']);
  assert.equal(enc.calls.drawOverlays[0].ops[0].ratio, 0.5, 'half way through two frames');
});

test('every overlay can be switched off, and then drawOverlays is not called', async () => {
  const session = new FakeSession({ responses: { callJson: [{ total: 0, events: [] }] } });
  const { recorder, enc } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await recorder.run(session, {
    action: 'export',
    tabId: 1,
    options: {
      showClickIndicators: false,
      showDragPaths: false,
      showActionLabels: false,
      showProgressBar: false,
      showWatermark: false,
    },
  });
  assert.equal(enc.calls.drawOverlays.length, 0);
  assert.equal(enc.calls.encodeGif.length, 1, 'the GIF is still produced');

  const defaults = mergeOptions(undefined);
  assert.deepEqual(defaults, {
    showClickIndicators: true,
    showDragPaths: true,
    showActionLabels: true,
    showProgressBar: true,
    showWatermark: true,
    quality: 10,
  });
  assert.equal(mergeOptions({ showWatermark: false }).showWatermark, false);
  assert.equal(mergeOptions({ showWatermark: 'false' }).showWatermark, false);
  const off = { ...defaults, showClickIndicators: false, showDragPaths: false, showActionLabels: false, showProgressBar: false, showWatermark: false };
  assert.deepEqual(overlayOps({ width: 100, height: 50, events: [{ x: 1, y: 2 }], options: off }), []);
});

test('quality maps to a palette size and is validated', async () => {
  assert.equal(paletteSize(1), 256);
  assert.equal(paletteSize(5), 256);
  assert.equal(paletteSize(10), 128);
  assert.equal(paletteSize(16), 64);
  assert.equal(paletteSize(23), 32);
  assert.equal(paletteSize(30), 16);
  assert.equal(ditherFor(10), true);
  assert.equal(ditherFor(11), false);
  assert.equal(mergeOptions({ quality: 3.4 }).quality, 3);
  assert.throws(() => mergeOptions({ quality: 0 }), /quality must be a number between 1 and 30/);
  assert.throws(() => mergeOptions({ quality: 31 }), /quality must be a number between 1 and 30/);
  assert.throws(() => mergeOptions({ quality: 'high' }), /quality must be a number between 1 and 30/);

  const { recorder, session, enc } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await recorder.run(session, { action: 'export', tabId: 1, options: { quality: 20 } });
  assert.equal(enc.calls.quantize[0].maxColors, 32);
  assert.deepEqual(enc.calls.quantize[0].opts, { dither: false });
});

test('export stops a running recording and says so', async () => {
  const { recorder, session, clock } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  const out = await recorder.run(session, { action: 'export', tabId: 1, download: true });
  assert.match(out, /Recording was still running and has been stopped\./);
  assert.equal(recorder.stateFor(1).recording, false);
  assert.equal(clock.pending(), 0);
});

test('frames that do not match the first frame size are skipped, not encoded', async () => {
  let decoded = 0;
  const enc = fakeGifenc({
    decodePng(buf) {
      decoded += 1;
      enc.calls.decodePng.push(buf);
      return decoded === 3 ? { width: 1600, height: 900, data: buf } : { width: 1600, height: 1000, data: buf };
    },
  });
  const { recorder, session, clock } = setup({ gifenc: enc });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick(2);
  const out = await recorder.run(session, { action: 'export', tabId: 1, download: true });
  assert.equal(enc.calls.encodeGif[0].frames.length, 2);
  assert.match(out, /Exported 2 frame\(s\)/);
  assert.match(out, /Skipped 1 frame\(s\) that did not match 800x500\./);
});

test('clear discards the frames and stops the loop', async () => {
  const { recorder, session, clock } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick();
  const msg = await recorder.run(session, { action: 'clear', tabId: 1 });
  assert.equal(msg, 'Cleared 2 frame(s) for tab 1. Frames: 0.');
  assert.equal(recorder.stateFor(1), null);
  assert.equal(clock.pending(), 0);
  assert.equal(await recorder.run(session, { action: 'clear', tabId: 1 }), 'Nothing to clear for tab 1. Frames: 0.');
});

test('recordings are scoped per tab', async () => {
  const session = new FakeSession({
    tabs: [{ tabId: 1, context: 'ctx-1', url: 'https://a/' }, { tabId: 2, context: 'ctx-2', url: 'https://b/' }],
  });
  const { recorder, clock } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await recorder.run(session, { action: 'start_recording', tabId: 2 });
  await clock.tick(2);
  assert.equal(recorder.stateFor(1).frames.length, 2);
  assert.equal(recorder.stateFor(2).frames.length, 2);
  await recorder.run(session, { action: 'clear', tabId: 1 });
  assert.equal(recorder.stateFor(1), null);
  assert.equal(recorder.stateFor(2).frames.length, 2);
  assert.equal(clock.pending(), 1, 'only tab 2 is still recording');
});

test('bad input is rejected with the shared wording', async () => {
  const { recorder, session } = setup();
  await assert.rejects(
    () => recorder.run(session, { action: 'record', tabId: 1 }),
    /Unknown action "record"\. Use start_recording, stop_recording, export or clear\./
  );
  await assert.rejects(() => recorder.run(session, { action: 'clear' }), /tabId is required/);
  await assert.rejects(() => recorder.run(session, { action: 'clear', tabId: 'x' }), /tabId must be a number/);
  await assert.rejects(
    () => recorder.run(session, { action: 'start_recording', tabId: 9 }),
    /Tab 9 no longer exists\. Call tabs_context_mcp to get valid tab ids\./
  );
  assert.equal(recorder.stateFor(9), null, 'a failed start leaves no state behind');
});

test('the frame delay follows the measured cadence within GIF limits', () => {
  assert.equal(frameDelay([{ at: 0 }], 700), 700);
  assert.equal(frameDelay([], 700), 700);
  assert.equal(frameDelay([{ at: 0 }, { at: 704 }, { at: 1404 }], 700), 700);
  assert.equal(frameDelay([{ at: 0 }, { at: 10 }], 700), 60, 'clamped up to 60ms');
  assert.equal(frameDelay([{ at: 0 }, { at: 90000 }], 700), 2000, 'clamped down to 2s');
});

test('the tool handler routes through ctx.session and ctx.config.downloadDir', async () => {
  const session = new FakeSession();
  const ctx = fakeCtx(session);
  const enc = fakeGifenc();
  const fs = fakeFs();
  const recorder = new GifRecorder({ gifenc: enc, fs, downloadDir: () => ctx.config.downloadDir, setTimeoutFn: () => null });
  const [def] = tools(ctx, recorder);
  assert.match(await def.handler({ action: 'start_recording', tabId: 1 }), /Recording tab 1\./);
  const out = await def.handler({ action: 'export', tabId: 1, download: true });
  assert.ok(out.includes(path.join(ctx.config.downloadDir, 'recording-1.gif')));
  assert.ok(fs.files.has(path.join(ctx.config.downloadDir, 'recording-1.gif')));
});

test('a click log sitting at its 200 entry cap still reports new clicks', () => {
  // eslint-disable-next-line no-eval
  const read = eval(CLICKS_FN);
  const clicks = [];
  globalThis.window = { __ffuse: { clicks } };
  try {
    for (let i = 0; i < 200; i++) clicks.push({ type: 'click', x: i, y: i, at: 1000 + i });
    let out = JSON.parse(read(Number.MAX_SAFE_INTEGER, 0));
    assert.equal(out.total, 200);
    assert.equal(out.last, 1199);

    // computer.js keeps the log at 200 by dropping its front, so from here on
    // the length never changes and the index cursor alone can never see a new
    // entry: the timestamp has to be what decides.
    clicks.shift();
    clicks.push({ type: 'click', x: 9, y: 9, at: 1300, label: 'left click' });
    out = JSON.parse(read(200, 1199));
    assert.equal(out.total, 200);
    assert.deepEqual(out.events.map((e) => e.at), [1300], 'the newest click is not lost behind a full log');
    assert.equal(out.last, 1300);

    // ...and reading again with the advanced cursor does not replay it.
    assert.deepEqual(JSON.parse(read(200, 1300)).events, []);
  } finally {
    delete globalThis.window;
  }
});

test('restarting after the frame cap does not walk past it', async () => {
  const { recorder, session, clock } = setup();
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await clock.tick(500);
  assert.equal(recorder.stateFor(1).frames.length, DEFAULTS.maxFrames);
  const shots = session.callsOf('screenshot').length;

  const msg = await recorder.run(session, { action: 'start_recording', tabId: 1 });
  assert.equal(
    msg,
    'Frame cap of 120 reached for tab 1. Frames: 120. '
    + 'Call gif_creator with action "export" or "clear" before recording again.'
  );
  assert.equal(recorder.stateFor(1).frames.length, DEFAULTS.maxFrames, 'no frame past the cap');
  assert.equal(session.callsOf('screenshot').length, shots, 'and no capture');
  assert.equal(clock.pending(), 0, 'and no timer');

  await recorder.run(session, { action: 'clear', tabId: 1 });
  assert.match(await recorder.run(session, { action: 'start_recording', tabId: 1 }), /Recording tab 1\./);
});

// A screenshot takes real time; stop / clear / export can land while one is in
// flight and must win, or the finished capture would resurrect the loop.
function gatedSession(responses = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let shots = 0;
  const shot = { data: Buffer.from('png').toString('base64'), mimeType: 'image/png' };
  const session = new FakeSession({
    responses: {
      screenshot: () => {
        shots += 1;
        return shots === 2 ? gate.then(() => shot) : shot;
      },
      ...responses,
    },
  });
  return { session, release: () => release() };
}

test('a stop that lands mid-capture drops that frame and leaves no timer', async () => {
  const { session, release } = gatedSession();
  const { recorder, clock } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  const inflight = clock.tick();

  const msg = await recorder.run(session, { action: 'stop_recording', tabId: 1 });
  assert.equal(msg, 'Stopped recording tab 1. Frames: 2.');
  release();
  await inflight;

  const rec = recorder.stateFor(1);
  assert.equal(rec.frames.length, 2, 'the abandoned run does not append its frame');
  assert.equal(rec.recording, false);
  assert.equal(clock.pending(), 0, 'the finished capture must not re-arm the loop');
  assert.equal(await clock.tick(3), 0);
});

test('a clear that lands mid-capture ends the loop for good', async () => {
  const { session, release } = gatedSession();
  const { recorder, clock } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  const inflight = clock.tick();

  assert.equal(await recorder.run(session, { action: 'clear', tabId: 1 }), 'Cleared 1 frame(s) for tab 1. Frames: 0.');
  release();
  await inflight;

  assert.equal(recorder.stateFor(1), null, 'the discarded recording stays discarded');
  assert.equal(clock.pending(), 0);
  assert.equal(session.callsOf('screenshot').length, 2, 'no capture after the clear');
});

test('labels are stripped of control characters and bounded in length', () => {
  assert.equal(cleanLabel('left click'), 'left click');
  assert.equal(cleanLabel('  drag\u0007 file\n'), 'drag file');
  assert.equal(cleanLabel(null), '');
  assert.equal(cleanLabel(undefined), '');
  const long = cleanLabel('x'.repeat(200));
  assert.equal(long.length, 48);
  assert.ok(long.endsWith('...'));

  const options = mergeOptions();
  const ops = overlayOps({ width: 200, height: 100, events: [{ x: 1, y: 2, label: '\u0001' }], options });
  const texts = ops.filter((op) => op.type === 'text');
  assert.equal(texts.length, 1, 'an unprintable label draws no label box');
  assert.equal(texts[0].text, 'firefox-use');
});

test('a frame that will not decode says which frame it was', async () => {
  const enc = fakeGifenc({ decodePng() { throw new Error('PNG: not a PNG file'); } });
  const { recorder, session } = setup({ gifenc: enc });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  await assert.rejects(
    () => recorder.run(session, { action: 'export', tabId: 1, download: true }),
    /Frame 1 of tab 1 could not be decoded: PNG: not a PNG file/
  );
});

test('clicks drained by an abandoned capture land on the frame that ended the run', async () => {
  const click = { type: 'click', x: 10, y: 20, x2: null, y2: null, label: 'left click', at: 500 };
  // The read that rides along with the blocked screenshot takes the click off
  // the page's log, so the frame stop_recording captures reads nothing new.
  const { session, release } = gatedSession({
    callJson: [
      { total: 0, last: 0, events: [] },
      { total: 1, last: 500, events: [click] },
      { total: 1, last: 500, events: [] },
    ],
  });
  const { recorder, clock } = setup({ session });
  await recorder.run(session, { action: 'start_recording', tabId: 1 });
  const inflight = clock.tick();
  await recorder.run(session, { action: 'stop_recording', tabId: 1 });
  release();
  await inflight;

  const rec = recorder.stateFor(1);
  assert.equal(rec.frames.length, 2);
  assert.deepEqual(rec.frames[1].events, [click], 'the click is not swallowed with the dropped frame');
});
