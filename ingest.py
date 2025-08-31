# ingest.py
from __future__ import annotations
from pathlib import Path
from datetime import datetime, timezone
import asyncio, json, hashlib, time, re
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode
import httpx, feedparser

RAW = Path("data/raw"); RAW.mkdir(parents=True, exist_ok=True)
FEEDS_FILE = Path("feeds.txt")

USER_AGENT = "KernelcutBot/1.0 (+https://github.com/joaofsant/kernelcut)"
TIMEOUT_S = 12.0
MAX_CONN = 20
RETRIES = 2  # total attempts = 1 + RETRIES

# remove tracking params so dedupe funciona melhor
TRACKING_KEYS = {"utm_source","utm_medium","utm_campaign","utm_term","utm_content","ref","fbclid","gclid","mc_cid","mc_eid"}

def now_utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

def safe_str(x) -> str:
    return "" if x is None else str(x)

def canonical_url(url: str) -> str:
    try:
        u = urlparse(url)
        qs = [(k,v) for k,v in parse_qsl(u.query, keep_blank_values=True) if k.lower() not in TRACKING_KEYS]
        return urlunparse((u.scheme, u.netloc, u.path, u.params, urlencode(qs, doseq=True), ""))  # drop fragment
    except Exception:
        return url

def norm_item(src: str, entry: dict) -> dict:
    # published UTC ISO
    published = None
    for k in ("published_parsed", "updated_parsed"):
        t = entry.get(k)
        if t:
            published = datetime(*t[:6], tzinfo=timezone.utc).isoformat()
            break
    if not published:
        # try plain string date
        s = entry.get("published") or entry.get("updated")
        if s:
            # feedparser already tz-normalizes most dates via parsed keys; fallback: keep string as is
            try:
                # very loose fallback: current time if unparsable (keeps item in pipeline)
                published = datetime.now(timezone.utc).isoformat()
            except Exception:
                published = None

    summary = entry.get("summary") or ""
    if not summary and entry.get("content"):
        summary = entry["content"][0].get("value", "")

    link = canonical_url(safe_str(entry.get("link")).strip())

    return {
        "source": src,
        "title": safe_str(entry.get("title")).strip(),
        "link": link,
        "summary": safe_str(summary).strip(),
        "published": published,  # ISO or None; transform() will coerce to UTC
    }

async def fetch_once(client: httpx.AsyncClient, url: str) -> list[dict]:
    r = await client.get(url, timeout=TIMEOUT_S, follow_redirects=True)
    r.raise_for_status()
    fp = feedparser.parse(r.content)
    src = fp.feed.get("title") or url
    return [norm_item(src, e) for e in fp.entries]

async def fetch_feed(client: httpx.AsyncClient, url: str) -> list[dict]:
    # simple retries with backoff
    for attempt in range(RETRIES + 1):
        try:
            return await fetch_once(client, url)
        except Exception:
            if attempt >= RETRIES:
                return []
            await asyncio.sleep(0.8 * (2 ** attempt))

async def run() -> list[dict]:
    if not FEEDS_FILE.exists():
        raise SystemExit("feeds.txt missing. Create it with one RSS/Atom URL per line.")
    urls = [u.strip() for u in FEEDS_FILE.read_text().splitlines() if u.strip() and not u.strip().startswith("#")]
    if not urls:
        raise SystemExit("feeds.txt is empty.")

    limits = httpx.Limits(max_connections=MAX_CONN, max_keepalive_connections=MAX_CONN//2)
    async with httpx.AsyncClient(limits=limits, headers={"User-Agent": USER_AGENT}) as client:
        results = await asyncio.gather(*[fetch_feed(client, u) for u in urls])

    rows = [it for sub in results for it in sub]

    # dedupe by canonical link (sha1)
    seen, uniq = set(), []
    for it in rows:
        h = hashlib.sha1((it.get("link") or "").encode()).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        uniq.append(it)
    return uniq

if __name__ == "__main__":
    rows = asyncio.run(run())
    ts = now_utc_iso()
    out = RAW / f"kernelcut_{ts}.json"
    out.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {len(rows)} items -> {out}")