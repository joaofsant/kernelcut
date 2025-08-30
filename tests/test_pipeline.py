# tests/test_pipeline.py
import sys, pathlib, subprocess
import pytest
sys.path.append(str(pathlib.Path(__file__).resolve().parents[1]))

@pytest.fixture(scope="session", autouse=True)
def ensure_raw():
    raw = pathlib.Path("data/raw")
    if not list(raw.glob("kernelcut_*.json")):
        subprocess.check_call([sys.executable, "ingest.py"])

def test_transform_and_quality():
    from transform import transform
    from quality import validate
    df = transform()
    validate(df)
    assert len(df) > 0