'use strict';
// Page script (stringified) that produces the accessibility-ish snapshot used
// for element refs. Kept in its own module so it can be unit tested.

const SNAPSHOT_FN = `(function (opts) {
  var MAX = opts.max || 200;
  var includeOffscreen = !!opts.includeOffscreen;
  var SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=searchbox]',
    '[role=textbox]', '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function cssPath(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      var tag = node.localName;
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      var parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var same = 0, index = 0;
      for (var i = 0; i < parent.children.length; i++) {
        var child = parent.children[i];
        if (child.localName === tag) { same++; if (child === node) index = same; }
      }
      parts.unshift(same > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  function labelFor(el) {
    var text = el.getAttribute('aria-label');
    if (!text && el.getAttribute('aria-labelledby')) {
      var ids = el.getAttribute('aria-labelledby').split(/\\s+/);
      var acc = [];
      for (var i = 0; i < ids.length; i++) {
        var ref = document.getElementById(ids[i]);
        if (ref) acc.push(ref.innerText || ref.textContent || '');
      }
      text = acc.join(' ');
    }
    if (!text && el.labels && el.labels.length) text = el.labels[0].innerText;
    if (!text) text = el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (!text && el.localName !== 'input' && el.localName !== 'textarea') text = el.innerText || el.textContent || '';
    if (!text) text = el.getAttribute('name') || el.value || '';
    return String(text).replace(/\\s+/g, ' ').trim().slice(0, 120);
  }

  function roleFor(el) {
    var role = el.getAttribute('role');
    if (role) return role;
    if (el.localName === 'a') return 'link';
    if (el.localName === 'input') return 'input:' + (el.getAttribute('type') || 'text');
    if (el.localName === 'textarea') return 'textbox';
    if (el.localName === 'select') return 'combobox';
    if (el.localName === 'button') return 'button';
    if (el.isContentEditable) return 'textbox';
    return el.localName;
  }

  var w = window.innerWidth, h = window.innerHeight;
  var nodes = document.querySelectorAll(SEL);
  var out = [];
  var seen = new Set();
  for (var i = 0; i < nodes.length && out.length < MAX; i++) {
    var el = nodes[i];
    if (seen.has(el)) continue;
    seen.add(el);
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    var onScreen = rect.bottom > 0 && rect.right > 0 && rect.top < h && rect.left < w;
    if (!onScreen && !includeOffscreen) continue;
    var item = {
      role: roleFor(el),
      name: labelFor(el),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      selector: cssPath(el),
      onScreen: onScreen
    };
    if (el.disabled) item.disabled = true;
    if (el.checked) item.checked = true;
    if (el.value && (el.localName === 'input' || el.localName === 'textarea')) {
      item.value = String(el.value).slice(0, 80);
    }
    if (el.localName === 'a' && el.href) item.href = String(el.href).slice(0, 200);
    out.push(item);
  }

  return JSON.stringify({
    url: location.href,
    title: document.title,
    viewport: { width: w, height: h },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    documentHeight: Math.round(document.documentElement.scrollHeight),
    truncated: nodes.length > MAX,
    elements: out
  });
})`;

// Resolves a stored selector again, scrolls it into view and reports where it
// landed, so a ref stays usable after the page has moved underneath it.
const RESOLVE_FN = `(function (selector, scroll) {
  var el = document.querySelector(selector);
  if (!el) return JSON.stringify({ found: false });
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var r = el.getBoundingClientRect();
  var visible = r.width > 0 && r.height > 0;
  return JSON.stringify({
    found: true,
    visible: visible,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    width: Math.round(r.width),
    height: Math.round(r.height),
    inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
    tag: el.localName
  });
})`;

const TEXT_FN = `(function (opts) {
  var body = document.body;
  var text = body ? (body.innerText || body.textContent || '') : '';
  text = text.replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  var start = opts.offset || 0;
  var limit = opts.limit || 8000;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    total: text.length,
    offset: start,
    text: text.slice(start, start + limit)
  });
})`;

module.exports = { SNAPSHOT_FN, RESOLVE_FN, TEXT_FN };
