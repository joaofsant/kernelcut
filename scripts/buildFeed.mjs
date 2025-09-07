// scripts/buildFeed.mjs
import fs from "fs/promises";
import path from "path";
import Parser from "rss-parser";
import { htmlToText } from "html-to-text";

// ============== knobs ==============
const HOURS_WINDOW = 24;      // strict 24h window
const MAX_PER_CATEGORY = 99;  // no practical per-category cap
const CANDIDATE_LIMIT = 60;   // cap before re-ranking
const TARGET_ITEMS = 12;      // final cutoff
const OUTPUT = path.resolve(process.cwd(), "docs/playlist.json");

// ============== parser =============
const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "KernelcutFeedBot/1.0 (+https://joaofsant.github.io/kernelcut/)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7"
  }
});

// ============== categories ==========
const CATEGORIES = [
  { id: "bigtech",       name: "Tech Titans & Upstarts",              emoji: "🚀" },
  { id: "nextfrontiers", name: "Next Frontiers (Science & Futurism)", emoji: "🔬" },
  { id: "code",          name: "Code & Systems",                      emoji: "💻" },
  { id: "design",        name: "Design & Creativity",                 emoji: "🎨" },
  { id: "ai_data",       name: "AI & Data Realities",                 emoji: "📊" },
  { id: "policy",        name: "Digital Policy & Society",            emoji: "🌍" },
  { id: "fintech",       name: "Fintech & Crypto",                    emoji: "💸" },
  { id: "consumer",      name: "Consumer Tech & Gadgets",             emoji: "📱" },
  { id: "space",         name: "Space & Exploration",                 emoji: "🛰️" }
];

// ============== feeds ===============
const FEEDS = {
  bigtech: [
    "https://techcrunch.com/feed/",
    "https://www.theverge.com/rss/index.xml",
    "https://feeds.arstechnica.com/arstechnica/index"
  ],
  nextfrontiers: [
    "https://www.technologyreview.com/feed/",
    "https://phys.org/rss-feed/technology-news/",
    "https://phys.org/rss-feed/technology-news/robotics/"
  ],
  code: [
    "https://github.blog/feed/",
    "https://stackoverflow.blog/feed/",
    "https://pythoninsider.blogspot.com/feeds/posts/default"
  ],
  design: [
    "https://www.smashingmagazine.com/feed/",
    "https://alistapart.com/main/feed/"
  ],
  ai_data: [
    "http://export.arxiv.org/api/query?search_query=cat:cs.LG+OR+cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=80",
    "https://openai.com/blog/rss.xml",
    "https://deepmind.google/discover/rss.xml"
  ],
  policy: [
    "https://edri.org/rss/",
    "https://www.schneier.com/feed/"
  ],
  fintech: [
    "https://techcrunch.com/tag/fintech/feed/",
    "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml"
  ],
  consumer: [
    "https://www.engadget.com/rss.xml",
    "https://www.theverge.com/rss/index.xml"
  ],
  space: [
    "https://www.nasa.gov/rss/dyn/breaking_news.rss",
    "https://spaceflightnow.com/feed/",
    "https://www.esa.int/rssfeed/Our_Activities/Space_Engineering_Technology"
  ]
};

// ======= relevance rules (curation) =======
const BAD_KEYWORDS = [
  "vacuum", "robot vacuum", "mattress", "toothbrush", "tv screen", "how to clean",
  "coupon", "deal", "discount", "sale", "promo code", "gift guide", "buyers guide",
  "buying guide", "the best", "best ", "hands-on", "review", "roundup"
];

const BOOST_KEYWORDS = [
  "ai", "machine learning", "neural", "llm", "openai", "deepmind",
  "nasa", "space", "spacex", "satellite", "mission", "launch",
  "cloud", "kubernetes", "infrastructure", "gpu", "nvidia", "amd",
  "quantum", "compiler", "database", "postgres", "vector", "embedding",
  "startup", "funding", "acquisition", "merger", "antitrust",
  "privacy", "gdpr", "policy", "regulation", "cybersecurity", "encryption"
];

const SOURCE_WEIGHTS = {
  "arxiv.org": 2.0,
  "nasa.gov": 2.0,
  "esa.int": 1.7,
  "spaceflightnow.com": 1.5,
  "technologyreview.com": 1.5,
  "openai.com": 1.5,
  "deepmind.google": 1.5,
  "github.blog": 1.3,
  "stackoverflow.blog": 1.2,
  "techcrunch.com": 1.0,
  "edri.org": 1.2,
  "schneier.com": 1.2,
  "theverge.com": 0.4,
  "engadget.com": 0.4
};

// ============== helpers ==============
const cutoff = new Date(Date.now() - HOURS_WINDOW * 3600 * 1000);

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    for (const p of ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","sr","fbclid","gclid","mc_cid","mc_eid"]) {
      u.searchParams.delete(p);
    }
    u.hash = "";
    return u.toString();
  } catch { return (raw || "").trim(); }
}

function cleanTitle(t) {
  return (t || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
}

function normTitle(t) {
  return (t || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function textify(html) {
  const txt = html
    ? htmlToText(html, {
        wordwrap: false,
        selectors: [
          { selector: "a", options: { ignoreHref: true } },
          { selector: "img", format: "skip" },
          { selector: "figure", format: "skip" },
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "noscript", format: "skip" },
          { selector: "svg", format: "skip" }
        ]
      }).trim()
    : "";
  return txt.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
}

function pickDate(it) {
  for (const f of [it.isoDate, it.pubDate, it.published, it.updated, it.date]) {
    if (!f) continue;
    const d = new Date(f);
    if (!isNaN(d)) return d;
  }
  return null;
}

function region(host) {
  if (!host) return "Global";
  if (host.endsWith(".co.uk") || host.includes("bbc")) return "UK";
  if (host.endsWith(".ie")) return "Ireland";
  if (host.endsWith(".pt")) return "Portugal";
  if (host.endsWith(".es")) return "Spain";
  if (host.endsWith(".fr")) return "France";
  if (host.endsWith(".de")) return "Germany";
  if (host.endsWith(".eu")) return "EU";
  return "Global";
}

function isLowValue(item) {
  const t = (item.title || "").toLowerCase();
  const d = (item.description || "").toLowerCase();
  return BAD_KEYWORDS.some(k => t.includes(k) || d.includes(k));
}

function relevanceScore(item) {
  const text = (item.title + " " + item.description).toLowerCase();
  let s = 0;
  for (const k of BOOST_KEYWORDS) if (text.includes(k)) s += 1;
  return Math.min(s, 7);
}

function sourceWeight(host) {
  if (!host) return 1.0;
  const h = host.replace(/^www\./, "");
  return SOURCE_WEIGHTS[h] || 1.0;
}

function recencyScore(iso) {
  if (!iso) return 0;
  const hrs = (Date.now() - new Date(iso).getTime()) / 3.6e6;
  return Math.max(0, 1 - Math.min(hrs, 24) / 24); // 1 → 0 across 24h
}

// ---------- summarization helpers ----------
function splitSentences(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map(x => x.trim())
    .filter(Boolean);
}
function uniqSentences(arr) {
  const seen = new Set(); const out = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}
function wordCount(s) { return (s || "").trim().split(/\s+/).filter(Boolean).length; }
function clipWords(s, max) {
  const w = s.trim().split(/\s+/);
  return w.length <= max ? s.trim() : w.slice(0, max).join(" ") + "…";
}

// ---- long summary (~100–160 words; no padding, no repeats)
function longSummary({ title, description, content, source, published_at }) {
  const base = textify(content || description || "");
  const t = textify(title || "").trim();

  // sentence-level cleanup
  let sentences = splitSentences(base).filter(s => {
    const low = s.toLowerCase();
    if (!s) return false;
    if (low.startsWith("image:") || low.startsWith("photo:") || low.startsWith("video:")) return false;
    if (low.includes("subscribe") || low.includes("sign up") || low.includes("read more")) return false;
    return true;
  });
  sentences = uniqSentences(sentences);

  // build a readable paragraph
  let lead = sentences.slice(0, 4).join(" ");
  if (!lead || wordCount(lead) < 40) lead = t; // fallback

  const parts = [lead];

  if (source) parts.push(`Source: ${source}.`);
  if (published_at) {
    try {
      const d = new Date(published_at);
      if (!isNaN(d)) parts.push(`Date: ${d.toISOString().slice(0, 10)}.`);
    } catch {}
  }

  // minimal, single-use scaffolding (optional)
  const scaffold = [
    "Why it matters: outline likely impact on technology, business, or society.",
    "What’s next: note near-term developments or signals to watch."
  ];
  const MAX = 160;
  for (const line of scaffold) {
    const joined = parts.concat(line).join(" ");
    if (wordCount(joined) <= MAX) parts.push(line);
    else break;
  }

  return clipWords(parts.join(" "), MAX);
}

function dedupe(arr) {
  const seenUrl = new Set(), seenTitle = new Set(), out = [];
  for (const it of arr) {
    const u = normalizeUrl(it.link || it.guid || it.url || "");
    const t = normTitle(it.title || "");
    if (u && seenUrl.has(u)) continue;
    if (!u && t && seenTitle.has(t)) continue;
    if (u) seenUrl.add(u);
    if (t) seenTitle.add(t);
    out.push(it);
  }
  return out;
}

async function fetchFeed(url) {
  try {
    const f = await parser.parseURL(url);
    return f.items || [];
  } catch {
    return [];
  }
}

// ============== build ==============
const results = [];
const pool = [];

for (const cat of CATEGORIES) {
  const feeds = FEEDS[cat.id] || [];
  const batches = await Promise.allSettled(feeds.map(u => fetchFeed(u)));
  const items = batches.flatMap(b => (b.status === "fulfilled" ? b.value : []));

  const mapped = items.map(r => {
    const url = normalizeUrl(r.link || r.url || r.guid || "");
    const d = pickDate(r);
    let host = ""; try { host = new URL(url).hostname; } catch {}
    const title = cleanTitle(r.title || "");
    const description = r.contentSnippet || r.summary || r.content || r["content:encoded"] || "";
    const content = r["content:encoded"] || r.content || "";

    return {
      title,
      url,
      description,
      content,
      published_at: d ? d.toISOString() : null,
      source: host || r.creator || r.author || "Unknown",
      author: r.creator || r.author || "",
      category_id: cat.id,
      region: region(host)
    };
  });

  // filters: time window + no HN/Reddit + no "comments/ask/show hn" + drop low-value
  const filtered = mapped.filter(m => {
    if (!m.published_at || new Date(m.published_at) < cutoff) return false;
    try {
      const h = new URL(m.url).hostname;
      if (h.includes("news.ycombinator.com") || h.includes("reddit.com")) return false;
    } catch {}
    const tt = (m.title || "").toLowerCase();
    if (tt.startsWith("comments") || tt.includes("ask hn") || tt.includes("show hn")) return false;
    if (isLowValue(m)) return false;
    return true;
  });

  const unique = dedupe(filtered).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  const top = unique.slice(0, MAX_PER_CATEGORY);
  const rest = unique.slice(MAX_PER_CATEGORY);

  results.push(...top.map(n => ({
    id: `${cat.id}:${normTitle(n.title).slice(0, 60)}:${n.published_at || ""}`,
    title: cleanTitle(n.title),
    url: n.url,
    category_id: n.category_id,
    region: n.region || "Global",
    source: n.source || "Unknown",
    author: n.author || "",
    published_at: n.published_at,
    summary_long: longSummary({
      title: n.title,
      description: n.description,
      content: n.content,
      source: n.source,
      published_at: n.published_at
    }),
    tags: []
  })));

  pool.push(...rest.map(n => ({
    id: `${cat.id}:${normTitle(n.title).slice(0, 60)}:${n.published_at || ""}`,
    title: cleanTitle(n.title),
    url: n.url,
    category_id: n.category_id,
    region: n.region || "Global",
    source: n.source || "Unknown",
    author: n.author || "",
    published_at: n.published_at,
    summary_long: longSummary({
      title: n.title,
      description: n.description,
      content: n.content,
      source: n.source,
      published_at: n.published_at
    }),
    tags: []
  })));
}

// initial recency sort + backfill
let final = dedupe(results).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

if (final.length < CANDIDATE_LIMIT && pool.length) {
  const poolSorted = dedupe(pool).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  const seenUrl = new Set(final.map(i => normalizeUrl(i.url || "")));
  const seenTitle = new Set(final.map(i => normTitle(i.title || "")));
  for (const item of poolSorted) {
    if (final.length >= CANDIDATE_LIMIT) break;
    const u = normalizeUrl(item.url || "");
    const t = normTitle(item.title || "");
    if ((u && seenUrl.has(u)) || (t && seenTitle.has(t))) continue;
    seenUrl.add(u); if (t) seenTitle.add(t);
    final.push(item);
  }
}

// relevance re-ranking (freshness + topic + source weight)
final = final
  .map(i => {
    let host = ""; try { host = new URL(i.url).hostname.replace(/^www\./, ""); } catch {}
    const score =
      0.55 * recencyScore(i.published_at) +        // 0..1
      0.30 * (relevanceScore(i) / 7) +             // 0..1
      0.15 * (sourceWeight(host) / 2.0);           // normalize to ~0..1
    return { ...i, _score: score };
  })
  .sort((a, b) => b._score - a._score)
  .map(({ _score, ...rest }) => rest);

// final cut
final = final.slice(0, TARGET_ITEMS);

// write
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(final, null, 2), "utf8");

console.log(`Wrote ${final.length} items to docs/playlist.json (24h window, final ${TARGET_ITEMS})`);