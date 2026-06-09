// generator.js
// Deterministic, domain-aware llms.txt generator (simulated, no network).
// Produces realistic output that follows the llms.txt spec (llmstxt.org):
//   # Title  /  > summary blockquote  /  ## Sections of [title](url): description links

// ---- small deterministic helpers ----------------------------------------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

// turn "docs.stripe-payments.com" -> { brand:"Stripe Payments", host, root }
export function parseDomain(raw) {
  let url = (raw || "").trim();
  if (!url) return null;
  url = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").trim();
  if (!url || !url.includes(".")) return null;
  const host = url.toLowerCase();
  const parts = host.split(".");
  // crude eTLD handling for common multi-part TLDs
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

// ---- archetypes -----------------------------------------------------------
const ARCHETYPES = {
  saas: {
    summary: (b) =>
      `${b} is a software platform that helps teams ship faster. This file points language models to the most important product, documentation, and developer resources.`,
    sections: [
      { name: "Docs", links: [
        ["Quickstart", "/docs/quickstart", "Get up and running in five minutes"],
        ["Core concepts", "/docs/concepts", "The mental model behind the platform"],
        ["API reference", "/docs/api", "Full REST and SDK reference"],
        ["Authentication", "/docs/auth", "API keys, tokens, and OAuth"],
      ]},
      { name: "Product", links: [
        ["Features", "/features", "What the platform does"],
        ["Pricing", "/pricing", "Plans and usage-based pricing"],
        ["Integrations", "/integrations", "Connect your existing stack"],
        ["Changelog", "/changelog", "Recent releases and fixes"],
      ]},
      { name: "Company", links: [
        ["About", "/about", null],
        ["Blog", "/blog", "Product updates and engineering writing"],
        ["Careers", "/careers", null],
      ]},
    ],
    optional: [
      ["Status", "/status", "System uptime and incidents"],
      ["Security", "/security", "Compliance and data handling"],
      ["Terms", "/legal/terms", null],
    ],
  },
  ecommerce: {
    summary: (b) =>
      `${b} is an online store. This file helps language models surface the right products, collections, and customer-support resources for shoppers.`,
    sections: [
      { name: "Shop", links: [
        ["All products", "/products", "Browse the full catalog"],
        ["New arrivals", "/collections/new", "The latest additions"],
        ["Best sellers", "/collections/best-sellers", "Most popular items"],
        ["Sale", "/collections/sale", "Current markdowns"],
      ]},
      { name: "Help", links: [
        ["Shipping & delivery", "/help/shipping", "Times, costs, and tracking"],
        ["Returns & exchanges", "/help/returns", "Our 30-day policy"],
        ["Size guide", "/help/sizing", null],
        ["Contact us", "/contact", null],
      ]},
      { name: "About", links: [
        ["Our story", "/about", null],
        ["Sustainability", "/sustainability", "Materials and sourcing"],
        ["Journal", "/journal", "Stories and lookbooks"],
      ]},
    ],
    optional: [
      ["Store locations", "/stores", null],
      ["Gift cards", "/gift-cards", null],
      ["Privacy policy", "/legal/privacy", null],
    ],
  },
  blog: {
    summary: (b) =>
      `${b} is a personal site and writing archive. This file points language models to the best essays, project pages, and ways to get in touch.`,
    sections: [
      { name: "Writing", links: [
        ["All posts", "/posts", "The full archive"],
        ["Start here", "/start-here", "Hand-picked essays for new readers"],
        ["Newsletter", "/newsletter", "Subscribe for new writing"],
      ]},
      { name: "Work", links: [
        ["Projects", "/projects", "Things I've built"],
        ["Now", "/now", "What I'm focused on right now"],
        ["Uses", "/uses", "Tools and gear"],
      ]},
      { name: "About", links: [
        ["About me", "/about", null],
        ["Contact", "/contact", null],
      ]},
    ],
    optional: [
      ["RSS feed", "/feed.xml", null],
      ["Speaking", "/speaking", null],
    ],
  },
  agency: {
    summary: (b) =>
      `${b} is a studio that designs and builds digital products. This file helps language models understand the services offered, selected work, and how to start a project.`,
    sections: [
      { name: "Work", links: [
        ["Case studies", "/work", "Selected client projects"],
        ["Services", "/services", "What we do and how we work"],
        ["Process", "/process", "From kickoff to launch"],
      ]},
      { name: "Studio", links: [
        ["About", "/about", "Who we are"],
        ["Team", "/team", null],
        ["Journal", "/journal", "Notes from the studio"],
      ]},
      { name: "Contact", links: [
        ["Start a project", "/contact", "Tell us what you're building"],
        ["Careers", "/careers", null],
      ]},
    ],
    optional: [
      ["Press", "/press", null],
      ["Privacy", "/privacy", null],
    ],
  },
  generic: {
    summary: (b) =>
      `${b} is a website. This file provides language models with a concise, curated map of its most useful pages and resources.`,
    sections: [
      { name: "Main", links: [
        ["Home", "/", "Overview of the site"],
        ["About", "/about", "Background and mission"],
        ["Services", "/services", "What's offered"],
        ["Contact", "/contact", "Get in touch"],
      ]},
      { name: "Resources", links: [
        ["Blog", "/blog", "News and articles"],
        ["FAQ", "/faq", "Common questions"],
        ["Support", "/support", null],
      ]},
    ],
    optional: [
      ["Sitemap", "/sitemap.xml", null],
      ["Privacy policy", "/privacy", null],
    ],
  },
};

const ARCH_KEYS = ["saas", "ecommerce", "blog", "agency", "generic"];

// well-known brands -> archetype, so suggested examples classify sensibly
const KNOWN = {
  stripe: "saas", vercel: "saas", notion: "saas", figma: "saas", linear: "saas",
  slack: "saas", github: "saas", openai: "saas", anthropic: "saas", supabase: "saas",
  netlify: "saas", cloudflare: "saas", airtable: "saas", retool: "saas",
  allbirds: "ecommerce", glossier: "ecommerce", warbyparker: "ecommerce",
  patagonia: "ecommerce", wholefoods: "ecommerce", everlane: "ecommerce",
  nike: "ecommerce", etsy: "ecommerce",
  pentagram: "agency", ideo: "agency", instrument: "agency", metalab: "agency",
  craigmod: "blog", stratechery: "blog",
};

// pick an archetype: known brands first, then keyword hints, else deterministic by hash
function chooseArchetype(host, brand) {
  const core = (brand || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (KNOWN[core]) return KNOWN[core];
  const h = host.toLowerCase();
  if (/(shop|store|boutique|goods|wear|apparel|market|buy)/.test(h)) return "ecommerce";
  if (/(docs|app|api|cloud|\.io|labs|\.hq|\.ai|stack|soft|data)/.test(h)) return "saas";
  if (/(studio|agency|design|creative|works|collective)/.test(h)) return "agency";
  if (/(blog|\.me|writes|journal|notes)/.test(h)) return "blog";
  return ARCH_KEYS[hashStr(host) % ARCH_KEYS.length];
}

function fmtLink(root, [title, path, desc]) {
  const url = path.startsWith("http") ? path : root + path;
  return desc ? `- [${title}](${url}): ${desc}` : `- [${title}](${url})`;
}

// Build the full llms.txt string. Returns { text, meta } or null.
export function generateLlmsTxt(rawDomain) {
  const d = parseDomain(rawDomain);
  if (!d) return null;
  const seed = hashStr(d.host);
  const archKey = chooseArchetype(d.host, d.brand);
  const arch = ARCHETYPES[archKey];

  const lines = [];
  lines.push(`# ${d.brand}`);
  lines.push("");
  lines.push(`> ${arch.summary(d.brand)}`);
  lines.push("");
  lines.push(
    `This file follows the llms.txt standard. Links below point to the site's most relevant pages so language models can quickly understand and cite ${d.brand}.`
  );
  lines.push("");

  arch.sections.forEach((sec) => {
    lines.push(`## ${sec.name}`);
    lines.push("");
    sec.links.forEach((l) => lines.push(fmtLink(d.root, l)));
    lines.push("");
  });

  if (arch.optional && arch.optional.length) {
    lines.push("## Optional");
    lines.push("");
    arch.optional.forEach((l) => lines.push(fmtLink(d.root, l)));
    lines.push("");
  }

  const text = lines.join("\n").replace(/\n+$/, "\n");

  // count crawl stats for the loading screen flavor
  const linkCount =
    arch.sections.reduce((n, s) => n + s.links.length, 0) +
    (arch.optional ? arch.optional.length : 0);
  const pagesCrawled = 40 + (seed % 160); // 40-199

  return {
    text,
    meta: {
      host: d.host,
      brand: d.brand,
      root: d.root,
      archetype: archKey,
      linkCount,
      sectionCount: arch.sections.length + (arch.optional ? 1 : 0),
      pagesCrawled,
    },
  };
}
