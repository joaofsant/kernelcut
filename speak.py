# speak.py
from __future__ import annotations
from pathlib import Path
import argparse, re, json, os, platform, shutil, tempfile, subprocess
from typing import Optional
from urllib.parse import urlparse

# Optional deps
try:
    from gtts import gTTS  # pip install gTTS
except Exception:
    gTTS = None

try:
    import httpx, trafilatura
except Exception:
    httpx = None
    trafilatura = None

DOCS = Path("docs"); DOCS.mkdir(parents=True, exist_ok=True)
AUDIO_DIR = DOCS / "audio"; AUDIO_DIR.mkdir(parents=True, exist_ok=True)
DIGEST_MD = DOCS / "digest.md"
INDEX_HTML = DOCS / "index.html"
PLAYLIST = DOCS / "playlist.json"

# ---------------- utils ----------------

def safe_slug(s: str) -> str:
    s = re.sub(r"[^\w\-]+", "-", (s or "").lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)

def _strip_html(t: str) -> str:
    return re.sub(r"<[^>]+>", "", t or "")

def clean_for_tts(text: str) -> str:
    """Light normalization for clearer speech."""
    t = text or ""
    t = re.sub(r"https?://\S+", " ", t)     # drop raw URLs
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"\bLLM\b", "large language model", t)
    t = re.sub(r"\bAI\b", "A.I.", t)
    return t

def build_tts_text(title: str, body: str, max_chars: int = 1800) -> str:
    joined = f"{title}. {body}".strip()
    joined = clean_for_tts(joined)
    return joined if len(joined) <= max_chars else joined[: max_chars - 1].rstrip() + "…"

# ------------- parsers (MD + HTML fallback) -------------

def parse_html_fallback(html_text: str, max_items: int = 12):
    """
    Parse cards from docs/index.html:
      <div class="card">
        <a class="title" href="LINK">…TITLE…</a>
        <div class="meta"><span class="chip">DOMAIN</span> …</div>
        <p class="summary">SUMMARY</p>
      </div>
    """
    items = []
    # tolerate single/double quotes and additional classes
    a_pat = re.compile(
        r'<a[^>]*class=(?:"|\')[^"\']*\btitle\b[^"\']*(?:"|\')[^>]*href=(?:"|\')([^"\']+)(?:"|\')[^>]*>(.*?)</a>',
        re.I | re.S
    )
    s_pat = re.compile(r'<p[^>]*class=(?:"|\')[^"\']*\bsummary\b[^"\']*(?:"|\')[^>]*>(.*?)</p>', re.I | re.S)
    d_pat = re.compile(r'<span[^>]*class=(?:"|\')[^"\']*\bchip\b[^"\']*(?:"|\')[^>]*>(.*?)</span>', re.I | re.S)

    cards = re.split(r'<div\s+class=(?:"|\')[^"\']*\bcard\b[^"\']*(?:"|\')\s*>', html_text, flags=re.I)
    for card in cards[1:]:
        ma = a_pat.search(card)
        if not ma:
            continue
        link = re.sub(r"\s+", " ", ma.group(1)).strip()
        title = re.sub(r"\s+", " ", _strip_html(ma.group(2))).strip()

        md = d_pat.search(card)
        domain = re.sub(r"\s+", " ", _strip_html(md.group(1))).strip() if md else ""
        if not domain:
            try:
                domain = urlparse(link).netloc or "unknown"
            except Exception:
                domain = "unknown"

        ms = s_pat.search(card)
        summary = re.sub(r"\s+", " ", _strip_html(ms.group(1))).strip() if ms else ""

        items.append({"title": title, "link": link, "domain": domain, "summary": summary})
        if len(items) >= max_items:
            break
    return items

def parse_digest(md_text: str, max_items: int = 12):
    """
    Parse docs/digest.md (primary) with a tolerant pattern, then
    fallback to docs/index.html if nothing is found.
    Expected MD structure (one item):
      - 😀 [Title](https://link) — _domain_
        - summary text...
    """
    items = []
    lines = md_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    # tolerant link: handles URLs with ')'
    link_pat = re.compile(r"\[([^\]]+)\]\((.+?)\)")

    # domain may appear as _dom_, *dom*, or after a dash/em-dash: — dom
    dom_mark_pat = re.compile(r"(?:[_*]([^_*]+)[_*])")
    dom_plain_pat = re.compile(r"[—–-]\s*([A-Za-z0-9.\-]+)(?:\s|$)")

    i = 0
    while i < len(lines) and len(items) < max_items:
        line = lines[i]
        # look for list bullet; otherwise still allow any line containing a [title](link)
        if not ("[" in line and "](" in line):
            i += 1
            continue

        # find the first markdown link in the line
        m = link_pat.search(line)
        if not m:
            i += 1
            continue

        title = m.group(1).strip()
        raw_link = m.group(2).strip()

        # If URL likely truncated by a close-paren inside it, try extending to the last ')'
        tail = line[m.start():]
        last_paren = tail.rfind(")")
        link = raw_link
        if last_paren != -1:
            candidate = tail[tail.find("(")+1:last_paren].strip()
            if candidate.startswith("http"):
                link = candidate

        # domain in the rest of the line
        tail_after = line[m.end():]
        dom = ""
        m1 = dom_mark_pat.search(tail_after)
        if m1:
            dom = m1.group(1).strip()
        else:
            m2 = dom_plain_pat.search(tail_after)
            if m2:
                dom = m2.group(1).strip()
        if not dom:
            try:
                dom = urlparse(link).netloc or "unknown"
            except Exception:
                dom = "unknown"

        # summary is usually on the next line starting with "- " (indented)
        summary = ""
        if i + 1 < len(lines):
            nxt = lines[i+1].rstrip()
            if re.match(r"^\s*-\s+.+", nxt):
                summary = re.sub(r"^\s*-\s+", "", nxt).strip()
        if len(summary) > 260:
            summary = summary[:259].rstrip() + "…"

        items.append({"title": title, "link": link, "domain": dom, "summary": summary})
        i += 1

    if items:
        return items

    # Fallback: parse index.html cards
    if INDEX_HTML.exists():
        return parse_html_fallback(INDEX_HTML.read_text(encoding="utf-8"), max_items=max_items)
    return []

# ------------- fulltext (optional) -------------

def fetch_fulltext(url: str, timeout=15) -> Optional[str]:
    """Best-effort full article extraction."""
    if not httpx or not trafilatura:
        return None
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as c:
            r = c.get(url, headers={"User-Agent": "KernelcutBot/1.0"})
            r.raise_for_status()
            txt = trafilatura.extract(r.text, include_comments=False, include_tables=False)
            if txt:
                txt = re.sub(r"\s+", " ", txt).strip()
                if len(txt) > 200:
                    return txt
    except Exception:
        pass
    return None

# ---------------- synthesis backends ----------------

def synth_mac(text: str, out_base: Path, voice: Optional[str] = None) -> Path:
    """
    macOS:
      1) say -f <tmp.txt> -o <out.aiff>
      2) afconvert <out.aiff> -> <out.m4a> (AAC 192 kbps)
    """
    aiff_path = out_base.with_suffix(".aiff")
    m4a_path  = out_base.with_suffix(".m4a")
    voice_args = ["-v", voice] if voice else []

    # write to a temp file to avoid quoting issues
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8") as tf:
        tf.write(text)
        txt_path = tf.name

    try:
        # 1) say
        cmd1 = ["say", *voice_args, "-f", txt_path, "-o", str(aiff_path)]
        subprocess.run(cmd1, check=True)

        if not aiff_path.exists() or aiff_path.stat().st_size == 0:
            raise RuntimeError("AIFF not created by 'say'")

        # 2) afconvert
        cmd2 = ["afconvert", "-f", "m4af", "-d", "aac", "-b", "192000", str(aiff_path), str(m4a_path)]
        subprocess.run(cmd2, check=True)

        if not m4a_path.exists() or m4a_path.stat().st_size == 0:
            raise RuntimeError("M4A not created by 'afconvert'")
    finally:
        try: os.unlink(txt_path)
        except Exception: pass
        try: aiff_path.unlink(missing_ok=True)
        except Exception: pass

    return m4a_path

def synth_gtts(text: str, out_base: Path, lang: str = "en") -> Path:
    if not gTTS:
        raise RuntimeError("gTTS not installed. pip install gTTS")
    mp3_path = out_base.with_suffix(".mp3")
    gTTS(text=clean_for_tts(text), lang=("en" if lang == "en" else "pt")).save(str(mp3_path))
    return mp3_path

# ---------------- main ----------------

def main(lang: str = "en", voice: Optional[str] = None, mode: str = "summary", backend: Optional[str] = None):
    if not DIGEST_MD.exists():
        raise SystemExit("docs/digest.md not found. Run: python digest.py first.")

    md = DIGEST_MD.read_text(encoding="utf-8")
    items = parse_digest(md)
    if not items:
        raise SystemExit("No items found in digest.md")

    # pick backend
    if backend is None:
        use_mac = (platform.system() == "Darwin") and shutil.which("say") and shutil.which("afconvert")
        chosen = "mac" if use_mac else "gtts"
    else:
        chosen = backend.lower()

    if chosen == "mac" and not (shutil.which("say") and shutil.which("afconvert")):
        chosen = "gtts"
    if chosen == "gtts" and not gTTS:
        raise SystemExit("No TTS available. Install gTTS: pip install gTTS")

    playlist = []
    for idx, it in enumerate(items, 1):
        title, link, domain = it["title"], it["link"], it["domain"]
        summary = it.get("summary", "")

        if mode == "full":
            full = fetch_fulltext(link) or ""
            body = full or summary or title
        else:
            body = summary or title

        text = build_tts_text(title, body, max_chars=1800)
        base = AUDIO_DIR / f"story_{idx:02d}_{safe_slug(title)[:50]}"

        if chosen == "mac":
            try:
                audio_path = synth_mac(text, base, voice=voice)   # -> .m4a
            except Exception as e:
                print(f"[warn] macOS TTS failed, falling back to gTTS: {e}")
                if not gTTS:
                    raise
                audio_path = synth_gtts(text, base, lang=lang)    # -> .mp3
        else:
            audio_path = synth_gtts(text, base, lang=lang)        # -> .mp3

        playlist.append({
            "n": idx,
            "title": title,
            "src": f"audio/{audio_path.name}",
            "link": link,
            "domain": domain
        })
        print(f"[{idx:02d}] saved {audio_path}")

    PLAYLIST.write_text(json.dumps(playlist, ensure_ascii=False, indent=2), encoding="utf-8")

    # If your HTML doesn't already include an inline player, you can use an external player.js.
    if INDEX_HTML.exists():
        html = INDEX_HTML.read_text(encoding="utf-8")
        if "player.js" not in html:
            html = html.replace("</body>", '<script src="player.js"></script>\n</body>')
            INDEX_HTML.write_text(html, encoding="utf-8")
    print("Playlist ready → docs/playlist.json")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en", choices=["en","pt"])
    ap.add_argument("--voice", default=None, help="macOS 'say' voice (e.g., 'Samantha', 'Joana')")
    ap.add_argument("--mode", default="summary", choices=["summary","full"], help="read summaries or full articles (best-effort)")
    ap.add_argument("--backend", default=None, choices=["mac","gtts"], help="force TTS backend (default: auto)")
    args = ap.parse_args()
    main(lang=args.lang, voice=args.voice, mode=args.mode, backend=args.backend)