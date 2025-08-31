# storage.py
from pathlib import Path
from datetime import datetime, timezone
import pandas as pd
from transform import transform

PROC_DIR = Path("data/processed")
PROC_DIR.mkdir(parents=True, exist_ok=True)

def store():
    df = transform(window="today")  # já filtra 24h/today
    date_str = datetime.now(timezone.utc).date().isoformat()
    out_dir = PROC_DIR / f"date={date_str}"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "kernelcut.parquet"
    df.to_parquet(out, index=False, engine="fastparquet")
    print(f"Wrote {len(df)} rows to {out}")

if __name__ == "__main__":
    store()