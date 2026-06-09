// api/generate.js — Vercel serverless function
//
// Real llms.txt generation. A browser can't fetch a third-party sitemap/HTML
// (CORS), so the crawl runs here, server-side:
//   1. resolve sitemap (sitemap.xml -> sitemap_index.xml -> robots.txt Sitemap:)
//   2. parse <loc> URLs, group by first path segment into H2 sections, rank + cap
//   3. fetch homepage + a few top pages for real <title> / <meta description>
//   4. ask Claude (cheapest model: Haiku) to write a clean, spec-compliant
//      llms.txt from the crawled data; fall back to a deterministic builder
//      if Claude is unavailable or returns something malformed.
//
// On any failure (no sitemap, fetch error, timeout) it returns
// { simulated: true } and the frontend falls back to the in-browser generator.
//
// Cost controls (this is a free tool — keep it very cheap):
//   - cheapest model only (claude-haiku-4-5)
//   - tight max_tokens, capped/curated input (limited URL list + short notes)
//   - in-memory rate limit (per warm instance) as a basic abuse guard

import Anthropic from "@anthropic-ai/sdk";

// cheapest available Claude model — explicitly chosen for a free tool
const CLAUDE_MODEL = "claude-haiku-4-5";
const CLAUDE_MAX_TOKENS = 1500;    // hard ceiling on output → caps per-call cost

const UA = "MakeLLM/1.0 (+https://makellm.com; llms.txt generator)";
const FETCH_TIMEOUT = 6000;        // per-request timeout
const MAX_PAGE_FETCHES = 6;        // how many real pages to fetch for titles/meta
const MAX_LINKS_PER_SECTION = 8;
const MAX_SECTIONS = 8;
const MAX_TOTAL_LINKS = 50;

// ---- tiny fetch helper with timeout --------------------------------------
async function fetchText(url, { accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: accept || "*/*",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- domain parsing (mirrors src/generator.js) ---------------------------
function parseDomain(raw) {
  let url = (raw || "").trim();
  if (!url) return null;
  url = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").trim();
  if (!url || !url.includes(".")) return null;
  const host = url.toLowerCase();
  const parts = host.split(".");
  const multi = ["co.uk", "com.au", "co.nz", "co.jp", "com.br", "co.in"];
  let coreParts;
  const last2 = parts.slice(-2).join(".");
  if (multi.includes(last2) && parts.length >= 3) coreParts = parts.slice(0, -2);
  else coreParts = parts.slice(0, -1);
  const core = coreParts[coreParts.length - 1] || parts[0];
  const brand = core
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { host, root: "https://" + host, brand };
}

// ---- sitemap discovery & parsing -----------------------------------------
function extractLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    locs.push(decodeXmlEntities(m[1].trim()));
  }
  return locs;
}

// Pull { loc, lastmod } per <url> entry so we can rank by freshness.
// lastmod is an epoch ms number (or 0 when absent/unparseable).
function extractEntries(xml) {
  const entries = [];
  const re = /<url\b[\s\S]*?<\/url>/gi;
  let block;
  while ((block = re.exec(xml))) {
    const seg = block[0];
    const locM = seg.match(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/i);
    if (!locM) continue;
    const loc = decodeXmlEntities(locM[1].trim());
    const lmM = seg.match(/<lastmod>\s*([^<\s][^<]*?)\s*<\/lastmod>/i);
    let lastmod = 0;
    if (lmM) {
      const t = Date.parse(lmM[1].trim());
      if (!Number.isNaN(t)) lastmod = t;
    }
    entries.push({ loc, lastmod });
  }
  return entries;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function looksLikeSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

// Resolve the robots.txt "Sitemap:" directives.
async function sitemapsFromRobots(root) {
  const txt = await fetchText(root + "/robots.txt");
  if (!txt) return [];
  const out = [];
  const re = /^\s*sitemap:\s*(\S+)\s*$/gim;
  let m;
  while ((m = re.exec(txt))) out.push(m[1].trim());
  return out;
}

// Returns a flat, de-duped list of { loc, lastmod } from the site's sitemap(s).
async function collectSitemapEntries(root) {
  const candidates = [
    root + "/sitemap.xml",
    root + "/sitemap_index.xml",
    root + "/sitemap-index.xml",
  ];
  const fromRobots = await sitemapsFromRobots(root);
  for (const s of fromRobots) if (!candidates.includes(s)) candidates.unshift(s);

  const seen = new Set();
  const entries = [];
  const add = (e) => {
    if (!seen.has(e.loc)) { seen.add(e.loc); entries.push(e); }
  };

  // first pass: try candidate sitemaps until one parses
  let rootXml = null;
  for (const url of candidates) {
    const xml = await fetchText(url, { accept: "application/xml,text/xml,*/*" });
    if (xml && /<(urlset|sitemapindex)[\s>]/i.test(xml)) {
      rootXml = xml;
      break;
    }
  }
  if (!rootXml) return [];

  if (looksLikeSitemapIndex(rootXml)) {
    // child sitemaps — fetch the freshest few, gather their <url> entries.
    // Sort children by their own <lastmod> so we crawl recently-updated
    // sections first when the index is larger than we'll read.
    const childEntries = extractEntries(rootXml);
    const children = (childEntries.length ? childEntries : extractLocs(rootXml).map((loc) => ({ loc, lastmod: 0 })))
      .sort((a, b) => b.lastmod - a.lastmod)
      .slice(0, 5)
      .map((e) => e.loc);
    for (const child of children) {
      const xml = await fetchText(child, { accept: "application/xml,text/xml,*/*" });
      if (!xml) continue;
      for (const e of extractEntries(xml)) {
        add(e);
        if (entries.length >= 400) break;
      }
      if (entries.length >= 400) break;
    }
  } else {
    for (const e of extractEntries(rootXml)) {
      add(e);
      if (entries.length >= 400) break;
    }
  }
  return entries;
}

// ---- group + rank URLs into sections -------------------------------------
const SEGMENT_TITLES = {
  docs: "Docs", documentation: "Docs", guides: "Guides", guide: "Guides",
  blog: "Blog", posts: "Blog", post: "Blog", articles: "Articles", news: "News",
  products: "Products", product: "Products", collections: "Shop", shop: "Shop",
  store: "Shop", pricing: "Pricing", features: "Features",
  about: "Company", company: "Company", team: "Company", careers: "Company",
  help: "Help", support: "Support", faq: "Help", contact: "Contact",
  api: "API", reference: "Reference", changelog: "Changelog",
  work: "Work", "case-studies": "Work", portfolio: "Work", services: "Services",
  resources: "Resources", learn: "Learn", legal: "Legal",
};

function titleFromSegment(seg) {
  if (SEGMENT_TITLES[seg]) return SEGMENT_TITLES[seg];
  return seg
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function titleFromUrl(u) {
  try {
    const { pathname } = new URL(u);
    const seg = pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (!seg) return "Home";
    return decodeURIComponent(seg)
      .replace(/\.[a-z0-9]+$/i, "")
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  } catch {
    return u;
  }
}

function firstSegment(u) {
  try {
    const { pathname } = new URL(u);
    const segs = pathname.split("/").filter(Boolean);
    return segs[0] || "";
  } catch {
    return "";
  }
}

// Build sections { name, links: [{title, url}] } from sitemap entries.
// entries: [{ loc, lastmod }]. Within a section, shallower (higher-level)
// pages rank first; among comparable depths, fresher <lastmod> wins.
function groupUrls(entries, root) {
  const home = [];
  const buckets = new Map(); // segment -> entries

  for (const e of entries) {
    const u = e.loc;
    let path;
    try { path = new URL(u).pathname; } catch { continue; }
    const seg = firstSegment(u);
    if (seg === "") {
      if (path === "/" || path === "") home.push(u);
      continue;
    }
    if (!buckets.has(seg)) buckets.set(seg, []);
    buckets.get(seg).push(e);
  }

  // sort buckets by size (most populated paths first), keep top N
  const ordered = [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_SECTIONS);

  const sections = [];
  let total = 0;

  const depth = (u) => (u.match(/\//g) || []).length;

  for (const [seg, segEntries] of ordered) {
    if (total >= MAX_TOTAL_LINKS) break;
    // shallower paths first, then most-recently-modified, then shorter URL
    const picked = segEntries
      .slice()
      .sort((a, b) => {
        const da = depth(a.loc), db = depth(b.loc);
        if (da !== db) return da - db;
        if (b.lastmod !== a.lastmod) return b.lastmod - a.lastmod;
        return a.loc.length - b.loc.length;
      })
      .slice(0, MAX_LINKS_PER_SECTION);

    const links = [];
    for (const e of picked) {
      if (total >= MAX_TOTAL_LINKS) break;
      links.push({ title: titleFromUrl(e.loc), url: e.loc });
      total++;
    }
    if (links.length) sections.push({ name: titleFromSegment(seg), links });
  }

  return { sections, home };
}

// ---- pull <title> / meta description from a page -------------------------
function extractMeta(html) {
  if (!html) return {};
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descM =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  const ogTitleM = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  const clean = (s) => (s ? decodeHtmlEntities(s).replace(/\s+/g, " ").trim() : "");
  return {
    title: clean(titleM && titleM[1]),
    ogTitle: clean(ogTitleM && ogTitleM[1]),
    description: clean(descM && descM[1]),
  };
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

// strip a trailing " | Brand" / " – Brand" suffix from a page <title>
function cleanPageTitle(title, brand) {
  if (!title) return "";
  let t = title.split(/\s+[|–—·\-]\s+/)[0].trim();
  if (!t) t = title.trim();
  return t;
}

// ---- assemble the llms.txt -----------------------------------------------
function buildLlmsTxt({ brand, root, host, summary, sections, fetched }) {
  const lines = [];
  lines.push(`# ${brand}`);
  lines.push("");
  if (summary) {
    lines.push(`> ${summary}`);
    lines.push("");
  }
  lines.push(
    `This file follows the llms.txt standard. Links below point to the site's most relevant pages so language models can quickly understand and cite ${brand}.`
  );
  lines.push("");

  let linkCount = 0;
  for (const sec of sections) {
    if (!sec.links.length) continue;
    lines.push(`## ${sec.name}`);
    lines.push("");
    for (const l of sec.links) {
      const note = fetched[l.url] && fetched[l.url].description;
      lines.push(note ? `- [${l.title}](${l.url}): ${note}` : `- [${l.title}](${l.url})`);
      linkCount++;
    }
    lines.push("");
  }

  const text = lines.join("\n").replace(/\n+$/, "\n");
  return { text, linkCount };
}

// ---- Claude: write the llms.txt from the crawled data --------------------
// Cheapest model, tight token cap, curated input. Returns a string or null.
async function writeWithClaude({ brand, root, host, summary, sections, fetched }) {
  const apiKey = process.env.CLAUDE_API_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Build a compact, bounded description of what we crawled. Keep it small so
  // input tokens stay low — this is the only place the model sees the site.
  const lines = [];
  for (const sec of sections) {
    lines.push(`Section: ${sec.name}`);
    for (const l of sec.links) {
      const note = fetched[l.url] && fetched[l.url].description;
      lines.push(`  - ${l.title} | ${l.url}${note ? ` | ${note.slice(0, 160)}` : ""}`);
    }
  }
  const crawl = lines.join("\n").slice(0, 6000); // hard cap on input size

  const prompt =
`You are generating an llms.txt file for the website "${host}" following the llms.txt standard (https://llmstxt.org).

The llms.txt format, in exact order:
1. An H1 with the site/project name: "# Name"
2. A blockquote one-sentence summary: "> ..."
3. Optionally a short plain paragraph (no headings) with extra context.
4. Zero or more "## Section" headers, each followed by a markdown list of links in the form "- [Title](url): short note". The note is optional.
5. An optional "## Optional" section at the end for links that can be skipped for a shorter context.

Here is what was crawled from the site (curated; use these real URLs — do not invent new ones):

Site name guess: ${brand}
Homepage summary guess: ${summary}

${crawl}

Write ONLY the llms.txt file content — no preamble, no code fences, no commentary. Keep link notes concise (under ~12 words). Group links sensibly under clear section headings. Use the exact URLs provided.`;

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    });
    const out = (msg.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // sanity-check: must start with an H1 and contain at least one link
    if (!/^#\s+\S/.test(out) || !/\]\(https?:\/\//.test(out)) return null;
    // strip stray code fences if the model added them anyway
    return out.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim() + "\n";
  } catch (e) {
    return null; // any API error → caller uses the deterministic builder
  }
}

// ---- basic in-memory rate limit (per warm serverless instance) -----------
// Not a hard global cap, but cheap insurance against a single client hammering
// a warm instance and running up Claude cost. Window resets on cold start.
const RATE = { windowMs: 60_000, max: 8, hits: new Map() };
function rateLimited(key) {
  const now = Date.now();
  const rec = RATE.hits.get(key);
  if (!rec || now - rec.start > RATE.windowMs) {
    RATE.hits.set(key, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE.max;
}

// ---- reuse an existing /llms.txt -----------------------------------------
// The single best signal: if the site already publishes one, prefer it.
// Returns the file text if it looks like a real llms.txt, else null.
async function fetchExistingLlmsTxt(root) {
  const txt = await fetchText(root + "/llms.txt", { accept: "text/plain,text/markdown,*/*" });
  if (!txt) return null;
  const body = txt.trim();
  // reject HTML error/SPA pages that some hosts serve as a 200 for /llms.txt
  if (/<!doctype html|<html[\s>]/i.test(body)) return null;
  // must contain a markdown H1 somewhere near the top (real files sometimes
  // lead with a blockquote or a comment line before the H1)
  if (!/^#\s+\S/m.test(body)) return null;
  if (body.length < 20) return null;
  return body.endsWith("\n") ? body : body + "\n";
}

// ---- handler --------------------------------------------------------------
export default async function handler(req, res) {
  const raw =
    (req.query && req.query.url) ||
    (req.body && req.body.url) ||
    "";

  const d = parseDomain(Array.isArray(raw) ? raw[0] : raw);
  if (!d) {
    res.status(400).json({ error: "invalid_domain" });
    return;
  }

  // basic abuse guard so a single client can't run up Claude cost
  const clientIp =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(clientIp)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  try {
    // 1) If the site already publishes an /llms.txt, that's the best answer —
    // return it directly rather than rebuilding from scratch.
    const existing = await fetchExistingLlmsTxt(d.root);
    if (existing) {
      const linkCount = (existing.match(/^\s*-\s*\[[^\]]*\]\(/gm) || []).length;
      const sectionCount = (existing.match(/^##\s+\S/gm) || []).length;
      const h1 = existing.match(/^#\s+(.+)$/m);
      res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
      res.status(200).json({
        simulated: false,
        generatedBy: "existing",
        text: existing,
        meta: {
          host: d.host,
          brand: (h1 && h1[1].trim()) || d.brand,
          root: d.root,
          linkCount,
          sectionCount,
          pagesCrawled: 0,
        },
      });
      return;
    }

    // 2) Otherwise crawl the sitemap and build one.
    const entries = await collectSitemapEntries(d.root);

    if (!entries.length) {
      // nothing to crawl — let the client fall back to the simulator
      res.status(200).json({ simulated: true, reason: "no_sitemap", meta: { host: d.host } });
      return;
    }

    const { sections } = groupUrls(entries, d.root);
    if (!sections.length) {
      res.status(200).json({ simulated: true, reason: "no_sections", meta: { host: d.host } });
      return;
    }

    // Fetch homepage + the first link of the top sections for real titles/meta.
    const toFetch = [d.root];
    for (const sec of sections) {
      if (sec.links[0]) toFetch.push(sec.links[0].url);
      if (toFetch.length >= MAX_PAGE_FETCHES) break;
    }
    const uniqueToFetch = [...new Set(toFetch)].slice(0, MAX_PAGE_FETCHES);

    const fetched = {};
    await Promise.all(
      uniqueToFetch.map(async (u) => {
        const html = await fetchText(u, { accept: "text/html,*/*" });
        const meta = extractMeta(html);
        fetched[u] = {
          title: cleanPageTitle(meta.ogTitle || meta.title, d.brand),
          description: meta.description,
        };
      })
    );

    // brand: prefer the homepage's cleaned title if it looks reasonable
    const homeMeta = fetched[d.root] || {};
    let brand = d.brand;
    if (homeMeta.title && homeMeta.title.length <= 40) brand = homeMeta.title;

    // summary: homepage meta description, else og fallback wording
    const summary =
      homeMeta.description ||
      `${brand} — curated map of the site's most useful pages for language models.`;

    // use fetched page titles where we have them
    for (const sec of sections) {
      for (const l of sec.links) {
        const f = fetched[l.url];
        if (f && f.title && f.title.length <= 60) l.title = f.title;
      }
    }

    // Try Claude (cheapest model) to write a clean llms.txt; fall back to the
    // deterministic builder if it's unavailable or returns something malformed.
    const built = buildLlmsTxt({
      brand, root: d.root, host: d.host, summary, sections, fetched,
    });
    const claudeText = await writeWithClaude({
      brand, root: d.root, host: d.host, summary, sections, fetched,
    });
    const text = claudeText || built.text;
    const usedClaude = Boolean(claudeText);

    // derive stats from whichever text we're returning
    const linkCount = (text.match(/^\s*-\s*\[[^\]]*\]\(/gm) || []).length;
    const sectionCount = (text.match(/^##\s+\S/gm) || []).length;

    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    res.status(200).json({
      simulated: false,
      generatedBy: usedClaude ? "claude" : "heuristic",
      text,
      meta: {
        host: d.host,
        brand,
        root: d.root,
        linkCount,
        sectionCount: sectionCount || sections.length,
        pagesCrawled: entries.length,
      },
    });
  } catch (e) {
    // any unexpected failure -> client falls back to the simulator
    res.status(200).json({ simulated: true, reason: "error", meta: { host: d.host } });
  }
}
