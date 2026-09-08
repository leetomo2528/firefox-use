'use strict';
// The `computer` tool: mouse, keyboard, waiting and screenshots.
//
// Every action ends up as a BiDi input.performActions payload (a pointer, key
// or wheel source) or a captureScreenshot call. Argument names, enums and
// limits come straight from Chrome's schema so a task written for one browser
// runs unchanged on the other.

const fs = require('node:fs');
const path = require('node:path');
const { comboActions, typeActions, keyValue, MODIFIERS } = require('./keys');
const { sleep } = require('./session');

const PIXELS_PER_TICK = 100; // one wheel tick, roughly what a real wheel sends
const MOVE_DURATION = 40;
const HOVER_DURATION = 60;
const DRAG_DURATION = 300;
const CLICK_HOLD = 30; // how long the button stays down
const CLICK_GAP = 60; // between the pairs of a double/triple click
const SCROLL_DURATION = 100;
const MAX_CLICK_LOG = 200;
// Synthetic input never leaves this machine: Firefox dispatches the events and
// answers, which takes milliseconds. A command that outlives this is not slow,
// it is stuck (a modal dialog, a renderer that stopped pumping its event loop),
// and the default 60s BiDi timeout would only buy the model a long silence -
// twice over, once for the action and once for the release that follows it.
const INPUT_TIMEOUT = 5000;
const RELEASE_TIMEOUT = 2000; // pure cleanup; never worth waiting on

const CLICKS = {
  left_click: { button: 0, clicks: 1, verb: 'Clicked' },
  right_click: { button: 2, clicks: 1, verb: 'Right-clicked' },
  double_click: { button: 0, clicks: 2, verb: 'Double-clicked' },
  triple_click: { button: 0, clicks: 3, verb: 'Triple-clicked' },
};

const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// "cmd" and "win" are the same WebDriver key; the model may send either.
const MODIFIER_NAMES = {
  ctrl: 'control', control: 'control',
  shift: 'shift',
  alt: 'alt', option: 'alt',
  cmd: 'meta', command: 'meta', meta: 'meta', super: 'meta',
  win: 'meta', windows: 'meta',
};

const CTRL_LIKE = new Set(['ctrl', 'control', 'cmd', 'command', 'meta', 'super', 'win', 'windows']);
const ZOOM_KEYS = new Set(['=', '+', '-', '_', '0', 'plus', 'minus', 'equal', 'equals', 'add', 'subtract']);

// Pointer trail the GIF recorder draws indicators from. Kept in the page so it
// survives across tool calls and dies with the document. A drag carries x2/y2
// as well, which is what gif_creator turns into an arrow.
const CLICK_LOG_FN = `(function (entry, cap) {
  if (!window.__ffuse) window.__ffuse = { refs: new Map(), next: 1, clicks: [] };
  if (!Array.isArray(window.__ffuse.clicks)) window.__ffuse.clicks = [];
  var e = entry || {};
  var item = { type: e.type || 'click', x: e.x, y: e.y, at: Date.now() };
  if (typeof e.x2 === 'number' && typeof e.y2 === 'number') { item.x2 = e.x2; item.y2 = e.y2; }
  if (e.label) item.label = e.label;
  var log = window.__ffuse.clicks;
  log.push(item);
  if (log.length > cap) log.splice(0, log.length - cap);
  return log.length;
})`;

// --- argument parsing -----------------------------------------------------

function readCoordinate(value, name = 'coordinate') {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${name} must be [x, y] in viewport pixels.`);
  }
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${name} must be [x, y] in viewport pixels.`);
  }
  if (x < 0 || y < 0) {
    throw new Error(`${name} [${x}, ${y}] is outside the viewport; coordinates start at 0, 0.`);
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function readRegion(region, viewport) {
  const bad = `zoom needs region [x0, y0, x1, y1] in viewport pixels.`;
  if (!Array.isArray(region) || region.length !== 4) throw new Error(bad);
  const [x0, y0, x1, y1] = region.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) throw new Error(bad);
  if (x0 < 0 || y0 < 0) throw new Error(`zoom region [${region.join(', ')}] must not be negative.`);
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(`zoom region [${region.join(', ')}] is empty; it needs x1 > x0 and y1 > y0.`);
  }
  const width = viewport?.width || 0;
  const height = viewport?.height || 0;
  if (width && height && (x1 > width || y1 > height)) {
    throw new Error(`zoom region [${region.join(', ')}] falls outside the ${width}x${height} viewport.`);
  }
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

function readRepeat(repeat) {
  if (repeat === undefined || repeat === null) return 1;
  const n = Number(repeat);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error('repeat must be a whole number between 1 and 100.');
  }
  return n;
}

function readScrollAmount(amount) {
  if (amount === undefined || amount === null) return 3;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    throw new Error('scroll_amount counts wheel ticks and must be between 1 and 10.');
  }
  return Math.round(n);
}

function readDuration(duration) {
  if (duration === undefined || duration === null) {
    throw new Error('the wait action needs duration in seconds (0 to 10).');
  }
  const n = Number(duration);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('duration must be a number of seconds between 0 and 10.');
  }
  if (n > 10) {
    throw new Error('duration is capped at 10 seconds; call wait again if you need to wait longer.');
  }
  return n;
}

function parseModifiers(modifiers) {
  if (modifiers === undefined || modifiers === null || modifiers === '') return [];
  const parts = String(modifiers).split('+').map((p) => p.trim()).filter(Boolean);
  return parts.map((part) => {
    const canonical = MODIFIER_NAMES[part.toLowerCase()];
    if (!canonical) {
      throw new Error(`unknown modifier: ${part}. Use ctrl, shift, alt, cmd (meta) or win, combined with "+".`);
    }
    return { name: part.toLowerCase(), value: keyValue(canonical) };
  });
}

// "cmd+shift+t" -> { mods: ['cmd','shift'], key: 't' }. A "+" pressed as a key
// ("cmd++", "+") would be swallowed by a plain split, and a token that ends in a
// lone "+" names no key at all - keys.js would quietly press the modifier on its
// own, so both cases are handled here instead.
function splitChord(token) {
  const raw = String(token).trim();
  if (raw === '+' || raw.endsWith('++')) {
    const mods = raw.slice(0, -1).split('+').map((p) => p.trim()).filter(Boolean);
    return { mods, key: '+' };
  }
  if (raw.endsWith('+')) throw new Error(`"${raw}" ends with "+" but names no key`);
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key combo');
  const key = parts.pop();
  return { mods: parts, key };
}

// cmd+= / ctrl+- / cmd+0 change the page zoom, which the model cannot see; the
// zoom action magnifies a region instead. Takes a token or a parsed chord.
function isZoomShortcut(token) {
  let chord;
  if (token && typeof token === 'object') {
    chord = token;
  } else {
    try { chord = splitChord(token); } catch { return false; }
  }
  if (!chord.mods.some((m) => CTRL_LIKE.has(String(m).toLowerCase()))) return false;
  return ZOOM_KEYS.has(String(chord.key).toLowerCase());
}

// keys.js owns the normal case; only a literal "+" key has to be built here.
function chordActions(token, chord) {
  if (chord.key !== '+') return comboActions(token);
  for (const mod of chord.mods) {
    if (!MODIFIERS.has(String(mod).toLowerCase())) throw new Error(`not a modifier: ${mod}`);
  }
  const values = chord.mods.map(keyValue);
  const actions = [];
  for (const value of values) actions.push({ type: 'keyDown', value });
  actions.push({ type: 'keyDown', value: '+' }, { type: 'keyUp', value: '+' });
  for (const value of [...values].reverse()) actions.push({ type: 'keyUp', value });
  return actions;
}

// "Backspace Backspace Delete" / "cmd+a" -> one flat key action list.
function keyActions(text, repeat = 1) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('the key action needs text, for example "Enter", "cmd+a" or "Backspace Backspace".');
  }
  const tokens = text.trim().split(/\s+/);
  // Parse and screen every token first, so a bad one in the middle sends nothing.
  const chords = tokens.map((token) => {
    let chord;
    try {
      chord = splitChord(token);
    } catch (err) {
      throw new Error(`cannot press "${token}": ${err.message}`);
    }
    if (isZoomShortcut(chord)) {
      throw new Error(
        `page zoom shortcuts like "${token}" are not supported. ` +
        'Use the zoom action to magnify a region of the page instead.'
      );
    }
    return chord;
  });
  const once = [];
  tokens.forEach((token, i) => {
    let actions;
    try {
      actions = chordActions(token, chords[i]);
    } catch (err) {
      throw new Error(`cannot press "${token}": ${err.message}`);
    }
    once.push(...actions);
  });
  const actions = [];
  for (let i = 0; i < repeat; i++) actions.push(...once);
  return { actions, tokens };
}

// --- BiDi input sources ---------------------------------------------------

const pause = (duration = 0) => ({ type: 'pause', duration });

function mouseSource(actions) {
  return { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions };
}

function keySource(actions) {
  return { type: 'key', id: 'keyboard', actions };
}

function wheelSource(actions) {
  return { type: 'wheel', id: 'wheel', actions };
}

// Sources advance in lockstep, one action per tick, so holding modifiers around
// a click means padding each source with pauses for the other one's ticks.
function pointerWithModifiers(pointerActions, mods = []) {
  if (!mods.length) return [mouseSource(pointerActions)];
  const keys = [];
  for (const mod of mods) keys.push({ type: 'keyDown', value: mod.value });
  for (let i = 0; i < pointerActions.length; i++) keys.push(pause(0));
  for (const mod of [...mods].reverse()) keys.push({ type: 'keyUp', value: mod.value });
  const pointer = [
    ...mods.map(() => pause(0)),
    ...pointerActions,
    ...mods.map(() => pause(0)),
  ];
  return [keySource(keys), mouseSource(pointer)];
}

function clickActions({ x, y, button = 0, clicks = 1 }) {
  const actions = [{ type: 'pointerMove', x, y, origin: 'viewport', duration: MOVE_DURATION }];
  for (let i = 0; i < clicks; i++) {
    actions.push({ type: 'pointerDown', button }, pause(CLICK_HOLD), { type: 'pointerUp', button });
    if (i < clicks - 1) actions.push(pause(CLICK_GAP));
  }
  return actions;
}

function dragActions({ from, to }) {
  const actions = [];
  if (from) actions.push({ type: 'pointerMove', x: from.x, y: from.y, origin: 'viewport', duration: MOVE_DURATION });
  actions.push(
    { type: 'pointerDown', button: 0 },
    pause(CLICK_HOLD),
    { type: 'pointerMove', x: to.x, y: to.y, origin: 'viewport', duration: DRAG_DURATION },
    pause(CLICK_HOLD),
    { type: 'pointerUp', button: 0 }
  );
  return actions;
}

function scrollActions({ x, y, direction, ticks }) {
  const [dx, dy] = DIRECTIONS[direction];
  const distance = ticks * PIXELS_PER_TICK;
  return [{
    type: 'scroll',
    x, y,
    deltaX: dx * distance,
    deltaY: dy * distance,
    origin: 'viewport',
    duration: SCROLL_DURATION,
  }];
}

// An alert/confirm/prompt freezes the page: input commands aimed at it are
// never answered, so both the action and its release run out the clock.
function dialogBlocking(session, tabId) {
  let blocked = null;
  try {
    blocked = session.promptTabId();
  } catch {
    return false; // no prompt bookkeeping; treat the tab as usable
  }
  return blocked !== null && blocked !== undefined && Number(blocked) === Number(tabId);
}

const dialogHint = (tabId) =>
  `Tab ${tabId} is blocked by a dialog, so the page takes no clicks or keystrokes. ` +
  'Call firefox_dialog to accept or dismiss it, then try again.';

function assertNoDialog(session, tabId) {
  if (dialogBlocking(session, tabId)) throw new Error(dialogHint(tabId));
}

// A tick that fails (an out-of-bounds move, a closed tab) leaves the browser's
// input state as it was: a button or a modifier can stay down and poison every
// later action. Release it before the error goes back to the model.
async function perform(session, tabId, sources) {
  const context = session.requireContext(tabId);
  assertNoDialog(session, tabId);
  try {
    return await session.send('input.performActions', { context, actions: sources }, { timeout: INPUT_TIMEOUT });
  } catch (err) {
    try {
      await session.send('input.releaseActions', { context }, { timeout: RELEASE_TIMEOUT });
    } catch {
      /* nothing left to release, or the tab is gone with its state */
    }
    // The action itself can be what opened the dialog; say so rather than
    // handing back a bare timeout the model cannot act on.
    if (dialogBlocking(session, tabId)) {
      const detail = String((err && err.message) || err).replace(/\s*\.?\s*$/, '');
      throw new Error(`${detail}. ${dialogHint(tabId)}`);
    }
    throw err;
  }
}

// --- page-side helpers ----------------------------------------------------

// A ref the model still holds can point at something that is not rendered - a
// menu that closed again, a display:none tab panel (read_page's default "all"
// filter lists those on purpose). getBoundingClientRect is then all zeros, and
// aiming at it would click the top-left corner of the page while reporting a
// hit on the ref. Refuse, and say what would make the ref usable.
function refPoint(session, tabId, ref, info, action) {
  const width = Number(info.width) || 0;
  const height = Number(info.height) || 0;
  const x = Math.round(Number(info.x));
  const y = Math.round(Number(info.y));
  if (info.visible === false || width === 0 || height === 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `${ref} is on the page but not visible (read_page marks it "(not visible)"), so ${action} has nothing ` +
      'to aim at. Open the menu, tab or section that holds it - or call read_page again and use a ref that ' +
      'is showing - then retry.'
    );
  }
  const viewport = session.viewportFor(tabId) || {};
  const vw = Number(viewport.width) || 0;
  const vh = Number(viewport.height) || 0;
  if (x < 0 || y < 0 || (vw && x >= vw) || (vh && y >= vh)) {
    const bounds = vw && vh ? `the ${vw}x${vh} viewport` : 'the viewport';
    throw new Error(
      `${ref} centres on (${x}, ${y}), outside ${bounds}, so ${action} cannot reach it even after scrolling ` +
      'it into view. Scroll the container that holds it, then call read_page again for a fresh ref.'
    );
  }
  return { x, y };
}

async function targetPoint(session, tabId, { coordinate, ref, action }) {
  if (ref !== undefined && ref !== null && ref !== '') {
    assertNoDialog(session, tabId);
    await session.ensureRefStore(tabId);
    const info = await session.resolveRef(tabId, ref, { scroll: true });
    const { x, y } = refPoint(session, tabId, ref, info, action);
    return { x, y, ref: String(ref), element: info };
  }
  if (coordinate !== undefined && coordinate !== null) return readCoordinate(coordinate);
  throw new Error(`${action} needs a coordinate [x, y] or a ref from read_page or find.`);
}

// Best effort: a click still counts even if the overlay log could not be written.
async function logPointer(session, tabId, entry) {
  try {
    await session.callFunction(tabId, CLICK_LOG_FN, [entry, MAX_CLICK_LOG]);
  } catch {
    /* the trail only feeds gif_creator's overlays */
  }
}

function pointerEntry(action, point, end = null) {
  const entry = { type: action, x: point.x, y: point.y, label: action.replace(/_/g, ' ') };
  if (end) { entry.type = 'drag'; entry.x2 = end.x; entry.y2 = end.y; }
  return entry;
}

async function pageUrl(session, tabId) {
  try {
    const info = await session.pageInfo(tabId);
    return info?.url || '(unknown url)';
  } catch {
    return '(unknown url)';
  }
}

function saveImage(ctx, name, data, mimeType) {
  const dir = ctx?.config?.downloadDir || process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${name}${mimeType === 'image/jpeg' ? '.jpg' : '.png'}`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function capture(session, tabId, { clip = null, kind, save = false, ctx }) {
  const shot = await session.screenshot(tabId, clip ? { clip } : {});
  const viewport = session.viewportFor(tabId) || { width: 0, height: 0 };
  const width = clip ? clip.width : viewport.width;
  const height = clip ? clip.height : viewport.height;
  const imageId = session.images.put({ data: shot.data, mimeType: shot.mimeType, width, height });
  let saved = null;
  if (save) {
    try {
      saved = saveImage(ctx, `${kind}-${imageId}`, shot.data, shot.mimeType);
    } catch (err) {
      throw new Error(`could not save the ${kind} to disk: ${err.message}`);
    }
    const stored = session.images.get(imageId);
    if (stored) stored.path = saved;
  }
  return { shot, imageId, width, height, saved };
}

function imageResult(shot, text) {
  return {
    content: [
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
      { type: 'text', text },
    ],
  };
}

// --- actions --------------------------------------------------------------

async function clickAction(session, tabId, args, action) {
  const spec = CLICKS[action];
  const point = await targetPoint(session, tabId, { coordinate: args.coordinate, ref: args.ref, action });
  const mods = parseModifiers(args.modifiers);
  const actions = clickActions({ x: point.x, y: point.y, button: spec.button, clicks: spec.clicks });
  await perform(session, tabId, pointerWithModifiers(actions, mods));
  await logPointer(session, tabId, pointerEntry(action, point));
  const where = point.ref ? `${point.ref} at (${point.x}, ${point.y})` : `(${point.x}, ${point.y})`;
  const held = mods.length ? ` with ${mods.map((m) => m.name).join('+')} held` : '';
  return `${spec.verb} ${where}${held}.`;
}

async function hoverAction(session, tabId, args) {
  const point = await targetPoint(session, tabId, { coordinate: args.coordinate, ref: args.ref, action: 'hover' });
  const mods = parseModifiers(args.modifiers);
  const move = [{ type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport', duration: HOVER_DURATION }];
  await perform(session, tabId, pointerWithModifiers(move, mods));
  await logPointer(session, tabId, pointerEntry('hover', point));
  const where = point.ref ? `${point.ref} at (${point.x}, ${point.y})` : `(${point.x}, ${point.y})`;
  return `Moved the mouse to ${where} without clicking.`;
}

async function dragAction(session, tabId, args) {
  const to = await targetPoint(session, tabId, {
    coordinate: args.coordinate, ref: args.ref, action: 'left_click_drag',
  });
  const from = args.start_coordinate === undefined || args.start_coordinate === null
    ? null
    : readCoordinate(args.start_coordinate, 'start_coordinate');
  const mods = parseModifiers(args.modifiers);
  await perform(session, tabId, pointerWithModifiers(dragActions({ from, to }), mods));
  await logPointer(session, tabId, from ? pointerEntry('left_click_drag', from, to) : pointerEntry('left_click_drag', to));
  const start = from ? `(${from.x}, ${from.y})` : 'the current pointer position';
  const held = mods.length ? ` with ${mods.map((m) => m.name).join('+')} held` : '';
  return `Dragged from ${start} to (${to.x}, ${to.y})${held}.`;
}

async function scrollAction(session, tabId, args) {
  const direction = String(args.scroll_direction || '').toLowerCase();
  if (!DIRECTIONS[direction]) {
    throw new Error('scroll needs scroll_direction: up, down, left or right.');
  }
  const ticks = readScrollAmount(args.scroll_amount);
  const point = await targetPoint(session, tabId, { coordinate: args.coordinate, ref: args.ref, action: 'scroll' });
  const actions = scrollActions({ x: point.x, y: point.y, direction, ticks });
  await perform(session, tabId, [wheelSource(actions)]);
  const pixels = ticks * PIXELS_PER_TICK;
  return `Scrolled ${direction} ${ticks} tick${ticks === 1 ? '' : 's'} (${pixels}px) at (${point.x}, ${point.y}).`;
}

async function typeAction(session, tabId, args) {
  const text = args.text;
  if (typeof text !== 'string' || text === '') {
    throw new Error('the type action needs text to type.');
  }
  // Chrome's type takes no target: the text goes to whatever holds focus. A ref
  // is worth a click first - the model named that field - but a coordinate is
  // often just carried over from the previous call, and clicking it would close
  // the menu or leave the field the model had already focused. So: ref clicks,
  // coordinate is ignored and the reply says so.
  let focused = '';
  const hasRef = args.ref !== undefined && args.ref !== null && args.ref !== '';
  if (hasRef) {
    const point = await targetPoint(session, tabId, { ref: args.ref, action: 'type' });
    await perform(session, tabId, pointerWithModifiers(clickActions({ x: point.x, y: point.y }), []));
    await logPointer(session, tabId, { type: 'left_click', x: point.x, y: point.y, label: 'type' });
    focused = ` after clicking ${point.ref} at (${point.x}, ${point.y})`;
  }
  let ignored = '';
  if (args.coordinate !== undefined && args.coordinate !== null) {
    ignored = hasRef
      ? ` The coordinate was ignored: ${String(args.ref)} is what decided where the focus went.`
      : ' The coordinate was ignored: type goes to whatever has keyboard focus, so click or hover it first,'
        + ' or pass ref, to move focus.';
  }
  await perform(session, tabId, [keySource(typeActions(text))]);
  // Count what actually gets pressed: typeActions walks code points, so an emoji
  // is one key press rather than the two UTF-16 units String#length reports.
  const count = Array.from(text).length;
  const newlines = text.split('\n').length - 1;
  const enters = newlines ? ` including ${newlines} Enter press${newlines === 1 ? '' : 'es'}` : '';
  return `Typed ${count} character${count === 1 ? '' : 's'}${enters}${focused}.${ignored}`;
}

async function keyAction(session, tabId, args) {
  const repeat = readRepeat(args.repeat);
  const { actions, tokens } = keyActions(args.text, repeat);
  await perform(session, tabId, [keySource(actions)]);
  const times = repeat > 1 ? ` ${repeat} times` : '';
  return `Pressed ${tokens.join(' ')}${times}.`;
}

async function waitAction(args) {
  const seconds = readDuration(args.duration);
  await sleep(Math.round(seconds * 1000));
  return `Waited ${seconds} second${seconds === 1 ? '' : 's'}.`;
}

async function screenshotAction(session, tabId, args, ctx) {
  const shot = await capture(session, tabId, { kind: 'screenshot', save: !!args.save_to_disk, ctx });
  const url = await pageUrl(session, tabId);
  const bits = [
    `Screenshot of ${url}`,
    `viewport ${shot.width}x${shot.height}`,
    `imageId ${shot.imageId}`,
  ];
  if (shot.saved) bits.push(`saved to ${shot.saved}`);
  return imageResult(shot.shot, bits.join(' | '));
}

async function zoomAction(session, tabId, args, ctx) {
  const clip = readRegion(args.region, session.viewportFor(tabId));
  const shot = await capture(session, tabId, { clip, kind: 'zoom', save: !!args.save_to_disk, ctx });
  const url = await pageUrl(session, tabId);
  const bits = [
    `Zoom of region [${args.region.join(', ')}] on ${url}`,
    `${shot.width}x${shot.height} px`,
    `imageId ${shot.imageId}`,
  ];
  if (shot.saved) bits.push(`saved to ${shot.saved}`);
  return imageResult(shot.shot, bits.join(' | '));
}

async function scrollToAction(session, tabId, args) {
  if (args.ref === undefined || args.ref === null || args.ref === '') {
    throw new Error('scroll_to needs a ref from read_page or find.');
  }
  assertNoDialog(session, tabId);
  await session.ensureRefStore(tabId);
  const info = await session.resolveRef(tabId, args.ref, { scroll: true });
  const tag = info.tag ? `<${info.tag}>` : 'element';
  // A display:none element has a zero box at the origin: inViewport reads true
  // for it, and reporting "fully in the viewport" would send the model straight
  // into a click that cannot land. scroll_to still reports rather than refuses -
  // it is the action that fixes a merely off-screen element - but it has to say
  // which of the two cases this is.
  if (info.visible === false || !(Number(info.width) > 0) || !(Number(info.height) > 0)) {
    return `${args.ref} ${tag} is on the page but not visible (read_page marks it "(not visible)"), so ` +
      'scrolling cannot bring it into view. Open the menu, tab or section that holds it, then call read_page ' +
      'again and use a ref that is showing.';
  }
  const placed = info.inViewport ? 'fully in the viewport' : 'still partly outside the viewport';
  return `Scrolled ${args.ref} ${tag} into view: center (${info.x}, ${info.y}), ${info.width}x${info.height}, ${placed}.`;
}

// --- entry point ----------------------------------------------------------

async function computer(session, args = {}, ctx = {}) {
  const action = args.action;
  if (!action) throw new Error('action is required. See the action enum for the supported ones.');
  const tabId = args.tabId ?? await session.defaultTabId();
  session.requireContext(tabId);

  if (CLICKS[action]) return clickAction(session, tabId, args, action);
  switch (action) {
    case 'hover': return hoverAction(session, tabId, args);
    case 'left_click_drag': return dragAction(session, tabId, args);
    case 'scroll': return scrollAction(session, tabId, args);
    case 'type': return typeAction(session, tabId, args);
    case 'key': return keyAction(session, tabId, args);
    case 'wait': return waitAction(args);
    case 'screenshot': return screenshotAction(session, tabId, args, ctx);
    case 'zoom': return zoomAction(session, tabId, args, ctx);
    case 'scroll_to': return scrollToAction(session, tabId, args);
    default:
      throw new Error(`unknown action: ${action}. Supported: ${SUPPORTED.join(', ')}.`);
  }
}

// Tool definition. The schema shape - names, types, enums, limits, required -
// is the one Chrome's integration declares, so a task written for either
// browser runs here unchanged; the wording is ours.
const TOOL = {
    "name": "computer",
    "description": "Drive one Firefox tab with synthetic pointer, wheel and keyboard input, and capture what it looks like. Each call performs exactly one `action` from the enum, against the tab named by `tabId`; ask tabs_context_mcp for a valid id before the first call.\n* Aim with `coordinate` (viewport pixels) or, preferably, with `ref` (an element id from read_page or find). Coordinates must come from your latest screenshot: pages scroll and re-render, and stale numbers land on whatever occupies that spot now.\n* A ref belongs to the snapshot that produced it. After a navigation or a re-render, ask read_page or find for new ids rather than reusing old ones.\n* Put the pointer in the middle of a control, not on its border. When a click appears to have done nothing, take a fresh screenshot and re-aim before repeating it.\n* Firefox specifics: this drives a profile the server owns, separate from your everyday browser, and no per-site approval step stands in the way. A native alert, confirm, prompt or beforeunload freezes the tab, and every action here fails until firefox_dialog accepts or dismisses it.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "left_click",
            "right_click",
            "type",
            "screenshot",
            "wait",
            "scroll",
            "key",
            "left_click_drag",
            "double_click",
            "triple_click",
            "zoom",
            "scroll_to",
            "hover"
          ],
          "description": "Which operation to run. Every other field is read according to this choice.\n* `left_click`: press and release the primary button on the target.\n* `right_click`: secondary-button click, the usual way to raise a context menu.\n* `double_click`: two primary clicks in quick succession - opens an item, selects a word.\n* `triple_click`: three in a row, which selects the whole line or paragraph under the pointer.\n* `hover`: move the pointer onto the target and press nothing, to raise a tooltip, drop a menu open or trigger a :hover style.\n* `left_click_drag`: hold the primary button down from `start_coordinate` (or from wherever the pointer already sits) and release it on the target.\n* `scroll`: turn the wheel `scroll_amount` notches in `scroll_direction` over the point you give, so the scrollable box under that point is what moves.\n* `type`: send `text` to whatever holds keyboard focus; pass `ref` to click that field first.\n* `key`: press the keys or chords named in `text`, `repeat` times over.\n* `wait`: pause for `duration` seconds while something loads or animates.\n* `screenshot`: capture the visible area of the tab.\n* `zoom`: capture `region` alone, for reading small icons or fine print.\n* `scroll_to`: bring the element named by `ref` into view; it needs no coordinate."
        },
        "coordinate": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 2,
          "maxItems": 2,
          "description": "Target point as [x, y] in CSS pixels measured from the top-left corner of the viewport, not of the screen. Give this or `ref` for left_click, right_click, double_click, triple_click, hover, scroll and left_click_drag; on a drag it marks where the button comes up, the end of the movement. Take the numbers from your most recent screenshot - an older one may name a spot the page has since moved. A tab here renders at devicePixelRatio 1, so one pixel of that image is one unit here; no scaling to do. `type` ignores this field, because typing follows keyboard focus."
        },
        "text": {
          "type": "string",
          "description": "Payload for two of the actions. Under `type` it is the literal string to enter, newlines included - each newline goes out as an Enter press. Under `key` it names a key or a chord, or several of them separated by spaces to be pressed in order: \"Enter\", \"cmd+a\", \"ArrowDown ArrowDown Enter\". The modifier names understood are ctrl, shift, alt, cmd (meta) and win (windows), attached to the key with \"+\"; macOS spells with cmd what Windows and Linux spell with ctrl. Chords that rescale the page - \"ctrl+-\", \"cmd+0\" and the like - are refused, since the new scale would be invisible to you; crop with the `zoom` action instead."
        },
        "duration": {
          "type": "number",
          "minimum": 0,
          "maximum": 10,
          "description": "Seconds the `wait` action sits idle, anywhere from 0 up to 10. Required by `wait`, read by nothing else. Fractions count (0.5 is half a second), and one call will never sit longer than 10 seconds, so wait a second time - with a screenshot in between - when a page needs more."
        },
        "scroll_direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "Which way the wheel turns during `scroll`, and mandatory there: up, down, left or right. `down` walks further down the document, the way a real wheel would."
        },
        "scroll_amount": {
          "type": "number",
          "minimum": 1,
          "maximum": 10,
          "description": "Wheel notches per `scroll` call, from 1 to 10; omit it and you get 3. A notch is worth roughly 100 pixels of travel here, so the default moves about 300."
        },
        "start_coordinate": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 2,
          "maxItems": 2,
          "description": "Where `left_click_drag` puts the button down, as [x, y] in viewport pixels; `coordinate` or `ref` supplies the point where it lifts again. Optional - leave it out and the drag begins wherever the previous action left the pointer, which is only predictable when that action was one of yours."
        },
        "region": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 4,
          "maxItems": 4,
          "description": "Crop box for `zoom`, required by it and read by nothing else: [x0, y0, x1, y1] in viewport pixels, top-left corner first and bottom-right second. x1 has to exceed x0 and y1 exceed y0, and the whole box must fit inside the viewport. What comes back is that rectangle at capture resolution, which is what makes a 16-pixel icon or a line of fine print legible."
        },
        "repeat": {
          "type": "number",
          "minimum": 1,
          "maximum": 100,
          "description": "How many times to replay the whole sequence in `text`: a whole number from 1 to 100, and 1 when you leave it out. Only the `key` action looks at it. One call carrying repeat 20 beats twenty calls when you are walking a list with ArrowDown or emptying a field with Backspace."
        },
        "ref": {
          "type": "string",
          "description": "Element handle from an earlier read_page or find call, written like \"ref_1\". `scroll_to` requires one and accepts nothing else. For clicks, hover, drag and scroll it stands in for `coordinate`, and it is the sturdier of the two: the element is looked up and scrolled into view at the moment the call runs. With `type` it means \"click this field first, then type into it\". Handles expire with the snapshot that produced them - navigate, or let the page re-render, and you need fresh ones. A handle that resolves to something hidden (a closed menu, an inactive tab panel) comes back as an error instead of a click at the page origin."
        },
        "modifiers": {
          "type": "string",
          "description": "Keys held down for the length of a pointer action - the four clicks, hover and drag all honour it. Name one of ctrl, shift, alt, cmd (or meta) or win (or windows), and join several with \"+\" when you need more than one, as in \"ctrl+shift\". This is how you shift-click a range or cmd-click a link into its own tab. Optional, and unrelated to the chords the `key` action parses out of `text`."
        },
        "tabId": {
          "type": "number",
          "description": "The tab this action is performed on, from the tab group this session owns. The schema marks it required: tabs_context_mcp lists the ids that exist, tabs_create_mcp returns the id of a tab it opens, and a page opened from a tab already in the group joins it. An id from outside the group is rejected."
        },
        "save_to_disk": {
          "type": "boolean",
          "description": "Only meaningful for `screenshot` and `zoom`: set it true to also write the captured image into the firefox-use downloads folder, and the result line will carry the file path so you can attach it to a message. The picture is returned in the response either way, so leave this off while you are merely looking at the page yourself."
        }
      },
      "required": [
        "action",
        "tabId"
      ]
    }
  };

const SUPPORTED = TOOL.inputSchema.properties.action.enum;

function tools(ctx) {
  return [{
    name: TOOL.name,
    description: TOOL.description,
    inputSchema: TOOL.inputSchema,
    handler: async (args = {}) => {
      const session = await ctx.session();
      return computer(session, args, ctx);
    },
  }];
}

module.exports = {
  computer, tools, TOOL,
  parseModifiers, isZoomShortcut, keyActions, splitChord,
  readCoordinate, readRegion, readRepeat, readScrollAmount, readDuration,
  clickActions, dragActions, scrollActions, pointerWithModifiers,
  mouseSource, keySource, wheelSource,
  CLICK_LOG_FN, PIXELS_PER_TICK, MAX_CLICK_LOG, INPUT_TIMEOUT, RELEASE_TIMEOUT,
};
