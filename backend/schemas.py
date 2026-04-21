from typing import Any, Literal

from pydantic import BaseModel, Field


class ErrorPattern(BaseModel):
    pattern: str
    first_seen: str
    last_seen: str
    frequency: int = Field(ge=1)
    examples: list[str] = Field(default_factory=list)
    root_cause: str
    status: Literal["active", "improving", "resolved"]
    recommended_review: list[str] = Field(default_factory=list)


class StudentMemory(BaseModel):
    student: str
    updated: str
    error_patterns: list[ErrorPattern] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    code: str = Field(min_length=1)
    language: str = Field(default="python")
    site: str | None = None
    student_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SuggestionFix(BaseModel):
    """Canonical fix shape shared by backend and extension pipeline.

    ``before`` is the verbatim original lines being replaced (including
    indentation).  ``replacement`` is the corrected code.  ``startLine``
    and ``endLine`` are 1-based inclusive line numbers used as a placement
    hint when ``before``-anchor matching is applied.
    """

    before: str = ""
    replacement: str
    startLine: int = Field(ge=1)
    endLine: int = Field(ge=1)


class AnalyzeSuggestion(BaseModel):
    line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    severity: str
    message: str
    fix: SuggestionFix
    source: str = "ai"


class AnalyzeResponse(BaseModel):
    suggestions: list[AnalyzeSuggestion]
    model: str
    analysis_time_ms: int = Field(ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)
