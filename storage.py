# storage.py
from pathlib import Path
import pandas as pd
from transform import transform

PROC_DIR = Path("data/processed")
PROC_DIR.mkdir(parents=True, exist_ok=True)

def store():
    df = transform(window="today")
    if df.empty:
        raise SystemExit("No rows after transform(window='today'). Run ingest.py first?")

    # partition by fetch date (UTC) from the data itself
    run_date = df["fetch_ts"].dt.tz_convert("UTC").dt.date.iloc[0]
    out_dir = PROC_DIR / f"date={run_date.isoformat()}"
    out_dir.mkdir(parents=True, exist_ok=True)

    out = out_dir / "kernelcut.parquet"
    df.to_parquet(out, index=False, engine="fastparquet")
    print(f"Wrote {len(df)} rows to {out}")

if __name__ == "__main__":
    store()