from typing import Any

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    code: str = Field(min_length=1)
    language: str = Field(default="python")
    site: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SuggestionRange(BaseModel):
    startLine: int = Field(ge=1)
    startCol: int = Field(ge=0)
    endLine: int = Field(ge=1)
    endCol: int = Field(ge=0)


class SuggestionFix(BaseModel):
    replacement: str = ""
    range: SuggestionRange


class AnalyzeSuggestion(BaseModel):
    line: int = Field(ge=1)
    col: int = Field(ge=0)
    end_line: int = Field(ge=1)
    end_col: int = Field(ge=0)
    severity: str
    message: str
    fix: SuggestionFix
    source: str = "ai"


class AnalyzeResponse(BaseModel):
    suggestions: list[AnalyzeSuggestion]
    model: str
    analysis_time_ms: int = Field(ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)