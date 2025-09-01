# transform.py
from pathlib import Path
import json, re
import pandas as pd
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

RAW_DIR = Path("data/raw")

GOOD_DOMAINS = {
    "www.theverge.com","arstechnica.com","techcrunch.com","www.wired.com",
    "www.nature.com","arxiv.org","spectrum.ieee.org","ai.googleblog.com",
    "openai.com","deepmind.google","www.semanticscholar.org"
}
BLOCK_TITLE = re.compile(r"(?i)^(show\s*hn|ask\s*hn|who\s*is\s*hiring|launch\s*hn)\b")
CLEAN_TITLE = re.compile(r"(?i)^(show\s*hn|ask\s*hn|launch\s*hn)\s*[:\-]\s*")

def latest_raw() -> Path:
    files = sorted(RAW_DIR.glob("kernelcut_*.json"))
    if not files:
        raise SystemExit("No raw files. Run: python ingest.py")
    return files[-1]

def normalize_link(u: str) -> str:
    try:
        p = urlparse(u)
        # drop tracking query params
        q = [(k,v) for k,v in parse_qsl(p.query, keep_blank_values=True)
             if not re.match(r"^(utm_|ref$|ref_src$|ncid$|fbclid$)", k, re.I)]
        p = p._replace(query=urlencode(q, doseq=True))
        # drop fragments
        p = p._replace(fragment="")
        return urlunparse(p)
    except Exception:
        return u or ""

def load_df(path: Path) -> pd.DataFrame:
    rows = json.loads(path.read_text())
    df = pd.DataFrame(rows)
    for c in ("title","summary","link","source","published"):
        if c not in df.columns: df[c] = None
    df["title"] = df["title"].fillna("").astype(str).str.strip()
    df["title"] = df["title"].str.replace(r"\s+", " ", regex=True)
    df["title_norm"] = df["title"].str.lower().str.replace(r"[^\w\s]", "", regex=True).str.strip()
    df["title"] = df["title"].str.replace(CLEAN_TITLE, "", regex=True).str.strip()

    df["link"] = df["link"].fillna("").astype(str).str.strip()
    df["link_norm"] = df["link"].apply(normalize_link)

    df["source"] = df["source"].fillna("Unknown").astype(str).str.strip()
    df["published"] = pd.to_datetime(df["published"], errors="coerce", utc=True)

    from urllib.parse import urlparse as up
    df["domain"] = df["link_norm"].apply(lambda u: up(u).netloc if u else "")
    return df

def score(df: pd.DataFrame) -> pd.Series:
    now = pd.Timestamp.now(tz="UTC")
    pub = df["published"].fillna(now)
    rec = (pub.astype("int64", copy=False) / 1e9)
    rec = (rec - rec.min()) / (rec.max() - rec.min() + 1e-9)

    tlen = df["title"].str.len().clip(lower=1)
    tlen = tlen / (tlen.max() or 1)

    bonus = df["domain"].isin(GOOD_DOMAINS).astype(float) * 0.20
    penalty = df["title"].str.match(BLOCK_TITLE).astype(float) * 0.40

    return (0.55*rec + 0.30*tlen + bonus - penalty).clip(lower=0, upper=1)

def transform(window: str | None = None) -> pd.DataFrame:
    path = latest_raw()
    df = load_df(path)

    # window filter
    if window:
        now = pd.Timestamp.now(tz="UTC")
        start = now.floor("D") if window == "today" else (now - pd.Timedelta(hours=24))
        recent = df["published"].ge(start)
        df = pd.concat([df[recent], df[df["published"].isna()]], ignore_index=True)

    # dedupe: link first, then title
    df = df.sort_values("published", ascending=False)
    df = df.drop_duplicates(subset=["link_norm"], keep="first")
    df = df.drop_duplicates(subset=["title_norm"], keep="first")

    ts = path.stem.replace("kernelcut_", "")
    df["fetch_ts"] = pd.to_datetime(ts, format="%Y%m%dT%H%M%SZ", utc=True)

    df["score"] = score(df)
    df = df.sort_values("score", ascending=False).reset_index(drop=True)

    # mantém um top razoável
    return df.head(200)

if __name__ == "__main__":
    print(transform("today").head(12)[["title","domain","score"]])