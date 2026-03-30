# qwen-research
using qwen to evaluate students' coding performance


```
conda env create -f environment.yml
conda activate gpu-env
```

start qwen
```
run python start_server.py
```

open another terminal and query it by running grade.py.
to run grade.py, pass an argument alongside it.
```
python grade.py student-code-examples/good/good_student_code.py
```

## Backend API (for browser extension)

Run a local API that wraps the existing grading flow:

```
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

API endpoints:

- `GET /health`
- `POST /analyze`

Example request:

```bash
curl -X POST http://localhost:8000/analyze \
	-H "Content-Type: application/json" \
	-d '{
		"code": "for i in range(10):\n    print(i)",
		"language": "python",
		"site": "onecompiler",
		"metadata": {"source": "manual"}
	}'
```

Optional environment variables:

- `QWEN_BASE_URL` (default `http://localhost:30001/v1`)
- `MODEL_ID` (default `default`)
- `QWEN_API_KEY` (default `n/a`)
- `REQUEST_TIMEOUT` (default `30`)
- `EXEC_TIMEOUT` (default `2`)
- `EXTENSION_API_KEY` (if set, API requires `X-API-Key`)
- `CORS_ALLOW_ORIGINS` (default `*`, comma-separated list supported)

## Chrome Extension MVP

An initial extension scaffold is in `extension/` with:

- allowlist detection for OneCompiler, Replit, LeetCode, and HackerRank
- optional broad detection mode (Monaco/CodeMirror/Ace/Textarea) in settings
- background worker that sends code snapshots to `/analyze`
- side panel that renders score and suggestion cards

Load it in Chrome:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder

Before testing the extension, run:

1. `python start_server.py`
2. `uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload`
