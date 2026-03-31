from typing import Any

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    code: str = Field(min_length=1)
    language: str = Field(default="python")
    site: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    exec_timeout_s: int | None = Field(default=None, ge=1, le=30)


class SuggestionRange(BaseModel):
    startLine: int = Field(ge=1)
    startCol: int = Field(ge=0)
    endLine: int = Field(ge=1)
    endCol: int = Field(ge=0)


class SuggestionFix(BaseModel):
    replacement: str = ""
    range: SuggestionRange


class PrefetchedFix(BaseModel):
    fixed_code: str
    message: str = ""
    validation: dict[str, Any] = Field(default_factory=dict)


class AnalyzeSuggestion(BaseModel):
    line: int = Field(ge=1)
    col: int = Field(ge=0)
    end_line: int = Field(ge=1)
    end_col: int = Field(ge=0)
    severity: str
    message: str
    fix: SuggestionFix
    source: str = "ai"
    prefetched_fix: PrefetchedFix | None = None


class SuggestionAnchor(BaseModel):
    line: int | None = Field(default=None, ge=1)


class Suggestion(BaseModel):
    rule_id: str
    severity: str
    category: str
    message: str
    rationale: str
    before: str | None = None
    after: str | None = None
    anchor: SuggestionAnchor | None = None
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    # Canonical analyze fields accepted by /fix to avoid schema-loss between endpoints.
    line: int | None = Field(default=None, ge=1)
    col: int | None = Field(default=None, ge=0)
    end_line: int | None = Field(default=None, ge=1)
    end_col: int | None = Field(default=None, ge=0)
    fix: SuggestionFix | None = None
    source: str | None = None
    prefetched_fix: PrefetchedFix | None = None


class AnalyzeResponse(BaseModel):
    suggestions: list[AnalyzeSuggestion]
    model: str
    analysis_time_ms: int = Field(ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class FixRequest(BaseModel):
    code: str = Field(min_length=1)
    language: str = Field(default="python")
    suggestion: Suggestion
    exec_timeout_s: int | None = Field(default=None, ge=1, le=30)
    preview_only: bool = False


class FixResponse(BaseModel):
    applied: bool
    fixed_code: str
    candidate_code: str | None = None
    message: str
    validation: dict[str, Any] = Field(default_factory=dict)
