# Code Coach

Code suggestion assistant for coding websites, with two analysis modes:

- local rule-based suggestions (fast)
- AI backend suggestions (Qwen)


## Setup

```bash
conda env create -f environment.yml
conda activate gpu-env
```

## Start AI suggestion backend

Start Qwen server:

```bash
python start_server.py
```

Start API wrapper:

```bash
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

Analyze example request:

```bash
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "code": "for i in range(10):\n    print(i)",
    "language": "python",
    "site": "onecompiler",
    "student_id": "zhang_chengming",
    "metadata": {"source": "manual"}
  }'
```

## Student memory

The backend tracks per-student error patterns as Markdown files under `memory/`. Each file has YAML frontmatter and a fenced JSON block:

```
memory/zhang_chengming.md
```

```markdown
---
student: Zhang, Chengming
updated: 2026-04-21
---

\`\`\`json
[
  {
    "pattern": "Off-by-one in loops",
    "first_seen": "2026-04-02",
    "last_seen": "2026-04-05",
    "frequency": 3,
    "examples": ["Used `i <= len(arr)` instead of `i < len(arr)`"],
    "root_cause": "Boundary condition misunderstanding",
    "status": "improving",
    "recommended_review": ["array indexing", "loop bounds", "dry-run practice"]
  }
]
\`\`\`
```

Pass `student_id` in the `/analyze` request body to load that student's memory. Known error patterns are injected into the model prompt so recurring mistakes receive extra attention.

`status` must be one of `active`, `improving`, or `resolved`.

Use `backend.memory.upsert_pattern()` to create or update a pattern entry programmatically.

## Backend API

Endpoints:

- `GET /health`
- `POST /analyze`

Environment variables:

- `QWEN_BASE_URL` (default `http://localhost:30001/v1`)
- `MODEL_ID` (default `default`)
- `QWEN_API_KEY` (default `n/a`)
- `REQUEST_TIMEOUT` (default `30`)
- `EXEC_TIMEOUT` (default `2`)
- `EXTENSION_API_KEY` (if set, API requires `X-API-Key`)
- `CORS_ALLOW_ORIGINS` (default `*`, comma-separated list supported)
- `MODEL_PATH` (default `Qwen/Qwen2.5-0.5B-Instruct`)
- `MODEL_SERVER_PORT` (default `30001`)
- `MODEL_SERVER_HOST` (default `0.0.0.0`)

## Chrome extension

Location: `extension/`

Features:

- allowlist detection for OneCompiler, Replit, LeetCode, and HackerRank
- optional broad detection mode (Monaco/CodeMirror/Ace/Textarea) in settings
- inline highlights with hover cards (Grammarly-style)
- side panel for grouped suggestions
- local mode and AI backend mode toggle

Load in Chrome:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension/` folder

## Extension settings

Open extension options and configure:

- `Analysis mode`
	- `Local rules (fast, offline)`
	- `AI backend (Qwen suggestions)`
- `Backend URL` (for AI mode), default `http://127.0.0.1:8000`
- `API Key` (optional)
- `Student ID` (optional) — when set, sent as `student_id` on every `/analyze` request so the backend loads that student's error pattern memory
- `Broad editor detection`
- `Auto-analyze while typing`

## ZeroTier / remote backend workflow

If AI backend runs remotely but browser is local, use SSH port forwarding:

```bash
ssh -N -L 8000:127.0.0.1:8000 char@10.144.50.20
```

Then set extension backend URL to:

- `http://127.0.0.1:8000`

## Troubleshooting

- AI mode shows connection errors:
	- verify local `curl http://127.0.0.1:8000/health`
	- verify tunnel is active if backend is remote
	- reload extension in `chrome://extensions`
- No inline highlights:
	- refresh coding site tab after extension reload
	- ensure page is one of supported sites or broad detection is enabled
	- open service worker logs in `chrome://extensions`

