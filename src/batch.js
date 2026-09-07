'use strict';
// browser_batch: many tool calls, one round trip.
//
// Items run sequentially through ctx.callTool, exactly as if the model had
// called each tool on its own. The whole list is validated first, so a nested
// browser_batch or a misspelled tool name never leaves half a batch applied to
// the page; after that the run stops at the first failing item and reports it
// together with the output of the items that already ran.

const NESTED = 'browser_batch cannot be nested.';

// Verbatim Chrome wording, minus the sentence about the extension's per-domain
// permission gate: firefox-use has no such check to run per item.
const TOOL = {
  name: 'browser_batch',
  description:
    'Execute a sequence of browser tool calls in ONE round trip. Each item is {name, input} where input is '
    + "exactly what you'd pass to that tool standalone. Actions execute SEQUENTIALLY (not in parallel) and stop "
    + 'on the first error. Use this tool extensively to quickly execute work whenever you can predict two or more '
    + 'steps ahead \u2014 e.g. navigate, click a field, type, press Return, screenshot. Screenshots and other images '
    + 'are returned interleaved with outputs; coordinates you write in THIS batch refer to the screenshot taken '
    + 'BEFORE this call. browser_batch cannot be nested.',
  inputSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Tool name (e.g. computer, navigate, find, tabs_create_mcp). browser_batch cannot be nested.',
            },
            input: {
              type: 'object',
              description: "That tool's input \u2014 same shape you'd pass when calling it directly.",
            },
          },
          required: ['name', 'input'],
        },
        description:
          'List of tool calls to execute sequentially. Example: [{"name":"computer","input":{"action":"left_click",'
          + '"coordinate":[100,200],"tabId":123}},{"name":"computer","input":{"action":"type","text":"hello",'
          + '"tabId":123}},{"name":"navigate","input":{"url":"https://example.com","tabId":123}}]',
      },
    },
    required: ['actions'],
  },
};

// --- validation -----------------------------------------------------------

// ctx only has to provide callTool; when it also exposes its registry a typo is
// caught before anything runs. null means "cannot tell from here".
function knownTool(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.hasTool === 'function') return !!ctx.hasTool.call(ctx, name);
    let source = ctx.toolNames !== undefined ? ctx.toolNames
      : (ctx.registry !== undefined ? ctx.registry : ctx.tools);
    // Call accessors with ctx as the receiver: ToolHost.tools() and friends are
    // prototype methods that need their `this`, and a detached call would throw
    // out of the pre-flight check and kill a batch that is perfectly valid.
    if (typeof source === 'function') source = source.call(ctx);
    if (!source) return null;
    if (Array.isArray(source)) return source.some((t) => t === name || (t && t.name === name));
    if (typeof source.has === 'function') return !!source.has(name);
  } catch {
    return null; // an unusable registry means "cannot tell", never a hard failure
  }
  return null;
}

function planBatch(ctx, actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('browser_batch needs at least one action in "actions".');
  }
  return actions.map((item, i) => {
    const index = i + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Action ${index} must be an object of the form {name, input}.`);
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) throw new Error(`Action ${index} is missing a tool name.`);
    if (name === TOOL.name) throw new Error(`Action ${index}: ${NESTED}`);
    const input = item.input === undefined || item.input === null ? {} : item.input;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`Action ${index} (${name}): input must be an object, not ${Array.isArray(input) ? 'an array' : typeof input}.`);
    }
    if (knownTool(ctx, name) === false) {
      throw new Error(`Action ${index} names an unknown tool: ${name}`);
    }
    return { index, name, input };
  });
}

// --- result shaping -------------------------------------------------------

function contentBlocks(result) {
  if (result === null || result === undefined) return [];
  if (typeof result === 'string') return result ? [{ type: 'text', text: result }] : [];
  if (Array.isArray(result.content)) return result.content.filter(Boolean);
  if (typeof result !== 'object') return [{ type: 'text', text: String(result) }];
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

// Tool text is almost always a string; anything else is serialized rather than
// stringified so a structured payload does not collapse into [object Object].
function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function blockText(blocks) {
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => textOf(b.text))
    .join('\n')
    .trim();
}

// A tool that answers with isError instead of throwing still ends the batch.
function resultError(result) {
  if (!result || typeof result !== 'object' || !result.isError) return null;
  const text = blockText(contentBlocks(result)) || 'the tool reported an error';
  return text.replace(/^Error:\s*/, '');
}

// "[2] computer" heads the item's text; every image gets its own label so an
// interleaved screenshot stays attributable to the action that took it.
function itemBlocks(index, name, result) {
  const label = `[${index}] ${name}`;
  const blocks = contentBlocks(result);
  const images = blocks.filter((b) => b && b.type === 'image').length;
  const out = [];
  let pending = [];
  let headed = false;
  let seen = 0;
  const flush = () => {
    if (!pending.length) return;
    const text = pending.join('\n');
    out.push({ type: 'text', text: headed ? text : `${label}\n${text}` });
    headed = true;
    pending = [];
  };
  for (const block of blocks) {
    if (block.type === 'text') {
      pending.push(textOf(block.text));
      continue;
    }
    flush();
    if (block.type === 'image') {
      seen += 1;
      out.push({ type: 'text', text: images > 1 ? `${label} image ${seen}:` : `${label} image:` });
    } else if (!headed) {
      // An audio/resource block still has to say which action produced it.
      out.push({ type: 'text', text: label });
    }
    headed = true;
    out.push(block);
  }
  flush();
  if (!out.length) out.push({ type: 'text', text: `${label}\n(no output)` });
  return out;
}

function plural(n) {
  return n === 1 ? '' : 's';
}

function failure(done, items, item, message) {
  const skipped = items.length - item.index;
  const text = `Action ${item.index} (${item.name}) failed: ${message}\n`
    + `Stopped: ${item.index - 1} of ${items.length} action${plural(items.length)} completed`
    + (skipped ? `, ${skipped} not run.` : '.');
  return { content: [...done, { type: 'text', text }], isError: true };
}

// --- tool -----------------------------------------------------------------

async function batch(ctx, args = {}) {
  const items = planBatch(ctx, args && args.actions);
  const content = [];
  for (const item of items) {
    let result;
    try {
      result = await ctx.callTool(item.name, item.input);
    } catch (err) {
      return failure(content, items, item, (err && err.message) || String(err));
    }
    const failed = resultError(result);
    if (failed) return failure(content, items, item, failed);
    content.push(...itemBlocks(item.index, item.name, result));
  }
  content.push({ type: 'text', text: `Completed all ${items.length} action${plural(items.length)}.` });
  return { content };
}

function tools(ctx) {
  return [{ ...TOOL, handler: (args) => batch(ctx, args || {}) }];
}

module.exports = {
  batch, tools, TOOL, NESTED,
  planBatch, knownTool, contentBlocks, itemBlocks, resultError,
};
