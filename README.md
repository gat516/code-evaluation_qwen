# Code Coach Extension

Chrome extension that provides Grammarly-style coding suggestions on supported coding websites.

This project is extension-only and uses local in-browser rule checks (no backend server required).

## Current features

- site allowlist detection: OneCompiler, Replit, LeetCode, HackerRank
- optional broad detection mode for Monaco/CodeMirror/Ace/Textarea editors
- debounced analysis while typing
- side panel with categorized suggestions and severity labels
- inline highlights with hover suggestion cards in supported editors
- manual refresh button in side panel

## Load extension in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder

## Extension settings

Open extension options and configure:

- `Auto-analyze while typing`
- `Enable broad editor detection`

## Supported websites

- `https://onecompiler.com/*`
- `https://replit.com/*`
- `https://leetcode.com/*`
- `https://www.hackerrank.com/*`

## How analysis works

Analysis runs in the extension service worker using lightweight local rules.

Current rule coverage includes:

- repeated print statements (loop refactor hint)
- dangerous dynamic execution patterns (`eval`, `exec`)
- potential hardcoded secrets (`password`, `token`, `api_key`)
- tabs/style consistency hints
- JavaScript `var` usage hint (`let`/`const` preferred)

## Local testing flow

1. Load extension in Chrome
2. Open a supported coding site
3. Type or paste code in the editor
4. Click the extension icon to open the side panel
5. Review suggestions

## Troubleshooting

- Extension appears inactive:
  - refresh the target page after loading/reloading the extension
  - confirm URL matches supported domains
- No suggestions appear:
  - ensure there is code in the editor
  - click `Refresh Analysis` in the side panel
  - check `chrome://extensions` -> `Code Coach` -> `service worker` logs
