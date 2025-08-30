# transform.py
from pathlib import Path
import json, glob
import pandas as pd

RAW_DIR = Path("data/raw")

def latest_raw():
    files = sorted(RAW_DIR.glob("kernelcut_*.json"))
    if not files:
        raise SystemExit("No raw files. Run: python ingest.py")
    return files[-1]

def transform():
    path = latest_raw()
    rows = json.loads(path.read_text())

    df = pd.DataFrame(rows)
    # normalize
    df["published"] = pd.to_datetime(df["published"], errors="coerce", utc=True)
    df["title"] = df["title"].fillna("n/a").str.strip()
    df["summary"] = df["summary"].fillna("").str.strip()

    # naive ranking: prefer recent + longer title (proxy for specificity)
    recency = (df["published"].fillna(pd.Timestamp.utcnow()) - pd.Timestamp("1970-01-01", tz="UTC")).dt.total_seconds()
    title_len = df["title"].str.len()
    df["score"] = (recency / recency.max()).fillna(0) * 0.6 + (title_len / title_len.clip(lower=1).max()) * 0.4

    # add fetch timestamp derived from filename
    ts = path.stem.replace("kernelcut_", "")
    df["fetch_ts"] = pd.to_datetime(ts, format="%Y%m%dT%H%M%SZ", utc=True)

    # domain
    from urllib.parse import urlparse
    df["domain"] = df["link"].apply(lambda u: urlparse(u).netloc if isinstance(u, str) else None)

    return df

if __name__ == "__main__":
    print(transform().head())
    