'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// stop() reads state.json; keep these tests away from a real one.
process.env.FIREFOX_USE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-home-'));
const launcher = require('../src/launcher');

test('the session endpoint is appended exactly once', () => {
  assert.equal(launcher.sessionUrl('ws://127.0.0.1:9222'), 'ws://127.0.0.1:9222/session');
  assert.equal(launcher.sessionUrl('ws://127.0.0.1:9222/'), 'ws://127.0.0.1:9222/session');
  assert.equal(launcher.sessionUrl('ws://127.0.0.1:9222/session'), 'ws://127.0.0.1:9222/session');
});

test('macOS app bundles are derived from the binary path', () => {
  assert.equal(
    launcher.appBundleFor('/Applications/Firefox.app/Contents/MacOS/firefox'),
    '/Applications/Firefox.app'
  );
  assert.equal(launcher.appBundleFor('/usr/bin/firefox'), null);
});

test('launch arguments carry the profile, port and headless flag', () => {
  const args = launcher.firefoxArgs({ profile: '/tmp/p', port: 9333, headless: true, url: 'https://x.dev' });
  assert.deepEqual(args, ['--profile', '/tmp/p', '--remote-debugging-port', '9333', '--headless', 'https://x.dev']);
  const plain = launcher.firefoxArgs({ profile: '/tmp/p', port: 9222, headless: false });
  assert.equal(plain.includes('--headless'), false);
  assert.equal(plain[plain.length - 1], 'about:blank');
});

test('a profile gets automation preferences written every launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-'));
  const dir = path.join(root, 'profile');
  try {
    assert.equal(launcher.ensureProfile(dir), true, 'reports a fresh profile');
    const prefs = fs.readFileSync(path.join(dir, 'user.js'), 'utf8');
    assert.match(prefs, /user_pref\("remote\.active-protocols", 1\);/);
    assert.match(prefs, /user_pref\("browser\.shell\.checkDefaultBrowser", false\);/);
    assert.match(prefs, /user_pref\("browser\.startup\.homepage", "about:blank"\);/);
    assert.equal(launcher.ensureProfile(dir), false, 'an existing profile is reused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dead pid is never reported alive', () => {
  assert.equal(launcher.pidAlive(0), false);
  assert.equal(launcher.pidAlive(999999), false);
  assert.equal(launcher.pidAlive(process.pid), true);
});

test('a closed port probes as closed', async () => {
  assert.equal(await launcher.probePort(1, '127.0.0.1', 200), false);
});

test('macOS tries launchd first and keeps a direct spawn in reserve', () => {
  assert.deepEqual(launcher.launchPlan('darwin', '/Applications/Firefox.app'), ['open', 'direct']);
  // A Mac without an .app bundle (a binary somewhere else) has nothing to hand launchd.
  assert.deepEqual(launcher.launchPlan('darwin', null), ['direct']);
  assert.deepEqual(launcher.launchPlan('linux', null), ['direct']);
  assert.deepEqual(launcher.launchPlan('win32', null), ['direct']);
});

test('waitForPort gives up on a direct spawn that died', async () => {
  const dead = { pid: 999999 };
  const note = {};
  const ok = await launcher.waitForPort(1, {
    deadline: Date.now() + 3000,
    child: dead,
    kind: 'direct',
    note,
  });
  assert.equal(ok, false);
  assert.equal(note.exited, true, 'reports why it stopped waiting');
});

test('waitForPort keeps waiting for open, whose exit says nothing', async () => {
  const started = Date.now();
  const note = {};
  const ok = await launcher.waitForPort(1, {
    deadline: Date.now() + 600,
    child: { pid: 999999 },
    kind: 'open',
    note,
  });
  assert.equal(ok, false);
  assert.equal(note.exited, undefined);
  assert.ok(Date.now() - started >= 500, 'waited for the deadline instead of the child');
});

test('extra preferences are written for one launch only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-'));
  const dir = path.join(root, 'profile');
  try {
    launcher.ensureProfile(dir, { 'dom.allow_scripts_to_close_windows': true });
    assert.match(fs.readFileSync(path.join(dir, 'user.js'), 'utf8'), /dom\.allow_scripts_to_close_windows", true/);
    launcher.ensureProfile(dir);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'user.js'), 'utf8'), /allow_scripts_to_close_windows/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the port pattern does not match a longer port number', () => {
  const re = new RegExp(launcher.portPattern(9222));
  assert.ok(re.test('/x/firefox --profile /p --remote-debugging-port 9222 about:blank'));
  assert.ok(re.test('/x/firefox --remote-debugging-port 9222'));
  assert.ok(!re.test('/x/firefox --remote-debugging-port 92220 about:blank'));
});

// A stand-in process whose command line carries the flag a launched Firefox
// has. `name` is the executable it runs as (a symlink to node).
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'ffuse-bin-'));
function fakeProcess(name, port) {
  const exe = path.join(FAKE_BIN, name);
  if (!fs.existsSync(exe)) fs.symlinkSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setInterval(() => {}, 1000)', '--', '--remote-debugging-port', String(port)], {
    stdio: 'ignore',
  });
  return new Promise((resolve) => setTimeout(() => resolve(child), 300));
}

test('stop ends the browser on our port, and nothing else that mentions it', async (t) => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const ours = await fakeProcess('firefox', port);
  const lookalike = await fakeProcess('firefox', `${port}0`);
  // A shell or grep whose arguments happen to carry the flag.
  const bystander = await fakeProcess('not-a-browser', port);
  t.after(() => { for (const p of [ours, lookalike, bystander]) p.kill('SIGKILL'); });

  assert.equal(launcher.isOurFirefox(ours.pid, port), true);
  assert.equal(launcher.isOurFirefox(lookalike.pid, port), false);
  assert.equal(launcher.isOurFirefox(process.pid, port), false, 'a live pid that is not ours');
  assert.deepEqual(launcher.findPidsForPort(port), [ours.pid]);

  // No state.json names it: stop finds it by the port alone.
  assert.equal(await launcher.stop({ port }), true);
  assert.equal(launcher.pidAlive(ours.pid), false);
  assert.equal(launcher.pidAlive(lookalike.pid), true);
  assert.equal(launcher.pidAlive(bystander.pid), true);
  assert.equal(await launcher.stop({ port }), false, 'nothing left to stop');
});

test('stop never signals a recycled pid from a stale state file', async () => {
  // state.json says Firefox is this test process: alive, but not ours.
  launcher.writeState({ pid: process.pid, port: 1, url: 'ws://127.0.0.1:1' });
  assert.equal(await launcher.stop({ port: 1 }), false);
});
