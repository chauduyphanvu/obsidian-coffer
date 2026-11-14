// The one look a published site has: a quiet column of text in the system's fonts, light or dark as the reader's device
// is set. Nothing is loaded from elsewhere and nothing runs.

/** The site's style sheet, `site.css`: every element the renderer and the page frame write has a rule here. */
export const THEME = `:root {
  color-scheme: light dark;
  --text: #1f2328;
  --muted: #5f6b76;
  --bg: #ffffff;
  --soft: #f5f6f8;
  --line: #d8dde3;
  --link: #0b5fcf;
  --mark: #fff0a0;
  --note: #2f6fdb;
  --tip: #1a8a6e;
  --warning: #c27100;
  --danger: #cf2c3a;
  --other: #7a8591;
}
@media (prefers-color-scheme: dark) {
  :root {
    --text: #e3e5e8;
    --muted: #9aa4af;
    --bg: #17191d;
    --soft: #20242a;
    --line: #343a42;
    --link: #79b0ff;
    --mark: #5a4b00;
    --note: #6c9ef0;
    --tip: #3fbf9b;
    --warning: #e3a03c;
    --danger: #f06b75;
    --other: #8b96a2;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0 1.25rem 4rem;
  background: var(--bg);
  color: var(--text);
  font: 1.0625rem/1.65 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: break-word;
}
header.site, main { max-width: 70ch; margin: 0 auto; }
header.site { padding: 1.25rem 0 1rem; margin-bottom: 2rem; border-bottom: 1px solid var(--line); }
header.site a { color: var(--muted); font-weight: 600; text-decoration: none; }
header.site a:hover { color: var(--text); }

h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2rem 0 0.75rem; font-weight: 650; }
h1 { font-size: 2rem; }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.25rem; }
h4, h5, h6 { font-size: 1rem; }
h6 { color: var(--muted); }
article > :first-child, h1.title { margin-top: 0; }
p, ul, ol, dl, blockquote, pre, table, details, .callout, .math { margin: 0 0 1rem; }
ul, ol { padding-left: 1.6rem; }
li > ul, li > ol { margin-bottom: 0; }
li.task { list-style: none; }
li.task > input[type="checkbox"] { margin: 0 0.45em 0 -1.35em; vertical-align: middle; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }

a { color: var(--link); text-underline-offset: 0.15em; }
a.internal { text-decoration-thickness: 1px; }
a.external { text-decoration-style: dotted; }
span.unresolved { color: var(--muted); }
span.tag {
  padding: 0.05em 0.4em;
  border-radius: 1em;
  background: var(--soft);
  color: var(--muted);
  font-size: 0.9em;
}
mark { background: var(--mark); color: inherit; padding: 0 0.1em; }

code, pre, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.9em; }
code, kbd { padding: 0.1em 0.3em; border-radius: 4px; background: var(--soft); }
kbd { border: 1px solid var(--line); }
pre { padding: 0.8rem 1rem; overflow-x: auto; border-radius: 6px; background: var(--soft); line-height: 1.45; }
pre code { padding: 0; background: none; font-size: inherit; }
.math { font-style: italic; }
pre.math { font-style: normal; }

blockquote { padding: 0 0 0 1rem; border-left: 3px solid var(--line); color: var(--muted); }
blockquote > :last-child, .callout-content > :last-child { margin-bottom: 0; }

.callout {
  --accent: var(--other);
  padding: 0.75rem 1rem;
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  background: var(--soft);
}
.callout[data-callout="note"], .callout[data-callout="info"], .callout[data-callout="todo"], .callout[data-callout="abstract"], .callout[data-callout="summary"], .callout[data-callout="tldr"] { --accent: var(--note); }
.callout[data-callout="tip"], .callout[data-callout="hint"], .callout[data-callout="important"], .callout[data-callout="success"], .callout[data-callout="check"], .callout[data-callout="done"] { --accent: var(--tip); }
.callout[data-callout="warning"], .callout[data-callout="caution"], .callout[data-callout="attention"], .callout[data-callout="question"], .callout[data-callout="help"], .callout[data-callout="faq"] { --accent: var(--warning); }
.callout[data-callout="danger"], .callout[data-callout="error"], .callout[data-callout="bug"], .callout[data-callout="failure"], .callout[data-callout="fail"], .callout[data-callout="missing"] { --accent: var(--danger); }
.callout-title { font-weight: 600; color: var(--accent); }
summary.callout-title { cursor: pointer; }
.callout-content { margin-top: 0.5rem; }

table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
th, td { padding: 0.4rem 0.75rem; border: 1px solid var(--line); vertical-align: top; }
th { background: var(--soft); text-align: left; }
th.left, td.left { text-align: left; }
th.center, td.center { text-align: center; }
th.right, td.right { text-align: right; }

img, video { max-width: 100%; height: auto; }
audio { width: 100%; }

.footnotes { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.9em; }
sup.footnote-ref a, a.footnote-back { text-decoration: none; }

nav.pages { margin-top: 2rem; }
article + nav.pages { padding-top: 1.5rem; border-top: 1px solid var(--line); }
nav.pages ul { list-style: none; padding-left: 0; margin: 0; }
nav.pages ul ul { padding-left: 1.1rem; margin: 0.15rem 0 0.4rem; border-left: 1px solid var(--line); }
nav.pages li { margin: 0.2rem 0; }
nav.pages span.folder { color: var(--muted); font-weight: 600; }
p.empty { color: var(--muted); }
`;
