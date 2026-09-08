#!/usr/bin/env node
'use strict';
// Generates the parity fixture from YOUR OWN Claude Code install.
//
// firefox-use matches the tool surface of Claude Code's Chrome integration so a
// browser task runs the same on either browser. Those definitions belong to
// Anthropic and are not redistributed here: this script reads them out of the
// Claude Code binary already on this machine and writes .spec/chrome-tool-spec.json,
// which test/parity.test.js compares our schemas against. The file stays local.
//
//   node scripts/extract-chrome-spec.js [--binary <path>] [--out <file>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT_DEFAULT = path.join(__dirname, '..', '.spec', 'chrome-tool-spec.json');
// One tool name that is unlikely to move; the array is found from here.
const ANCHOR = '{name:"read_page",description:';

function findBinary(explicit) {
  if (explicit) return explicit;
  const home = os.homedir();
  const versions = path.join(home, '.local/share/claude/versions');
  if (fs.existsSync(versions)) {
    const entries = fs.readdirSync(versions)
      .map((name) => ({ name, full: path.join(versions, name) }))
      .filter((e) => fs.statSync(e.full).isFile())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (entries.length) return entries[entries.length - 1].full;
  }
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    const resolved = fs.realpathSync(which.stdout.trim());
    if (fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

// The array literal starts at `[{name:`; a bare lastIndexOf('[') would land on a
// bracket inside one of the descriptions. Candidates are tried newest first.
function arrayStarts(text, anchorIndex) {
  const starts = [];
  let from = anchorIndex;
  while (starts.length < 8) {
    const at = text.lastIndexOf('[{name:', from);
    if (at === -1) break;
    starts.push(at);
    from = at - 1;
  }
  return starts;
}

// Reads one balanced array literal, tracking strings so a bracket inside a
// description never ends the scan early.
function sliceArray(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('the tool array is not terminated');
}

// The minified array references a few locals defined just before it.
function collectBindings(text, arrayStart) {
  const window = text.slice(Math.max(0, arrayStart - 6000), arrayStart);
  const bindings = [];
  // Declarations are comma-chained after minification (var a=1,b=2,e=10), so
  // the leading keyword is optional after the first declarator.
  const re = /(?:var|let|const|,)\s*([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:e\d+)?)(?=\s*[,;])/g;
  let m;
  while ((m = re.exec(window))) bindings.push(`var ${m[1]} = ${m[2]};`);
  return bindings.join('\n');
}

function evaluateLiteral(literal, prelude) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      // eslint-disable-next-line no-new-func
      return new Function(`${prelude}\nreturn ${literal};`)();
    } catch (err) {
      const missing = /(\w[\w$]*) is not defined/.exec(err.message);
      if (!missing) throw err;
      // A local the prelude did not capture; a placeholder keeps the shape.
      globalThis[missing[1]] = '';
    }
  }
  throw new Error('could not evaluate the tool array');
}

function extract(binaryPath) {
  const text = fs.readFileSync(binaryPath, 'latin1');
  const anchorIndex = text.indexOf(ANCHOR);
  if (anchorIndex === -1) {
    throw new Error(
      'This Claude Code build does not contain the browser tool definitions in the expected form. ' +
      'Skip the parity fixture: the unit tests and the live suite do not need it.'
    );
  }
  const problems = [];
  for (const start of arrayStarts(text, anchorIndex)) {
    try {
      const tools = evaluateLiteral(sliceArray(text, start), collectBindings(text, start));
      if (!Array.isArray(tools)) continue;
      const clean = tools.filter((t) => t && typeof t.name === 'string' && t.inputSchema);
      if (clean.some((t) => t.name === 'read_page') && clean.length >= 10) return clean;
    } catch (err) {
      problems.push(err.message);
    }
  }
  throw new Error(`no tool array could be read (${problems.slice(0, 2).join('; ') || 'no candidate matched'})`);
}

function main() {
  const args = process.argv.slice(2);
  const binary = findBinary(args.includes('--binary') ? args[args.indexOf('--binary') + 1] : null);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : OUT_DEFAULT;
  if (!binary) {
    console.error('Claude Code was not found. Pass --binary <path> to point at it.');
    process.exit(1);
  }
  console.error(`reading ${binary}`);
  const tools = extract(binary);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(tools, null, 2)}\n`);
  console.log(`${tools.length} tool definitions -> ${out}`);
  console.log(tools.map((t) => t.name).join(', '));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`extract-chrome-spec: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { extract, findBinary, sliceArray, arrayStarts, collectBindings, evaluateLiteral };
