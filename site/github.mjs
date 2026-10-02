// Releases from GitHub, for the download buttons and the changelog. Every push to main is a release
// (.github/workflows/release.yml) whose notes are the commit message, so the changelog is those
// messages, tidied: the PR title instead of "Merge pull request #n from …", housekeeping left out.
export const REPO = "Sam-Apostel/slide-station";

const TTL = 10 * 60 * 1000; // unauthenticated, GitHub allows 60 requests an hour per IP
let cache = { at: 0, releases: [] };
let pending = null;

export async function releases() {
  if (Date.now() - cache.at < TTL) return cache.releases;
  pending ??= load().finally(() => (pending = null));
  try {
    return await pending;
  } catch (err) {
    console.error("releases:", err.message);
    cache.at = Date.now() - TTL + 60_000; // retry in a minute, keep serving what we had
    return cache.releases;
  }
}

async function load() {
  const headers = { accept: "application/vnd.github+json", "user-agent": "slide-station-site" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const list = (await res.json()).filter((r) => !r.draft && !r.prerelease).map(tidy);
  cache = { at: Date.now(), releases: list };
  return list;
}

const HOUSEKEEPING = /^(merge (origin\/)?main|merge branch|rebuild the web|bump|wip\b)/i;

function tidy(r) {
  const lines = (r.body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(co-authored-by|signed-off-by):/i.test(l));
  let title = lines[0] ?? "";
  let pr = null;
  let rest = lines.slice(1);
  const merge = title.match(/^Merge pull request #(\d+) from /);
  if (merge) {
    pr = Number(merge[1]);
    title = rest[0] ?? title;
    rest = rest.slice(1);
  }
  const dmg = r.assets.find((a) => a.name.endsWith(".dmg"));
  const zip = r.assets.find((a) => a.name.endsWith("-mac.zip"));
  return {
    version: r.tag_name.replace(/^v/, ""),
    tag: r.tag_name,
    url: r.html_url,
    date: r.published_at,
    title,
    details: rest,
    pr,
    housekeeping: HOUSEKEEPING.test(title),
    dmg: dmg && { url: dmg.browser_download_url, size: dmg.size, name: dmg.name },
    zip: zip && { url: zip.browser_download_url, size: zip.size, name: zip.name },
  };
}

export async function latest() {
  return (await releases()).find((r) => r.dmg) ?? null;
}
