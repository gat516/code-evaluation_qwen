import os

from fastapi import Header, HTTPException


def get_cors_origins() -> list[str]:
    origins = os.getenv("CORS_ALLOW_ORIGINS", "*")
    if origins.strip() == "*":
        return ["*"]
    return [o.strip() for o in origins.split(",") if o.strip()]


def verify_api_key(x_api_key: str | None = Header(default=None)) -> None:
    expected = os.getenv("EXTENSION_API_KEY", "").strip()
    if not expected:
        return
    if x_api_key != expected:
        raise HTTPException(
            status_code=401,
            detail={"error": "unauthorized", "message": "Missing or invalid X-API-Key"},
        )
