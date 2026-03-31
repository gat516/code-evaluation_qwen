import ast
import re

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.schemas import AnalyzeRequest, AnalyzeResponse, FixRequest, FixResponse, Suggestion
from backend.security import get_cors_origins, verify_api_key
from grading.core import analyze_submission, propose_fix_submission, run_student_code

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


def _build_suggestions(grading_tool_output: dict, execution: dict) -> list[Suggestion]:
    suggestions: list[Suggestion] = []
    grade = grading_tool_output.get("grade")
    explanation = grading_tool_output.get("explanation", "No explanation provided.")
    security_warning = bool(grading_tool_output.get("security_warning", False))

    timed_out = bool(execution.get("timed_out", False))
    exit_code = execution.get("exit_code")
    stderr = str(execution.get("stderr") or "").strip()
    execution_failed = timed_out or (exit_code is not None and exit_code != 0)

    if execution_failed:
      if timed_out:
          runtime_reason = "Program timed out during execution."
      elif stderr:
          runtime_reason = stderr[-600:]
      else:
          runtime_reason = f"Program exited with non-zero status: {exit_code}."

      suggestions.append(
          Suggestion(
              rule_id="correctness.runtime-error",
              severity="high",
              category="correctness",
              message="Code does not run successfully; fix runtime errors before quality review.",
              rationale=runtime_reason,
              confidence=1.0,
          )
      )

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

    if isinstance(grade, int) and not execution_failed:
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


def _replace_exact_block_near_line(code: str, before: str, replacement_lines: list[str], line_number: int | None) -> str:
    if not line_number or line_number < 1:
        return _replace_exact_block(code, before, replacement_lines)

    lines = code.splitlines()
    before_lines = [line.strip() for line in before.splitlines() if line.strip()]
    if not before_lines:
        return code

    span = len(before_lines)
    target_idx = line_number - 1
    best_idx = None
    best_distance = None

    for i in range(0, len(lines) - span + 1):
        window = [line.strip() for line in lines[i : i + span]]
        if window != before_lines:
            continue
        distance = abs(i - target_idx)
        if best_idx is None or distance < best_distance:
            best_idx = i
            best_distance = distance

    if best_idx is None:
        return code

    return "\n".join(lines[:best_idx] + replacement_lines + lines[best_idx + span :])


def _line_index_from_anchor(suggestion: Suggestion, max_len: int) -> int | None:
    line_number = suggestion.anchor.line if suggestion.anchor else None
    if line_number is None:
        return None
    idx = line_number - 1
    if idx < 0 or idx >= max_len:
        return None
    return idx


def _apply_python_loop_fix(code: str, suggestion: Suggestion) -> str:
    before = (suggestion.before or "").strip()
    after = (suggestion.after or "").strip()
    if not before or not after:
        return code

    before_lines = [line.strip() for line in before.splitlines() if line.strip()]
    ints: list[int] = []
    for line in before_lines:
        m = re.search(r"\(\s*(-?\d+)\s*\)", line)
        if not m:
            return code
        ints.append(int(m.group(1)))

    if not ints or not all(ints[i] == ints[i - 1] + 1 for i in range(1, len(ints))):
        return code

    start_val = ints[0]
    end_exclusive = ints[-1] + 1
    replacement = [f"for i in range({start_val}, {end_exclusive}):", f"    {after}"]
    line_number = suggestion.anchor.line if suggestion.anchor else None
    return _replace_exact_block_near_line(code, before, replacement, line_number)


def _apply_python_secret_fix(code: str, suggestion: Suggestion) -> str:
    lines = code.splitlines()
    secret_regex = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["\'][^"\']+["\']\s*$')
    changed_idx: int | None = None

    anchored_idx = _line_index_from_anchor(suggestion, len(lines))
    candidate_indices = [anchored_idx] if anchored_idx is not None else list(range(len(lines)))
    if anchored_idx is not None:
        candidate_indices.extend([idx for idx in range(len(lines)) if idx != anchored_idx])

    for idx in candidate_indices:
        line = lines[idx]
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
        changed_idx = idx
        break

    if changed_idx is None:
        return code

    next_code = "\n".join(lines)
    if not re.search(r"^\s*import\s+os\s*$", next_code, flags=re.MULTILINE):
        next_code = f"import os\n{next_code}"
    return next_code


def _apply_python_eval_exec_fix(code: str, suggestion: Suggestion) -> str:
    lines = code.splitlines()
    changed_idx: int | None = None

    anchored_idx = _line_index_from_anchor(suggestion, len(lines))
    candidate_indices = [anchored_idx] if anchored_idx is not None else list(range(len(lines)))
    if anchored_idx is not None:
        candidate_indices.extend([idx for idx in range(len(lines)) if idx != anchored_idx])

    for idx in candidate_indices:
        line = lines[idx]
        patched = re.sub(r"\beval\(([^\n\)]*)\)", r"ast.literal_eval(\1)", line)
        patched = re.sub(r"\bexec\(([^\n\)]*)\)", r"# exec removed for safety: \1", patched)
        if patched != line:
            lines[idx] = patched
            changed_idx = idx
            break

    if changed_idx is None:
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


def _strip_code_fences(code: str) -> str:
    text = (code or "").strip()
    if not text.startswith("```"):
        return code

    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines)


def _apply_line_range_replace(code: str, start_line: int, end_line: int, after: str) -> str:
    lines = code.splitlines()
    if start_line < 1 or end_line < start_line:
        return code
    if end_line > len(lines):
        return code

    replacement_lines = _strip_code_fences(after).splitlines()
    return "\n".join(lines[: start_line - 1] + replacement_lines + lines[end_line:])


def _apply_ai_edits(code: str, edits: list[dict]) -> tuple[str, int]:
    current = code
    applied_count = 0

    for raw_edit in edits or []:
        if not isinstance(raw_edit, dict):
            continue

        after_raw = str(raw_edit.get("after") or "")
        after = _strip_code_fences(after_raw)
        before = str(raw_edit.get("before") or "").strip()
        anchor_line = raw_edit.get("anchor_line")
        start_line = raw_edit.get("start_line")
        end_line = raw_edit.get("end_line")

        next_code = current
        if before:
            next_code = _replace_exact_block_near_line(current, before, after.splitlines(), anchor_line)
        elif isinstance(start_line, int) and isinstance(end_line, int):
            next_code = _apply_line_range_replace(current, start_line, end_line, after)

        if next_code != current:
            current = next_code
            applied_count += 1

    return current, applied_count


def _apply_ai_python_fix(code: str, suggestion: Suggestion, timeout_s: int | None) -> tuple[str, str]:
    run_result = run_student_code(code, timeout_s=timeout_s)
    ai_payload = propose_fix_submission(code, suggestion.model_dump(), run_result)
    if ai_payload.get("error"):
        return code, f"AI fix generation failed: {ai_payload.get('error')}"

    edits = ai_payload.get("edits") or []
    if isinstance(edits, list) and edits:
        edited_code, applied_count = _apply_ai_edits(code, edits)
        if edited_code != code and applied_count > 0:
            return edited_code, f"AI-generated section edits applied: {applied_count}."

    fixed_code = _strip_code_fences(str(ai_payload.get("fixed_code") or ""))
    if not fixed_code.strip():
        return code, "AI fix generation returned no applicable edits or full-file patch."

    return fixed_code, "AI-generated fix candidate."


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
        suggestions=_build_suggestions(result["grading_tool_output"], result["execution"]),
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

    ai_fixed_code, ai_message = _apply_ai_python_fix(payload.code, payload.suggestion, payload.exec_timeout_s)
    validation = _validate_python_fix(payload.code, ai_fixed_code, payload.exec_timeout_s)
    applied = bool(validation.get("syntax_ok") and validation.get("changed"))

    fixed_code = ai_fixed_code
    message = ai_message

    if applied:
        message = "Validated fix generated by AI backend."
    else:
        message = str(validation.get("reason") or ai_message or "No valid fix generated.")

    return FixResponse(
        applied=applied,
        fixed_code=fixed_code if applied else payload.code,
        message=message,
        validation=validation,
    )
