'use strict';
// CLI argument parsing, split out so it can be tested without launching anything.

const VALUE_FLAGS = new Set(['port', 'profile', 'scope', 'name']);
// Spelled like flags, but they are commands: without this `firefox-use --help`
// fell through to the default and sat waiting for MCP input on stdin.
const FLAG_COMMANDS = new Set(['--help', '-h', '--version', '-v']);

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && (!args[0].startsWith('-') || FLAG_COMMANDS.has(args[0])) ? args.shift() : 'mcp';
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    // A value flag consumes the next token, so it never lands in positionals
    // and turns `shot page.png --port 9333` into a navigation to "9333".
    if (VALUE_FLAGS.has(name) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      flags.set(name, args[++i]);
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags, positionals, flag: (name) => flags.get(name) };
}

module.exports = { parseArgs, VALUE_FLAGS };
