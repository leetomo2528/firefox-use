'use strict';
// WebDriver key values (Unicode PUA, spec section "Keyboard actions") for named
// keys, plus combo parsing. Written as escapes so the source stays ASCII.

const KEYS = {
  cancel: '\uE001', help: '\uE002', backspace: '\uE003', tab: '\uE004', clear: '\uE005',
  return: '\uE006', enter: '\uE007', shift: '\uE008', control: '\uE009', ctrl: '\uE009',
  alt: '\uE00A', option: '\uE00A', pause: '\uE00B', escape: '\uE00C', esc: '\uE00C',
  space: ' ', pageup: '\uE00E', pagedown: '\uE00F', end: '\uE010', home: '\uE011',
  arrowleft: '\uE012', left: '\uE012', arrowup: '\uE013', up: '\uE013',
  arrowright: '\uE014', right: '\uE014', arrowdown: '\uE015', down: '\uE015',
  insert: '\uE016', delete: '\uE017', del: '\uE017',
  f1: '\uE031', f2: '\uE032', f3: '\uE033', f4: '\uE034', f5: '\uE035', f6: '\uE036',
  f7: '\uE037', f8: '\uE038', f9: '\uE039', f10: '\uE03A', f11: '\uE03B', f12: '\uE03C',
  meta: '\uE03D', command: '\uE03D', cmd: '\uE03D', super: '\uE03D', win: '\uE03D',
};

const MODIFIERS = new Set(['shift', 'control', 'ctrl', 'alt', 'option', 'meta', 'command', 'cmd', 'super', 'win']);

function keyValue(name) {
  const key = String(name).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KEYS, key)) return KEYS[key];
  if (Array.from(String(name)).length === 1) return String(name);
  throw new Error(`unknown key: ${name}`);
}

// "cmd+shift+t" -> key actions that hold the modifiers around the final key.
function comboActions(combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key combo');
  const last = parts.pop();
  for (const part of parts) {
    if (!MODIFIERS.has(part.toLowerCase())) throw new Error(`not a modifier: ${part}`);
  }
  const mods = parts.map(keyValue);
  const key = keyValue(last);
  const actions = [];
  for (const mod of mods) actions.push({ type: 'keyDown', value: mod });
  actions.push({ type: 'keyDown', value: key }, { type: 'keyUp', value: key });
  for (const mod of [...mods].reverse()) actions.push({ type: 'keyUp', value: mod });
  return actions;
}

function typeActions(text) {
  const actions = [];
  for (const ch of String(text)) {
    const value = ch === '\n' ? KEYS.enter : ch;
    actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
  }
  return actions;
}

module.exports = { KEYS, MODIFIERS, keyValue, comboActions, typeActions };
