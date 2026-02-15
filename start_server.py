import subprocess
import os

model = "Qwen/Qwen2.5-0.5B-Instruct"
PORT = 30001

os.environ["CUDA_VISIBLE_DEVICES"] = "0"

def launch():
    print(f"Starting Qwen Server on port {PORT} . . ")
    cmd = [
        "python3", "-m", "sglang.launch_server",
        "--model-path", model,
        "--port", str(PORT),
        "--host", "0.0.0.0",
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
