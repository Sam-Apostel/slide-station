import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The built UI is committed to slidestation/web so the app runs without Node.
// `--mode web` builds the browser-only version (no backend; src/standalone) into dist-web, a static
// site that can be hosted anywhere.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        // the server build never runs the browser engine: don't bundle it (or its worker)
        ...(web ? [] : [{ find: /^@\/standalone\/.*$/, replacement: path.resolve(import.meta.dirname, "src/standalone/absent.ts") }]),
        { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
      ],
    },
    base: "./",
    define: { "import.meta.env.VITE_STANDALONE": JSON.stringify(web ? "1" : "") },
    worker: { format: "es" },
    build: { outDir: web ? "dist-web" : "../slidestation/web", emptyOutDir: true },
    server: web
      ? // the browser version's face detector is the Python app's model file (engine.worker.ts)
        {
          fs: {
            allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(import.meta.dirname, "../slidestation/models")],
          },
        }
      : { proxy: { "/api": `http://localhost:${process.env.SLIDESTATION_PORT || 8765}` } },
  };
});
