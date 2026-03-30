from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.schemas import AnalyzeRequest, AnalyzeResponse, Suggestion
from backend.security import get_cors_origins, verify_api_key
from grading.core import analyze_submission

app = FastAPI(title="Code Evaluation Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _build_suggestions(grading_tool_output: dict) -> list[Suggestion]:
    suggestions: list[Suggestion] = []
    grade = grading_tool_output.get("grade")
    explanation = grading_tool_output.get("explanation", "No explanation provided.")
    security_warning = bool(grading_tool_output.get("security_warning", False))

    if security_warning:
        suggestions.append(
            Suggestion(
                rule_id="security.warning",
                severity="high",
                category="security",
                message="Potentially dangerous code pattern detected.",
                rationale=explanation,
                confidence=0.8,
            )
        )

    if isinstance(grade, int):
        if grade < 60:
            severity = "high"
        elif grade < 80:
            severity = "medium"
        else:
            severity = "low"

        suggestions.append(
            Suggestion(
                rule_id="quality.grade",
                severity=severity,
                category="correctness",
                message=f"Overall quality score: {grade}/100",
                rationale=explanation,
                confidence=0.7,
            )
        )
    elif "error" in grading_tool_output:
        suggestions.append(
            Suggestion(
                rule_id="analysis.error",
                severity="high",
                category="system",
                message="Unable to generate reliable grading output.",
                rationale=str(grading_tool_output.get("error")),
                confidence=1.0,
            )
        )

    return suggestions


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(payload: AnalyzeRequest, _: None = Depends(verify_api_key)) -> AnalyzeResponse:
    if payload.language.lower() != "python":
        raise HTTPException(
            status_code=400,
            detail={
                "error": "unsupported_language",
                "message": "MVP backend currently supports python only.",
            },
        )

    try:
        result = analyze_submission(payload.code, timeout_s=payload.exec_timeout_s)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "analysis_failed", "message": str(exc)},
        ) from exc

    return AnalyzeResponse(
        execution=result["execution"],
        grading_tool_output=result["grading_tool_output"],
        suggestions=_build_suggestions(result["grading_tool_output"]),
    )
