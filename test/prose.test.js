'use strict';
// The interface is shared with Claude Code's Chrome integration; the writing is
// not. This guards that: no long run of text may match the reference, which is
// generated locally by `npm run spec` and never committed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SPEC_PATH = path.join(__dirname, '..', '.spec', 'chrome-tool-spec.json');
const SPEC = fs.existsSync(SPEC_PATH) ? JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) : null;
const skip = SPEC ? false : 'run `npm run spec` to generate .spec/chrome-tool-spec.json';

// Shared technical phrasing is unavoidable ("the URL to navigate to"); a copied
// sentence is not. This is where one stops being the other.
const MAX_SHARED_RUN = 50;

function longestSharedRun(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return { length: 0, text: '' };
  let previous = new Array(y.length + 1).fill(0);
  let best = 0;
  let end = 0;
  for (let i = 1; i <= x.length; i++) {
    const current = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] !== y[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) {
        best = current[j];
        end = i;
      }
    }
    previous = current;
  }
  return { length: best, text: x.slice(end - best, end) };
}

function ourTools() {
  const { ToolHost } = require('../src/tools');
  return new Map(new ToolHost({}).tools().map((t) => [t.name, t]));
}

test('longestSharedRun finds the overlap it is asked for', () => {
  assert.equal(longestSharedRun('abcdef', 'zzcdezz').text, 'cde');
  assert.equal(longestSharedRun('same text', 'same text').length, 9);
  assert.equal(longestSharedRun('abc', 'xyz').length, 0);
  assert.equal(longestSharedRun('', 'anything').length, 0);
});

test('no tool description repeats the reference text', { skip }, () => {
  const mine = ourTools();
  const offenders = [];
  for (const spec of SPEC) {
    const tool = mine.get(spec.name);
    if (!tool) continue;
    const run = longestSharedRun(tool.description, spec.description);
    if (run.length >= MAX_SHARED_RUN) {
      offenders.push(`${spec.name}: ${run.length} chars - ${JSON.stringify(run.text.slice(0, 80))}`);
    }
  }
  assert.deepEqual(offenders, [], `rewrite these in our own words:\n  ${offenders.join('\n  ')}`);
});

test('no parameter description repeats the reference text', { skip }, () => {
  const mine = ourTools();
  const offenders = [];
  for (const spec of SPEC) {
    const tool = mine.get(spec.name);
    if (!tool) continue;
    for (const [prop, def] of Object.entries(spec.inputSchema.properties || {})) {
      const ours = tool.inputSchema.properties?.[prop];
      if (!ours || !def.description || !ours.description) continue;
      const run = longestSharedRun(ours.description, def.description);
      if (run.length >= MAX_SHARED_RUN) {
        offenders.push(`${spec.name}.${prop}: ${run.length} chars - ${JSON.stringify(run.text.slice(0, 80))}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `rewrite these in our own words:\n  ${offenders.join('\n  ')}`);
});

test('the repository ships none of the extracted definitions', () => {
  const root = path.join(__dirname, '..');
  const stray = ['docs/chrome-tool-spec.json', 'chrome-tool-spec.json', 'spec/chrome-tool-spec.json']
    .filter((rel) => fs.existsSync(path.join(root, rel)));
  assert.deepEqual(stray, [], `these must stay local (.spec/): ${stray.join(', ')}`);
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.spec\/$/m, '.spec/ must be gitignored');
});
