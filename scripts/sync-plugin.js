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

const files = [
  {
    what: 'skill',
    from: path.join(ROOT, 'skills/claude-in-firefox/SKILL.md'),
    to: path.join(ROOT, 'plugins/firefox-use/skills/claude-in-firefox/SKILL.md'),
  },
];

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

if (CHECK && drift.length) {
  console.error(`plugin is out of sync:\n  ${drift.join('\n  ')}\nRun: npm run sync-plugin`);
  process.exit(1);
}
if (CHECK) console.log('plugin is in sync');
