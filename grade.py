import json
import subprocess
import tempfile
import sys
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:30001/v1",
    api_key="n/a"
)

#grading function
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
                        "description": "The grade given to the code  from 0 to 100",
                    },
                    "explanation": {
                        "type": "string",
                        "description": "An explanation of why the grade was given."
                    },
                    "security_warning": {
                        "type": "boolean",
                        "description": "set true if the code is malicious or has dangerous patterns."
                    }
                },
                "required": ["grade", "explanation", "security_warning"]
            }
        }
    }
]


#execute student code in a subprocess and capture its output.
def run_student_code(code: str, timeout_s: int = 2) -> dict:
    with tempfile.TemporaryDirectory() as d:
        path = f"{d}/student.py"
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)

        try:
            # We run the code locally to get the stdout/stderr
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



#query the server and force function call.
def grade_submission(code: str, run_result: dict):
    messages = [
        {
            "role": "system", 
            "content": "You are a strict automated programming grader. You must review the code and the execution result, then call the 'grade_code' function."
        },
        {
            "role": "user", 
            "content": f"""
Please grade this submission.

--- STUDENT CODE ---
{code}

--- EXECUTION RESULT ---
{json.dumps(run_result)}
"""
        }
    ]

    #call server
    response = client.chat.completions.create(
        model="default",
        messages=messages,
        tools=GRADING_TOOL,
        tool_choice="required", 
    )

    # extract function call args
    try:
        tool_calls = response.choices[0].message.tool_calls
        if tool_calls:
            # model called grading function
            args = json.loads(tool_calls[0].function.arguments)
            return args
        else:
            #model called grading function
            return {"error": "model did not call grading function", "raw_content": response.choices[0].message.content}
    except Exception as e:
        return {"error": f"failed to parse:: {str(e)}"}

def main():
    if len(sys.argv) != 2:
        print("Usage: python grade.py student_code.py")
        sys.exit(1)

    # read student code
    student_file = sys.argv[1]
    with open(student_file, "r", encoding="utf-8") as f:
        code = f.read()

    # run student code locally
    print(f"Running {student_file}...")
    run_result = run_student_code(code)

    # query the qwen server
    print("Querying Qwen Server...")
    grade = grade_submission(code, run_result)

    # output the result.
    print("\n" + "="*30)
    print(json.dumps({
        "execution": run_result,
        "grading_tool_output": grade
    }, indent=2))
    print("="*30)

if __name__ == "__main__":
    main()
