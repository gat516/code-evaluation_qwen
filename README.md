# qwen-research
using qwen to evaluate students' coding performance


start by conda env create -f environment.yml

manually install
```
pip install sgl-kernel -i https://docs.sglang.ai/whl/cu124
pip install flashinfer -i https://flashinfer.ai/whl/cu124/torch2.5
```


run python start_server.py

open another terminal and query it by running grade.py
```
python grade_local.py student-code-examples/good_student_code.py
```
