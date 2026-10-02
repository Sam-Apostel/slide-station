// Renders the user docs in docs/ into dist/docs.json for the /docs pages. Runs at image build time
// (and before `npm run dev`), so the server needs no Markdown parser at runtime. The same files
// read fine on GitHub: links between them are relative .md links, rewritten here.
import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";

const here = import.meta.dirname;
const repo = path.resolve(here, "..");
const blob = "https://github.com/Sam-Apostel/slide-station/blob/main/";

// sidebar order; the title is each file's first heading
const PAGES = [
  { slug: "", file: "docs/getting-started.md" },
  { slug: "workflow", file: "docs/workflow.md" },
  { slug: "immich", file: "docs/immich.md" },
  { slug: "suggestions", file: "docs/suggestions.md" },
  { slug: "people-and-places", file: "docs/people-and-places.md" },
  { slug: "browser", file: "docs/browser.md" },
  { slug: "self-hosting", file: "docs/self-hosting.md" },
  { slug: "tips", file: "docs/tips.md" },
];

export const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

function render(page) {
  const dir = path.posix.dirname(page.file);
  const toc = [];
  const seen = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        let id = slugify(html);
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id += `-${n}`;
        if (depth === 2 || depth === 3) toc.push({ id, depth, html });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        // links between the docs stay on the site; other repository paths go to GitHub
        href = href.replace(/^https:\/\/slide-station\.sams\.land(?=\/)/, "");
        if (!/^([a-z]+:|#|\/)/i.test(href)) {
          const [file, hash] = href.split("#");
          const target = path.posix.normalize(path.posix.join(dir, file));
          const doc = PAGES.find((p) => p.file === target);
          href = (doc ? `/docs${doc.slug ? `/${doc.slug}` : ""}` : blob + target) + (hash ? `#${hash}` : "");
        }
        const external = /^https?:/.test(href) ? ' rel="noopener"' : "";
        return `<a href="${href}"${title ? ` title="${title}"` : ""}${external}>${text}</a>`;
      },
    },
  });
  const md = fs.readFileSync(path.join(repo, page.file), "utf8");
  const html = marked.parse(md);
  const title = md.match(/^# (.+)$/m)?.[1] ?? page.slug;
  return { slug: page.slug, title, source: blob + page.file, html, toc };
}

fs.mkdirSync(path.join(here, "dist"), { recursive: true });
const docs = PAGES.map(render);
fs.writeFileSync(path.join(here, "dist/docs.json"), JSON.stringify(docs));
console.log(`docs: ${docs.map((d) => `${d.slug || "guide"} (${d.toc.length} sections)`).join(", ")}`);
