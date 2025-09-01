# digest.py
from pathlib import Path
from datetime import datetime, timezone
import pandas as pd
import re
from html import unescape
import hashlib
from urllib.parse import urlparse

# Optional (used only when available for fetching summaries)
try:
    import httpx, trafilatura  # pip install httpx trafilatura
except Exception:
    httpx = None
    trafilatura = None

ARTICLE_URL_RE = re.compile(r"(?:Article\s*URL|Original\s*Link)\s*:\s*(https?://\S+)", re.I)

PROC = Path("data/processed")
DOCS = Path("docs"); DOCS.mkdir(parents=True, exist_ok=True)
SEEN_FILE = DOCS / ".seen_links.txt"
SEEN_LIMIT = 300

# --- noise filters (HN artifacts etc.) ---
NOISE_POINTS_COMMENTS = re.compile(
    r"""(?ix)
    (\b\d+\s+points?\b)|
    (\b\d+\s+comments?\b)|
    (\bcomments?\b.*$)|
    (\|\s*\d+\s+points?.*$)|
    (\|\s*\d+\s+comments?.*$)
    """
)

def clean_noise(text: str) -> str:
    if not isinstance(text, str):
        return ""
    t = re.sub(NOISE_POINTS_COMMENTS, " ", text)
    # drop "Article URL: ..." / "Original Link: ..." lines entirely
    t = re.sub(r"(?im)^\s*(article\s*url|original\s*link)\s*:.*$", " ", t)
    # drop HN prefixes
    t = re.sub(r"^(show\s*hn|ask\s*hn|hiring)\s*[:\-]\s*", "", t, flags=re.I)
    # normalize whitespace/punct
    t = re.sub(r"\s+", " ", t).strip(" -|·•\u2022\t\n\r ")
    return t

def load_seen() -> set[str]:
    if not SEEN_FILE.exists():
        return set()
    return set(x.strip() for x in SEEN_FILE.read_text().splitlines() if x.strip())

def save_seen(links: list[str]):
    prev = list(load_seen())
    new = prev + links
    SEEN_FILE.write_text("\n".join(new[-SEEN_LIMIT:]), encoding="utf-8")

def find_parquet() -> Path:
    parts = sorted(PROC.glob("date=*/kernelcut.parquet"))
    if parts:
        return parts[-1]
    single = PROC / "kernelcut.parquet"
    if single.exists():
        return single
    raise SystemExit("No processed data found. Run: python storage.py")

def strip_html(text: str) -> str:
    if not isinstance(text, str):
        return ""
    t = unescape(text)
    t = re.sub(r"(?is)<script.*?>.*?</script>|<style.*?>.*?</style>", " ", t)
    t = re.sub(r"(?is)<img[^>]*>|<iframe[^>]*>.*?</iframe>", " ", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    # remove raw URLs and "Article URL:" lines
    t = re.sub(r"(?im)^\s*(article\s*url|original\s*link)\s*:.*$", " ", t)
    t = re.sub(r"https?://\S+", " ", t)
    return re.sub(r"\s+", " ", t).strip()

def extract_article_url(summary: str) -> str | None:
    if not isinstance(summary, str):
        return None
    m = ARTICLE_URL_RE.search(summary)
    return m.group(1) if m else None

def first_sentences(text: str, max_chars: int = 240, max_sents: int = 2) -> str:
    if not text:
        return ""
    parts = re.split(r"(?<=[\.\!\?])\s+", text)
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        out.append(p)
        if len(" ".join(out)) >= max_chars or len(out) >= max_sents:
            break
    s = " ".join(out).strip()
    return s if len(s) <= max_chars else s[: max_chars - 1].rstrip() + "…"

def short(s: str, limit: int = 220) -> str:
    s = (s or "").strip()
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"

KEYWORDS = {
    "ai": ["ai","artificial intelligence","gpt","llm","openai","deepmind","transformer","agent"],
    "dev": ["developer","sdk","api","framework","library","runtime","debug","compiler","devops","docker","kubernetes"],
    "security": ["vuln","cve","xss","rce","security","breach","malware","ransom"],
    "research": ["paper","arxiv","preprint","dataset","benchmark"],
    "hardware": ["cpu","gpu","chip","silicon","nvidia","amd","intel","raspberry","arduino"],
    "data": ["data","warehouse","lakehouse","etl","elt","spark","parquet","duckdb"],
    "cloud": ["aws","azure","gcp","cloud","serverless"],
    "mobile": ["ios","android","swift","kotlin","mobile"],
    "design": ["design","ux","ui","typography","figma"],
    "business": ["raise","funding","acquire","acquisition","revenue","pricing","profit"],
    "opensource": ["open source","oss","github","gitlab"],
    "social": ["twitter","x.com","facebook","instagram","tiktok","reddit"],
}

EMOJIS = {
    "ai": "🤖", "dev": "💻", "security": "🔐", "research": "📄",
    "hardware": "🖥️", "data": "📊", "cloud": "☁️", "mobile": "📱",
    "design": "🎨", "business": "💼", "opensource": "🧩", "social": "🌐",
    "default": "✨",
}

EMOJI_POOL = [
    "🚀","🧠","🛠️","⚙️","🔧","🔬","🛰️","📰","🧪","🧵","🧱","🪄","🧭","🪐","🧰",
    "🧮","📦","📈","📡","🔗","🪫","🔋","🧬","🧑‍💻"
]

def category_for(text: str) -> str:
    t = text.lower()
    for cat, kws in KEYWORDS.items():
        if any(k in t for k in kws):
            return cat
    if "arxiv" in t: return "research"
    if "github" in t: return "opensource"
    return "default"

def pick_emoji_unique(title: str, domain: str, used: set) -> str:
    cat = category_for(f"{title} {domain}")
    primary = EMOJIS.get(cat, EMOJIS["default"])
    if primary not in used:
        used.add(primary)
        return primary
    for e in EMOJI_POOL:
        if e not in used:
            used.add(e)
            return e
    return primary

def seeded_jitter(text: str, seed: int) -> float:
    h = hashlib.md5(f"{seed}|{text}".encode()).hexdigest()
    return (int(h[:8], 16) % 1_000_000) / 1_000_000.0

# --- curated “TLDR-like” filters ---
TECH_DOMAINS = {
    "techmeme.com","tldr.tech","techcrunch.com","wired.com","theverge.com",
    "zdnet.com","geekwire.com","engadget.com","vox.com","anandtech.com","arstechnica.com",
    "aws.amazon.com","kubernetes.io","github.blog"
}

TECH_KEYWORDS = [
    "ai","machine learning","llm","gpt","devops","cloud","serverless",
    "api","benchmark","startup","infosec","security","datascience","developer","sdk","framework"
]

BAN_KEYWORDS = ["celebrity","fashion","sale","coupon","horoscope","gossip","recipes","travel"]

def get_summary(url: str) -> str:
    if not (httpx and trafilatura):
        return ""
    try:
        with httpx.Client(timeout=10.0, follow_redirects=True) as c:
            r = c.get(url, headers={"User-Agent": "KernelcutBot/1.0"})
            r.raise_for_status()
            txt = trafilatura.extract(r.text, include_comments=False, include_tables=False)
            if txt:
                txt = re.sub(r"\s+", " ", txt).strip()
                return first_sentences(txt, max_chars=260, max_sents=2)
    except Exception:
        pass
    return ""

def build_digest():
    pf = find_parquet()
    df = pd.read_parquet(pf, engine="fastparquet")

    now = datetime.now(timezone.utc)
    today = now.strftime("%b %d, %Y")

    # Avoid repeats across runs (fail-soft if all filtered)
    seen = load_seen()
    if "link" in df.columns and seen:
        filtered = df[~df["link"].isin(seen)].copy()
        if len(filtered):
            df = filtered

    # Normalize/clean titles
    df["title_clean"] = df["title"].astype(str).apply(clean_noise)
    # Drop HN meta posts
    df = df[~df["title_clean"].str.contains(r"(?:\bask\s*hn\b|\bshow\s*hn\b|\bhiring\b)", case=False, na=False)]

    # Derive domain if missing
    if "domain" not in df.columns or df["domain"].isna().any():
        df["domain"] = df.apply(
            lambda r: (r.get("domain") or urlparse(str(r.get("link") or "")).netloc or "unknown"),
            axis=1
        )

    # “TLDR-like” curation
    def is_tech_row(row) -> bool:
        title = (row.get("title_clean") or "").lower()
        summary = (row.get("summary") or "").lower()
        domain = (row.get("domain") or "").lower()

        # strong allow by curated domains (endswith handles subdomains)
        if any(domain.endswith(d) for d in TECH_DOMAINS):
            return True
        # explicit ban words
        if any(b in title or b in summary for b in BAN_KEYWORDS):
            return False
        # tech keywords
        if any(k in title or k in summary for k in TECH_KEYWORDS):
            return True
        return False

    df = df[df.apply(is_tech_row, axis=1)].copy()

    # Jitter for tie-break (hourly)
    seed = int(now.strftime("%Y%m%d%H"))
    df["jitter"] = df["title_clean"].apply(lambda s: seeded_jitter(s, seed))

    # Rank
    sort_cols = [c for c in ["score", "jitter"] if c in df.columns]
    df = df.sort_values(sort_cols, ascending=[False]*len(sort_cols), ignore_index=True)

    # Source diversity + cap
    cap_per_source = 4
    target = 12
    used_per_source, picks = {}, []
    for _, row in df.iterrows():
        src = row.get("source", "Unknown")
        if used_per_source.get(src, 0) >= cap_per_source:
            continue
        picks.append(row)
        used_per_source[src] = used_per_source.get(src, 0) + 1
        if len(picks) >= target:
            break
    # Top-up if needed
    if len(picks) < target:
        for _, r in df.iterrows():
            if r not in picks:
                picks.append(r)
                if len(picks) >= target:
                    break

    if not picks:
        # absolute fallback
        picks = list(df.head(target).itertuples(index=False))

    # Unique emojis (reused MD + HTML)
    used_emojis: set = set()
    chosen = []
    for row in picks:
        title = (row.get("title_clean") if isinstance(row, dict) else getattr(row, "title_clean", None)) or "n/a"
        domain = (row.get("domain") if isinstance(row, dict) else getattr(row, "domain", "unknown")) or "unknown"
        emoji = pick_emoji_unique(title, domain, used_emojis)
        chosen.append(emoji)

    # Persist seen links
    seen_links = []
    for row in picks:
        link = (row.get("link") if isinstance(row, dict) else getattr(row, "link", None))
        if isinstance(link, str):
            seen_links.append(link)
    if seen_links:
        save_seen(seen_links)

    # -------- Markdown --------
    md_lines = [f"# Kernelcut\n**Daily Tech Digest — {today}**\n"]
    for row, emoji in zip(picks, chosen):
        link = (row.get("link") if isinstance(row, dict) else getattr(row, "link", ""))
        title = (row.get("title_clean") if isinstance(row, dict) else getattr(row, "title_clean", "")) or "n/a"
        domain = (row.get("domain") if isinstance(row, dict) else getattr(row, "domain", "unknown")) or "unknown"

        summary_raw = strip_html((row.get("summary") if isinstance(row, dict) else getattr(row, "summary", "")) or "")
        summary = first_sentences(clean_noise(summary_raw), max_chars=240, max_sents=2)
        if not summary:
            summary = get_summary(link)

        md_lines.append(f"- {emoji} [{title}]({link}) — _{domain}_")
        if summary:
            md_lines.append(f"  - {summary}")

    md_lines.append("\n---\n*Kernelcut slices the noise; keeps the signal.*\n")
    (DOCS / "digest.md").write_text("\n".join(md_lines), encoding="utf-8")

    # -------- HTML --------
    cards = []
    for idx, (row, emoji) in enumerate(zip(picks, chosen), start=1):
        link = (row.get("link") if isinstance(row, dict) else getattr(row, "link", ""))
        title = (row.get("title_clean") if isinstance(row, dict) else getattr(row, "title_clean", "")) or "n/a"
        domain = (row.get("domain") if isinstance(row, dict) else getattr(row, "domain", "unknown")) or "unknown"

        summary_raw = strip_html((row.get("summary") if isinstance(row, dict) else getattr(row, "summary", "")) or "")
        summary = first_sentences(clean_noise(summary_raw), max_chars=260, max_sents=2)
        if not summary:
            summary = get_summary(link)

        cards.append(f"""
        <div class="card">
          <a class="title" href="{link}" target="_blank" rel="noopener noreferrer">{emoji} {title}</a>
          <div class="meta">
            <span class="chip">{domain}</span>
            <button class="chip" data-play-idx="{idx}" title="Listen to this article">▶ Listen</button>
          </div>
          <p class="summary">{summary}</p>
        </div>
        """)

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kernelcut — Daily Tech Digest</title>
<style>
  :root {{
    --bg:#fbfbfa; --page:#ffffff; --fg:#202124; --muted:#6b7280;
    --border:#e5e7eb; --chip:#f3f4f6; --link:#111827;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#0f1115; --page:#111319; --fg:#e5e7eb; --muted:#9ca3af;
            --border:#262a33; --chip:#1a1e27; --link:#e5e7eb; }}
  }}
  * {{ box-sizing:border-box }}
  body {{ margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial }}
  .page {{ max-width:840px; margin:48px auto; padding:48px 56px;
           background:var(--page); border:1px solid var(--border); border-radius:16px }}
  h1 {{ margin:0 0 6px; font-size:34px; letter-spacing:-0.01em }}
  .subtitle {{ color:var(--muted); margin:0 0 24px }}
  .player {{ margin:10px 0 22px; padding:8px 12px; border:1px solid var(--border);
             border-radius:10px; background:var(--chip); display:flex; gap:8px; align-items:center; flex-wrap:wrap }}
  .player button {{ padding:6px 10px; border:1px solid var(--border); background:#fff0; border-radius:8px; cursor:pointer }}
  .player .now {{ color:var(--muted); font-size:13px }}
  .card {{ padding:16px 18px; border:1px solid var(--border);
           border-radius:12px; margin:12px 0 }}
  .title {{ color:var(--link); text-decoration:none; font-weight:600; border-bottom:1px solid transparent }}
  .title:hover {{ border-bottom-color:var(--link) }}
  .meta {{ margin-top:6px; display:flex; gap:8px; flex-wrap:wrap; align-items:center }}
  .chip {{ display:inline-block; font-size:12px; padding:4px 8px;
           background:var(--chip); color:var(--muted);
           border:1px solid var(--border); border-radius:999px; cursor:pointer }}
  .summary {{ margin:10px 0 0 }}
  footer {{ color:var(--muted); margin-top:28px; font-size:13px }}
</style>
</head>
<body>
  <main class="page">
    <h1>Kernelcut</h1>
    <p class="subtitle"><strong>Daily Tech Digest</strong> — {today}</p>

    <div class="player" id="kc-player">
      <button id="kc-prev">⏮︎ Prev</button>
      <button id="kc-toggle">▶︎ Play</button>
      <button id="kc-next">⏭︎ Next</button>
      <span class="now" id="kc-now"></span>
      <audio id="kc-audio" preload="metadata"></audio>
    </div>

    {''.join(cards)}

    <footer>Kernelcut slices the noise; keeps the signal.</footer>
  </main>

  <script>
  (function() {{
    const audio = document.getElementById('kc-audio');
    const btn = document.getElementById('kc-toggle');
    const prev = document.getElementById('kc-prev');
    const next = document.getElementById('kc-next');
    const now = document.getElementById('kc-now');
    let list = [], idx = 0;

    function load(i) {{
      if (!list.length) return;
      idx = Math.max(0, Math.min(i, list.length-1));
      const it = list[idx];
      audio.src = it.src;
      now.textContent = '(' + (idx+1) + '/' + list.length + ') ' + it.title;
    }}
    function playIdx(i) {{ load(i); audio.play(); }}

    fetch('playlist.json')
      .then(r => r.ok ? r.json() : [])
      .then(items => {{ list = items || []; if (list.length) load(0); }})
      .catch(() => {{ list = []; }});

    btn.addEventListener('click', () => {{
      if (!audio.src) return;
      if (audio.paused) {{ audio.play(); }} else {{ audio.pause(); }}
    }});
    prev.addEventListener('click', () => playIdx((idx-1+list.length)%list.length));
    next.addEventListener('click', () => playIdx((idx+1)%list.length));
    audio.addEventListener('play',   () => {{ btn.textContent = '⏸︎ Pause'; }});
    audio.addEventListener('pause',  () => {{ btn.textContent = '▶︎ Play'; }});
    audio.addEventListener('ended',  () => next.click());

    document.querySelectorAll('[data-play-idx]').forEach(el => {{
      el.addEventListener('click', () => {{
        const n = parseInt(el.getAttribute('data-play-idx'), 10) - 1;
        playIdx(Math.max(0, n));
      }});
    }});
  }})();
  </script>
</body>
</html>"""
    (DOCS / "index.html").write_text(html, encoding="utf-8")
    print("Digest written → docs/index.html and docs/digest.md")

if __name__ == "__main__":
    build_digest()