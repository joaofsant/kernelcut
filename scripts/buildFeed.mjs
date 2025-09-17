// scripts/buildFeed.mjs
import fs from "fs/promises";
import path from "path";
import Parser from "rss-parser";
import { htmlToText } from "html-to-text";

// ============== knobs ==============
const HOURS_WINDOW = 24;      // strict 24h window
const MAX_PER_CATEGORY = 99;  // no practical per-category cap (kept for pool logic)
const CANDIDATE_LIMIT = 60;   // cap before re-ranking
const TARGET_ITEMS = 12;      // final cutoff
const OUTPUT = path.resolve(process.cwd(), "docs/playlist.json");

// ============== parser =============
const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "KernelcutFeedBot/1.0 (+https://kernelcut.com/)",
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

// ======= relevance rules (base) =======
// Keep a soft low-value filter for obvious shopping/reviews,
// but don't ban brands; impact scoring below decides the rest.
const BAD_KEYWORDS = [
  "vacuum", "robot vacuum", "mattress", "toothbrush", "tv screen", "how to clean",
  "coupon", "deal", "discount", "sale", "promo code", "gift guide", "buyers guide",
  "buying guide", "the best", "best ", "hands-on", "roundup"
];

// ======= hybrid impact scoring (contextual) =======
// Reputation boosts
const SOURCE_SCORE = new Map(Object.entries({
  "ieee.org": 35, "spectrum.ieee.org": 35, "technologyreview.com": 30, "arstechnica.com": 28,
  "bloomberg.com": 24, "reuters.com": 24, "ft.com": 22, "wsj.com": 20,
  "wired.com": 18, "theverge.com": 12, "techcrunch.com": 12,
  // official eng/research blogs
  "research.google": 30, "openai.com": 30, "deepmind.google": 28, "nvidia.com": 26,
  "microsoft.com": 22, "about.fb.com": 20, "aws.amazon.com": 22, "azure.microsoft.com": 20,
  "databricks.com": 24, "snowflake.com": 22
}));

// Technical positives
const TECH_POSITIVE = [
  /ai|llm|model|dataset|benchmark|agent|inference/i,
  /chip|gpu|semiconductor|foundry|nvidia|tpu|asic|cpu|interconnect/i,
  /cloud|aws|gcp|azure|kafka|spark|databricks|snowflake|postgres|duckdb|sdk|api|vector db/i,
  /security|privacy|encryption|breach|ransom|zero[- ]?day|cve|passkey|webauthn/i,
  /robot|automation|autonomy|space|spacex|nasa|iss|fusion|quantum|materials/i,
  /infra|scalability|latency|throughput|benchmark/i,
  /startup|seed|series [abc]|ipo|acqui[- ]?hire/i
];

// Pop-culture noise (penalty, not hard block)
const POP_CULTURE_NEGATIVE = [
  /trailer|season|episode|casting|celebrity|box office|fans?/i,
  /rumou?r|leak|teaser/i,
  /recap|review(?!\s*paper)/i
];

// High-impact terms
const IMPACT_TERMS = [
  /acquisition|acquires|merger|ipo|funding|raises|series [abc]/i,
  /breach|hack|ransom|shutdown|layoffs?/i,
  /launch|release|general availability|ga\b|open[- ]?source/i,
  /partnership|regulation|ban|compliance|gdpr|antitrust|doj|eu commission/i
];

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

function hostname(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return ""; }
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

// ===== Hacker News signals (optional) =====
const ENABLE_HN = true;

async function fetchHNSignals(limit = 100) {
  if (!ENABLE_HN) return { urlPoints: new Map(), hotHosts: new Map() };
  try {
    const topIds = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")
      .then(r => r.json()).then(ids => ids.slice(0, limit));
    const items = await Promise.all(topIds.map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()).catch(()=>null)
    ));
    const urlPoints = new Map();
    const hotHosts = new Map();
    for (const it of items.filter(Boolean)) {
      if (!it.url || typeof it.score !== "number") continue;
      const clean = normalizeUrl(it.url);
      const host = hostname(clean);
      urlPoints.set(clean, (urlPoints.get(clean) || 0) + it.score);
      hotHosts.set(host, (hotHosts.get(host) || 0) + it.score);
    }
    return { urlPoints, hotHosts };
  } catch (e) {
    console.warn("[curation] HN fetch failed:", e.message);
    return { urlPoints: new Map(), hotHosts: new Map() };
  }
}

// ===== Category guesser (maps to your site cats) =====
function guessCategoryFromText(a) {
  const text = `${a.title || ""} ${a.summary_long || a.summary || ""}`.toLowerCase();
  if (/ai|llm|model|dataset|benchmark|agent/.test(text)) return "ai_data";
  if (/gpu|chip|semiconductor|nvidia|tpu|foundry|asic|cpu/.test(text)) return "bigtech";
  if (/cloud|aws|gcp|azure|kafka|spark|postgres|duckdb|sdk|api|kubernetes|docker/.test(text)) return "code";
  if (/quantum|robot|space|fusion|bio|materials|spacex|nasa|iss/.test(text)) return "nextfrontiers";
  if (/design|ux|ui|accessibility|typography/.test(text)) return "design";
  if (/breach|ransom|privacy|gdpr|security|zero[- ]?day|cve/.test(text)) return "policy"; // or "security" if you split
  if (/wallet|stablecoin|defi|fintech|crypto|bitcoin|ethereum/.test(text)) return "fintech";
  if (/iphone|android|gadget|wearable|headset|tv|console/.test(text)) return "consumer";
  if (/policy|regulation|antitrust|ai act|doj|ec/.test(text)) return "policy";
  if (/satellite|orbital|lunar|mars/.test(text)) return "space";
  return "bigtech";
}

// ===== Impact scoring =====
function scoreImpact(item, hnSignals) {
  const title = item.title || "";
  const sum = item.summary_long || item.summary || "";
  const text = `${title} ${sum}`.toLowerCase();
  const host = hostname(item.url || "");
  let s = 0;

  // Source reputation (by host)
  if (SOURCE_SCORE.has(host)) s += SOURCE_SCORE.get(host);

  // Technical content
  if (TECH_POSITIVE.some(rx => rx.test(text))) {
    s += 20;
  }

  // Pop-culture penalty
  if (POP_CULTURE_NEGATIVE.some(rx => rx.test(text))) s -= 50;

  // Impact terms (M&A, funding, breaches, GA, regulation, launches)
  if (IMPACT_TERMS.some(rx => rx.test(text))) s += 30;

  // Concrete numbers (money/users)
  if (/\$[0-9]+(\.[0-9]+)?\s?(m|b)\b/i.test(text) || /\b[0-9]+ (million|billion|users)\b/i.test(text)) s += 10;

  // Title quality
  if (title.length <= 90) s += 4;

  // Recency (normalize 0..10)
  s += Math.round(recencyScore(item.published_at) * 10);

  // Hacker News boosts
  if (hnSignals) {
    const pts = hnSignals.urlPoints.get(normalizeUrl(item.url || ""));
    if (typeof pts === "number") {
      s += Math.min(30, Math.round(Math.log2(1 + pts) * 6)); // direct URL match
    } else {
      const hostPts = hnSignals.hotHosts.get(host) || 0;
      if (hostPts > 50) s += 4; // warm host
    }
  }
  return s;
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

  // base filters: time window + no HN/Reddit + drop low-value
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

// initial recency sort + backfill to candidate limit
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

// ===== IMPACT RE-RANK + DIVERSITY =====
const hnSignals = await fetchHNSignals(100);

// score each item
let scored = final.map(i => ({ ...i, _score: scoreImpact(i, hnSignals) }))
  .filter(i => i._score > 0)
  // tie-break by recency
  .sort((a,b) => (b._score - a._score) || (new Date(b.published_at) - new Date(a.published_at)));

// ensure category diversity: max 3 per category, cap total to TARGET_ITEMS
function pickTopByCategory(arr, perCat = 3, maxTotal = TARGET_ITEMS) {
  const out = [];
  const used = new Map();
  for (const it of arr) {
    const key = it.category_id || "misc";
    const n = used.get(key) || 0;
    if (n < perCat) {
      out.push(it);
      used.set(key, n + 1);
    }
    if (out.length >= maxTotal) break;
  }
  return out;
}

final = pickTopByCategory(scored, 3, TARGET_ITEMS).map(({ _score, ...rest }) => rest);

// write
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(final, null, 2), "utf8");

console.log(`Wrote ${final.length} items to docs/playlist.json (impact-ranked, diversified, ${TARGET_ITEMS} max)`);