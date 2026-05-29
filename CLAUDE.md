# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

BlackBar is a Chrome Manifest V3 extension that redacts sensitive data (PII, secrets, identifiers) at three intensity levels — `soft`, `medium`, `hard`. All processing is local; the extension makes no network requests.

There is no build step, no package manager, no test runner, and no linter. Code is vanilla ES2015+ JavaScript loaded directly by the browser.

## Running and testing

Reload the unpacked extension at `chrome://extensions` after any change (toggle Developer mode → Load unpacked → select this folder; subsequent edits need the reload button on the extension card). Content-script edits also require closing and reopening any tabs that already had the old script injected. There is no automated test suite — verify changes by:

1. Opening the popup and pasting representative input at each level.
2. Selecting text on any page and using the right-click "Redact with BlackBar" submenu (this exercises `background.js`).
3. Pasting clipboard text containing detectable items into a chat input on any site (e.g. claude.ai, chatgpt.com, Slack) — the inline level picker should appear (this exercises `content.js`).

The service worker logs to the extension's own DevTools (chrome://extensions → "service worker" link on the BlackBar card). The popup logs to its own DevTools (right-click the popup → Inspect). Content-script logs go to the host page's DevTools console.

## Architecture

Four execution contexts share one redaction engine:

- **`redactor.js`** — pure engine, no DOM dependencies. Exposes `BlackBarRedactor.redact(text, level)` on `self`/`globalThis` so it works in the popup window, the MV3 service worker (which imports it via `importScripts`), and content scripts (auto-loaded by manifest before `content.js`).
- **`popup.js`** — popup UI controller. Live-redacts on input (220 ms debounce), persists `level` and `lastInput` to `chrome.storage.local`.
- **`background.js`** — service worker. Creates the context-menu tree on `onInstalled`, and on click runs the redactor then injects a small function via `chrome.scripting.executeScript` to write the result to the page's clipboard (service workers cannot access `navigator.clipboard` directly) and show a toast.
- **`content.js`** — paste interceptor injected on `<all_urls>` at `document_idle`. Captures paste events on editable elements (textarea, plain `<input>` types, contenteditable), runs a `hard`-pass detection on the clipboard text, and only intervenes if matches exist — otherwise the paste proceeds normally. When it intervenes, it shows an inline picker (Shadow-DOM, closed, fixed-position, z-index `2147483647`) with per-level match counts and inserts the chosen redaction via `setRangeText` (inputs) or `execCommand('insertText')` (contenteditable, for undo-history compatibility with apps like Slack/ChatGPT/Claude.ai).

### The PATTERNS array (the part that matters)

All redaction logic lives in the `PATTERNS` array in `redactor.js`. Each entry is `{ name, regex, minLevel, soft, medium, hard }`. The engine iterates patterns **in declared order** and applies `String.prototype.replace` for each, so **ordering is load-bearing**: specific patterns must come before general ones (e.g. `CREDIT_CARD` before `LONG_NUMBER`, `API_KEY` before generic hex matches), otherwise the general pattern consumes the text first and the specific transform never runs.

`minLevel` gates a pattern by `LEVEL_RANK` (`soft:1, medium:2, hard:3`). A pattern with `minLevel: 'hard'` (NAME, ADDRESS, LONG_NUMBER) is skipped entirely at soft/medium even though the regex would match. When adding a new pattern, decide its minLevel deliberately — pushing aggressive heuristics to `hard` only is the established convention.

Each level transform receives the matched string and returns the replacement. Conventions in use:
- `soft` preserves shape/last-4 where possible (good for screenshots with context).
- `medium` returns a bracketed label like `[EMAIL]`.
- `hard` returns solid block characters (`█`) for shape-detectable items, or `[LABEL]` for heuristic catches.

### Manifest permissions

`contextMenus`, `scripting`, `activeTab`, `storage`. Adding new capabilities (e.g. a DOM walker for full-page redaction) will likely require declaring additional permissions in `manifest.json`.
