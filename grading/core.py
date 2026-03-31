import json
import os
import subprocess
import tempfile
from typing import Any, Dict

from openai import OpenAI

GRADING_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "grade_code",
            "description": "Grade the code and give feedback on it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "grade": {
                        "type": "integer",
                        "description": "The grade given to the code from 0 to 100",
                    },
                    "explanation": {
                        "type": "string",
                        "description": "An explanation of why the grade was given.",
                    },
                    "security_warning": {
                        "type": "boolean",
                        "description": "Set true if the code is malicious or has dangerous patterns.",
                    },
                },
                "required": ["grade", "explanation", "security_warning"],
            },
        },
    }
]

FIX_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "propose_code_fix",
            "description": "Return a full corrected Python source file for the provided suggestion.",
            "parameters": {
                "type": "object",
                "properties": {
                    "fixed_code": {
                        "type": "string",
                        "description": "Complete Python source code after applying the fix.",
                    },
                    "summary": {
                        "type": "string",
                        "description": "Short summary of what was changed.",
                    },
                },
                "required": ["fixed_code"],
            },
        },
    }
]


def _get_client() -> OpenAI:
    base_url = os.getenv("QWEN_BASE_URL", "http://localhost:30001/v1")
    api_key = os.getenv("QWEN_API_KEY", "n/a")
    timeout_s = float(os.getenv("REQUEST_TIMEOUT", "30"))
    return OpenAI(base_url=base_url, api_key=api_key, timeout=timeout_s)


def get_model_id() -> str:
    return os.getenv("MODEL_ID", "default")


def get_default_exec_timeout() -> int:
    return int(os.getenv("EXEC_TIMEOUT", "2"))


def run_student_code(code: str, timeout_s: int | None = None) -> Dict[str, Any]:
    timeout_val = timeout_s if timeout_s is not None else get_default_exec_timeout()

    with tempfile.TemporaryDirectory() as temp_dir:
        path = f"{temp_dir}/student.py"
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)

        try:
            proc = subprocess.run(
                ["python3", path],
                capture_output=True,
                text=True,
                timeout=timeout_val,
            )
            return {
                "stdout": proc.stdout[-4000:],
                "stderr": proc.stderr[-4000:],
                "exit_code": proc.returncode,
                "timed_out": False,
            }
        except subprocess.TimeoutExpired as exc:
            stdout_val = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr_val = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            return {
                "stdout": stdout_val[-4000:],
                "stderr": (stderr_val[-4000:] + "\n[Timed out]"),
                "exit_code": None,
                "timed_out": True,
            }


def grade_submission(code: str, run_result: Dict[str, Any]) -> Dict[str, Any]:
    messages = [
        {
            "role": "system",
            "content": (
                "You are a strict automated programming grader. You must review the code and the "
                "execution result, then call the 'grade_code' function."
            ),
        },
        {
            "role": "user",
            "content": (
                "Please grade this submission.\n\n"
                "--- STUDENT CODE ---\n"
                f"{code}\n\n"
                "--- EXECUTION RESULT ---\n"
                f"{json.dumps(run_result)}"
            ),
        },
    ]

    response = _get_client().chat.completions.create(
        model=get_model_id(),
        messages=messages,
        tools=GRADING_TOOL,
        tool_choice="required",
    )

    try:
        tool_calls = response.choices[0].message.tool_calls
        if tool_calls:
            return json.loads(tool_calls[0].function.arguments)
        return {
            "error": "model did not call grading function",
            "raw_content": response.choices[0].message.content,
        }
    except Exception as exc:
        return {"error": f"failed to parse: {str(exc)}"}


def analyze_submission(code: str, timeout_s: int | None = None) -> Dict[str, Any]:
    execution = run_student_code(code, timeout_s=timeout_s)
    grading = grade_submission(code, execution)
    return {
        "execution": execution,
        "grading_tool_output": grading,
    }


def propose_fix_submission(code: str, suggestion: Dict[str, Any], run_result: Dict[str, Any]) -> Dict[str, Any]:
    messages = [
        {
            "role": "system",
            "content": (
                "You are an automated Python code-fix assistant. Apply only the minimum safe changes "
                "needed to resolve the suggestion while preserving intended behavior. "
                "Return the FULL updated file by calling the 'propose_code_fix' function."
            ),
        },
        {
            "role": "user",
            "content": (
                "Apply a fix for this suggestion.\n\n"
                "--- ORIGINAL CODE ---\n"
                f"{code}\n\n"
                "--- SUGGESTION ---\n"
                f"{json.dumps(suggestion)}\n\n"
                "--- EXECUTION RESULT ---\n"
                f"{json.dumps(run_result)}"
            ),
        },
    ]

    response = _get_client().chat.completions.create(
        model=get_model_id(),
        messages=messages,
        tools=FIX_TOOL,
        tool_choice="required",
    )

    try:
        tool_calls = response.choices[0].message.tool_calls
        if not tool_calls:
            return {
                "error": "model did not call fix function",
                "raw_content": response.choices[0].message.content,
            }

        payload = json.loads(tool_calls[0].function.arguments)
        fixed_code = str(payload.get("fixed_code") or "")
        if fixed_code.strip().startswith("```"):
            fixed_code = fixed_code.strip().strip("`")
            if "\n" in fixed_code:
                fixed_code = "\n".join(fixed_code.split("\n")[1:])
        return {
            "fixed_code": fixed_code,
            "summary": payload.get("summary", ""),
        }
    except Exception as exc:
        return {"error": f"failed to parse fix: {str(exc)}"}
