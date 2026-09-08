# Module contract

Every tool module exports handlers plus its MCP tool definitions. `src/tools.js`
(owned by the integrator) concatenates them; modules never import each other.

```js
// src/<module>.js
const { NO_TAB, NO_REF } = require('./session');

async function readPage(session, { tabId, filter, depth, ref_id, max_chars }) { /* pure-ish logic */ }

function tools(ctx) {
  return [{
    name: 'read_page',                    // EXACT name from .spec/chrome-tool-spec.json
    description: '...',                   // our own wording; must state every default and limit the schema declares
    inputSchema: { /* copy verbatim */ },
    handler: async (args) => {
      const session = await ctx.session();
      return readPage(session, args);     // string | {content:[...]}
    },
  }];
}

module.exports = { readPage, tools };
```

## ctx

| Member | Meaning |
|---|---|
| `ctx.session()` | `Promise<Session>` — opens Firefox on first use, reused afterwards |
| `ctx.callTool(name, input)` | `Promise<ToolResult>` — only `browser_batch` uses this |
| `ctx.config` | `{ downloadDir }` — where files written for the user go |

## Handler results

- Return a `string` for text output.
- Return `{ content: [...] }` for images: `{type:'image', data: base64, mimeType}` followed by a
  short `{type:'text'}` line. `src/mcp.js` passes both through unchanged.
- Throw on failure; the server turns it into `isError: true`. Use the Chrome wording from
  `session.js` (`NO_TAB`, `NO_REF`) so failures read the same on either browser.

## Session API (src/session.js — do not edit it)

```
session.listTabs()                       -> [{tabId, context, url, clientWindow}]
session.createTab({url}) / closeTab(id)  -> numeric tab ids
session.requireContext(tabId)            -> BiDi context, throws NO_TAB
session.defaultTabId({createIfEmpty})    -> tabId for calls that omit it
session.navigate(tabId, url, wait)
session.callFunction(tabId, fnSrc, args, {ownership,timeout})   -> JS value ('root' -> RemoteValue)
session.callJson(tabId, fnSrc, args)     -> JSON.parse of a string-returning page function
session.evaluate(tabId, expression)      -> JS value (throws with .isPageException on page errors)
session.ensureRefStore(tabId)            -> installs window.__ffuse.refs (Map ref -> Element)
session.resolveRef(tabId, ref, {scroll}) -> {x,y,width,height,tag,visible,inViewport}
session.refNode(tabId, ref)              -> RemoteValue node with sharedId (for input.setFiles)
session.screenshot(tabId, {clip,format,quality,fullPage}) -> {data(base64), mimeType}
session.performActions(tabId, actions)   -> BiDi input.performActions
session.setViewport(tabId, {width,height})
session.images                           -> ImageStore: put({data,mimeType,path,width,height}) -> imageId, get(id)
session.on(bidiEvent, handler) / session.subscribe([events])
session.send(method, params, opts)       -> raw BiDi
session.viewportSize                     -> {width, height}
session.modifier                         -> 'meta' on mac, 'ctrl' elsewhere
```

Page-side ref store: `window.__ffuse = { refs: Map<string, Element>, next: number, clicks: [] }`.
`read_page`/`find` fill it; `computer`, `form_input`, `file_upload`, `upload_image` read it.

## Rules

1. **Never launch Firefox in tests.** Firefox allows one BiDi session at a time, and modules are
   built in parallel. Unit-test against `test/helpers/fake-session.js`; live checks happen later.
2. Only touch the files assigned to you. Do not edit `src/session.js`, `src/tools.js`, `bin/`,
   `package.json`, `README.md`, or another module's files.
3. Keep source ASCII: write ``-style escapes, never raw control or non-ASCII characters.
4. No npm dependencies. Node built-ins only (`zlib` is available and useful for GIF/PNG work).
5. Names and schemas come from `.spec/chrome-tool-spec.json` (generate it with `npm run spec`)
   and must match it exactly - property names, types, enums, `required`, minimum/maximum.
   **Descriptions are written here, in our own words.** Never copy the reference prose:
   `test/prose.test.js` fails on any run of ~50 characters shared with it.
