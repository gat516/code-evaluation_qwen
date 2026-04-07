# Replacement Strategy Refactor Plan
Date: 2026-04-06

## Decision
Refactor the code replacement/fix-application pipeline to eliminate inconsistency caused by
triple-redundant range representations and excessive AI discretion in targeting.

## Root Causes Identified
1. Three competing range representations (suggestion.line/end_line, fix.range.startLine/endLine, col-level data)
2. Three separate normalization passes (parsing.py, service-worker.js, content-script.js) that each guess differently
3. Dangerous identical-line expansion heuristic in applyFixToCode() that can clobber unrelated lines
4. Column data requested from LLM but never used in replacement logic
5. No verification that the replacement target still matches the actual code at apply time
6. Dead/disconnected fix path in grading/core.py (FIX_TOOL / propose_fix_submission)

## Tradeoffs Considered
- Full-file replacement (simple but loses student intent / causes jarring UX) vs line-range replacement (precise but needs reliable targeting)
- Client-side heuristics (fast iteration but brittle) vs server-side validation (adds latency but deterministic)
- Keeping column-level precision (future-proofs for inline fixes) vs removing it (matches actual capability, reduces hallucination surface)
- Chose: line-range replacement with server-side validation and no column data

## Plan (Priority Order)
1. Canonicalize to single contract: {startLine, endLine, replacement} -- remove col fields
2. Add server-side validation in parsing.py (range within code bounds, replacement non-empty)
3. Remove identical-line expansion heuristic from content-script.js applyFixToCode()
4. Add "before" anchor field: server includes original text being replaced, client verifies before splicing
5. Clean up grading/core.py: remove dead FIX_TOOL/propose_fix_submission or integrate properly

## Key Files
- /home/cj/projects/research/code-evaluation_qwen/extension/content/content-script.js (applyFixToCode lines 203-234)
- /home/cj/projects/research/code-evaluation_qwen/backend/prompting.py (SCHEMA_EXAMPLE, build_analysis_messages)
- /home/cj/projects/research/code-evaluation_qwen/backend/parsing.py (_normalize_one, parse_llm_suggestions)
- /home/cj/projects/research/code-evaluation_qwen/extension/background/service-worker.js (normalizeSuggestion lines 43-83)
- /home/cj/projects/research/code-evaluation_qwen/grading/core.py (FIX_TOOL, propose_fix_submission lines 37-88, 187-241)

## Next Action
Start with Phase 1: update SCHEMA_EXAMPLE in prompting.py and _normalize_one in parsing.py
to use the simplified canonical contract. Then update content-script.js applyFixToCode to
match. This is a ~2 hour change that addresses the core reliability issue.
