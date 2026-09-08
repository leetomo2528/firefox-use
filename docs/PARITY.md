# Parity target: Claude in Chrome

firefox-use implements the same tool names and parameter shapes as Claude Code's
Chrome integration (`mcp__claude-in-chrome__*`), so a browser task runs the same on
either browser. The reference used by the tests is generated locally with
`npm run spec`, which reads the definitions out of your own Claude Code install into
`.spec/chrome-tool-spec.json`; it is never committed, and the wording of our own
descriptions is ours (see NOTICE).

## Implemented (17)

| Tool | Notes on the Firefox implementation |
|---|---|
| `tabs_context_mcp` | Numeric tab ids in a session-owned tab group; `createIfEmpty` opens a window |
| `tabs_create_mcp` | New tab inside the group |
| `tabs_close_mcp` | Close one of the group's tabs |
| `navigate` | url / `back` / `forward`; bare host gets `https://`; standalone call may omit tabId |
| `computer` | left/right/double/triple click, hover, type, key (space-separated, chords, repeat), scroll (ticks), left_click_drag, screenshot, zoom (clipped capture), scroll_to, wait |
| `read_page` | Accessibility tree with `ref_N` ids, `filter`, `depth`, `ref_id`, `max_chars` |
| `find` | Natural-language element lookup over the same tree, max 20 hits |
| `form_input` | Set a value by ref (string / number / boolean / select option) |
| `get_page_text` | Article-first plain text |
| `read_console_messages` | `pattern` regex, `onlyErrors`, `clear`, `limit` |
| `read_network_requests` | `urlPattern`, `clear`, `limit`; cleared on cross-domain navigation |
| `javascript_tool` | REPL semantics: last expression is the result, top-level await |
| `browser_batch` | Sequential, stops on first error, images interleaved, no nesting |
| `resize_window` | Window/viewport resize |
| `file_upload` | Real file input population via BiDi `input.setFiles` |
| `upload_image` | A captured screenshot by `imageId` into a file input or drop target |
| `gif_creator` | start/stop/export/clear with click, drag, label, progress and watermark overlays |

## Not applicable

`switch_browser`, `list_connected_browsers`, `select_browser` (Chrome extension
pairing), `shortcuts_list`, `shortcuts_execute` (Claude-in-Chrome side panel).

## Behavioural notes taken from the Chrome skill

- Call `tabs_context_mcp` once before anything else; create your own tab rather than
  reusing the user's; close tabs you opened.
- Coordinates are screenshot pixels of the tab viewport.
- `key` takes space-separated keys ("Backspace Backspace Delete") and chords ("cmd+a").
- Dialogs block the page: avoid triggering them; `javascript_tool` can clear them.

## Deliberate deviations

| Behaviour | Chrome | Here | Why |
|---|---|---|---|
| Tab group membership | Only tabs the extension created | Tabs we created, tabs opened by one of ours (target=_blank, window.open, OAuth popups), and whatever was already open in the automation profile | The profile at `~/.firefox-use/profile` is dedicated to automation, so a leftover tab there is ours, not the user's browsing. Tabs the user opens in another window still stay out. |
| Element refs | Extension-side handles, stale refs error | `ref_N` minted in per-document blocks of 10000 | Same contract - a ref from a previous document is simply absent, so it errors instead of resolving to a different element. |
| Blocking dialogs | End the automation session | `firefox_dialog` accepts or dismisses them, and pointer actions fail fast while one is open | BiDi can answer prompts; there is no reason to inherit the limitation. |
| Per-site permission | The extension prompts per site | None; access is whatever the automation profile is logged into | There is no extension UI to prompt from. `firefox-use stop` is the off switch. |
| `file_upload` sandbox | Files the user shared with the session | Files under the download directory, the server's working directory, or a root listed in `FIREFOX_USE_UPLOAD_ROOTS` | Claude Code has no session file-sharing concept here, so the gate is explicit instead of implied. |
| Extra tools | - | `firefox_status`, `firefox_restart`, `firefox_dialog` | Managing a browser we launch ourselves. |
