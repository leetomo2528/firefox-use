#!/usr/bin/env node
'use strict';
// The plugin ships the skill, and the version lives in three manifests. This
// copies the one from the other, so they cannot drift.
//
//   node scripts/sync-plugin.js [--check]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK = process.argv.includes('--check');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const PLUGIN = path.join(ROOT, 'plugins/firefox-use');

// The plugin carries its own copy of the server so it works the moment it is
// installed - no npm, no network. These are copies, never edited in place.
const TREES = ['src', 'bin'];
const files = [
  {
    what: 'skill',
    from: path.join(ROOT, 'skills/claude-in-firefox/SKILL.md'),
    to: path.join(PLUGIN, 'skills/claude-in-firefox/SKILL.md'),
  },
  { what: 'license', from: path.join(ROOT, 'LICENSE'), to: path.join(PLUGIN, 'LICENSE') },
  { what: 'notice', from: path.join(ROOT, 'NOTICE'), to: path.join(PLUGIN, 'NOTICE') },
];

function listTree(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTree(full));
    else out.push(full);
  }
  return out;
}

for (const tree of TREES) {
  const base = path.join(ROOT, tree);
  for (const from of listTree(base)) {
    files.push({
      what: tree,
      from,
      to: path.join(PLUGIN, tree, path.relative(base, from)),
      mode: fs.statSync(from).mode,
    });
  }
}

// The bundled server reads its own package.json for the version string.
files.push({ what: 'package', from: path.join(ROOT, 'package.json'), to: path.join(PLUGIN, 'package.json') });

const versioned = [
  path.join(ROOT, '.claude-plugin/marketplace.json'),
  path.join(ROOT, 'plugins/firefox-use/.claude-plugin/plugin.json'),
];

let drift = [];

for (const file of files) {
  const source = fs.readFileSync(file.from, 'utf8');
  const current = fs.existsSync(file.to) ? fs.readFileSync(file.to, 'utf8') : null;
  if (source === current) continue;
  if (CHECK) drift.push(`${file.what}: ${path.relative(ROOT, file.to)} is out of date`);
  else {
    fs.mkdirSync(path.dirname(file.to), { recursive: true });
    fs.writeFileSync(file.to, source);
    if (file.mode) fs.chmodSync(file.to, file.mode);
    console.log(`synced ${path.relative(ROOT, file.to)}`);
  }
}

for (const manifest of versioned) {
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const stamp = (obj) => {
    let changed = false;
    if (obj.version && obj.version !== pkg.version) { obj.version = pkg.version; changed = true; }
    if (obj.metadata?.version && obj.metadata.version !== pkg.version) { obj.metadata.version = pkg.version; changed = true; }
    for (const plugin of obj.plugins || []) {
      if (plugin.version !== pkg.version) { plugin.version = pkg.version; changed = true; }
    }
    return changed;
  };
  if (!stamp(data)) continue;
  if (CHECK) drift.push(`version: ${path.relative(ROOT, manifest)} does not say ${pkg.version}`);
  else {
    fs.writeFileSync(manifest, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`stamped ${path.relative(ROOT, manifest)} with ${pkg.version}`);
  }
}

// A file deleted upstream must disappear from the copy too.
for (const tree of [...TREES]) {
  const base = path.join(PLUGIN, tree);
  if (!fs.existsSync(base)) continue;
  const expected = new Set(files.filter((f) => f.what === tree).map((f) => f.to));
  for (const existing of listTree(base)) {
    if (expected.has(existing)) continue;
    if (CHECK) drift.push(`stale: ${path.relative(ROOT, existing)}`);
    else {
      fs.rmSync(existing);
      console.log(`removed ${path.relative(ROOT, existing)}`);
    }
  }
}

if (CHECK && drift.length) {
  console.error(`plugin is out of sync:\n  ${drift.join('\n  ')}\nRun: npm run sync-plugin`);
  process.exit(1);
}
if (CHECK) console.log('plugin is in sync');
