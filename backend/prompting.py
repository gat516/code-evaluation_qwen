from __future__ import annotations

import json
from typing import Any

from backend.schemas import StudentMemory


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


def _format_memory(memory: StudentMemory) -> str:
    lines = [f"Student: {memory.student}", "Known error patterns:"]
    for p in memory.error_patterns:
        lines.append(
            f"  - {p.pattern} (freq={p.frequency}, status={p.status}): {p.root_cause}"
        )
    return "\n".join(lines)


def build_analysis_messages(
    code: str,
    language: str,
    site: str | None,
    metadata: dict[str, Any],
    student_memory: StudentMemory | None = None,
) -> list[dict[str, str]]:
    schema_text = json.dumps(SCHEMA_EXAMPLE, indent=2)
    site_name = site or "unknown"
    metadata_text = json.dumps(metadata or {}, ensure_ascii=True)

    memory_clause = (
        f"\nStudent error history:\n{_format_memory(student_memory)}\n"
        "Pay extra attention to these known patterns when reviewing the code.\n"
        if student_memory and student_memory.error_patterns
        else ""
    )

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
        "CRITICAL: The replacement must be functionally different from the original — do not return the same code with only whitespace changes. "
        "If you suggest an algorithmic improvement (e.g. use a hash map instead of nested loops), the replacement must actually implement the better algorithm. "
        "If the flagged code is a method inside a class, the replacement must also be a method with the same signature including 'self'. "
        "Never remove class membership, method parameters, or change indentation level of the top-level construct.\n"
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
        f"Metadata:\n{metadata_text}\n"
        f"{memory_clause}\n"
        f"Example JSON format:\n{schema_text}\n\n"
        f"Code:\n```{language}\n{code}\n```"
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
