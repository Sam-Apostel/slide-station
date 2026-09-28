// Renders the repository's READMEs into dist/docs.json for the /docs pages. Runs at image build
// time (and before `npm run dev`), so the server needs no Markdown parser at runtime.
import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";

const here = import.meta.dirname;
const repo = path.resolve(here, "..");
const blob = "https://github.com/Sam-Apostel/slide-station/blob/main/";

// slug → source file, in sidebar order
const PAGES = [
  { slug: "", file: "README.md", title: "Guide" },
  { slug: "desktop", file: "desktop/README.md", title: "Desktop app" },
  { slug: "ipad", file: "apple/README.md", title: "iPad and iPhone" },
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
        // links between the READMEs stay on the site; other repository paths go to GitHub
        if (!/^([a-z]+:|#|\/)/i.test(href)) {
          const target = path.posix.normalize(path.posix.join(dir, href));
          const doc = PAGES.find((p) => p.file === target);
          href = doc ? `/docs/${doc.slug}` : blob + target;
        }
        const external = /^https?:/.test(href) ? ' rel="noopener"' : "";
        return `<a href="${href}"${title ? ` title="${title}"` : ""}${external}>${text}</a>`;
      },
    },
  });
  const md = fs.readFileSync(path.join(repo, page.file), "utf8");
  const html = marked.parse(md);
  return { slug: page.slug, title: page.title, source: blob + page.file, html, toc };
}

fs.mkdirSync(path.join(here, "dist"), { recursive: true });
const docs = PAGES.map(render);
fs.writeFileSync(path.join(here, "dist/docs.json"), JSON.stringify(docs));
console.log(`docs: ${docs.map((d) => `${d.slug || "guide"} (${d.toc.length} sections)`).join(", ")}`);
