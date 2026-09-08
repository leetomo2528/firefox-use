'use strict';
// browser_batch: many tool calls, one round trip.
//
// Items run sequentially through ctx.callTool, exactly as if the model had
// called each tool on its own. The whole list is validated first, so a nested
// browser_batch or a misspelled tool name never leaves half a batch applied to
// the page; after that the run stops at the first failing item and reports it
// together with the output of the items that already ran.

const NESTED = 'browser_batch cannot be nested.';

// The schema below is the Chrome contract - same tool name, same {name, input}
// item shape, same minItems - so a batch written for one browser runs on the
// other. The wording is ours, and it says what firefox-use actually does: there
// is no per-domain permission gate to run between items here.
const TOOL = {
  name: 'browser_batch',
  description:
    'Push a whole run of browser tool calls through one request rather than spending a turn on each. '
    + 'Every entry is {name, input}, where input is the same object you would hand that tool on its own. '
    + 'Entries run one after another, never in parallel, and the run halts at the first failure: you get the '
    + 'output of everything that finished, the error from the entry that broke, and a count of the entries '
    + 'that never started. The list is checked before anything touches the page, so an unknown tool name, or '
    + 'an attempt to put browser_batch inside itself, rejects the call outright instead of half-applying it. '
    + 'Batch aggressively whenever you can see two or more moves ahead - open the page, click into the '
    + 'search box, type the query, press Return, take a screenshot. Images come back inline among the text '
    + 'outputs, each labelled with the entry that produced it. Two things bite here. First, any coordinate '
    + 'you write in these entries, and any ref you name, come from a screenshot taken BEFORE the call or a '
    + 'read_page that ran before it, since nothing this batch paints is visible to you while you compose it '
    + '- and once an entry navigates or reloads, every earlier ref and coordinate is stale, so end the batch '
    + 'there and look again. Second, every entry that acts on a page has to state tabId - inside a '
    + 'batch no tab is inferred, so a batch that creates a tab and then drives it must repeat that new id on '
    + 'each later entry. Unlike the Chrome extension, firefox-use runs no per-site permission check between '
    + 'entries; it drives its own automation profile. A modal dialog does still freeze the page, so clear it '
    + 'with firefox_dialog rather than letting the rest of the batch queue up behind it.',
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
              description:
                'Which tool this entry calls, spelled exactly as it is registered - computer, navigate, find, '
                + 'read_page, tabs_create_mcp and the rest. Naming browser_batch here is refused up front, '
                + 'because a batch may not contain another batch.',
            },
            input: {
              type: 'object',
              description:
                'The arguments for that tool, shaped exactly as they would be in a standalone call; pass {} '
                + 'for a tool that takes none. Anything that acts on a page needs its tabId given here.',
            },
          },
          required: ['name', 'input'],
        },
        description:
          'The ordered calls to make, one or more, run from the top down. Example: '
          + '[{"name":"navigate","input":{"tabId":7,"url":"https://docs.example.org/search"}},'
          + '{"name":"computer","input":{"tabId":7,"coordinate":[420,260],"action":"left_click"}},'
          + '{"name":"computer","input":{"tabId":7,"text":"budget report","action":"type"}}]',
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
      // Page tools require an explicit tabId inside a batch (the Chrome spec
      // says so): without this stamp, an item that forgot tabId would silently
      // act on the group's first tab instead of the one the batch just made.
      result = await ctx.callTool(item.name, { ...item.input, __inBatch: true });
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
