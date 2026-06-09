import { useState, useRef, useEffect, useCallback } from 'react'
import { generateLlmsTxt, parseDomain } from './generator.js'

// ---------- syntax highlighting for the llms.txt preview ------------------
function classifyLine(line, key) {
  if (line.startsWith("# ")) {
    return <div key={key} className="ed-line"><span className="ed-h1">{line}</span></div>;
  }
  if (line.startsWith("## ")) {
    return <div key={key} className="ed-line"><span className="ed-h2">{line}</span></div>;
  }
  if (line.startsWith("> ")) {
    return <div key={key} className="ed-line ed-quote">{line}</div>;
  }
  // markdown link list item:  - [title](url): desc
  const m = line.match(/^(\s*-\s*)\[([^\]]*)\]\(([^)]*)\)(:\s*(.*))?$/);
  if (m) {
    return (
      <div key={key} className="ed-line">
        <span className="ed-bullet">{m[1]}</span>
        <span className="ed-bracket">[</span>
        <span className="ed-linktitle">{m[2]}</span>
        <span className="ed-bracket">]</span>
        <span className="ed-paren">(</span>
        <span className="ed-url">{m[3]}</span>
        <span className="ed-paren">)</span>
        {m[4] ? <span className="ed-desc">{": "}{m[5]}</span> : null}
      </div>
    );
  }
  if (line.trim() === "") return <div key={key} className="ed-line">{" "}</div>;
  return <div key={key} className="ed-line ed-text">{line}</div>;
}

function CodeView({ text }) {
  const lines = text.split("\n");
  return (
    <div className="editor-code">
      <div className="ed-gutter" aria-hidden="true">
        {lines.map((_, i) => <div key={i} className="ed-num">{i + 1}</div>)}
      </div>
      <div className="ed-content">
        {lines.map((l, i) => classifyLine(l, i))}
      </div>
    </div>
  );
}

// ---------- icons ----------------------------------------------------------
const Icon = {
  arrow: (p) => <svg viewBox="0 0 24 24" fill="none" {...p}><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  check: (p) => <svg viewBox="0 0 24 24" fill="none" {...p}><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  copy: (p) => <svg viewBox="0 0 24 24" fill="none" {...p}><rect x="9" y="9" width="11" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.8"/><path d="M5 15V6a2 2 0 0 1 2-2h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>,
  download: (p) => <svg viewBox="0 0 24 24" fill="none" {...p}><path d="M12 4v11M7 11l5 5 5-5M5 20h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  refresh: (p) => <svg viewBox="0 0 24 24" fill="none" {...p}><path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  doc: (p) => <svg viewBox="0 0 24 24" fill="none" {...p}><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg>,
  spark: (p) => <svg viewBox="0 0 24 24" fill="none" {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>,
};

// ---------- loading sequence ----------------------------------------------
function LoadingPanel({ meta }) {
  const steps = [
    `Connecting to ${meta.host}`,
    `Crawling pages`,
    `Reading content & metadata`,
    `Ranking the most useful links`,
    `Writing llms.txt`,
  ];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const durations = [520, 900, 760, 640, 560];
    let i = 0;
    let timer;
    const tick = () => {
      i += 1;
      if (i < steps.length) {
        setActive(i);
        timer = setTimeout(tick, durations[i]);
      }
    };
    timer = setTimeout(tick, durations[0]);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="loading">
      <div className="loading-head">
        <span className="spinner" aria-hidden="true" />
        <div className="loading-head-txt">
          <div className="loading-title">Generating your llms.txt</div>
          <div className="loading-sub">{meta.root}</div>
        </div>
      </div>
      <ul className="steps">
        {steps.map((s, i) => {
          const state = i < active ? "done" : i === active ? "now" : "todo";
          let label = s;
          if (i === 1 && state !== "todo") label = `Crawling pages · ${meta.pagesCrawled} found`;
          if (i === 3 && state !== "todo") label = `Ranking the most useful links · ${meta.linkCount} kept`;
          return (
            <li key={i} className={`step step-${state}`}>
              <span className="step-mark">
                {state === "done" ? <Icon.check className="step-check" /> : <span className="step-dot" />}
              </span>
              <span className="step-label">{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- result panel ---------------------------------------------------
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
}

function ResultPanel({ result, onReset }) {
  const [copied, setCopied] = useState(false);
  const { text, meta } = result;

  const doCopy = useCallback(() => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        fallbackCopy(text); done();
      });
    } else { fallbackCopy(text); done(); }
  }, [text]);

  const doDownload = useCallback(() => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "llms.txt";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [text]);

  return (
    <div className="result">
      <div className="result-meta">
        <span className="meta-pill meta-ok"><Icon.check className="meta-ico" /> Generated</span>
        <span className="meta-stat"><strong>{meta.sectionCount}</strong> sections</span>
        <span className="meta-dot">·</span>
        <span className="meta-stat"><strong>{meta.linkCount}</strong> links</span>
        <span className="meta-dot">·</span>
        <span className="meta-stat">from <strong>{meta.pagesCrawled}</strong> pages</span>
      </div>

      <div className="editor">
        <div className="editor-bar">
          <div className="editor-file">
            <Icon.doc className="editor-fileico" />
            <span className="editor-filename">llms.txt</span>
            <span className="editor-host">{meta.host}</span>
          </div>
          <div className="editor-actions">
            <button className="ebtn" onClick={doCopy}>
              {copied ? <Icon.check className="ebtn-ico" /> : <Icon.copy className="ebtn-ico" />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
            <button className="ebtn ebtn-primary" onClick={doDownload}>
              <Icon.download className="ebtn-ico" />
              <span>Download</span>
            </button>
          </div>
        </div>
        <div className="editor-scroll">
          <CodeView text={text} />
        </div>
      </div>

      <div className="result-foot">
        <button className="linkbtn" onClick={onReset}>
          <Icon.refresh className="linkbtn-ico" /> Generate for another site
        </button>
        <span className="result-hint">Place this file at <code>{meta.root}/llms.txt</code></span>
      </div>
    </div>
  );
}

// ---------- input form -----------------------------------------------------
function InputPanel({ onGenerate }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const submit = (e) => {
    if (e) e.preventDefault();
    const parsed = parseDomain(value);
    if (!parsed) {
      setError("Enter a valid website address, like example.com");
      return;
    }
    setError("");
    onGenerate(value);
  };

  const examples = ["stripe.com", "allbirds.com", "studio.design", "craigmod.com"];

  return (
    <form className="inputwrap" onSubmit={submit}>
      <div className={`field ${error ? "field-err" : ""}`}>
        <span className="field-scheme">https://</span>
        <input
          ref={inputRef}
          className="field-input"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck="false"
          placeholder="yourwebsite.com"
          value={value}
          onChange={(e) => { setValue(e.target.value); if (error) setError(""); }}
        />
        <button type="submit" className="gen-btn">
          <Icon.spark className="gen-ico" />
          <span>Generate</span>
          <Icon.arrow className="gen-arrow" />
        </button>
      </div>
      <div className="field-meta">
        {error
          ? <span className="field-error">{error}</span>
          : <span className="field-try">Try
              {examples.map((ex) => (
                <button type="button" key={ex} className="chip"
                  onClick={() => { setValue(ex); setError(""); inputRef.current && inputRef.current.focus(); }}>
                  {ex}
                </button>
              ))}
            </span>}
      </div>
    </form>
  );
}

// Call the backend to really crawl the site + write the llms.txt with Claude.
// Falls back to the in-browser simulator if the API is unavailable or can't
// generate a real file (no sitemap, fetch blocked, etc.).
async function fetchGenerated(domain) {
  try {
    const res = await fetch(`/api/generate?url=${encodeURIComponent(domain)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return generateLlmsTxt(domain);
    const data = await res.json();
    if (data && data.simulated === false && data.text) {
      return { text: data.text, meta: data.meta };
    }
  } catch (e) {
    // network error — fall through to the simulator
  }
  return generateLlmsTxt(domain);
}

// ---------- the tool (state machine) ---------------------------------------
function Tool() {
  const [status, setStatus] = useState("idle"); // idle | loading | done
  const [loadingMeta, setLoadingMeta] = useState(null);
  const [result, setResult] = useState(null);

  const handleGenerate = (domain) => {
    // Show the loading animation immediately with provisional stats from the
    // local generator, while the real generation runs in the background.
    const provisional = generateLlmsTxt(domain);
    if (!provisional) return;
    setLoadingMeta(provisional.meta);
    setResult(null);
    setStatus("loading");

    const minDelay = new Promise((r) => setTimeout(r, 3500)); // keep the animation
    Promise.all([fetchGenerated(domain), minDelay]).then(([r]) => {
      setResult(r || provisional);
      setStatus("done");
    });
  };

  const reset = () => { setStatus("idle"); setResult(null); setLoadingMeta(null); };

  return (
    <div className="tool">
      {status === "idle" && <InputPanel onGenerate={handleGenerate} />}
      {status === "loading" && loadingMeta && <LoadingPanel meta={loadingMeta} />}
      {status === "done" && result && <ResultPanel result={result} onReset={reset} />}
    </div>
  );
}

// ---------- page chrome ----------------------------------------------------
function Explainer() {
  const items = [
    ["What's an llms.txt?", "A simple Markdown file at the root of your site that gives AI models a clean, curated map of your most important pages — so they understand and cite you correctly."],
    ["Why it matters", "Models burn through bloated HTML and miss the point. llms.txt hands them the signal directly: titles, links, and short descriptions, nothing else."],
    ["How to use it", "Download the file, drop it at /llms.txt on your domain, and you're done. No build step, no plugin, no account."],
  ];
  return (
    <section className="explainer">
      {items.map(([t, d]) => (
        <div className="ex-card" key={t}>
          <h3 className="ex-title">{t}</h3>
          <p className="ex-body">{d}</p>
        </div>
      ))}
    </section>
  );
}

export default function App() {
  return (
    <div className="page">
      <header className="topbar">
        <a className="brand" href="#top">
          <span className="brand-mark">M</span>
          <span className="brand-name">MakeLLM</span>
          <span className="brand-tag">.txt</span>
        </a>
        <div className="topbar-right">
          <a className="top-link" href="https://llmstxt.org" target="_blank" rel="noreferrer">The spec</a>
          <span className="free-pill">Free</span>
        </div>
      </header>

      <main className="hero" id="top">
        <div className="eyebrow"><span className="eyebrow-dot" /> llms.txt generator</div>
        <h1 className="headline">Make any website<br/>legible to AI.</h1>
        <p className="subhead">
          Paste a URL. We read the site, map what matters, and hand you a clean
          <span className="nowrap"> <code>llms.txt</code> </span>— ready to publish in seconds.
        </p>

        <Tool />
        <Explainer />
      </main>

      <footer className="footer">
        <span className="brand-mark sm">M</span>
        <span>MakeLLM — a free tool for the open web.</span>
        <span className="footer-sep">·</span>
        <a className="top-link" href="https://llmstxt.org" target="_blank" rel="noreferrer">Learn about the standard</a>
        <span className="footer-sep">·</span>
        <span>Brought to you free by the team at <a className="top-link" href="https://nerdysherpas.com/" target="_blank" rel="noreferrer">Nerdy Sherpas</a></span>
      </footer>
    </div>
  );
}
