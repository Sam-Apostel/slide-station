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
<meta name="theme-color" content="#f6efe3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16120e" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
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
  ["Brackets become one", "Repeated scans of a slide are grouped and exposure-fused into one HDR image."],
  ["Upright by itself", "Rotation is guessed from faces and skies, and left alone when it isn't sure."],
  ["Faded film restored", "Colour comes back, and your corrections teach it how to pre-set the next slides."],
  ["Crooked mounts, dust, scratches", "Straightens slides in their mount and cleans up dust, scratches, mould and Newton rings."],
  ["People across trays", "Optionally recognises faces: name someone once and Immich gets them as a tag."],
  ["Straight into Immich", "An album per tray (or one for all), each photo tagged with its tray. Works with Immich v1.118 → v3."],
  ["Local adjustments", "Graduated filters, radials and a brush to dodge and burn one part of a slide."],
  ["Card cleaned safely", "Scans are deleted from the scanner's card only once they're verified and uploaded."],
];

export function home({ release, waitlistState, tip }) {
  const download = release
    ? `<a class="button primary" href="/download/mac">Download for Mac</a>`
    : `<a class="button primary" href="${GH}/releases">Download for Mac</a>`;
  const version = release
    ? `<p class="fine">Version ${esc(release.version)} · ${day(release.date)} · Apple silicon · ${mb(release.dmg.size)} · updates itself</p>`
    : "";
  const joined = waitlistState === "joined";
  const error = waitlistState && !joined ? waitlistState : "";
  return layout({
    title: "Slide Station: digitise 35mm slides without the tedium",
    description:
      "Import Kodak Slide N Scan scans, blend brackets into HDR, turn slides upright, restore faded colour, upload to Immich and clean the card, in one window.",
    current: "/",
    body: `<main>
<section class="hero">
  <div class="bar">
    <div class="hero-text">
      <p class="eyebrow">For the Kodak Slide N Scan, a camera rig, or any folder of scans</p>
      <h1>Digitise 35mm slides without the tedium.</h1>
      <p class="lede">Import a tray, blend bracketed scans into HDR, turn slides upright, bring faded colour back and send them to Immich, then clean the scanner's card. Keyboard-first, built for working through thousands of slides. Everything runs on your own computer.</p>
      <div class="actions">
        ${download}
        <a class="button" href="/app/">Open in browser</a>
        <a class="button ghost" href="#testflight">iPad beta</a>
      </div>
      ${version}
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="slide s1">${MOUNT}</div>
      <div class="slide s2">${MOUNT}</div>
      <div class="slide s3">${MOUNT}</div>
    </div>
  </div>
</section>

<section class="features">
  <div class="bar">
    <h2>What it does</h2>
    <ul class="grid">${FEATURES.map(([t, d]) => `<li><h3>${t}</h3><p>${d}</p></li>`).join("")}</ul>
  </div>
</section>

<section id="download" class="ways">
  <div class="bar">
    <h2>Get it</h2>
    <div class="cards">
      <article class="card">
        <h3>Mac app</h3>
        <p>Its own window with native menus, folder pickers, drag-and-drop, notifications when the scanner is plugged in, and updates that install themselves.</p>
        <div class="card-foot">${download}</div>
        ${version}
      </article>
      <article class="card">
        <h3>In the browser</h3>
        <p>Nothing to install: drop the scanner's card or a folder of JPEGs on the page. Nothing leaves your computer except what you send to your own Immich.</p>
        <div class="card-foot"><a class="button" href="/app/">Open Slide Station</a></div>
        <p class="fine">Best in Chrome or Edge. <a href="/docs#in-the-browser-nothing-to-install">What works where</a></p>
      </article>
      <article class="card">
        <h3>Next to Immich</h3>
        <p>A container on the server that runs Immich, used from any browser. Scans upload to the server, which does the work and sends slides on to Immich.</p>
        <div class="card-foot"><a class="button" href="/docs#next-to-immich-as-a-container">Set it up</a></div>
        <p class="fine">Docker · accounts per Immich user</p>
      </article>
    </div>
  </div>
</section>

<section id="testflight" class="split">
  <div class="bar">
    <div>
      <h2>iPad and iPhone beta</h2>
      <p>Plug the Slide N Scan into an iPad, import a tray, keep, skip or turn each slide, and send it to Immich. No Mac needed. It's coming to TestFlight: leave your email and you'll get an invite when there's room.</p>
      <p class="fine">Your address is only used for the TestFlight invite, and nothing else.</p>
    </div>
    <form class="waitlist" method="post" action="/waitlist" data-state="${joined ? "joined" : ""}">
      <div class="joined" role="status">${joined ? "<strong>You're on the list.</strong> Thanks! The invite will come from TestFlight." : ""}</div>
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
      <p>Slide Station is free and open source. If it rescued a box of family slides, a tip keeps it going.</p>
    </div>
    <a class="button primary" href="${esc(tip.url)}" rel="noopener">${esc(tip.label)}</a>
  </div>
</section>`
    : ""
}

<section class="links">
  <div class="bar">
    <h2>Links</h2>
    <ul>
      <li><a href="/docs">Documentation</a><span>Setup, the workflow per tray, Immich, film stock, people, places</span></li>
      <li><a href="/changelog">Changelog</a><span>Every release, newest first</span></li>
      <li><a href="${GH}">Source code</a><span>GitHub, MIT licence</span></li>
      <li><a href="${GH}/issues">Issues</a><span>Report a problem or ask for something</span></li>
      <li><a href="${GH}/releases">All releases</a><span>Older versions and the zip builds</span></li>
      <li><a href="${GH}/blob/main/ROADMAP.md">Roadmap</a><span>What's next</span></li>
    </ul>
  </div>
</section>
</main>`,
  });
}

export function docs(page, all) {
  const side = all
    .map(
      (p) =>
        `<li><a href="/docs${p.slug ? `/${p.slug}` : ""}"${p === page ? ' aria-current="page"' : ""}>${esc(p.title)}</a>${
          p === page
            ? `<ul>${p.toc.filter((t) => t.depth === 2).map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join("")}</ul>`
            : ""
        }</li>`,
    )
    .join("");
  return layout({
    title: `${page.title} · Slide Station docs`,
    description: "How to set up and use Slide Station.",
    current: "/docs",
    wide: true,
    body: `<main class="docs bar wide">
  <aside><nav aria-label="Documentation"><ul>${side}</ul></nav></aside>
  <article class="prose">${page.html}<p class="fine"><a href="${page.source}">Edit this page on GitHub</a></p></article>
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
