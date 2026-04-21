"""Student error-pattern memory stored as Markdown files with an embedded JSON block.

File layout (memory/<student_id>.md):

    ---
    student: Zhang, Chengming
    updated: 2026-04-21
    ---

    ```json
    [
      {
        "pattern": "Off-by-one in loops",
        "first_seen": "2026-04-02",
        "last_seen": "2026-04-05",
        "frequency": 3,
        "examples": ["Used `i <= len(arr)` instead of `i < len(arr)`"],
        "root_cause": "Boundary condition misunderstanding",
        "status": "improving",
        "recommended_review": ["array indexing", "loop bounds", "dry-run practice"]
      }
    ]
    ```
"""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

from pydantic import ValidationError

from backend.schemas import ErrorPattern, StudentMemory

MEMORY_DIR = Path(__file__).parent.parent / "memory"
_JSON_BLOCK = re.compile(r"```json\s*([\s\S]*?)```", re.MULTILINE)
_FRONTMATTER = re.compile(r"^---\s*\n([\s\S]*?)\n---\s*\n", re.MULTILINE)


def _memory_path(student_id: str) -> Path:
    safe = re.sub(r"[^\w\-]", "_", student_id)
    return MEMORY_DIR / f"{safe}.md"


def load(student_id: str) -> StudentMemory | None:
    path = _memory_path(student_id)
    if not path.exists():
        return None

    text = path.read_text()

    fm_match = _FRONTMATTER.search(text)
    student_name = student_id
    updated = str(date.today())
    if fm_match:
        for line in fm_match.group(1).splitlines():
            if line.startswith("student:"):
                student_name = line.split(":", 1)[1].strip()
            elif line.startswith("updated:"):
                updated = line.split(":", 1)[1].strip()

    json_match = _JSON_BLOCK.search(text)
    if not json_match:
        return StudentMemory(student=student_name, updated=updated)

    raw = json.loads(json_match.group(1))
    patterns = [ErrorPattern.model_validate(p) for p in raw]
    return StudentMemory(student=student_name, updated=updated, error_patterns=patterns)


def save(student_id: str, memory: StudentMemory) -> None:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    path = _memory_path(student_id)
    patterns_json = json.dumps(
        [p.model_dump() for p in memory.error_patterns], indent=2
    )
    content = (
        f"---\nstudent: {memory.student}\nupdated: {memory.updated}\n---\n\n"
        f"```json\n{patterns_json}\n```\n"
    )
    path.write_text(content)


def upsert_pattern(student_id: str, student_name: str, pattern: ErrorPattern) -> StudentMemory:
    memory = load(student_id) or StudentMemory(
        student=student_name, updated=str(date.today())
    )
    existing = {p.pattern: i for i, p in enumerate(memory.error_patterns)}
    if pattern.pattern in existing:
        memory.error_patterns[existing[pattern.pattern]] = pattern
    else:
        memory.error_patterns.append(pattern)
    memory.updated = str(date.today())
    save(student_id, memory)
    return memory
