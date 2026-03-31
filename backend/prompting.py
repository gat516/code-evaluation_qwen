from __future__ import annotations

import json
from typing import Any


SCHEMA_EXAMPLE = {
    "suggestions": [
        {
            "line": 2,
            "col": 11,
            "end_line": 2,
            "end_col": 15,
            "severity": "error",
            "message": "NameError: 'none' should be 'None' (Python is case-sensitive)",
            "fix": {
                "replacement": "None",
                "range": {
                    "startLine": 2,
                    "startCol": 11,
                    "endLine": 2,
                    "endCol": 15,
                },
            },
            "source": "ai",
        }
    ]
}


def build_analysis_messages(code: str, language: str, site: str | None, metadata: dict[str, Any]) -> list[dict[str, str]]:
    schema_text = json.dumps(SCHEMA_EXAMPLE, indent=2)
    site_name = site or "unknown"
    metadata_text = json.dumps(metadata or {}, ensure_ascii=True)

    system_prompt = (
        "You are a strict static analysis assistant for coding interview solutions. "
        "Return valid JSON only, with no markdown fences and no explanations outside JSON. "
        "Focus on correctness and high-signal Python issues first. "
        "Only emit suggestions that include an actionable concrete fix."
    )

    user_prompt = (
        f"Analyze this code for language={language} from site={site_name}.\n"
        "Return only a JSON object with key 'suggestions' (array).\n"
        "Each suggestion must include exactly: "
        "line, col, end_line, end_col, severity(error|warning|info), message, "
        "fix{replacement, range{startLine,startCol,endLine,endCol}}, source='ai'.\n"
        "Keep fixes minimal and syntactically valid. Prefer replacing the smallest correct range.\n"
        "Return at most 3 suggestions, sorted by impact.\n"
        "If there are no issues with actionable fixes, return {'suggestions': []}.\n\n"
        f"Metadata:\n{metadata_text}\n\n"
        f"Example JSON format:\n{schema_text}\n\n"
        f"Code:\n```{language}\n{code}\n```"
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
