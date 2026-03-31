# Code Coach — GitHub Copilot Project Instructions

## What This Project Is

Code Coach is a Chrome extension (MV3) that behaves like Grammarly for code on LeetCode, NeetCode, OneCompiler, Replit, and HackerRank. It observes editor typing, runs debounced analysis, and renders inline section highlights with sticky hover cards.

There are two analysis modes:
1. `local` rules in extension service worker (fast/offline)
2. `ai` backend via FastAPI + Qwen model server

The extension is Python-first.

## Current Architecture (Implemented)

```
extension/
├── background/service-worker.js
├── content/content-script.js
├── options/options.{html,js}
├── sidebar/sidebar.{html,css,js}
└── manifest.json

backend/
├── app.py
├── schemas.py
├── prompting.py
├── parsing.py
├── llm_client.py
└── security.py
```

## Critical Behaviors

### 1. Debounced Analysis Only

- Never analyze per-keystroke.
- Content script resets an idle timer on input/keydown/paste.
- Default idle timeout is `3000ms` from `chrome.storage.sync`.
- Manual trigger is `Ctrl+Shift+A`.

### 2. Editor Extraction

- Use editor APIs first:
  - Monaco: focused editor `getValue()`/model
  - CodeMirror 5/6: instance/doc API
  - Ace: `ace.edit(...).getValue()`
- Fallback to DOM line scraping only when API unavailable.
- Fallback broad detection mode supported.

### 3. Inline Section Overlays + Sticky Card

- Render highlights in a dedicated absolute/fixed overlay layer.
- Suggestion spans are section-based: `line/col -> end_line/end_col`.
- Multi-line sections render multiple rectangles.
- Card remains open while pointer moves highlight <-> card.
- Card actions are:
  - `Apply Fix`
  - `Dismiss`
  - `Copy` (fix or details)
- Card shows fix preview block (from `fix.replacement`, fallback from prefetched fixed code section).

### 4. No Inline Without Ready Fix (Python)

- Python inline cards/highlights are shown only when `prefetched_fix.fixed_code` exists.
- If no validated prefetched fix exists, do not render inline for that suggestion.

### 5. Apply Semantics

- Python `Apply Fix` uses prefetched validated code (`prefetched_fix.fixed_code`).
- Do not rely on click-time model generation for Python normal flow.
- On successful apply:
  - write to editor via editor API
  - remove applied highlighted suggestion immediately from local render state
  - trigger re-analysis snapshot

### 6. Loading Indicators

- Content script shows floating backend activity indicator during AI analysis/apply.
- Sidebar has spinner while tab state is `collecting` or `analyzing`.

## AI Query Strategy (Current)

### Single AI Analyze Query Produces Fix-Ready Suggestions

- Service worker in `ai` mode sends one `/analyze` request.
- Backend `/analyze`:
  - prompts model for structured suggestions including fix ranges/replacements
  - parses/normalizes model JSON safely
  - hydrates each suggestion by applying patch to source and validating
  - only keeps suggestions with valid pre-applied candidate
  - returns `prefetched_fix` per suggestion

This removes worker-side per-suggestion `/fix` prefetch loops in normal AI analysis flow.

### `/fix` Endpoint

- Still exists for explicit/manual validation paths and compatibility.
- Deterministic repeated-print refactor path exists to avoid bad full-file AI edits.

## Service Worker Rules

- Deduplicate snapshots by `(code, language, site)` with short cooldown.
- Coalesce in-flight analyze requests per tab.
- Normalize suggestion schema for extension consumers.
- Infer repeated-print contiguous ranges when coarse anchors are returned.
- Filter known hallucination patterns and noop results.

## Backend Rules

### `/analyze`

- Accepts `AnalyzeRequest`.
- Calls Qwen via OpenAI-compatible `/v1/chat/completions`.
- Parses fenced/malformed-ish outputs safely.
- Enforces JSON schema-like normalization.
- Hydrates `prefetched_fix` by patch+validation.
- Returns `AnalyzeResponse` with `suggestions`, `model`, `analysis_time_ms`, `metadata`.

### `/fix`

- Accepts `FixRequest`.
- Supports deterministic repeated-print handling.
- Falls back to AI fix generation + validation.

## Schemas (Current)

- `AnalyzeSuggestion` includes:
  - `line`, `col`, `end_line`, `end_col`
  - `severity`, `message`, `fix`
  - `source`
  - `prefetched_fix` (optional), with:
    - `fixed_code`
    - `message`
    - `validation`

## Model/Runtime Defaults

- `start_server.py` default model path: `Qwen/Qwen2.5-3B-Instruct`.
- `llm_client.py` applies request timeout and token cap (`LLM_MAX_TOKENS`).

## Request Budget and Reliability

- Debounce + dedupe + in-flight coalescing are mandatory.
- Sidebar refresh must never trigger backend analysis by itself.
- If backend is unreachable, fail gracefully without alert spam.

## Explicit Product Constraints

1. No per-keystroke backend calls.
2. No DOM mutation inside Monaco/CodeMirror internals.
3. Section-first highlighting, not single-line-only simplification.
4. Sticky tooltip interactions.
5. No preview-only action button in sidebar/content cards.
6. Python inline suggestions must be actionable (fix-ready) before display.

## What to Ignore

- `grade.py` and `grading/` are not part of extension runtime flow.
- `student-code-examples/` is fixture data.