# transform.py
from pathlib import Path
import json
import os
import argparse
import pandas as pd
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse

RAW_DIR = Path("data/raw")

def latest_raw() -> Path:
    files = sorted(RAW_DIR.glob("kernelcut_*.json"))
    if not files:
        raise SystemExit("No raw files. Run: python ingest.py")
    return files[-1]

def build_filter_mask(df: pd.DataFrame, window: str) -> pd.Series:
    now = datetime.now(timezone.utc)
    if window == "today":
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        end = start + timedelta(days=1)
        return (df["published"] >= start) & (df["published"] < end)
    # default: last 24h
    cutoff = now - timedelta(days=1)
    return df["published"] >= cutoff

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Kernelcut transform")
    p.add_argument(
        "--window",
        choices=["24h", "today"],
        default=os.getenv("KERNELCUT_WINDOW", "24h"),
        help="Time filter: last 24h (default) or 'today' (UTC)",
    )
    return p.parse_args()

def transform(window: str = None) -> pd.DataFrame:
    if window is None:
        window = os.getenv("KERNELCUT_WINDOW", "24h")

    path = latest_raw()
    rows = json.loads(path.read_text())
    df = pd.DataFrame(rows)

    # fetch_ts from filename (UTC)
    ts = path.stem.replace("kernelcut_", "")
    fetch_ts = pd.to_datetime(ts, format="%Y%m%dT%H%M%SZ", utc=True)
    df["fetch_ts"] = fetch_ts

    # published (UTC) with fallback to fetch_ts
    df["published"] = pd.to_datetime(df.get("published"), errors="coerce", utc=True)
    df["published"] = df["published"].fillna(df["fetch_ts"])

    # text cleanup
    df["title"] = df.get("title", "").fillna("n/a").astype(str).str.strip()
    df["summary"] = df.get("summary", "").fillna("").astype(str).str.strip()

    # link/domain
    df["link"] = df.get("link").astype(str)
    df["domain"] = df["link"].apply(lambda u: urlparse(u).netloc if isinstance(u, str) and u else None)

    # --- time window filter ---
    mask = build_filter_mask(df, window)
    df = df[mask].copy()
    if df.empty:
        raise SystemExit(f"No items for window='{window}' (UTC). Try later or add more sources.")

    # --- de-dup (prefer newest) ---
    df = df.sort_values(["published"], ascending=False)
    df = df.drop_duplicates(subset=["link"], keep="first")
    df = df.drop_duplicates(subset=["title"], keep="first")

    # --- ranking: recency vs title length ---
    if window == "today":
        # relative to start-of-day for stability
        now = datetime.now(timezone.utc)
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        recency_sec = (df["published"] - start).dt.total_seconds().clip(lower=0)
    else:
        cutoff = datetime.now(timezone.utc) - timedelta(days=1)
        recency_sec = (df["published"] - cutoff).dt.total_seconds().clip(lower=0)

    rec_norm = recency_sec / recency_sec.max() if recency_sec.max() > 0 else 0
    title_len = df["title"].str.len().clip(lower=1)
    tlen_norm = title_len / title_len.max()

    df["score"] = rec_norm * 0.7 + tlen_norm * 0.3

    cols = ["source", "title", "link", "domain", "summary", "published", "fetch_ts", "score"]
    extra = [c for c in df.columns if c not in cols]
    return df[cols + extra].reset_index(drop=True)

if __name__ == "__main__":
    args = parse_args()
    out = transform(window=args.window)
    print(out.head(5))
    print(f"Rows ({args.window} UTC): {len(out)}")