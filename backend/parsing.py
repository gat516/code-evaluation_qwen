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


def _normalize_one(raw: dict[str, Any]) -> dict[str, Any]:
    line = _safe_int(raw.get("line"), 1, minimum=1)
    col = _safe_int(raw.get("col"), 0, minimum=0)
    end_line = _safe_int(raw.get("end_line"), line, minimum=1)
    end_col = _safe_int(raw.get("end_col"), max(col + 1, 1), minimum=0)

    severity = str(raw.get("severity") or "info").lower()
    if severity not in ("error", "warning", "info"):
        severity = "info"

    message = str(raw.get("message") or "Potential issue detected.").strip() or "Potential issue detected."

    fix_raw = raw.get("fix") if isinstance(raw.get("fix"), dict) else {}
    fix_replacement = str(fix_raw.get("replacement") or "")
    fix_range_raw = fix_raw.get("range") if isinstance(fix_raw.get("range"), dict) else {}

    return {
        "line": line,
        "col": col,
        "end_line": end_line,
        "end_col": end_col,
        "severity": severity,
        "message": message,
        "fix": {
            "replacement": fix_replacement,
            "range": {
                "startLine": _safe_int(fix_range_raw.get("startLine"), line, minimum=1),
                "startCol": _safe_int(fix_range_raw.get("startCol"), col, minimum=0),
                "endLine": _safe_int(fix_range_raw.get("endLine"), end_line, minimum=1),
                "endCol": _safe_int(fix_range_raw.get("endCol"), end_col, minimum=0),
            },
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
            normalized.append(_normalize_one(item))
    return normalized
