// Server-rendered pages. Plain template strings: every value from outside (release notes, query
// strings) goes through esc().
import { REPO } from "./github.mjs";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const GH = `https://github.com/${REPO}`;
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
// `code` spans in release notes, like the commit messages use them
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

const MOUNT = `<svg class="mount" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fac97a"/><stop offset="1" stop-color="#e49a2c"/></linearGradient>
    <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26346e"/><stop offset="1" stop-color="#f79646"/></linearGradient>
    <clipPath id="w"><rect x="15" y="17" width="34" height="24" rx="2"/></clipPath>
  </defs>
  <rect x="9" y="3" width="50" height="50" rx="7" fill="#8f6424"/>
  <rect x="4" y="8" width="52" height="52" rx="7" fill="url(#m)"/>
  <rect x="4.75" y="8.75" width="50.5" height="50.5" rx="6.5" fill="none" stroke="#ffecc4" stroke-opacity=".5" stroke-width="1.5"/>
  <g clip-path="url(#w)">
    <rect x="15" y="17" width="34" height="24" fill="url(#s)"/>
    <circle cx="37" cy="32" r="4.5" fill="#ffe296"/>
    <path d="M15 33 C22 30 30 31 36 33 S46 34 49 32 V41 H15 Z" fill="#5c283c"/>
    <path d="M15 37 C24 35 32 36.5 40 38 S47 38 49 37 V41 H15 Z" fill="#26122a"/>
  </g>
  <rect x="15" y="17" width="34" height="24" rx="2" fill="none" stroke="#50290a" stroke-opacity=".7" stroke-width="1.2"/>
  <rect x="24" y="48" width="16" height="3" rx="1.5" fill="#8f5a14" fill-opacity=".45"/>
</svg>`;

function layout({ title, description, current, body, wide = false }) {
  const nav = [
    ["/docs", "Docs"],
    ["/changelog", "Changelog"],
    ["/#download", "Download"],
    [GH, "GitHub"],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="https://slide-station.sams.land/assets/apple-touch-icon.png">
<meta name="theme-color" content="#131316">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="preload" href="/assets/fonts/fraunces.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/style.css">
<link rel="alternate" type="application/atom+xml" title="Slide Station releases" href="/changelog.atom">
</head>
<body>
<header class="top">
  <div class="bar${wide ? " wide" : ""}">
    <a class="brand" href="/">${MOUNT}<span>Slide Station</span></a>
    <nav>${nav
      .map(([href, label]) => `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a>`)
      .join("")}<a class="button small" href="/app/">Open in browser</a></nav>
  </div>
</header>
${body}
<footer>
  <div class="bar${wide ? " wide" : ""}">
    <span>Slide Station · MIT licence · made by <a href="https://sams.land">Sam Apostel</a></span>
    <span><a href="${GH}/issues">Report a problem</a> · <a href="/changelog.atom">Releases feed</a></span>
  </div>
</footer>
<script src="/assets/site.js" defer></script>
</body>
</html>`;
}

const FEATURES = [
  ["Brackets become one", "Took a brighter scan too? They're grouped and blended into one photo with detail in the highlights and shadows."],
  ["Upright by itself", "Rotation is guessed from faces and skies, and left alone when it isn't sure."],
  ["Faded film restored", "Colour comes back automatically, and your corrections teach it how to start the next slides."],
  ["Dust, mould, crooked mounts", "Straightens slides in their mount and cleans up dust, scratches, mould and Newton rings."],
  ["People across trays", "Name someone once and every slide with them gets the name, on Immich's People page too."],
  ["Straight into Immich", "An album per tray, with dates, places, captions and tags filled in. Immich v1.118 to v3."],
  ["Local adjustments", "Graduated filters, radials and a brush to fix one part of a slide."],
  ["The card, cleaned safely", "Scans are deleted from the scanner's card only once they're verified and uploaded."],
];

// before / after pairs: DOCUMERICA slides (US EPA, 1971–77, public domain), developed by the app
const COMPARE = [
  ["toddler", "A toddler on the beach, 1973"],
  ["tub", "Children in a park in Baltimore, 1973"],
  ["pyramid", "Pyramid Lake, Nevada, 1972"],
  ["rockport", "Rockport harbour, Massachusetts, 1973"],
];

const shot = (name, alt, eager = false) =>
  `<img src="/assets/img/app-${name}-2000.webp" srcset="/assets/img/app-${name}-1100.webp 1100w, /assets/img/app-${name}-2000.webp 2000w" sizes="(max-width: 1240px) 100vw, 1200px" width="2000" height="1250" alt="${alt}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}>`;

const APPLE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 12.64c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.19-1.72-1.35-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.62 1.1 8.79.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.52-.71 2.85-.71s1.7.71 2.87.69c1.19-.02 1.94-1.08 2.66-2.15.84-1.23 1.19-2.42 1.2-2.48-.03-.01-2.3-.88-2.33-3.5ZM14.2 6.17c.6-.74 1.01-1.75.9-2.77-.87.04-1.93.58-2.55 1.31-.56.64-1.05 1.68-.92 2.67.97.08 1.97-.49 2.57-1.21Z"/></svg>`;

export function home({ release, waitlistState, tip }) {
  const downloadHref = release ? "/download/mac" : `${GH}/releases`;
  const download = `<a class="button primary" href="${downloadHref}">${APPLE}Download for Mac</a>`;
  const version = release
    ? `<p class="fine">Version ${esc(release.version)} · Apple silicon · ${mb(release.dmg.size)} · updates itself · <a href="/changelog">What's new</a></p>`
    : "";
  const joined = waitlistState === "joined";
  const error = waitlistState && !joined ? waitlistState : "";
  const [first] = COMPARE;
  return layout({
    title: "Slide Station: digitise 35mm slides without the tedium",
    description:
      "Import a tray of scanned slides, blend brackets, turn them upright, restore faded colour and send them to Immich, in one window.",
    current: "/",
    body: `<main>
<section class="hero">
  <div class="bar">
    <a class="eyebrow" href="#testflight"><b>New</b> The iPad and iPhone app is coming to TestFlight</a>
    <h1>Digitise 35mm slides without the tedium.</h1>
    <p class="lede">Import a tray from the Kodak Slide N Scan, and Slide Station blends the brackets, turns the slides upright and brings faded colour back. Check them with a few keys, and they go to Immich with dates, places and people.</p>
    <div class="actions">
      ${download}
      <a class="button" href="/app/">Try it in your browser</a>
    </div>
    ${version}
  </div>
  <div class="hero-shot-wrap">
    <figure class="shot hero-shot">${shot("develop", "Slide Station developing a tray of slides from 1973: the filmstrip on the left, the slide in the middle, tone curve and restore controls on the right", true)}</figure>
  </div>
</section>

<section class="compare" aria-labelledby="compare-title">
  <div class="bar">
    <div class="section-head center">
      <h2 id="compare-title">Faded film, fixed by itself.</h2>
      <p>Real slides from the 1970s, as they came off the scanner and after Slide Station's automatic restore. Drag to compare.</p>
    </div>
    <div class="frame" data-compare>
      <img class="after" src="/assets/img/${first[0]}-after.webp" width="1200" height="804" alt="${first[1]}, restored by Slide Station">
      <div class="before"><img src="/assets/img/${first[0]}-before.webp" width="1200" height="804" alt="${first[1]}, the faded scan"></div>
      <span class="divider" aria-hidden="true"></span>
      <span class="tag left">Scan</span><span class="tag right">Slide Station</span>
      <input type="range" min="0" max="100" value="50" aria-label="Compare the scan with the restored slide">
    </div>
    <div class="picker" role="group" aria-label="Example slides">${COMPARE.map(
      ([name, caption], i) =>
        `<button type="button" data-slide="${name}" data-caption="${caption}" aria-pressed="${i === 0}" aria-label="${caption}"><img src="/assets/img/${name}-thumb.webp" alt="" width="72" height="48"></button>`,
    ).join("")}</div>
    <p class="fine">Slides from <a href="https://en.wikipedia.org/wiki/Documerica">DOCUMERICA</a>, the US Environmental Protection Agency's 1971–77 photo project (public domain).</p>
  </div>
</section>

<section class="features">
  <div class="bar">
    <div class="section-head">
      <h2>It does the boring parts.</h2>
      <p>Everything a tray needs between the scanner and your photo library, on your own computer.</p>
    </div>
    <ul class="grid">${FEATURES.map(([t, d]) => `<li><h3>${t}</h3><p>${d}</p></li>`).join("")}</ul>
  </div>
</section>

<section class="showcase">
  <div class="bar">
    <div>
      <h2>A whole tray at a glance.</h2>
      <p>Built for working through thousands of slides. Most need nothing, so checking them is a key press each, and the full-resolution work happens in the background.</p>
      <ul class="keys">
        <li><kbd>Space</kbd> Looks good, next</li>
        <li><kbd>R</kbd> Turn it</li>
        <li><kbd>X</kbd> Skip it</li>
        <li><kbd>G</kbd> The whole tray at once</li>
      </ul>
      <p class="fine"><a href="/docs/workflow">All the shortcuts</a></p>
    </div>
    <figure class="shot">${shot("grid", "The review grid showing twelve slides of the tray at once")}</figure>
  </div>
</section>

<section id="download" class="ways">
  <div class="bar">
    <div class="section-head">
      <h2>Get Slide Station</h2>
      <p>Free and open source.</p>
    </div>
    <div class="cards">
      <article class="card featured">
        <h3>Mac app</h3>
        <p>Notices when the scanner is plugged in, cleans its card, and keeps itself up to date.</p>
        <div class="card-foot">${download}</div>
        ${release ? `<p class="fine">Version ${esc(release.version)} · macOS on Apple silicon</p>` : ""}
      </article>
      <article class="card">
        <h3>In the browser</h3>
        <p>Nothing to install: drop the scanner's card or a folder of scans on the page. Nothing leaves your computer except what you send to your own Immich.</p>
        <div class="card-foot"><a class="button" href="/app/">Open Slide Station</a></div>
        <p class="fine">Best in Chrome or Edge. <a href="/docs/browser">What works where</a></p>
      </article>
      <article class="card">
        <h3>On your server</h3>
        <p>Run it next to Immich and everyone in the house uses it from their own browser, signed in with their Immich account.</p>
        <div class="card-foot"><a class="button" href="/docs/self-hosting">Set it up</a></div>
        <p class="fine">Docker</p>
      </article>
    </div>
  </div>
</section>

<section id="testflight" class="split">
  <div class="bar">
    <div>
      <h2>iPad and iPhone beta</h2>
      <p>Plug the Slide N Scan into an iPad, import a tray, keep, skip or turn each slide, and send it to Immich. No Mac needed. It's coming to TestFlight: leave your email and you'll get an invite when there's room.</p>
      <p class="fine">Your address is only used for the TestFlight invite.</p>
    </div>
    <form class="waitlist" method="post" action="/waitlist" data-state="${joined ? "joined" : ""}">
      <div class="joined" role="status">${joined ? "<strong>You're on the list.</strong> The invite will come from TestFlight." : ""}</div>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
      <fieldset>
        <legend>I'd use it on</legend>
        <label><input type="radio" name="device" value="ipad" checked> iPad</label>
        <label><input type="radio" name="device" value="iphone"> iPhone</label>
        <label><input type="radio" name="device" value="both"> Both</label>
      </fieldset>
      <label class="hp" aria-hidden="true">Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label>
      <button class="button primary" type="submit">Join the waitlist</button>
      <p class="error" role="alert">${esc(error)}</p>
    </form>
  </div>
</section>

${
  tip
    ? `<section id="tip" class="tip">
  <div class="bar">
    <div>
      <h2>Tip jar</h2>
      <p>Slide Station is free. If it rescued a box of family slides, a tip keeps it going.</p>
    </div>
    <a class="button primary" href="${esc(tip.url)}" rel="noopener">${esc(tip.label)}</a>
  </div>
</section>`
    : ""
}

<section class="links">
  <div class="bar">
    <h2>More</h2>
    <ul>
      <li><a href="/docs">Documentation</a><span>Getting started, the workflow, Immich, self-hosting</span></li>
      <li><a href="/changelog">Changelog</a><span>Every release, newest first</span></li>
      <li><a href="${GH}/issues">Report a problem</a><span>Or ask for something, on GitHub</span></li>
      <li><a href="${GH}">Source code</a><span>MIT licence</span></li>
    </ul>
  </div>
</section>
</main>`,
  });
}

export function docs(page, all) {
  const href = (p) => `/docs${p.slug ? `/${p.slug}` : ""}`;
  const i = all.indexOf(page);
  const [prev, next] = [all[i - 1], all[i + 1]];
  const side = all
    .map(
      (p) =>
        `<li><a href="${href(p)}"${p === page ? ' aria-current="page"' : ""}>${esc(p.title)}</a>${
          p === page
            ? `<ul>${p.toc.filter((t) => t.depth === 2).map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join("")}</ul>`
            : ""
        }</li>`,
    )
    .join("");
  return layout({
    title: `${page.title} · Slide Station docs`,
    description: page.html.match(/<p>(.*?)<\/p>/s)?.[1].replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").slice(0, 200) ?? "How to use Slide Station.",
    current: "/docs",
    wide: true,
    body: `<main class="docs bar wide">
  <aside><nav aria-label="Documentation"><ul>${side}</ul></nav></aside>
  <details class="docs-menu">
    <summary><span>Docs</span> ${esc(page.title)}</summary>
    <ul>${all.map((p) => `<li><a href="${href(p)}"${p === page ? ' aria-current="page"' : ""}>${esc(p.title)}</a></li>`).join("")}</ul>
  </details>
  <article class="prose">${page.html}
    <nav class="pager" aria-label="More docs">${prev ? `<a class="prev" href="${href(prev)}"><span>Previous</span>${esc(prev.title)}</a>` : "<span></span>"}${
      next ? `<a class="next" href="${href(next)}"><span>Next</span>${esc(next.title)}</a>` : ""
    }</nav>
    <p class="fine"><a href="${page.source}">Suggest a change to this page</a></p>
  </article>
</main>`,
  });
}

export function changelog(releases) {
  const shown = releases.filter((r) => !r.housekeeping);
  const items = shown
    .map(
      (r) => `<li id="v${esc(r.version)}">
  <div class="meta"><a class="version" href="${esc(r.url)}">${esc(r.version)}</a><time datetime="${esc(r.date)}">${day(r.date)}</time></div>
  <div class="entry">
    <h3>${inline(r.title)}${r.pr ? ` <a class="pr" href="${GH}/pull/${r.pr}">#${r.pr}</a>` : ""}</h3>
    ${r.details.length ? `<ul>${r.details.map((d) => `<li>${inline(d.replace(/^[-*]\s*/, ""))}</li>`).join("")}</ul>` : ""}
    ${r.dmg ? `<p class="fine"><a href="${esc(r.dmg.url)}">${esc(r.dmg.name)}</a> · ${mb(r.dmg.size)}</p>` : ""}
  </div>
</li>`,
    )
    .join("");
  return layout({
    title: "Changelog · Slide Station",
    description: "Every Slide Station release, newest first.",
    current: "/changelog",
    body: `<main class="bar changelog">
  <h1>Changelog</h1>
  <p class="lede">Every change that lands is a release; the Mac app picks it up by itself. <a href="/changelog.atom">Follow the feed</a>.</p>
  ${shown.length ? `<ol>${items}</ol>` : `<p>Couldn't reach GitHub just now. <a href="${GH}/releases">See the releases there</a>.</p>`}
</main>`,
  });
}

export function atom(releases, origin) {
  const shown = releases.filter((r) => !r.housekeeping).slice(0, 50);
  const updated = shown[0]?.date ?? new Date().toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Slide Station releases</title>
  <id>${origin}/changelog</id>
  <link href="${origin}/changelog"/>
  <link rel="self" href="${origin}/changelog.atom"/>
  <updated>${updated}</updated>
  ${shown
    .map(
      (r) => `<entry>
    <title>${esc(`${r.version}: ${r.title}`)}</title>
    <id>${origin}/changelog#v${esc(r.version)}</id>
    <link href="${origin}/changelog#v${esc(r.version)}"/>
    <updated>${r.date}</updated>
    <content type="text">${esc([r.title, ...r.details].join("\n"))}</content>
  </entry>`,
    )
    .join("\n  ")}
</feed>`;
}

export function notFound() {
  return layout({
    title: "Not found · Slide Station",
    description: "",
    body: `<main class="bar notfound"><h1>Nothing here</h1><p>That page doesn't exist. <a href="/">Back to the start</a>.</p></main>`,
  });
}
