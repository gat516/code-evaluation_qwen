from __future__ import annotations

import json
import re
from typing import Any


def strip_markdown_fences(text: str) -> str:
    raw = (text or "").strip()
    if not raw.startswith("```"):
        return raw

    lines = raw.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def extract_json_text(text: str) -> str:
    cleaned = strip_markdown_fences(text)
    if not cleaned:
        return "{}"

    # Prefer explicit JSON object payloads from model output.
    object_match = re.search(r"\{[\s\S]*\}", cleaned)
    if object_match:
        return object_match.group(0)

    # Some models return a top-level array; wrap into expected object shape.
    array_match = re.search(r"\[[\s\S]*\]", cleaned)
    if array_match:
        return '{"suggestions": ' + array_match.group(0) + "}"

    return "{}"


def _safe_int(value: Any, default: int, minimum: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return parsed if parsed >= minimum else default


def _normalize_one(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize a raw LLM suggestion into the canonical contract.

    Returns ``None`` when the suggestion is missing required fix data and
    should be discarded rather than surfaced to the client.

    Canonical fix shape::

        {
            "before": "<verbatim original lines being replaced>",
            "replacement": "<corrected lines>",
            "startLine": <int, 1-based>,
            "endLine": <int, 1-based>,
        }
    """
    line = _safe_int(raw.get("line"), 1, minimum=1)
    end_line = _safe_int(raw.get("end_line"), line, minimum=1)
    # Guard: end_line must not precede line.
    if end_line < line:
        end_line = line

    severity = str(raw.get("severity") or "info").lower()
    if severity not in ("error", "warning", "info"):
        severity = "info"

    message = str(raw.get("message") or "Potential issue detected.").strip() or "Potential issue detected."

    fix_raw = raw.get("fix") if isinstance(raw.get("fix"), dict) else {}

    # startLine/endLine are optional hint fields the LLM may include.
    # Fall back to the top-level line/end_line when absent.
    start_line = _safe_int(fix_raw.get("startLine"), line, minimum=1)
    end_line_fix = _safe_int(fix_raw.get("endLine"), end_line, minimum=1)
    if end_line_fix < start_line:
        end_line_fix = start_line

    fix_replacement = str(fix_raw.get("replacement") or "")
    fix_before = str(fix_raw.get("before") or "")

    # Replacement must be non-empty — a fix with no replacement is unactionable.
    # before is optional; if absent, line-number hints are used as fallback.
    if not fix_replacement.strip():
        return None

    return {
        "line": start_line,
        "end_line": end_line_fix,
        "severity": severity,
        "message": message,
        "fix": {
            "before": fix_before,
            "replacement": fix_replacement,
            "startLine": start_line,
            "endLine": end_line_fix,
        },
        "source": "ai",
    }


def parse_llm_suggestions(raw_text: str) -> list[dict[str, Any]]:
    try:
        payload = json.loads(extract_json_text(raw_text))
    except json.JSONDecodeError:
        return []

    raw_suggestions = payload.get("suggestions") if isinstance(payload, dict) else []
    if not isinstance(raw_suggestions, list):
        return []

    normalized: list[dict[str, Any]] = []
    for item in raw_suggestions:
        if isinstance(item, dict):
            result = _normalize_one(item)
            if result is not None:
                normalized.append(result)
    return normalized
