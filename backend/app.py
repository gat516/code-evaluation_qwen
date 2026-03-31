import ast
import re

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.schemas import AnalyzeRequest, AnalyzeResponse, FixRequest, FixResponse, Suggestion
from backend.security import get_cors_origins, verify_api_key
from grading.core import analyze_submission, run_student_code

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

        if grade < 60:
            message = "AI review found major improvement opportunities."
        elif grade < 80:
            message = "AI review found moderate improvement opportunities."
        else:
            message = "AI review found minor improvement opportunities."

        suggestions.append(
            Suggestion(
                rule_id="quality.review",
                severity=severity,
                category="maintainability",
                message=message,
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


def _replace_exact_block(code: str, before: str, replacement_lines: list[str]) -> str:
    lines = code.splitlines()
    before_lines = [line.strip() for line in before.splitlines() if line.strip()]
    if not before_lines:
        return code

    span = len(before_lines)
    for i in range(0, len(lines) - span + 1):
        window = [line.strip() for line in lines[i : i + span]]
        if window == before_lines:
            return "\n".join(lines[:i] + replacement_lines + lines[i + span :])
    return code


def _apply_python_loop_fix(code: str, suggestion: Suggestion) -> str:
    before = (suggestion.before or "").strip()
    after = (suggestion.after or "").strip()
    if before and after:
        before_lines = [line.strip() for line in before.splitlines() if line.strip()]
        ints: list[int] = []
        for line in before_lines:
            m = re.search(r"\(\s*(-?\d+)\s*\)", line)
            if not m:
                ints = []
                break
            ints.append(int(m.group(1)))
        if ints and all(ints[i] == ints[i - 1] + 1 for i in range(1, len(ints))):
            start_val = ints[0]
            end_exclusive = ints[-1] + 1
            replacement = [f"for i in range({start_val}, {end_exclusive}):", f"    {after}"]
            replaced = _replace_exact_block(code, before, replacement)
            if replaced != code:
                return replaced

    lines = code.splitlines()

    def parse_numeric_call(line: str) -> tuple[str, int] | None:
        m = re.match(r"^\s*([A-Za-z_][\w\.]*)\s*\(\s*(-?\d+)\s*\)\s*;?\s*$", line)
        if not m:
            return None
        return m.group(1), int(m.group(2))

    best: tuple[int, int, str, int, int] | None = None
    start = -1
    callee = ""
    prev = 0

    def flush(end_exclusive: int) -> None:
        nonlocal best, start, callee, prev
        if start == -1:
            return
        count = end_exclusive - start
        if count >= 3:
            start_info = parse_numeric_call(lines[start])
            end_info = parse_numeric_call(lines[end_exclusive - 1])
            if start_info and end_info:
                candidate = (count, start, end_exclusive - 1, callee, start_info[1], end_info[1] + 1)
                if best is None or candidate[0] > best[0]:
                    best = candidate
        start = -1
        callee = ""
        prev = 0

    for i, line in enumerate(lines):
        parsed = parse_numeric_call(line)
        if parsed is None:
            flush(i)
            continue
        current_callee, current_val = parsed
        if start == -1:
            start = i
            callee = current_callee
            prev = current_val
            continue
        if current_callee == callee and current_val == prev + 1:
            prev = current_val
            continue
        flush(i)
        start = i
        callee = current_callee
        prev = current_val

    flush(len(lines))
    if best is None:
        return code

    _, run_start, run_end, run_callee, start_val, end_exclusive = best
    replacement = [f"for i in range({start_val}, {end_exclusive}):", f"    {run_callee}(i)"]
    return "\n".join(lines[:run_start] + replacement + lines[run_end + 1 :])


def _apply_python_secret_fix(code: str, _: Suggestion) -> str:
    lines = code.splitlines()
    secret_regex = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["\'][^"\']+["\']\s*$')
    changed = False

    for idx, line in enumerate(lines):
        match = secret_regex.match(line)
        if not match:
            continue
        var_name = match.group(1)
        lowered = var_name.lower()
        if not any(token in lowered for token in ("password", "token", "key", "secret")):
            continue
        indent = re.match(r"^\s*", line).group(0)
        env_key = re.sub(r"[^A-Z0-9_]", "_", var_name.upper())
        lines[idx] = f'{indent}{var_name} = os.getenv("{env_key}", "")'
        changed = True

    if not changed:
        return code

    next_code = "\n".join(lines)
    if not re.search(r"^\s*import\s+os\s*$", next_code, flags=re.MULTILINE):
        next_code = f"import os\n{next_code}"
    return next_code


def _apply_python_eval_exec_fix(code: str, _: Suggestion) -> str:
    lines = code.splitlines()
    changed = False
    for idx, line in enumerate(lines):
        patched = re.sub(r"\beval\(([^\n\)]*)\)", r"ast.literal_eval(\1)", line)
        patched = re.sub(r"\bexec\(([^\n\)]*)\)", r"# exec removed for safety: \1", patched)
        if patched != line:
            lines[idx] = patched
            changed = True
    if not changed:
        return code

    next_code = "\n".join(lines)
    if not re.search(r"^\s*import\s+ast\s*$", next_code, flags=re.MULTILINE):
        next_code = f"import ast\n{next_code}"
    return next_code


def _apply_python_fix(code: str, suggestion: Suggestion) -> str:
    rule_id = suggestion.rule_id
    text = f"{suggestion.message} {suggestion.rationale}".lower()

    if rule_id == "python.loop.refactor":
        return _apply_python_loop_fix(code, suggestion)
    if rule_id in ("secrets.hardcoded",):
        return _apply_python_secret_fix(code, suggestion)
    if rule_id in ("python.unsafe.dynamic-exec", "js.unsafe.eval"):
        return _apply_python_eval_exec_fix(code, suggestion)
    if rule_id == "security.warning":
        if any(token in text for token in ("secret", "password", "token", "api key")):
            return _apply_python_secret_fix(code, suggestion)
        if any(token in text for token in ("eval", "exec", "dangerous")):
            return _apply_python_eval_exec_fix(code, suggestion)
    if rule_id in ("quality.review", "quality.grade") and ("repeated" in text and "print" in text):
        return _apply_python_loop_fix(code, suggestion)

    return code


def _validate_python_fix(original_code: str, fixed_code: str, timeout_s: int | None) -> dict:
    if fixed_code == original_code:
        return {
            "syntax_ok": True,
            "exec_ok": None,
            "changed": False,
            "reason": "No applicable transformation generated.",
        }

    try:
        ast.parse(fixed_code)
    except SyntaxError as exc:
        return {
            "syntax_ok": False,
            "exec_ok": None,
            "changed": True,
            "reason": f"Syntax check failed: {exc.msg} (line {exc.lineno})",
        }

    exec_result = run_student_code(fixed_code, timeout_s=timeout_s)
    exec_ok = bool(exec_result.get("exit_code") == 0 and not exec_result.get("timed_out"))
    return {
        "syntax_ok": True,
        "exec_ok": exec_ok,
        "changed": True,
        "execution": exec_result,
    }


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


@app.post("/fix", response_model=FixResponse)
def fix(payload: FixRequest, _: None = Depends(verify_api_key)) -> FixResponse:
    if payload.language.lower() != "python":
        raise HTTPException(
            status_code=400,
            detail={
                "error": "unsupported_language",
                "message": "MVP backend currently supports python only.",
            },
        )

    fixed_code = _apply_python_fix(payload.code, payload.suggestion)
    validation = _validate_python_fix(payload.code, fixed_code, payload.exec_timeout_s)
    applied = bool(validation.get("syntax_ok") and validation.get("changed"))

    if applied:
        message = "Validated fix generated by backend."
    else:
        message = str(validation.get("reason") or "No valid fix generated.")

    return FixResponse(
        applied=applied,
        fixed_code=fixed_code if applied else payload.code,
        message=message,
        validation=validation,
    )
