'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FakeSession, fakeCtx } = require('./helpers/fake-session');
const {
  computer, tools, TOOL,
  parseModifiers, isZoomShortcut, keyActions, splitChord,
  readRegion, readRepeat, readScrollAmount, readDuration, readCoordinate,
  CLICK_LOG_FN, MAX_CLICK_LOG,
} = require('../src/computer');

const META = '\uE03D';
const SHIFT = '\uE008';
const ENTER = '\uE007';
const BACKSPACE = '\uE003';
const DELETE = '\uE017';
const ARROW_DOWN = '\uE015';

const run = (session, args, ctx) => computer(session, { tabId: 1, ...args }, ctx);
const lastActions = (session) => session.callsOf('performActions').at(-1).args.actions;

test('the tool definition is the Chrome spec verbatim', () => {
  const spec = require('../docs/chrome-tool-spec.json').find((t) => t.name === 'computer');
  const [tool] = tools(fakeCtx(new FakeSession()));
  assert.equal(tool.name, 'computer');
  assert.equal(tool.description, spec.description);
  assert.deepStrictEqual(tool.inputSchema, spec.inputSchema);
  assert.deepStrictEqual(TOOL.inputSchema.properties.action.enum, [
    'left_click', 'right_click', 'type', 'screenshot', 'wait', 'scroll', 'key',
    'left_click_drag', 'double_click', 'triple_click', 'zoom', 'scroll_to', 'hover',
  ]);
  assert.equal(typeof tool.handler, 'function');
});

test('left_click sends one pointer source: move, down, pause, up', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'left_click', coordinate: [10, 20] });
  assert.equal(text, 'Clicked (10, 20).');
  assert.deepStrictEqual(lastActions(session), [{
    type: 'pointer',
    id: 'mouse',
    parameters: { pointerType: 'mouse' },
    actions: [
      { type: 'pointerMove', x: 10, y: 20, origin: 'viewport', duration: 40 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 30 },
      { type: 'pointerUp', button: 0 },
    ],
  }]);
});

test('right/double/triple clicks differ only in button and press count', async () => {
  const session = new FakeSession();
  await run(session, { action: 'right_click', coordinate: [1, 2] });
  const right = lastActions(session)[0].actions;
  assert.deepStrictEqual(right.slice(1), [
    { type: 'pointerDown', button: 2 },
    { type: 'pause', duration: 30 },
    { type: 'pointerUp', button: 2 },
  ]);

  await run(session, { action: 'double_click', coordinate: [1, 2] });
  const dbl = lastActions(session)[0].actions;
  assert.equal(dbl.filter((a) => a.type === 'pointerDown').length, 2);
  assert.deepStrictEqual(dbl[4], { type: 'pause', duration: 60 }, 'gap between the two pairs');

  const triple = await run(session, { action: 'triple_click', coordinate: [1, 2] });
  const acts = lastActions(session)[0].actions;
  assert.equal(acts.filter((a) => a.type === 'pointerUp').length, 3);
  assert.equal(acts.filter((a) => a.type === 'pause' && a.duration === 60).length, 2);
  assert.equal(triple, 'Triple-clicked (1, 2).');
});

test('modifiers are held by a key source aligned with the pointer source', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'left_click', coordinate: [5, 6], modifiers: 'cmd+shift' });
  const [keys, mouse] = lastActions(session);
  assert.equal(keys.type, 'key');
  assert.equal(mouse.type, 'pointer');
  assert.deepStrictEqual(keys.actions, [
    { type: 'keyDown', value: META },
    { type: 'keyDown', value: SHIFT },
    { type: 'pause', duration: 0 },
    { type: 'pause', duration: 0 },
    { type: 'pause', duration: 0 },
    { type: 'pause', duration: 0 },
    { type: 'keyUp', value: SHIFT },
    { type: 'keyUp', value: META },
  ]);
  // Same tick count on both sources, with the click in the middle.
  assert.equal(mouse.actions.length, keys.actions.length);
  assert.deepStrictEqual(mouse.actions[0], { type: 'pause', duration: 0 });
  assert.deepStrictEqual(mouse.actions[2], { type: 'pointerMove', x: 5, y: 6, origin: 'viewport', duration: 40 });
  assert.equal(text, 'Clicked (5, 6) with cmd+shift held.');
});

test('modifier names map onto WebDriver keys and unknown ones are refused', () => {
  assert.deepStrictEqual(parseModifiers('win').map((m) => m.value), [META]);
  assert.deepStrictEqual(parseModifiers('CMD + Alt').map((m) => m.name), ['cmd', 'alt']);
  assert.deepStrictEqual(parseModifiers(''), []);
  assert.deepStrictEqual(parseModifiers(undefined), []);
  assert.throws(() => parseModifiers('fn'), /unknown modifier: fn/);
});

test('a ref targets the element centre and refuses to guess without one', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'left_click', ref: 'ref_3' });
  assert.equal(session.callsOf('ensureRefStore').length, 1);
  assert.deepStrictEqual(session.callsOf('resolveRef')[0].args.opts, { scroll: true });
  assert.deepStrictEqual(lastActions(session)[0].actions[0], {
    type: 'pointerMove', x: 100, y: 200, origin: 'viewport', duration: 40,
  });
  assert.equal(text, 'Clicked ref_3 at (100, 200).');

  await assert.rejects(
    () => run(session, { action: 'left_click' }),
    /left_click needs a coordinate \[x, y\] or a ref from read_page or find\./
  );
  await assert.rejects(() => run(session, { action: 'left_click', ref: 'nope' }), /Element nope was not found/);
});

test('bad coordinates are rejected before anything is sent to the page', async () => {
  const session = new FakeSession();
  await assert.rejects(() => run(session, { action: 'left_click', coordinate: [5] }), /coordinate must be \[x, y\]/);
  await assert.rejects(() => run(session, { action: 'left_click', coordinate: ['a', 2] }), /coordinate must be \[x, y\]/);
  await assert.rejects(() => run(session, { action: 'left_click', coordinate: [5, -2] }), /is outside the viewport/);
  assert.equal(session.callsOf('performActions').length, 0);
  assert.deepStrictEqual(readCoordinate([10.4, 20.6]), { x: 10, y: 21 });
});

test('hover only moves the pointer', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'hover', coordinate: [7, 8] });
  assert.deepStrictEqual(lastActions(session)[0].actions, [
    { type: 'pointerMove', x: 7, y: 8, origin: 'viewport', duration: 60 },
  ]);
  assert.equal(text, 'Moved the mouse to (7, 8) without clicking.');
});

test('left_click_drag presses, moves with a real duration, releases', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'left_click_drag', start_coordinate: [10, 10], coordinate: [90, 40] });
  assert.deepStrictEqual(lastActions(session)[0].actions, [
    { type: 'pointerMove', x: 10, y: 10, origin: 'viewport', duration: 40 },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 30 },
    { type: 'pointerMove', x: 90, y: 40, origin: 'viewport', duration: 300 },
    { type: 'pause', duration: 30 },
    { type: 'pointerUp', button: 0 },
  ]);
  assert.equal(text, 'Dragged from (10, 10) to (90, 40).');

  const fromHere = await run(session, { action: 'left_click_drag', coordinate: [90, 40] });
  assert.equal(lastActions(session)[0].actions[0].type, 'pointerDown', 'no move when no start is given');
  assert.match(fromHere, /Dragged from the current pointer position to \(90, 40\)\./);
});

test('scroll turns wheel ticks into pixel deltas at the coordinate', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'scroll', coordinate: [400, 300], scroll_direction: 'down' });
  assert.deepStrictEqual(lastActions(session), [{
    type: 'wheel',
    id: 'wheel',
    actions: [{
      type: 'scroll', x: 400, y: 300, deltaX: 0, deltaY: 300, origin: 'viewport', duration: 100,
    }],
  }]);
  assert.equal(text, 'Scrolled down 3 ticks (300px) at (400, 300).');

  await run(session, { action: 'scroll', coordinate: [1, 1], scroll_direction: 'up', scroll_amount: 1 });
  assert.deepStrictEqual(lastActions(session)[0].actions[0].deltaY, -100);
  await run(session, { action: 'scroll', coordinate: [1, 1], scroll_direction: 'right', scroll_amount: 10 });
  assert.deepStrictEqual(lastActions(session)[0].actions[0], {
    type: 'scroll', x: 1, y: 1, deltaX: 1000, deltaY: 0, origin: 'viewport', duration: 100,
  });
  await run(session, { action: 'scroll', coordinate: [1, 1], scroll_direction: 'left' });
  assert.equal(lastActions(session)[0].actions[0].deltaX, -300);
});

test('scroll validates direction, amount and target', async () => {
  const session = new FakeSession();
  await assert.rejects(
    () => run(session, { action: 'scroll', coordinate: [1, 1] }),
    /scroll needs scroll_direction: up, down, left or right\./
  );
  await assert.rejects(
    () => run(session, { action: 'scroll', coordinate: [1, 1], scroll_direction: 'sideways' }),
    /scroll needs scroll_direction/
  );
  await assert.rejects(
    () => run(session, { action: 'scroll', scroll_direction: 'down' }),
    /scroll needs a coordinate \[x, y\] or a ref/
  );
  await assert.rejects(
    () => run(session, { action: 'scroll', coordinate: [1, 1], scroll_direction: 'down', scroll_amount: 11 }),
    /scroll_amount counts wheel ticks and must be between 1 and 10\./
  );
  assert.equal(readScrollAmount(undefined), 3);
  assert.throws(() => readScrollAmount(0), /between 1 and 10/);
});

test('type sends a key source and turns newlines into Enter', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'type', text: 'hi\n' });
  const [source] = lastActions(session);
  assert.equal(source.type, 'key');
  assert.equal(source.id, 'keyboard');
  assert.deepStrictEqual(source.actions.slice(0, 2), [
    { type: 'keyDown', value: 'h' }, { type: 'keyUp', value: 'h' },
  ]);
  assert.deepStrictEqual(source.actions.slice(-2), [
    { type: 'keyDown', value: ENTER }, { type: 'keyUp', value: ENTER },
  ]);
  assert.equal(text, 'Typed 3 characters including 1 Enter press.');
  // One key press per code point, so an astral character counts once.
  const emoji = await run(session, { action: 'type', text: 'a\u{1F600}' });
  assert.equal(lastActions(session)[0].actions.length, 4);
  assert.equal(emoji, 'Typed 2 characters.');
  await assert.rejects(() => run(session, { action: 'type', text: '' }), /the type action needs text to type\./);
});

test('type clicks first when given a target, so the text lands in that field', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'type', text: 'ab', coordinate: [30, 40] });
  const calls = session.callsOf('performActions');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.actions[0].type, 'pointer');
  assert.equal(calls[1].args.actions[0].type, 'key');
  assert.equal(text, 'Typed 2 characters after clicking (30, 40).');
});

test('key parses space-separated keys and chords, and repeats the whole sequence', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'key', text: 'Backspace Backspace Delete' });
  assert.deepStrictEqual(lastActions(session)[0].actions.map((a) => a.value), [
    BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, DELETE, DELETE,
  ]);
  assert.equal(text, 'Pressed Backspace Backspace Delete.');

  await run(session, { action: 'key', text: 'cmd+a' });
  assert.deepStrictEqual(lastActions(session)[0].actions, [
    { type: 'keyDown', value: META },
    { type: 'keyDown', value: 'a' },
    { type: 'keyUp', value: 'a' },
    { type: 'keyUp', value: META },
  ]);

  const repeated = await run(session, { action: 'key', text: 'ArrowDown', repeat: 3 });
  const actions = lastActions(session)[0].actions;
  assert.equal(actions.length, 6);
  assert.ok(actions.every((a) => a.value === ARROW_DOWN));
  assert.equal(repeated, 'Pressed ArrowDown 3 times.');

  // 100 is the schema maximum, so it has to be accepted, not rejected.
  await run(session, { action: 'key', text: 'ArrowDown', repeat: 100 });
  assert.equal(lastActions(session)[0].actions.length, 200);
});

test('key rejects a bad repeat, empty text and unknown keys', async () => {
  const session = new FakeSession();
  for (const repeat of [0, 101, 1.5]) {
    await assert.rejects(
      () => run(session, { action: 'key', text: 'Enter', repeat }),
      /repeat must be a whole number between 1 and 100\./
    );
  }
  assert.equal(readRepeat(undefined), 1);
  await assert.rejects(() => run(session, { action: 'key', text: '   ' }), /the key action needs text/);
  await assert.rejects(() => run(session, { action: 'key', text: 'cmd+nope' }), /cannot press "cmd\+nope": unknown key: nope/);
  assert.equal(session.callsOf('performActions').length, 0);
});

test('page zoom shortcuts are refused and point at the zoom action', async () => {
  const session = new FakeSession();
  for (const combo of ['cmd+=', 'cmd+-', 'cmd+0', 'ctrl+=', 'CMD+Plus', 'cmd++', 'ctrl+shift+=']) {
    assert.equal(isZoomShortcut(combo), true, combo);
    await assert.rejects(
      () => run(session, { action: 'key', text: `Escape ${combo}` }),
      /page zoom shortcuts like ".+" are not supported\. Use the zoom action to magnify a region of the page instead\./,
      combo
    );
  }
  for (const combo of ['cmd+a', 'shift+0', 'Enter', '-', 'ctrl+shift+r']) {
    assert.equal(isZoomShortcut(combo), false, combo);
  }
  assert.doesNotThrow(() => keyActions('ctrl+shift+r'));
});

test('a "+" in a chord is a key, and a chord that names none is refused', async () => {
  const session = new FakeSession();
  assert.deepStrictEqual(splitChord('cmd+shift+t'), { mods: ['cmd', 'shift'], key: 't' });
  assert.deepStrictEqual(splitChord('shift++'), { mods: ['shift'], key: '+' });
  assert.deepStrictEqual(splitChord('+'), { mods: [], key: '+' });
  assert.throws(() => splitChord('cmd+'), /ends with "\+" but names no key/);

  // A trailing "+" used to be dropped, which pressed the modifier on its own.
  await run(session, { action: 'key', text: 'shift++' });
  assert.deepStrictEqual(lastActions(session)[0].actions, [
    { type: 'keyDown', value: SHIFT },
    { type: 'keyDown', value: '+' },
    { type: 'keyUp', value: '+' },
    { type: 'keyUp', value: SHIFT },
  ]);

  await assert.rejects(
    () => run(session, { action: 'key', text: 'cmd+ a' }),
    /cannot press "cmd\+": "cmd\+" ends with "\+" but names no key/
  );
  assert.equal(isZoomShortcut('cmd+'), false, 'a dangling + is malformed, not a zoom shortcut');
  await assert.rejects(() => run(session, { action: 'key', text: 'nope++' }), /cannot press "nope\+\+": not a modifier: nope/);
  assert.equal(session.callsOf('performActions').length, 1, 'nothing sent for the refused chords');
});

test('a failed action releases the input state before the error is reported', async () => {
  const session = new FakeSession();
  session.performActions = async () => { throw new Error('move target out of bounds'); };
  await assert.rejects(
    () => run(session, { action: 'left_click', coordinate: [5000, 5000], modifiers: 'cmd' }),
    /move target out of bounds/
  );
  const released = session.callsOf('send').filter((c) => c.args.method === 'input.releaseActions');
  assert.equal(released.length, 1, 'cmd must not stay held down for the next action');
  assert.deepStrictEqual(released[0].args.params, { context: 'ctx-1' });

  // A release that fails too must not mask the original error.
  session.send = async () => { throw new Error('tab is gone'); };
  await assert.rejects(() => run(session, { action: 'key', text: 'Enter' }), /move target out of bounds/);
});

test('wait validates the duration and reports what it waited', async () => {
  const session = new FakeSession();
  const started = Date.now();
  assert.equal(await run(session, { action: 'wait', duration: 0.01 }), 'Waited 0.01 seconds.');
  assert.equal(await run(session, { action: 'wait', duration: 1 }), 'Waited 1 second.');
  assert.ok(Date.now() - started >= 1000, 'actually waits');
  await assert.rejects(() => run(session, { action: 'wait' }), /the wait action needs duration in seconds \(0 to 10\)\./);
  await assert.rejects(() => run(session, { action: 'wait', duration: 11 }), /duration is capped at 10 seconds/);
  await assert.rejects(() => run(session, { action: 'wait', duration: -1 }), /between 0 and 10/);
  assert.equal(readDuration(10), 10);
});

test('screenshot returns the image plus a text line with url, viewport and imageId', async () => {
  const session = new FakeSession();
  const res = await run(session, { action: 'screenshot' }, fakeCtx(session));
  assert.equal(res.content.length, 2);
  assert.deepStrictEqual(res.content[0], {
    type: 'image',
    data: Buffer.from('fake-png').toString('base64'),
    mimeType: 'image/png',
  });
  assert.equal(res.content[1].type, 'text');
  assert.equal(res.content[1].text, 'Screenshot of https://example.com/ | viewport 1280x800 | imageId img_1');
  const stored = session.images.get('img_1');
  assert.equal(stored.mimeType, 'image/png');
  assert.deepStrictEqual([stored.width, stored.height], [1280, 800]);
  assert.equal(stored.path, null, 'nothing written without save_to_disk');
  assert.deepStrictEqual(session.callsOf('screenshot')[0].args, { tabId: 1 });
});

test('save_to_disk writes the png under downloadDir and names the absolute path', async () => {
  const session = new FakeSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-computer-'));
  const ctx = { session: async () => session, config: { downloadDir: dir } };
  try {
    const res = await run(session, { action: 'screenshot', save_to_disk: true }, ctx);
    const file = path.join(dir, 'screenshot-img_1.png');
    assert.equal(fs.readFileSync(file, 'utf8'), 'fake-png');
    assert.ok(res.content[1].text.endsWith(`| saved to ${file}`), res.content[1].text);
    assert.equal(session.images.get('img_1').path, file, 'upload_image can find it on disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zoom captures a clipped region and validates it against the viewport', async () => {
  const session = new FakeSession();
  const res = await run(session, { action: 'zoom', region: [10, 20, 110, 70] }, fakeCtx(session));
  assert.deepStrictEqual(session.callsOf('screenshot')[0].args, {
    tabId: 1, clip: { x: 10, y: 20, width: 100, height: 50 },
  });
  assert.equal(res.content[0].type, 'image');
  assert.equal(res.content[1].text, 'Zoom of region [10, 20, 110, 70] on https://example.com/ | 100x50 px | imageId img_1');

  await assert.rejects(() => run(session, { action: 'zoom', region: [10, 20, 10, 70] }), /is empty; it needs x1 > x0 and y1 > y0/);
  await assert.rejects(() => run(session, { action: 'zoom', region: [10, 20, 110, 20] }), /is empty; it needs x1 > x0 and y1 > y0/);
  await assert.rejects(() => run(session, { action: 'zoom', region: [-1, 0, 10, 10] }), /must not be negative/);
  await assert.rejects(() => run(session, { action: 'zoom', region: [0, 0, 2000, 100] }), /falls outside the 1280x800 viewport/);
  await assert.rejects(() => run(session, { action: 'zoom', region: [0, 0, 10] }), /zoom needs region \[x0, y0, x1, y1\]/);
  await assert.rejects(() => run(session, { action: 'zoom' }), /zoom needs region \[x0, y0, x1, y1\]/);
  assert.deepStrictEqual(readRegion([0, 0, 5, 5], null), { x: 0, y: 0, width: 5, height: 5 });
  // The whole viewport is inside the viewport; only past its edge is an error.
  await run(session, { action: 'zoom', region: [0, 0, 1280, 800] }, fakeCtx(session));
  assert.deepStrictEqual(session.callsOf('screenshot').at(-1).args.clip, { x: 0, y: 0, width: 1280, height: 800 });
});

test('scroll_to needs a ref and reports where the element landed', async () => {
  const session = new FakeSession();
  await assert.rejects(() => run(session, { action: 'scroll_to' }), /scroll_to needs a ref from read_page or find\./);
  const text = await run(session, { action: 'scroll_to', ref: 'ref_9' });
  assert.deepStrictEqual(session.callsOf('resolveRef')[0].args, { tabId: 1, ref: 'ref_9', opts: { scroll: true } });
  assert.equal(text, 'Scrolled ref_9 <button> into view: center (100, 200), 40x20, fully in the viewport.');

  const offscreen = new FakeSession({ responses: { resolveRef: [{ found: true, x: 5, y: 900, width: 10, height: 10, tag: 'div', inViewport: false }] } });
  assert.match(await run(offscreen, { action: 'scroll_to', ref: 'ref_1' }), /still partly outside the viewport\.$/);
});

test('pointer actions append to the page click log, but a failed write never fails the click', async () => {
  const session = new FakeSession();
  await run(session, { action: 'left_click', coordinate: [10, 20] });
  const [logged] = session.callsOf('callFunction');
  assert.equal(logged.args.fn, CLICK_LOG_FN);
  assert.deepStrictEqual(logged.args.args, [
    { type: 'left_click', x: 10, y: 20, label: 'left click' }, MAX_CLICK_LOG,
  ]);

  // gif_creator draws an arrow only for a single entry carrying x2/y2.
  await run(session, { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] });
  assert.deepStrictEqual(session.callsOf('callFunction').at(-1).args.args[0], {
    type: 'drag', x: 1, y: 2, x2: 3, y2: 4, label: 'left click drag',
  });

  await run(session, { action: 'left_click_drag', coordinate: [3, 4] });
  assert.deepStrictEqual(session.callsOf('callFunction').at(-1).args.args[0], {
    type: 'left_click_drag', x: 3, y: 4, label: 'left click drag',
  });

  session.callFunction = async () => { throw new Error('page went away'); };
  assert.equal(await run(session, { action: 'hover', coordinate: [1, 1] }), 'Moved the mouse to (1, 1) without clicking.');
});

test('the click log script is a valid ASCII page function that caps the trail', () => {
  assert.ok(!/[^\x20-\x7e\n]/.test(CLICK_LOG_FN), 'no raw control or non-ASCII characters');
  const win = {};
  const log = new Function('window', `return ${CLICK_LOG_FN}`)(win);
  for (let i = 0; i < MAX_CLICK_LOG + 5; i++) {
    log({ type: 'left_click', x: i, y: i * 2, label: 'left click' }, MAX_CLICK_LOG);
  }
  assert.equal(win.__ffuse.clicks.length, MAX_CLICK_LOG);
  const last = win.__ffuse.clicks.at(-1);
  assert.equal(last.type, 'left_click');
  assert.deepStrictEqual([last.x, last.y], [MAX_CLICK_LOG + 4, (MAX_CLICK_LOG + 4) * 2]);
  assert.equal(typeof last.at, 'number');
  assert.equal(last.x2, undefined, 'a plain click carries no drag end point');
  assert.equal(win.__ffuse.clicks[0].x, 5, 'oldest entries drop off the front');

  log({ type: 'drag', x: 1, y: 2, x2: 3, y2: 4 }, MAX_CLICK_LOG);
  const drag = win.__ffuse.clicks.at(-1);
  assert.deepStrictEqual([drag.type, drag.x2, drag.y2], ['drag', 3, 4]);
});

test('a stale tab id fails with the Chrome wording, and an omitted one falls back', async () => {
  const session = new FakeSession();
  await assert.rejects(
    () => computer(session, { action: 'wait', duration: 0, tabId: 99 }),
    /Tab 99 no longer exists\. Call tabs_context_mcp to get valid tab ids\./
  );
  assert.equal(await computer(session, { action: 'wait', duration: 0 }), 'Waited 0 seconds.');
  await assert.rejects(() => computer(session, {}), /action is required/);
  await assert.rejects(() => run(session, { action: 'middle_click' }), /unknown action: middle_click\. Supported: left_click, /);
});

test('the handler resolves the session from ctx and runs the action', async () => {
  const session = new FakeSession();
  const [tool] = tools(fakeCtx(session));
  const text = await tool.handler({ action: 'left_click', coordinate: [2, 3], tabId: 1 });
  assert.equal(text, 'Clicked (2, 3).');
  assert.equal(session.callsOf('performActions').length, 1);
});
