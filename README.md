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
python grade_local.py student-code-examples/good_student_code.py
```
