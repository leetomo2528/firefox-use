'use strict';
// Finds, launches and tracks the Firefox instance that exposes WebDriver BiDi.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOME = os.homedir();
const STATE_DIR = process.env.FIREFOX_USE_HOME || path.join(HOME, '.firefox-use');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'firefox.log');
const DEFAULT_PROFILE = path.join(STATE_DIR, 'profile');
const DEFAULT_PORT = Number(process.env.FIREFOX_USE_PORT || 9222);

const CANDIDATES = [
  process.env.FIREFOX_BIN,
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
  path.join(HOME, 'Applications/Firefox.app/Contents/MacOS/firefox'),
  '/usr/bin/firefox',
  '/usr/local/bin/firefox',
  '/snap/bin/firefox',
];

// Preferences that keep an automation profile quiet: no first-run tour, no
// telemetry prompts, no session restore dialog after a hard stop.
const PREFS = {
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage': '"about:blank"',
  'browser.startup.page': 0,
  'browser.startup.firstrunSkipsHomepage': true,
  'browser.aboutwelcome.enabled': false,
  'browser.sessionstore.resume_from_crash': false,
  'browser.tabs.warnOnClose': false,
  'browser.warnOnQuit': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'trailhead.firstrun.didSeeAboutWelcome': true,
  'browser.contentblocking.category': '"standard"',
  'app.update.auto': false,
  'remote.active-protocols': 1, // WebDriver BiDi only
};

function findFirefox() {
  for (const p of CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  const which = spawnSync('which', ['firefox'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function probePort(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function ensureProfile(dir) {
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const lines = Object.entries(PREFS).map(
    ([key, value]) => `user_pref("${key}", ${typeof value === 'string' ? value : JSON.stringify(value)});`
  );
  fs.writeFileSync(path.join(dir, 'user.js'), lines.join('\n') + '\n');
  return fresh;
}

const BIDI_LINE = /WebDriver BiDi listening on (ws:\/\/\S+)/;

function scanLogForUrl(since = 0) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').slice(since);
    const m = text.match(BIDI_LINE);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function scanLogTail(since = 0, max = 400) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').slice(since).trim().split('\n').slice(-3).join(' | ').slice(-max);
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appBundleFor(bin) {
  const i = bin.indexOf('.app/Contents/MacOS/');
  return i === -1 ? null : bin.slice(0, i + 4);
}

function findPidForPort(port) {
  const res = spawnSync('pgrep', ['-f', `remote-debugging-port ${port}`], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const pids = res.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  return pids.length ? pids[pids.length - 1] : null;
}

function firefoxArgs({ profile, port, headless, url }) {
  const args = ['--profile', profile, '--remote-debugging-port', String(port)];
  if (headless) args.push('--headless');
  args.push(url || 'about:blank');
  return args;
}

async function launch(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const profile = opts.profile || process.env.FIREFOX_USE_PROFILE || DEFAULT_PROFILE;
  const headless = opts.headless ?? process.env.FIREFOX_USE_HEADLESS === '1';
  const bin = opts.bin || findFirefox();
  if (!bin) {
    throw new Error('Firefox not found. Install it, or set FIREFOX_BIN to the firefox binary path.');
  }
  ensureProfile(profile);
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const args = firefoxArgs({ profile, port, headless, url: opts.url });
  const logStart = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  const log = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} launch ${bin} ${args.join(' ')}\n`);

  const bundle = process.platform === 'darwin' ? appBundleFor(bin) : null;
  let child;
  if (bundle) {
    // macOS protects an application's support directory, and a Firefox started
    // as a child of the shell inherits the shell's (denied) permissions, so it
    // dies with "Could not find profile folder". `open` hands the launch to
    // launchd, where Firefox runs under its own identity.
    child = spawn('/usr/bin/open', ['-n', '-a', bundle, '--args', ...args], {
      detached: true,
      stdio: ['ignore', log, log],
    });
  } else {
    child = spawn(bin, [...args, '--no-remote'], { detached: true, stdio: ['ignore', log, log] });
  }
  child.unref();
  fs.closeSync(log);

  const deadline = Date.now() + (opts.timeout || 45000);
  let reachable = false;
  while (Date.now() < deadline) {
    if (await probePort(port)) { reachable = true; break; }
    if (!bundle && !pidAlive(child.pid)) {
      throw new Error(`Firefox exited during startup. See ${LOG_FILE}`);
    }
    await sleep(200);
  }
  if (!reachable) {
    const tail = scanLogTail(logStart);
    throw new Error(`Firefox did not open the BiDi port ${port} in time.${tail ? ` Log: ${tail}` : ''} See ${LOG_FILE}`);
  }

  const url = scanLogForUrl(logStart) || `ws://127.0.0.1:${port}`;
  const pid = bundle ? findPidForPort(port) : child.pid;
  const state = { pid, port, url, profile, headless, bin, startedAt: new Date().toISOString() };
  writeState(state);
  return state;
}

async function status() {
  const state = readState();
  const port = state?.port || DEFAULT_PORT;
  const open = await probePort(port);
  return {
    running: open,
    reachable: open,
    pid: state?.pid ?? null,
    pidAlive: pidAlive(state?.pid),
    port,
    url: state?.url || `ws://127.0.0.1:${port}`,
    profile: state?.profile || DEFAULT_PROFILE,
    headless: state?.headless ?? false,
    logFile: LOG_FILE,
  };
}

// Returns the BiDi endpoint, launching Firefox only when nothing answers yet.
async function ensureRunning(opts = {}) {
  const st = await status();
  if (st.reachable && !opts.forceRestart) return { ...st, launched: false };
  const state = await launch(opts);
  return { ...state, launched: true };
}

async function stop({ force = false } = {}) {
  const state = readState();
  if (!state?.pid || !pidAlive(state.pid)) return false;
  try {
    process.kill(state.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    return false;
  }
  for (let i = 0; i < 50 && pidAlive(state.pid); i++) await sleep(100);
  if (pidAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
  return true;
}

function sessionUrl(base) {
  const u = base.replace(/\/+$/, '');
  return u.endsWith('/session') ? u : `${u}/session`;
}

module.exports = {
  STATE_DIR, STATE_FILE, LOG_FILE, DEFAULT_PROFILE, DEFAULT_PORT,
  findFirefox, readState, writeState, pidAlive, probePort, ensureProfile,
  appBundleFor, firefoxArgs, findPidForPort, scanLogForUrl,
  launch, status, ensureRunning, stop, sessionUrl,
};
