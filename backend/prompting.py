from __future__ import annotations

import json
from typing import Any


SCHEMA_EXAMPLE = {
    "suggestions": [
        {
            "line": 3,
            "col": 4,
            "end_line": 3,
            "end_col": 22,
            "severity": "error",
            "message": "Potential IndexError: loop upper bound can exceed list length.",
            "fix": {
                "replacement": "for i in range(min(k, len(nums))):",
                "range": {
                    "startLine": 3,
                    "startCol": 4,
                    "endLine": 3,
                    "endCol": 22,
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
        "Only emit suggestions that include an actionable concrete fix. "
        "Do not output advisory comments without an actual replacement patch."
    )

    user_prompt = (
        f"Analyze this code for language={language} from site={site_name}.\n"
        "Return only a JSON object with key 'suggestions' (array).\n"
        "Each suggestion must include exactly: "
        "line, col, end_line, end_col, severity(error|warning|info), message, "
        "fix{replacement, range{startLine,startCol,endLine,endCol}}, source='ai'.\n"
        "Keep fixes minimal and syntactically valid. Prefer replacing the smallest correct range.\n"
        "Each suggestion must target a specific section that can be replaced directly.\n"
        "Cover high-value bug classes when present: syntax/parsing issues, bounds checks, off-by-one errors, "
        "wrong return value/variable/type conversion, missing None checks, incorrect branch conditions, "
        "and unsafe operations.\n"
        "Important maintainability rule: detect repeated contiguous statements (especially repeated print calls) "
        "and suggest replacing the whole repeated section with a loop.\n"
        "When suggesting a loop refactor, set range start/end to cover the entire repeated block.\n"
        "Return at most 5 suggestions, sorted by impact.\n"
        "If there are no issues with actionable fixes, return {'suggestions': []}.\n\n"
        f"Metadata:\n{metadata_text}\n\n"
        f"Example JSON format:\n{schema_text}\n\n"
        f"Code:\n```{language}\n{code}\n```"
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
