# MakeLLM

A free tool to generate an [`llms.txt`](https://llmstxt.org) for any website. Paste a
URL, watch an animated "crawling / analyzing / writing" sequence, and get a clean,
spec-compliant `llms.txt` in a code-editor panel with Copy and Download.

Built with Vite + React.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle in dist/
npm run preview  # preview the built bundle
```

## How it works

The browser posts the domain to **`/api/generate`** (a Vercel serverless function — a
browser can't fetch a third-party `sitemap.xml` because of CORS, so the crawl runs
server-side). The function:

1. Resolves the sitemap (`sitemap.xml` → `sitemap_index.xml` → `robots.txt` `Sitemap:`).
2. Parses the `<loc>` URLs, groups them into sections, ranks and caps them.
3. Fetches the homepage + a few top pages for real `<title>` / `<meta description>`.
4. Asks **Claude** (`claude-haiku-4-5`, the cheapest model) to write a clean,
   spec-compliant `llms.txt` from that crawled data, using the real URLs.

It returns `{ text, meta, generatedBy: "claude" | "heuristic" }`.

### Cost controls

This is a free tool, so the Claude call is kept very cheap: cheapest model only, a tight
`max_tokens` ceiling, a curated/bounded input (limited URL list + short notes), and a
basic per-instance rate limit. If Claude is unavailable it falls back to a deterministic
builder; if there's no token at all it still returns the heuristic file.

### Fallback

`src/generator.js` is a deterministic, domain-aware generator used as a fallback when the
site has no sitemap, the fetch is blocked, or the API is unreachable — it classifies the
domain into an archetype (SaaS, e-commerce, blog, agency, generic) and emits a plausible
`llms.txt` so the tool never dead-ends.

## Configuration

The function needs a Claude API token. Locally, copy `.env.example` to `.env` and set
`CLAUDE_API_TOKEN`. On Vercel, set it in **Project Settings → Environment Variables**.
Run `/api/*` locally with `vercel dev` (plain `vite dev` does not execute serverless
functions).
