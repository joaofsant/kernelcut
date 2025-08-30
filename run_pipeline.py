# run_pipeline.py
import subprocess

steps = [
    ["python","ingest.py"],
    ["python","transform.py"],
    ["python","quality.py"],
    ["python","storage.py"],
    ["python","digest.py"]
]
for cmd in steps:
    print("→", " ".join(cmd))
    subprocess.check_call(cmd)