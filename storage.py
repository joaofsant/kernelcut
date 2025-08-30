# storage.py
from pathlib import Path
from transform import transform

PROC = Path("data/processed")

def write_partitioned():
    df = transform()
    PROC.mkdir(parents=True, exist_ok=True)
    run_date = df["fetch_ts"].dt.date.iloc[0].isoformat()
    out_dir = PROC / f"date={run_date}"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "kernelcut.parquet"
    df.to_parquet(out, index=False, engine="fastparquet")
    print(f"Wrote {len(df)} rows to {out}")

if __name__ == "__main__":
    write_partitioned()
    