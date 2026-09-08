# firefox-use

**Browser control for Claude Code, on Firefox.**

Claude Code can drive Chrome. This drives Firefox, with the same tools under the same names:
screenshots and clicks, typing and keys, forms, tabs, page reading, console and network logs,
file uploads, and GIF recordings of a whole flow. A browser task written for one browser runs
on the other.

It talks to Firefox over **WebDriver BiDi**, which Firefox speaks natively - no extension, no
geckodriver, and **no npm dependencies**: the WebSocket client, the MCP server, the PNG
decoder and the GIF encoder are all in `src/`, on Node built-ins.

```
you: "log into the staging site and screenshot the dashboard"
     -> read_page finds the form, form_input fills it, computer clicks and screenshots
```

## Install

**As a Claude Code plugin** (brings the tools and the skill together):

```bash
claude plugin marketplace add leetomo2528/firefox-use
claude plugin install firefox-use@firefox-use
```

**From npm**, if you would rather register it yourself:

```bash
npx firefox-use install          # registers the MCP server with Claude Code
npx firefox-use install-skill    # adds the usage skill to ~/.claude/skills
npx firefox-use doctor           # checks Firefox, the profile, the port, the handshake
```

**From source:**

```bash
git clone https://github.com/leetomo2528/firefox-use.git
cd firefox-use && node bin/firefox-use install && node bin/firefox-use install-skill
```

Start a new Claude Code session afterwards. Firefox launches by itself on the first tool call.

Needs **Firefox 129+** and **Node 18+**. Developed and tested on macOS; Linux runs in CI.
Windows is not supported yet.

## The tools

| Tool | What it does |
|---|---|
| `tabs_context_mcp` | The tabs this session can act on. Call it first |
| `tabs_create_mcp` / `tabs_close_mcp` | Open and close tabs of your own |
| `navigate` | Go to a URL, back, or forward |
| `computer` | Click, double/triple/right click, hover, drag, type, keys, scroll, screenshot, zoom, wait |
| `read_page` | Accessibility tree with a `ref_N` on every element |
| `find` | "the search box", "the accept button" - refs by description |
| `form_input` | Set a field by ref: text, number, checkbox, select |
| `get_page_text` | Readable text, markup stripped |
| `read_console_messages` | Console output, filtered by a regex you supply |
| `read_network_requests` | Requests with status, type, timing and size |
| `javascript_tool` | Evaluate an expression in the page |
| `browser_batch` | Several calls in one round trip, stopping at the first error |
| `resize_window` | Resize the window a tab lives in |
| `file_upload` / `upload_image` | Fill a file input; drop a screenshot onto a page |
| `gif_creator` | Record a flow and export an annotated GIF |

Plus three that are ours alone: `firefox_status`, `firefox_restart`, and `firefox_dialog` -
Chrome's integration is finished by a modal dialog, here you can answer it.

## Command line

```bash
firefox-use start [url]      # launch Firefox with BiDi enabled
firefox-use status           # what is running, which profile, which tabs
firefox-use open <url>
firefox-use shot page.png [url] [--full]
firefox-use stop | restart | doctor
firefox-use mcp              # the MCP server on stdio (what Claude Code runs)
```

Options: `--headless`, `--port <n>`, `--profile <dir>`.
Environment: `FIREFOX_BIN`, `FIREFOX_USE_PORT`, `FIREFOX_USE_PROFILE`, `FIREFOX_USE_HEADLESS=1`,
`FIREFOX_USE_DOWNLOADS`, `FIREFOX_USE_UPLOAD_ROOTS`, `FIREFOX_USE_AUTO_RESTART=0`.

## How it works

```
Claude Code ──stdio JSON-RPC (MCP)──▶ bin/firefox-use mcp
                                        │
                    src/tools.js         registry, shared session, downloads
                    src/pages.js         navigate, tabs, javascript_tool, form_input, resize
                    src/a11y.js          read_page, find, get_page_text
                    src/computer.js      mouse, keyboard, screenshots, zoom
                    src/observers.js     console and network capture
                    src/uploads.js       file_upload, upload_image
                    src/gif.js/gifenc.js recording, PNG decode, GIF89a encode
                    src/batch.js         browser_batch
                                        │
                    src/session.js       tab group, element refs, screenshots, input
                    src/bidi.js          WebDriver BiDi commands and events
                    src/ws.js            RFC 6455 client
                                        ▼
                        firefox --remote-debugging-port 9222
```

Worth knowing:

- **A profile of its own** at `~/.firefox-use/profile`. Log in there once and it sticks; your
  everyday Firefox is never touched. `firefox-use stop` is the off switch.
- **macOS launches through `open -n -a`.** A Firefox started as a child of the shell inherits
  the shell's permissions and dies with *"Could not find profile folder"* under macOS app-data
  protection; `open` hands the launch to launchd instead.
- **A fixed 1280x800 viewport** per tab, at devicePixelRatio 1, so screenshot pixels and click
  coordinates share one coordinate space. `resize_window` changes it deliberately, per tab.
- **Refs are minted per document.** After a navigation, a ref from the old page reports that it
  is gone rather than resolving to whatever now sits at that index.
- **One automation session per browser.** The server closes its session on shutdown;
  `firefox_restart` clears one left behind by a crash.

## Development

```bash
npm test                    # unit tests, no browser
npm run test:integration    # + a real headless Firefox, end to end
npm run spec                # generate the parity fixture from your Claude Code install
npm run sync-plugin         # copy the skill into the plugin and stamp versions
```

`npm run spec` writes `.spec/chrome-tool-spec.json` - the Chrome integration's tool
definitions, read out of the Claude Code binary on your own machine. `test/parity.test.js`
compares our schemas against it and `test/prose.test.js` checks that our wording is not
borrowed from it. The file is never committed; those tests skip without it.

## Limits

- The Firefox window is the whole world: no OS-level input, no `about:` privileged pages.
- The accessibility tree covers the top-level document; cross-origin iframes are not walked
  (click by coordinate, or use `javascript_tool`).
- One browser instance per port.

## Notices

MIT licensed. An independent project - not affiliated with Mozilla or Anthropic. Tool names
and parameter shapes match Claude Code's Chrome integration on purpose, so tasks are portable;
the descriptions, the skill and the documentation are written for this project. See
[NOTICE](NOTICE).
