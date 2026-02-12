import json
import subprocess
import tempfile
import sys
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    dtype=torch.float16,
    device_map="auto",
)

def run_student_code(code: str, timeout_s: int = 2) -> dict:
    with tempfile.TemporaryDirectory() as d:
        path = f"{d}/student.py"
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)

        try:
            p = subprocess.run(
                ["python3", path],
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
            return {
                "stdout": p.stdout[-4000:],
                "stderr": p.stderr[-4000:],
                "exit_code": p.returncode,
                "timed_out": False,
            }
        except subprocess.TimeoutExpired as e:
            stdout_val = (e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or ""))
            stderr_val = (e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or ""))
            return {
                "stdout": stdout_val[-4000:],
                "stderr": (stderr_val[-4000:] + "\n[Timed out]"),
                "exit_code": None,
                "timed_out": True,
            }

def qwen_grade(code: str, run_result: dict) -> dict:
    prompt = f"""You are an automated programming grader.

Student code:
{code}

Execution result:
{json.dumps(run_result, indent=2)}

Return ONLY valid JSON:
{{
"score": 0-100,
"explanation": "brief explanation"
}}
"""
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    outputs = model.generate(
        **inputs,
        max_new_tokens=256,
        do_sample=False,
    )
    
    response = tokenizer.decode(outputs[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True)
    return {"raw_response": response.strip()}

def main():
    if len(sys.argv) != 2:
        print("Usage: python grade_local.py student_code.py")
        sys.exit(1)

    with open(sys.argv[1], "r", encoding="utf-8") as f:
        code = f.read()

    run_result = run_student_code(code)
    grade = qwen_grade(code, run_result)

    print(json.dumps({
        "run_result": run_result,
        "grade": grade
    }, indent=2))

if __name__ == "__main__":
    main()
