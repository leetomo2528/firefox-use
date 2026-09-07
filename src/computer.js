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

// A tick that fails (an out-of-bounds move, a closed tab) leaves the browser's
// input state as it was: a button or a modifier can stay down and poison every
// later action. Release it before the error goes back to the model.
async function perform(session, tabId, sources) {
  try {
    return await session.performActions(tabId, sources);
  } catch (err) {
    try {
      await session.send('input.releaseActions', { context: session.requireContext(tabId) });
    } catch {
      /* nothing left to release, or the tab is gone with its state */
    }
    throw err;
  }
}

// --- page-side helpers ----------------------------------------------------

async function targetPoint(session, tabId, { coordinate, ref, action }) {
  if (ref !== undefined && ref !== null && ref !== '') {
    await session.ensureRefStore(tabId);
    const info = await session.resolveRef(tabId, ref, { scroll: true });
    return { x: info.x, y: info.y, ref: String(ref), element: info };
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
  const viewport = session.viewportSize || { width: 0, height: 0 };
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
  let focused = '';
  const hasTarget = (args.ref !== undefined && args.ref !== null && args.ref !== '')
    || (args.coordinate !== undefined && args.coordinate !== null);
  if (hasTarget) {
    const point = await targetPoint(session, tabId, { coordinate: args.coordinate, ref: args.ref, action: 'type' });
    await perform(session, tabId, pointerWithModifiers(clickActions({ x: point.x, y: point.y }), []));
    await logPointer(session, tabId, { type: 'left_click', x: point.x, y: point.y, label: 'type' });
    focused = ` after clicking (${point.x}, ${point.y})`;
  }
  await perform(session, tabId, [keySource(typeActions(text))]);
  // Count what actually gets pressed: typeActions walks code points, so an emoji
  // is one key press rather than the two UTF-16 units String#length reports.
  const count = Array.from(text).length;
  const newlines = text.split('\n').length - 1;
  const enters = newlines ? ` including ${newlines} Enter press${newlines === 1 ? '' : 'es'}` : '';
  return `Typed ${count} character${count === 1 ? '' : 's'}${enters}${focused}.`;
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
  const clip = readRegion(args.region, session.viewportSize);
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
  await session.ensureRefStore(tabId);
  const info = await session.resolveRef(tabId, args.ref, { scroll: true });
  const tag = info.tag ? `<${info.tag}>` : 'element';
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

// Tool definition copied from docs/chrome-tool-spec.json; nothing but the
// browser name may differ, and this tool's text never names one.
const TOOL = {
    "name": "computer",
    "description": "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
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
          "description": "The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states."
        },
        "coordinate": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 2,
          "maxItems": 2,
          "description": "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."
        },
        "text": {
          "type": "string",
          "description": "The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., \"Backspace Backspace Delete\"). Supports keyboard shortcuts using the platform's modifier key (use \"cmd\" on Mac, \"ctrl\" on Windows/Linux, e.g., \"cmd+a\" or \"ctrl+a\" for select all). Page zoom shortcuts (e.g. \"cmd+=\", \"ctrl+-\", \"cmd+0\") are not supported and will return an error - use the `zoom` action to magnify a region of the page instead."
        },
        "duration": {
          "type": "number",
          "minimum": 0,
          "maximum": 10,
          "description": "The number of seconds to wait. Required for `wait`. Maximum 10 seconds."
        },
        "scroll_direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "The direction to scroll. Required for `scroll`."
        },
        "scroll_amount": {
          "type": "number",
          "minimum": 1,
          "maximum": 10,
          "description": "The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."
        },
        "start_coordinate": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 2,
          "maxItems": 2,
          "description": "(x, y): The starting coordinates for `left_click_drag`."
        },
        "region": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 4,
          "maxItems": 4,
          "description": "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."
        },
        "repeat": {
          "type": "number",
          "minimum": 1,
          "maximum": 100,
          "description": "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."
        },
        "ref": {
          "type": "string",
          "description": "Element reference ID from read_page or find tools (e.g., \"ref_1\", \"ref_2\"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions."
        },
        "modifiers": {
          "type": "string",
          "description": "Modifier keys for click actions. Supports: \"ctrl\", \"shift\", \"alt\", \"cmd\" (or \"meta\"), \"win\" (or \"windows\"). Can be combined with \"+\" (e.g., \"ctrl+shift\", \"cmd+alt\"). Optional."
        },
        "tabId": {
          "type": "number",
          "description": "Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        },
        "save_to_disk": {
          "type": "boolean",
          "description": "For screenshot/zoom actions: save the image to disk so it can be attached to a message for the user. Returns the saved path in the tool result. Only set this when you intend to share the image \u2014 screenshots you're just looking at don't need saving."
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
  CLICK_LOG_FN, PIXELS_PER_TICK, MAX_CLICK_LOG,
};
