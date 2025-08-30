# digest.py
from pathlib import Path
from datetime import datetime
import pandas as pd
import re
from html import unescape

PROC = Path("data/processed")
DOCS = Path("docs"); DOCS.mkdir(parents=True, exist_ok=True)

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
    t = re.sub(r"(?i)(article url|comments url)\s*:\s*\S+", " ", t)
    t = re.sub(r"https?://\S+", " ", t)
    return re.sub(r"\s+", " ", t).strip()

def short(s: str, limit: int = 220) -> str:
    s = (s or "").strip()
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"

# categorias -> palavras-chave
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

# emoji preferido por categoria
EMOJIS = {
    "ai": "🤖", "dev": "💻", "security": "🔐", "research": "📄",
    "hardware": "🖥️", "data": "📊", "cloud": "☁️", "mobile": "📱",
    "design": "🎨", "business": "💼", "opensource": "🧩", "social": "🌐",
    "default": "✨",
}

# pool de backup (para não repetir no mesmo dia)
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

def build_digest():
    pf = find_parquet()
    df = pd.read_parquet(pf, engine="fastparquet")
    today = datetime.utcnow().strftime("%b %d, %Y")

    df = df.sort_values("score", ascending=False, ignore_index=True)
    cap_per_source = 4
    used_per_source, picks = {}, []
    for _, row in df.iterrows():
        src = row.get("source","Unknown")
        if used_per_source.get(src, 0) >= cap_per_source:
            continue
        picks.append(row)
        used_per_source[src] = used_per_source.get(src, 0) + 1
        if len(picks) >= 12:
            break

    used_emojis: set = set()

    # Markdown
    md_lines = [f"# Kernelcut\n**Daily Tech Digest — {today}**\n"]
    for row in picks:
        link = row["link"]; title = row["title"] or "n/a"
        domain = row.get("domain","unknown")
        summary = short(strip_html(row.get("summary","")), 240)
        emoji = pick_emoji_unique(title, domain, used_emojis)
        md_lines.append(f"- {emoji} [{title}]({link}) — _{domain}_")
        if summary:
            md_lines.append(f"  - {summary}")
    md_lines.append("\n---\n*Kernelcut slices the noise; keeps the signal.*\n")
    (DOCS / "digest.md").write_text("\n".join(md_lines), encoding="utf-8")

    # HTML
    cards = []
    for row in picks:
        link = row["link"]; title = row["title"] or "n/a"
        domain = row.get("domain","unknown")
        summary = short(strip_html(row.get("summary","")), 260)
        emoji = pick_emoji_unique(title, domain, used_emojis)  # mesmo conjunto para evitar repetir
        cards.append(f"""
        <div class="card">
          <a class="title" href="{link}" target="_blank" rel="noopener noreferrer">{emoji} {title}</a>
          <div class="meta"><span class="chip">{domain}</span></div>
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
    --bg: #fbfbfa; --page: #ffffff; --fg: #202124; --muted: #6b7280;
    --border: #e5e7eb; --chip: #f3f4f6; --link: #111827;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg: #0f1115; --page: #111319; --fg: #e5e7eb; --muted: #9ca3af;
            --border: #262a33; --chip: #1a1e27; --link: #e5e7eb; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--fg);
         font: 16px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Arial; }}
  .page {{ max-width: 840px; margin: 48px auto; padding: 48px 56px;
           background: var(--page); border: 1px solid var(--border); border-radius: 16px; }}
  h1 {{ margin: 0 0 6px; font-size: 34px; letter-spacing: -0.01em; }}
  .subtitle {{ color: var(--muted); margin: 0 0 24px; }}
  .card {{ padding: 16px 18px; border: 1px solid var(--border);
           border-radius: 12px; margin: 12px 0; }}
  .title {{ color: var(--link); text-decoration: none; font-weight: 600;
           border-bottom: 1px solid transparent; }}
  .title:hover {{ border-bottom-color: var(--link); }}
  .meta {{ margin-top: 6px; }}
  .chip {{ display: inline-block; font-size: 12px; padding: 4px 8px;
           background: var(--chip); color: var(--muted);
           border: 1px solid var(--border); border-radius: 999px; }}
  .summary {{ margin: 10px 0 0; }}
  footer {{ color: var(--muted); margin-top: 28px; font-size: 13px; }}
</style>
</head>
<body>
  <main class="page">
    <h1>Kernelcut</h1>
    <p class="subtitle"><strong>Daily Tech Digest</strong> — {today}</p>
    {''.join(cards)}
    <footer>Kernelcut slices the noise; keeps the signal.</footer>
  </main>
</body>
</html>"""
    (DOCS / "index.html").write_text(html, encoding="utf-8")
    print("Digest written → docs/index.html and docs/digest.md")

if __name__ == "__main__":
    build_digest()