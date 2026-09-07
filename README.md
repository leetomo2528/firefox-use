# firefox-use

Computer use for Firefox. Claude Code ships a Chrome-only integration (`claude --chrome`);
this is the same idea for Firefox: an MCP server that drives a real Firefox window
through **WebDriver BiDi** — screenshots, clicks at coordinates, typing, scrolling,
tabs, console logs and page scripting.

No npm dependencies (the WebSocket client, the BiDi transport and the MCP server are
in `src/`), no geckodriver, no extension to install. Firefox 129+ speaks BiDi natively.

## Install

```bash
node ~/firefox-use/bin/firefox-use install      # runs: claude mcp add firefox -- node .../bin/firefox-use mcp
node ~/firefox-use/bin/firefox-use doctor       # checks Firefox, the profile, the port and the handshake
```

Start a new Claude Code session afterwards. The tools appear as `mcp__firefox__firefox_*`.

Optional: put it on your PATH.

```bash
ln -s ~/firefox-use/bin/firefox-use ~/bin/firefox-use
```

## Tools

| Tool | What it does |
|---|---|
| `firefox_navigate` | Open a URL and wait for load |
| `firefox_snapshot` | List interactive elements with refs (`e1`, `e2`, …) and coordinates |
| `firefox_screenshot` | Viewport or full-page image (png/jpeg) |
| `firefox_click` | Click a ref or a coordinate; left/middle/right, single or double |
| `firefox_type` | Focus a field, optionally clear it, type, optionally press Enter |
| `firefox_press_key` | `Enter`, `Escape`, `Tab`, `cmd+a`, `ctrl+shift+r`, … |
| `firefox_scroll` | Wheel scrolling at a point |
| `firefox_hover` / `firefox_drag` | Reveal menus; drag between two points |
| `firefox_read_page` | Visible text, paged with `offset` |
| `firefox_evaluate` | Run JavaScript in the page and get the value back |
| `firefox_tabs` / `firefox_history` | list/new/select/close; back/forward/reload |
| `firefox_wait` | Wait for text to appear, or for N seconds |
| `firefox_console` | Console messages and page errors |
| `firefox_dialog` | Accept or dismiss alert/confirm/prompt |
| `firefox_status` / `firefox_restart` | Where things stand; recover a stuck session |

The usual loop is **snapshot → act on a ref → screenshot when you need to see it**.
Refs come from the last snapshot and are re-resolved against the live DOM on use, so a
ref that has disappeared reports an error instead of clicking the wrong thing.

## CLI

```bash
firefox-use start [url]      # launch Firefox with BiDi enabled
firefox-use status           # running? which profile, port and tabs
firefox-use open <url>
firefox-use shot page.png [url] [--full]
firefox-use stop | restart
firefox-use mcp              # the MCP server on stdio (what Claude Code runs)
```

Options: `--headless`, `--port <n>`, `--profile <dir>`.
Environment: `FIREFOX_BIN`, `FIREFOX_USE_PORT`, `FIREFOX_USE_PROFILE`,
`FIREFOX_USE_HEADLESS=1`, `FIREFOX_USE_AUTO_RESTART=0`.

## How it works

```
Claude Code ──stdio JSON-RPC(MCP)──▶ bin/firefox-use mcp
                                       │
                                src/tools.js      tool surface
                                src/browser.js    tabs, input, screenshots, snapshots
                                src/bidi.js       WebDriver BiDi commands/events
                                src/ws.js         RFC 6455 client (no deps)
                                       │
                                       ▼
                        Firefox --remote-debugging-port 9222
                        ws://127.0.0.1:9222/session
```

Details worth knowing:

- **Dedicated profile** at `~/.firefox-use/profile`, so automation never touches your
  everyday Firefox profile. Log into sites once there and the session persists.
- **macOS launch goes through `open -n -a Firefox`.** A Firefox started as a child of
  the shell inherits the shell's permissions and dies with *"Could not find profile
  folder"* under macOS app-data protection; `open` hands the launch to launchd instead.
- **Fixed 1280x800 viewport** (`browsingContext.setViewport`, devicePixelRatio 1) so
  screenshot pixels and click coordinates are the same space regardless of window size.
- **One BiDi session per browser.** The server ends its session on shutdown; if a
  crashed client leaves one behind, `firefox_restart` (or `firefox-use restart`) clears it.
- Firefox keeps running when Claude Code exits — only the session is released.

## Tests

```bash
npm test              # 37 unit tests, no browser
npm run test:integration   # + real headless Firefox (navigate, type, click, screenshot, tabs)
```

## Limits

- Browser-scoped: no OS-level mouse/keyboard outside Firefox, no `about:` privileged pages.
- Snapshots cover the top-level document; elements inside cross-origin iframes are not listed
  (click them by coordinate, or use `firefox_evaluate`).
- One browser instance per port.
