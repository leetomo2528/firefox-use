'use strict';
// Model-supplied regexes reach us from read_console_messages. Node has no
// regex timeout, and a pattern like `(\w+\s*)+ERROR` against an ordinary log
// line backtracks effectively forever - which would hang the MCP server, not
// just the call. Matching therefore runs in a worker we can terminate.

const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 1000;
// A quantified group whose body can match the same text more than one way is
// the catastrophic shape - (\w+\s*)+ or (a|aa)+. Everything else takes the
// fast path, so the common case costs nothing.

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const re = new RegExp(workerData.source, workerData.flags);
const out = [];
for (let i = 0; i < workerData.strings.length; i++) {
  if (re.test(workerData.strings[i])) out.push(i);
}
parentPort.postMessage(out);
`;

function compile(pattern, flags = 'i') {
  try {
    return new RegExp(String(pattern), flags);
  } catch (err) {
    throw new Error(`Invalid regex pattern ${JSON.stringify(String(pattern))}: ${err.message}`);
  }
}

function looksRisky(pattern) {
  const source = String(pattern);
  if (source.length > 200) return true;
  const stack = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { stack.push(i); continue; }
    if (ch !== ')') continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const next = source[i + 1];
    const quantified = next === '*' || next === '+' ||
      (next === '{' && /^\{\d+,\s*\d*\}/.test(source.slice(i + 1)));
    if (!quantified) continue;
    // The group repeats; ambiguity inside it is what makes backtracking blow up.
    const body = source.slice(start + 1, i);
    if (/[*+?|]/.test(body.replace(/\\./g, '')) || /\{\d+,/.test(body)) return true;
  }
  return false;
}

// Returns the indices of `strings` the pattern matches. Throws if the pattern
// is invalid, or if matching blew past the time budget.
async function matchIndices(pattern, strings, { flags = 'i', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const re = compile(pattern, flags);
  if (!looksRisky(pattern)) {
    const out = [];
    strings.forEach((s, i) => { if (re.test(s)) out.push(i); });
    return out;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: re.source, flags: re.flags, strings },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(
        `Pattern ${JSON.stringify(String(pattern))} took longer than ${timeoutMs}ms to match ` +
        '(catastrophic backtracking). Simplify it - avoid nested quantifiers like (\\w+\\s*)+.'
      ));
    }, timeoutMs);
    worker.once('message', (indices) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(indices);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { matchIndices, compile, looksRisky, DEFAULT_TIMEOUT_MS };
