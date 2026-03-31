from typing import Any

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    code: str = Field(min_length=1)
    language: str = Field(default="python")
    site: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    exec_timeout_s: int | None = Field(default=None, ge=1, le=30)


class Suggestion(BaseModel):
    rule_id: str
    severity: str
    category: str
    message: str
    rationale: str
    before: str | None = None
    after: str | None = None
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)


class AnalyzeResponse(BaseModel):
    execution: dict[str, Any]
    grading_tool_output: dict[str, Any]
    suggestions: list[Suggestion]


class FixRequest(BaseModel):
    code: str = Field(min_length=1)
    language: str = Field(default="python")
    suggestion: Suggestion
    exec_timeout_s: int | None = Field(default=None, ge=1, le=30)


class FixResponse(BaseModel):
    applied: bool
    fixed_code: str
    message: str
    validation: dict[str, Any] = Field(default_factory=dict)
