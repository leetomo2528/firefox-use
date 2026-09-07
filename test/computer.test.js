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
  CLICK_LOG_FN, MAX_CLICK_LOG, INPUT_TIMEOUT, RELEASE_TIMEOUT,
} = require('../src/computer');

const META = '\uE03D';
const SHIFT = '\uE008';
const ENTER = '\uE007';
const BACKSPACE = '\uE003';
const DELETE = '\uE017';
const ARROW_DOWN = '\uE015';

const run = (session, args, ctx) => computer(session, { tabId: 1, ...args }, ctx);
// Input goes out as a raw BiDi command so it can carry its own short timeout.
const inputCalls = (session) => session.callsOf('send').filter((c) => c.args.method === 'input.performActions');
const releaseCalls = (session) => session.callsOf('send').filter((c) => c.args.method === 'input.releaseActions');
const lastActions = (session) => inputCalls(session).at(-1).args.params.actions;

// Make input.performActions fail the way a stuck tab does, keeping the record.
function failInput(session, message) {
  const send = Object.getPrototypeOf(session).send;
  session.send = async function (method, params, opts) {
    const res = await send.call(this, method, params, opts);
    if (method === 'input.performActions') throw new Error(message);
    return res;
  };
}

// A ref that resolved to a display:none element: a box of zeros at the origin.
const HIDDEN_REF = {
  found: true, visible: false, x: 0, y: 0, left: 0, top: 0,
  width: 0, height: 0, inViewport: true, tag: 'button',
};

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
  assert.equal(inputCalls(session).length, 0);
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

test('type clicks first for a ref, so the text lands in that field', async () => {
  const session = new FakeSession();
  const text = await run(session, { action: 'type', text: 'ab', ref: 'ref_7' });
  const calls = inputCalls(session);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.params.actions[0].type, 'pointer');
  assert.equal(calls[1].args.params.actions[0].type, 'key');
  assert.equal(text, 'Typed 2 characters after clicking ref_7 at (100, 200).');
});

test('type ignores a coordinate instead of clicking wherever the last call pointed', async () => {
  const session = new FakeSession();
  // Chrome's type has no target: a coordinate carried over from the previous
  // call used to fire a click here, closing menus and moving focus.
  const text = await run(session, { action: 'type', text: 'ab', coordinate: [30, 40] });
  const calls = inputCalls(session);
  assert.equal(calls.length, 1, 'no click, just the keystrokes');
  assert.equal(calls[0].args.params.actions[0].type, 'key');
  assert.equal(session.callsOf('callFunction').length, 0, 'nothing logged as a click either');
  assert.equal(
    text,
    'Typed 2 characters. The coordinate was ignored: type goes to whatever has keyboard focus,'
    + ' so click or hover it first, or pass ref, to move focus.'
  );

  // A ref still wins, and the ignored coordinate is called out alongside it.
  const both = await run(session, { action: 'type', text: 'x', ref: 'ref_2', coordinate: [30, 40] });
  assert.match(both, /^Typed 1 character after clicking ref_2 at \(100, 200\)\./);
  assert.match(both, /The coordinate was ignored/);
  assert.equal(inputCalls(session).at(-2).args.params.actions[0].type, 'pointer', 'the ref was clicked');
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
  assert.equal(inputCalls(session).length, 0);
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
  assert.equal(inputCalls(session).length, 1, 'nothing sent for the refused chords');
});

test('a failed action releases the input state before the error is reported', async () => {
  const session = new FakeSession();
  failInput(session, 'move target out of bounds');
  await assert.rejects(
    () => run(session, { action: 'left_click', coordinate: [5000, 5000], modifiers: 'cmd' }),
    /move target out of bounds/
  );
  const released = releaseCalls(session);
  assert.equal(released.length, 1, 'cmd must not stay held down for the next action');
  assert.deepStrictEqual(released[0].args.params, { context: 'ctx-1' });

  // A release that fails too must not mask the original error.
  session.send = async () => { throw new Error('tab is gone'); };
  await assert.rejects(() => run(session, { action: 'key', text: 'Enter' }), /tab is gone/);
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
  assert.equal(inputCalls(session).length, 1);
});

test('a ref that is not visible is refused instead of clicking the origin', async () => {
  // read_page's default filter lists non-visible elements, so the model reaches
  // these refs routinely. getBoundingClientRect is all zeros for them, which
  // used to aim every pointer action at (0, 0) - the site logo - and report a
  // hit on the ref.
  for (const action of ['left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag', 'scroll']) {
    const session = new FakeSession({ responses: { resolveRef: [HIDDEN_REF] } });
    await assert.rejects(
      () => run(session, { action, ref: 'ref_42', scroll_direction: 'down' }),
      (err) => {
        assert.match(err.message, /^ref_42 is on the page but not visible/, action);
        assert.match(err.message, /read_page/, action);
        return true;
      },
      action
    );
    assert.equal(inputCalls(session).length, 0, `${action} must not fire at the origin`);
  }

  // The implicit focus click of `type` goes through the same check, so nothing
  // is clicked and nothing is typed.
  const typing = new FakeSession({ responses: { resolveRef: [HIDDEN_REF] } });
  await assert.rejects(() => run(typing, { action: 'type', text: 'hi', ref: 'ref_42' }), /not visible/);
  assert.equal(inputCalls(typing).length, 0);

  // A zero-sized box is unusable even when the page did not say so outright.
  const zero = new FakeSession({ responses: { resolveRef: [{ found: true, x: 0, y: 0, width: 0, height: 0, tag: 'div' }] } });
  await assert.rejects(() => run(zero, { action: 'left_click', ref: 'ref_8' }), /ref_8 is on the page but not visible/);
  assert.equal(inputCalls(zero).length, 0);
});

test('a ref whose centre lands outside the viewport is refused with the bounds named', async () => {
  const below = new FakeSession({
    responses: { resolveRef: [{ found: true, visible: true, x: 640, y: 1400, width: 20, height: 10, tag: 'a' }] },
  });
  await assert.rejects(
    () => run(below, { action: 'left_click', ref: 'ref_5' }),
    /^Error: ref_5 centres on \(640, 1400\), outside the 1280x800 viewport, so left_click cannot reach it/
  );
  assert.equal(inputCalls(below).length, 0, 'better a clear error than an opaque one from BiDi');

  const above = new FakeSession({
    responses: { resolveRef: [{ found: true, visible: true, x: 10, y: -40, width: 20, height: 10, tag: 'a' }] },
  });
  await assert.rejects(() => run(above, { action: 'hover', ref: 'ref_6' }), /centres on \(10, -40\), outside the 1280x800 viewport/);

  // scroll_to still reports such an element: it is the action that fixes it.
  const offscreen = new FakeSession({
    responses: { resolveRef: [{ found: true, visible: true, x: 5, y: 900, width: 10, height: 10, tag: 'div', inViewport: false }] },
  });
  assert.match(await run(offscreen, { action: 'scroll_to', ref: 'ref_1' }), /still partly outside the viewport\./);
});

test('a tab blocked by a dialog fails at once and names firefox_dialog', async () => {
  const session = new FakeSession();
  session.blockedTabId = 1;
  const blocked = (err) => {
    assert.match(err.message, /Tab 1 is blocked by a dialog/);
    assert.match(err.message, /Call firefox_dialog to accept or dismiss it/);
    return true;
  };
  for (const args of [
    { action: 'left_click', coordinate: [10, 10] },
    { action: 'key', text: 'Enter' },
    { action: 'type', text: 'hi' },
    { action: 'scroll', coordinate: [1, 1], scroll_direction: 'down' },
    { action: 'left_click', ref: 'ref_1' },
    { action: 'scroll_to', ref: 'ref_1' },
  ]) {
    await assert.rejects(() => run(session, args), blocked, args.action);
  }
  assert.equal(inputCalls(session).length, 0, 'nothing is sent to a tab that cannot answer');
  assert.equal(session.callsOf('resolveRef').length, 0, 'and no page script is waited on either');

  // Only the blocked tab is affected.
  const two = new FakeSession({
    tabs: [
      { tabId: 1, context: 'ctx-1', url: 'https://one.test/' },
      { tabId: 2, context: 'ctx-2', url: 'https://two.test/' },
    ],
  });
  two.blockedTabId = 2;
  assert.equal(await computer(two, { action: 'left_click', coordinate: [1, 2], tabId: 1 }), 'Clicked (1, 2).');
});

test('input commands carry their own short timeout, and the release an even shorter one', async () => {
  const session = new FakeSession();
  await run(session, { action: 'left_click', coordinate: [1, 2] });
  const sent = inputCalls(session).at(-1).args;
  assert.equal(sent.params.context, 'ctx-1');
  assert.deepStrictEqual(sent.opts, { timeout: INPUT_TIMEOUT });
  // The BiDi default is 60s per command; a failing action used to burn two of
  // them (the action, then the release) before the model heard anything.
  assert.ok(INPUT_TIMEOUT <= 10000, 'a stuck tab must not hold the model for the 60s default');

  failInput(session, 'BiDi command timed out: input.performActions');
  await assert.rejects(() => run(session, { action: 'key', text: 'Enter' }), /timed out/);
  assert.deepStrictEqual(releaseCalls(session).at(-1).args.opts, { timeout: RELEASE_TIMEOUT });
  assert.ok(RELEASE_TIMEOUT <= INPUT_TIMEOUT, 'the recovery must not double the wait');
});

test('an action that opens a dialog itself reports it instead of a bare timeout', async () => {
  const session = new FakeSession();
  const send = Object.getPrototypeOf(session).send;
  session.send = async function (method, params, opts) {
    const res = await send.call(this, method, params, opts);
    if (method === 'input.performActions') {
      this.blockedTabId = 1; // the click raised a confirm(), which never answers
      throw new Error('BiDi command timed out: input.performActions');
    }
    return res;
  };
  await assert.rejects(
    () => run(session, { action: 'left_click', coordinate: [5, 5] }),
    /timed out: input\.performActions\. Tab 1 is blocked by a dialog.*firefox_dialog/
  );
  assert.equal(releaseCalls(session).length, 1, 'the input state is still released');
});

test('screenshot labels and zoom bounds follow the viewport of the tab acted on', async () => {
  const session = new FakeSession({
    tabs: [
      { tabId: 1, context: 'ctx-1', url: 'https://one.test/' },
      { tabId: 2, context: 'ctx-2', url: 'https://two.test/' },
    ],
  });
  const ctx = fakeCtx(session);
  await session.setViewport(1, { width: 500, height: 400 }); // resize_window on tab 1 only

  const one = await computer(session, { action: 'screenshot', tabId: 1 }, ctx);
  assert.equal(one.content[1].text, 'Screenshot of https://one.test/ | viewport 500x400 | imageId img_1');
  const stored = session.images.get('img_1');
  assert.deepStrictEqual([stored.width, stored.height], [500, 400], 'the image store must not learn tab 2\'s size');

  const two = await computer(session, { action: 'screenshot', tabId: 2 }, ctx);
  assert.equal(two.content[1].text, 'Screenshot of https://two.test/ | viewport 1280x800 | imageId img_2');

  // Zoom is validated against that tab's bounds, not the session default.
  await assert.rejects(
    () => computer(session, { action: 'zoom', region: [0, 0, 900, 300], tabId: 1 }, ctx),
    /zoom region \[0, 0, 900, 300\] falls outside the 500x400 viewport\./
  );
  const zoomed = await computer(session, { action: 'zoom', region: [0, 0, 900, 300], tabId: 2 }, ctx);
  assert.deepStrictEqual(session.callsOf('screenshot').at(-1).args.clip, { x: 0, y: 0, width: 900, height: 300 });
  assert.match(zoomed.content[1].text, /900x300 px/);
});

test('a box with one zero dimension is refused too, and named for what it is', async () => {
  // resolveRef only sets visible from width>0 && height>0, so a stub or a future
  // resolver that omits the flag must not get a click aimed at a line with no
  // area: the centre of a 120x0 box sits on its own top edge.
  const flat = new FakeSession({ responses: { resolveRef: [{ found: true, x: 60, y: 300, width: 120, height: 0, tag: 'span' }] } });
  await assert.rejects(
    () => run(flat, { action: 'left_click', ref: 'ref_4' }),
    /^Error: ref_4 is on the page but not visible/
  );
  assert.equal(inputCalls(flat).length, 0);
});

test('scroll_to does not call a zero-sized box "fully in the viewport"', async () => {
  // inViewport is computed from a rect of zeros, so it reads true for a
  // display:none element. Saying it landed in the viewport would send the model
  // back to a click that now (correctly) refuses, with no idea why.
  const session = new FakeSession({ responses: { resolveRef: [HIDDEN_REF] } });
  const text = await run(session, { action: 'scroll_to', ref: 'ref_42' });
  assert.doesNotMatch(text, /in the viewport/);
  assert.match(text, /^ref_42 <button> is on the page but not visible/);
  assert.match(text, /read_page/);
});

test('the dialog hint never masks a failure that was not an Error', async () => {
  const session = new FakeSession();
  const send = Object.getPrototypeOf(session).send;
  session.send = async function (method, params, opts) {
    const res = await send.call(this, method, params, opts);
    if (method === 'input.performActions') {
      this.blockedTabId = 1;
      throw 'socket closed mid-command'; // a bare string, not an Error
    }
    return res;
  };
  await assert.rejects(
    () => run(session, { action: 'left_click', coordinate: [5, 5] }),
    /^Error: socket closed mid-command\. Tab 1 is blocked by a dialog/
  );
});

test('the ignored-coordinate note fits whichever way focus was set', async () => {
  const session = new FakeSession();
  const alone = await run(session, { action: 'type', text: 'x', coordinate: [30, 40] });
  assert.match(alone, /so click or hover it first, or pass ref, to move focus\.$/);
  // Telling the model to "pass ref" when it just passed one is bad advice.
  const withRef = await run(session, { action: 'type', text: 'x', ref: 'ref_2', coordinate: [30, 40] });
  assert.match(withRef, /The coordinate was ignored: ref_2 is what decided where the focus went\.$/);
  assert.doesNotMatch(withRef, /or pass ref/);
});
