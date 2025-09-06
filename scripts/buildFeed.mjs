// scripts/buildFeed.mjs
import fs from "fs/promises";
import path from "path";
import Parser from "rss-parser";
import { htmlToText } from "html-to-text";

// ================== knobs ==================
const HOURS_WINDOW = 24;      // strict 24h window
const MAX_PER_CATEGORY = 99;  // no practical cap per category
const CANDIDATE_LIMIT = 60;   // maximum candidates before final cut
const TARGET_ITEMS = 12;      // final cutoff: 12 items
const OUTPUT = path.resolve(process.cwd(), "docs/playlist.json");

// ================== parser =================
const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "KernelcutFeedBot/1.0 (+https://joaofsant.github.io/kernelcut/)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7"
  }
});

// ================== categories =============
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

// ================== feeds ==================
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

// ================== helpers =================
const cutoff = new Date(Date.now() - HOURS_WINDOW * 3600 * 1000);

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    for (const p of [
      "utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
      "sr","fbclid","gclid","mc_cid","mc_eid"
    ]) u.searchParams.delete(p);
    u.hash = "";
    return u.toString();
  } catch { return (raw || "").trim(); }
}

function normTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textify(html) {
  return html
    ? htmlToText(html, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }] }).trim()
    : "";
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

// ---- long summary (~120–160 words; 4–7 sentences) ----
function longSummary({ title, description, content, source, published_at }) {
  const raw = textify(content || description || "");
  const clean = raw.replace(/\s+/g, " ").trim();
  const t = textify(title || "").trim();

  const TARGET_MIN = 120, TARGET_MAX = 160;
  const words = s => s.split(/\s+/).filter(Boolean);
  const trimTo = (s, n) => words(s).slice(0, n).join(" ");

  if (words(clean).length >= TARGET_MAX) {
    return trimTo(clean, TARGET_MAX) + "…";
  }

  const when = (() => {
    try {
      if (!published_at) return "";
      const d = new Date(published_at);
      return isNaN(d) ? "" : d.toISOString().slice(0, 10);
    } catch { return ""; }
  })();

  const where = source ? ` Source: ${source}.` : "";

  const scaffold =
`${clean || t}.
Why it matters: highlight the impact on technology, business, or society.${where}
Who is affected: identify the main stakeholders or users and how they may change their work or strategy.
What’s next: note near-term developments, expected responses, or signals to watch.${when ? ` Date: ${when}.` : ""}`;

  let out = (clean ? `${clean} ` : "") + scaffold;
  const pad = " Additional notes: independent validation, benchmarks, and follow-up announcements will clarify the real effect.";

  while (words(out).length < TARGET_MIN) out += pad;

  const clipped = trimTo(out, TARGET_MAX);
  return clipped + (words(out).length > TARGET_MAX ? "…" : "");
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

// ================== build ===================
const results = [];
const pool = []; // overflow items for controlled backfill

for (const cat of CATEGORIES) {
  const feeds = FEEDS[cat.id] || [];
  const batches = await Promise.allSettled(feeds.map(u => fetchFeed(u)));
  const items = batches.flatMap(b => (b.status === "fulfilled" ? b.value : []));

  const mapped = items.map(r => {
    const url = normalizeUrl(r.link || r.url || r.guid || "");
    const d = pickDate(r);
    let host = "";
    try { host = new URL(url).hostname; } catch {}
    return {
      title: r.title || "",
      url,
      description: r.contentSnippet || r.summary || r.content || r["content:encoded"] || "",
      content: r["content:encoded"] || r.content || "",
      published_at: d ? d.toISOString() : null,
      source: host || r.creator || r.author || "Unknown",
      author: r.creator || r.author || "",
      category_id: cat.id,
      region: region(host)
    };
  });

  // filters: 24h, no HN/Reddit, no "comments/ask/show hn"
  const filtered = mapped.filter(m => {
    if (!m.published_at || new Date(m.published_at) < cutoff) return false;
    try {
      const h = new URL(m.url).hostname;
      if (h.includes("news.ycombinator.com") || h.includes("reddit.com")) return false;
    } catch {}
    const tt = (m.title || "").toLowerCase();
    if (tt.startsWith("comments") || tt.includes("ask hn") || tt.includes("show hn")) return false;
    return true;
  });

  const unique = dedupe(filtered)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const top = unique.slice(0, MAX_PER_CATEGORY);
  const rest = unique.slice(MAX_PER_CATEGORY);

  results.push(
    ...top.map(n => ({
      id: `${cat.id}:${normTitle(n.title).slice(0, 60)}:${n.published_at || ""}`,
      title: n.title,
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
    }))
  );

  pool.push(
    ...rest.map(n => ({
      id: `${cat.id}:${normTitle(n.title).slice(0, 60)}:${n.published_at || ""}`,
      title: n.title,
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
    }))
  );
}

// dedupe + sort by recency
let final = dedupe(results).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

// backfill up to CANDIDATE_LIMIT from pool (most recent first)
if (final.length < CANDIDATE_LIMIT && pool.length) {
  const poolSorted = dedupe(pool).sort(
    (a, b) => new Date(b.published_at) - new Date(a.published_at)
  );

  const seenUrl = new Set(final.map(i => normalizeUrl(i.url || "")));
  const seenTitle = new Set(final.map(i => normTitle(i.title || "")));

  for (const item of poolSorted) {
    if (final.length >= CANDIDATE_LIMIT) break;
    const u = normalizeUrl(item.url || "");
    const t = normTitle(item.title || "");
    if ((u && seenUrl.has(u)) || (t && seenTitle.has(t))) continue;
    seenUrl.add(u);
    if (t) seenTitle.add(t);
    final.push(item);
  }
}

// FINAL CUT: exactly 12 items
final = final.slice(0, TARGET_ITEMS);

// ensure docs/ exists and write
await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(final, null, 2), "utf8");

console.log(
  `Wrote ${final.length} items to docs/playlist.json (<= ${MAX_PER_CATEGORY}/cat, candidates <= ${CANDIDATE_LIMIT}, ${HOURS_WINDOW}h window, final ${TARGET_ITEMS})`
);