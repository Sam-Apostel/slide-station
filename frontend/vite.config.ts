import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The built UI is committed to slidestation/web so the app runs without Node.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  base: "./",
  build: { outDir: "../slidestation/web", emptyOutDir: true },
  server: { proxy: { "/api": `http://localhost:${process.env.SLIDESTATION_PORT || 8765}` } },
});
