#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

AI_PID=""
API_PID=""

cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "Stopping backend processes..."

  if [[ -n "$AI_PID" ]] && kill -0 "$AI_PID" 2>/dev/null; then
    kill "$AI_PID" 2>/dev/null || true
  fi

  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
  fi

  # Also clean up by pattern to catch auto-reload/process-spawned workers.
  pkill -f "uvicorn backend.app:app" 2>/dev/null || true
  pkill -f "sglang.launch_server" 2>/dev/null || true
  pkill -f "sglang::scheduler" 2>/dev/null || true

  wait 2>/dev/null || true
  echo "All backend processes stopped."
}

trap cleanup INT TERM EXIT

echo "Killing old backend processes..."
pkill -f "uvicorn backend.app:app" 2>/dev/null || true
pkill -f "sglang.launch_server" 2>/dev/null || true
pkill -f "sglang::scheduler" 2>/dev/null || true

if command -v conda >/dev/null 2>&1; then
  eval "$(conda shell.bash hook)"
  if conda env list | awk '{print $1}' | grep -qx "gpu-env"; then
    conda activate gpu-env
  else
    echo "Warning: conda environment 'gpu-env' not found. Using current environment."
  fi
else
  echo "Warning: conda not found in PATH. Ensure gpu-env is already active."
fi

echo "Starting AI suggestion backend (start_server.py)..."
python start_server.py &
AI_PID=$!

echo "Starting FastAPI backend on 0.0.0.0:8000..."
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload &
API_PID=$!

echo "Backends are running. Press Ctrl+C to stop everything."

wait
