import os
import time

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.llm_client import LLMClientError, query_chat_completions
from backend.parsing import parse_llm_suggestions
from backend.prompting import build_analysis_messages
from backend.schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    AnalyzeSuggestion,
)
from backend.security import get_cors_origins, verify_api_key

app = FastAPI(title="Code Coach Backend", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": os.getenv("MODEL_ID", "qwen2.5")}


def _is_noop_suggestion(suggestion: AnalyzeSuggestion) -> bool:
    msg = (suggestion.message or "").strip().lower()
    if not msg:
        return True
    noop_markers = (
        "no issues found",
        "no issue found",
        "no problems found",
        "looks good",
        "code is correct",
    )
    return any(marker in msg for marker in noop_markers)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(payload: AnalyzeRequest, _: None = Depends(verify_api_key)) -> AnalyzeResponse:
    if payload.language.lower() != "python":
        raise HTTPException(
            status_code=400,
            detail={
                "error": "unsupported_language",
                "message": "Backend currently supports Python only.",
            },
        )

    start = time.perf_counter()
    metadata: dict = {
        "site": payload.site,
        "language": payload.language,
    }

    try:
        messages = build_analysis_messages(
            code=payload.code,
            language=payload.language,
            site=payload.site,
            metadata=payload.metadata,
        )
        model_name, content = query_chat_completions(messages)
        parsed_suggestions = parse_llm_suggestions(content)

        suggestions = [AnalyzeSuggestion(**item) for item in parsed_suggestions]
        suggestions = [s for s in suggestions if not _is_noop_suggestion(s)]

        elapsed_ms = int((time.perf_counter() - start) * 1000)
        return AnalyzeResponse(
            suggestions=suggestions,
            model=model_name,
            analysis_time_ms=max(0, elapsed_ms),
            metadata=metadata,
        )

    except LLMClientError as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "llm_error", "message": str(exc)},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={"error": "analysis_failed", "message": f"Unexpected error: {exc}"},
        ) from exc