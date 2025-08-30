# ingest.py
from pathlib import Path
import json, datetime
import feedparser

RAW_DIR = Path("data/raw"); RAW_DIR.mkdir(parents=True, exist_ok=True)

FEEDS = {
    "TechCrunch": "http://feeds.feedburner.com/Techcrunch",
    "The Verge": "https://www.theverge.com/rss/index.xml",
    "Hacker News (frontpage)": "https://hnrss.org/frontpage",
    "The Defiant": "https://thedefiant.io/",
    "New Atlas": "https://newatlas.com/",
    "SiliconANGLE": "https://siliconangle.com/",
    "Product Led SEO": "https://www.productledseo.com/",
    "Teslarati": "https://www.teslarati.com/",
    "Grow Hunhinged": "https://www.growthunhinged.com/"
    # add more later (Wired, Product Hunt RSS, AI newsletters with RSS, etc.)
}

def fetch():
    now = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    out = RAW_DIR / f"kernelcut_{now}.json"
    items = []
    for source, url in FEEDS.items():
        feed = feedparser.parse(url)
        for entry in feed.entries[:10]:
            items.append({
                "source": source,
                "title": entry.get("title"),
                "link": entry.get("link"),
                "summary": entry.get("summary", "")[:500],
                "published": entry.get("published", ""),
            })
    out.write_text(json.dumps(items, ensure_ascii=False))
    print(f"Fetched {len(items)} items -> {out}")

if __name__ == "__main__":
    fetch()