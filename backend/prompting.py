from __future__ import annotations

import json
from typing import Any


SCHEMA_EXAMPLE = {
    "suggestions": [
        {
            "line": 1,
            "end_line": 3,
            "severity": "warning",
            "message": "<short description of the issue>",
            "fix": {
                "before": "<exact original lines being replaced, verbatim including indentation>",
                "replacement": "<corrected code that replaces the flagged lines>",
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
        "line, end_line, severity(error|warning|info), message, "
        "fix{before, replacement}, source='ai'.\n"
        "The fix.before field must be the verbatim original lines being replaced, copied exactly as they appear "
        "in the code (including indentation). The fix.replacement field must be the corrected code.\n"
        "line and end_line must be the 1-based inclusive line numbers of the replaced block.\n"
        "Keep fixes minimal and syntactically valid. Prefer replacing the smallest correct range.\n"
        "Each suggestion must target a specific section that can be replaced directly.\n"
        "Cover high-value bug classes when present: syntax/parsing issues, bounds checks, off-by-one errors, "
        "wrong return value/variable/type conversion, missing None checks, incorrect branch conditions, "
        "and unsafe operations.\n"
        "Important maintainability rule: detect repeated contiguous statements (especially repeated print calls) "
        "and suggest replacing the whole repeated section with a loop.\n"
        "When suggesting a loop refactor, set line/end_line to cover the entire repeated block and set "
        "before to the full verbatim text of that repeated block.\n"
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
