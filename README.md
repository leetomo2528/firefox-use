# firefox-use

**Computer use for Firefox.** Claude Code ships a Chrome-only browser integration
(`claude --chrome`, tools `mcp__claude-in-chrome__*`). firefox-use gives Claude the
**same tool surface** — same names, same schemas, same semantics — driving Firefox
through **WebDriver BiDi**.

No npm dependencies, no geckodriver, no browser extension. Firefox 129+ speaks BiDi
natively; everything here (WebSocket client, BiDi transport, MCP server, PNG/GIF
codecs) is plain Node built-ins.

## Install

```bash
node ~/firefox-use/bin/firefox-use install         # claude mcp add firefox
node ~/firefox-use/bin/firefox-use install-skill   # the claude-in-firefox skill
node ~/firefox-use/bin/firefox-use doctor          # Firefox, profile, port, handshake
```

Start a new Claude Code session; the tools appear as `mcp__firefox__*`.

## The tool surface (parity with Claude in Chrome)

`docs/chrome-tool-spec.json` holds the Chrome integration's verbatim tool definitions,
extracted from the Claude Code bundle. These are implemented against Firefox:

| Tool | Purpose |
|---|---|
| `tabs_context_mcp` | The session's tab group — call it before anything else |
| `tabs_create_mcp` / `tabs_close_mcp` | Open / close a tab in the group |
| `navigate` | URL, `back`, `forward` |
| `computer` | click / double / triple / right click, hover, type, key, scroll, drag, screenshot, zoom, scroll_to, wait |
| `read_page` | Accessibility tree with `ref_N` element refs |
| `find` | Natural-language element lookup |
| `form_input` | Set a field by ref (text, number, checkbox, select) |
| `get_page_text` | Article-first plain text |
| `read_console_messages` | Console output, regex-filtered |
| `read_network_requests` | Network log, URL-filtered |
| `javascript_tool` | Run JS in the page (REPL semantics) |
| `browser_batch` | Several tool calls in one round trip |
| `resize_window` | Resize the window |
| `file_upload` / `upload_image` | Populate file inputs; drop a screenshot onto a page |
| `gif_creator` | Record the session and export an annotated GIF |

Firefox-only extras: `firefox_status`, `firefox_restart`, `firefox_dialog` (Chrome's
integration dies on a modal dialog; here you can clear it).

Not applicable: `switch_browser`, `list_connected_browsers`, `select_browser`,
`shortcuts_list`, `shortcuts_execute` — Chrome-extension and side-panel features.

## CLI

```bash
firefox-use start [url]      # launch Firefox with BiDi enabled
firefox-use status           # running? which profile, port, tabs
firefox-use open <url>
firefox-use shot page.png [url] [--full]
firefox-use stop | restart | doctor
firefox-use mcp              # the MCP server on stdio (what Claude Code runs)
```

Options: `--headless`, `--port <n>`, `--profile <dir>`.
Environment: `FIREFOX_BIN`, `FIREFOX_USE_PORT`, `FIREFOX_USE_PROFILE`,
`FIREFOX_USE_HEADLESS=1`, `FIREFOX_USE_AUTO_RESTART=0`, `FIREFOX_USE_DOWNLOADS`.

## How it works

```
Claude Code ──stdio JSON-RPC (MCP)──▶ bin/firefox-use mcp
                                        │
                    src/tools.js         registry + shared ctx
                    src/pages.js         navigate, tabs, javascript_tool, form_input, resize
                    src/a11y.js          read_page, find, get_page_text
                    src/computer.js      mouse, keyboard, screenshots, zoom
                    src/observers.js     console + network capture
                    src/uploads.js       file_upload, upload_image
                    src/gif.js + gifenc  recording, PNG decode, GIF89a encode
                    src/batch.js         browser_batch
                                        │
                    src/session.js       tab group, element refs, screenshots, input
                    src/bidi.js          WebDriver BiDi commands/events
                    src/ws.js            RFC 6455 client
                                        ▼
                        Firefox --remote-debugging-port 9222
```

Details worth knowing:

- **Dedicated profile** at `~/.firefox-use/profile`, so automation never touches your
  everyday Firefox. Log into sites once there and it persists.
- **macOS launches through `open -n -a Firefox`.** A Firefox started as a child of the
  shell inherits the shell's permissions and dies with *"Could not find profile folder"*
  under macOS app-data protection; `open` hands the launch to launchd instead.
- **Fixed 1280x800 viewport** (devicePixelRatio 1) so screenshot pixels and click
  coordinates share one space. `resize_window` changes it deliberately.
- **One BiDi session per browser.** The server ends its session on shutdown; a session
  left behind by a crashed client is cleared by `firefox_restart`.
- **Element refs** (`ref_1`, …) live in a page-side map, so they survive DOM moves and
  go stale exactly when the document navigates — the same contract Chrome's refs have.

## Tests

```bash
npm test                    # unit tests, no browser
npm run test:integration    # + real headless Firefox
```

## Limits

- Browser-scoped: no OS-level input outside Firefox, no `about:` privileged pages.
- The accessibility tree covers the top-level document; cross-origin iframes are not
  walked (click by coordinate, or use `javascript_tool`).
- One browser instance per port.
