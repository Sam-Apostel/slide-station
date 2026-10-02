// slide-station.sams.land: the homepage, docs, changelog and waitlist, plus the browser version of
// the app under /app. Node's own http server; the only state is the waitlist (waitlist.mjs).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as views from "./views.mjs";
import * as waitlist from "./waitlist.mjs";
import { releases, latest } from "./github.mjs";

const here = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 8080);
const ORIGIN = process.env.SITE_ORIGIN ?? "https://slide-station.sams.land";
// the browser version (frontend: `npm run build:web`); the Dockerfile builds it into here
const APP_DIR = path.resolve(process.env.APP_DIR ?? path.join(here, "../frontend/dist-web"));
const ASSETS_DIRS = [path.join(here, "public"), path.resolve(here, "../frontend/public")]; // + the app's icons
const DOCS = JSON.parse(fs.readFileSync(path.join(here, "dist/docs.json"), "utf8"));
const TIP = process.env.TIP_URL ? { url: process.env.TIP_URL, label: process.env.TIP_LABEL || "Leave a tip" } : null;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...PAGE_HEADERS, "cache-control": "no-cache", ...headers });
  res.end(body);
}

function redirect(res, location, status = 303) {
  res.writeHead(status, { location, "cache-control": "no-cache" });
  res.end();
}

/** Serves a file below root, or returns false. */
function serveFile(req, res, root, rel, { immutable = false } = {}) {
  const file = path.join(root, path.normalize(`/${rel}`));
  if (!file.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
  const headers = {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "x-content-type-options": "nosniff",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end(), true;
  }
  res.writeHead(200, { ...headers, "content-length": stat.size });
  if (req.method === "HEAD") return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

// A few waitlist sign-ups per address per hour is plenty; this stops a script filling the table.
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 3600_000);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) attempts.clear();
  return recent.length > 10;
}

function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error("too large")), req.destroy();
    });
    req.on("end", () => {
      try {
        const type = req.headers["content-type"] ?? "";
        resolve(type.includes("json") ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body)));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function authorised(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const [scheme, value = ""] = (req.headers.authorization ?? "").split(" ");
  const given =
    scheme === "Bearer" ? value : scheme === "Basic" ? Buffer.from(value, "base64").toString().split(":").slice(1).join(":") : "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  const get = req.method === "GET" || req.method === "HEAD";

  if (p === "/healthz") return send(res, 200, "ok", { "content-type": "text/plain" });

  if (p === "/app") return redirect(res, "/app/", 301);
  if (p.startsWith("/app/") && get) {
    const rel = decodeURIComponent(p.slice(5)) || "index.html";
    if (serveFile(req, res, APP_DIR, rel, { immutable: rel.startsWith("assets/") })) return;
    // the app is a single page: anything unknown that isn't a file gets index.html
    if (!path.extname(rel) && serveFile(req, res, APP_DIR, "index.html")) return;
    return send(res, 404, views.notFound());
  }
  if (p.startsWith("/assets/") && get) {
    const rel = decodeURIComponent(p.slice(8));
    if (ASSETS_DIRS.some((dir) => serveFile(req, res, dir, rel))) return;
    return send(res, 404, "not found", { "content-type": "text/plain" });
  }

  if (p === "/" && get) {
    const state = url.searchParams.get("joined") ? "joined" : url.searchParams.get("error");
    return send(res, 200, views.home({ release: await latest(), waitlistState: state, tip: TIP }));
  }
  if ((p === "/docs" || p.startsWith("/docs/")) && get) {
    const slug = p.replace(/^\/docs\/?/, "").replace(/\/$/, "");
    const page = DOCS.find((d) => d.slug === slug);
    if (page) return send(res, 200, views.docs(page, DOCS));
  }
  if (p === "/changelog" && get) return send(res, 200, views.changelog(await releases()));
  if (p === "/changelog.atom" && get) {
    return send(res, 200, views.atom(await releases(), ORIGIN), {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": "public, max-age=600",
    });
  }
  // stable links to the newest build, for READMEs and posts
  if ((p === "/download/mac" || p === "/download/mac.zip") && get) {
    const release = await latest();
    const asset = p.endsWith(".zip") ? release?.zip : release?.dmg;
    return redirect(res, asset?.url ?? "https://github.com/Sam-Apostel/slide-station/releases/latest", 302);
  }

  if (p === "/waitlist" && req.method === "POST") {
    const wantsJson = (req.headers.accept ?? "").includes("application/json");
    let error = null;
    try {
      const form = await readForm(req);
      if (form.website) error = null; // the honeypot: pretend it worked
      else if (limited(req.headers["x-forwarded-for"]?.split(",")[0].trim() ?? req.socket.remoteAddress)) {
        error = "Too many tries from here. Please try again later.";
      } else error = waitlist.join(form.email, form.device);
    } catch {
      error = "Something went wrong reading that form.";
    }
    if (wantsJson) return send(res, error ? 400 : 200, JSON.stringify({ ok: !error, error }), { "content-type": "application/json" });
    return redirect(res, error ? `/?error=${encodeURIComponent(error)}#testflight` : "/?joined=1#testflight");
  }

  if (p === "/admin/waitlist.csv" && get) {
    if (!authorised(req)) return send(res, 401, "sign in", { "content-type": "text/plain", "www-authenticate": 'Basic realm="waitlist"' });
    return send(res, 200, waitlist.csv(), {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="slide-station-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  send(res, 404, views.notFound());
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(req.method, req.url, err);
      if (!res.headersSent) send(res, 500, "Something went wrong.", { "content-type": "text/plain" });
      else res.end();
    });
  })
  .listen(PORT, () => {
    console.log(`slide-station site on :${PORT} (app from ${APP_DIR}, ${waitlist.count()} on the waitlist)`);
    releases(); // warm the cache
  });
