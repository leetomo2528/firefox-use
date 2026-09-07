# Parity target: Claude in Chrome

`docs/chrome-tool-spec.json` is the verbatim tool surface of Claude Code's Chrome
integration (`mcp__claude-in-chrome__*`), extracted from the Claude Code 2.1.263
bundle. firefox-use implements the same tool names, schemas and semantics against
Firefox so a browser task runs identically on either browser.

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
