import subprocess
import os

MODEL_PATH = os.getenv("MODEL_PATH", "Qwen/Qwen2.5-1.5B-Instruct")
PORT = int(os.getenv("MODEL_SERVER_PORT", "30001"))
HOST = os.getenv("MODEL_SERVER_HOST", "0.0.0.0")

os.environ["CUDA_VISIBLE_DEVICES"] = "0"

def launch():
    print(f"Starting Qwen Server on port {PORT} . . ")
    cmd = [
        "python3", "-m", "sglang.launch_server",
        "--model-path", MODEL_PATH,
        "--port", str(PORT),
        "--host", HOST,
        "--tool-call-parser", "qwen25",
        "--attention-backend", "triton",
        "--sampling-backend", "pytorch"
        ]

    try:
        subprocess.run(cmd, check=True)
    except KeyboardInterrupt:
        print("\n Server shut down.")


if __name__ == "__main__":
    launch()
