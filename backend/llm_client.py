from __future__ import annotations

import json
import os
from typing import Any
from urllib import error, request


class LLMClientError(RuntimeError):
    pass


def _join_url(base_url: str, suffix: str) -> str:
    return base_url.rstrip("/") + "/" + suffix.lstrip("/")


def query_chat_completions(messages: list[dict[str, str]]) -> tuple[str, str]:
    base_url = os.getenv("QWEN_BASE_URL", "http://localhost:30001/v1")
    api_key = os.getenv("QWEN_API_KEY", "n/a")
    model = os.getenv("MODEL_ID", "qwen2.5")
    timeout_s = int(os.getenv("REQUEST_TIMEOUT", "30"))

    endpoint = _join_url(base_url, "/chat/completions")
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
    }

    encoded = json.dumps(payload).encode("utf-8")
    req = request.Request(endpoint, data=encoded, method="POST")
    req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")

    try:
        with request.urlopen(req, timeout=timeout_s) as response:
            body = response.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else str(exc)
        raise LLMClientError(f"Model server HTTP {exc.code}: {detail}") from exc
    except Exception as exc:  # noqa: BLE001 - normalize all transport failures
        raise LLMClientError(f"Model server request failed: {exc}") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise LLMClientError("Model server returned non-JSON response.") from exc

    choices = parsed.get("choices") if isinstance(parsed, dict) else None
    if not isinstance(choices, list) or not choices:
        raise LLMClientError("Model server response missing choices.")

    first = choices[0] if isinstance(choices[0], dict) else {}
    message = first.get("message") if isinstance(first.get("message"), dict) else {}
    content = message.get("content")
    if not isinstance(content, str):
        raise LLMClientError("Model server response missing message content.")

    return model, content
