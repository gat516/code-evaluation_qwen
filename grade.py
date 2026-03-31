import sys
import json

from grading.core import grade_submission, run_student_code

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
    print(
        json.dumps(
            {
                "execution": run_result,
                "grading_tool_output": grade,
            },
            indent=2,
        )
    )
    print("="*30)

if __name__ == "__main__":
    main()
