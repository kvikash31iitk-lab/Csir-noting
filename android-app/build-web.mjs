/*
 * Builds the web assets the Android app serves, into ./www
 *  - bundles src/entry.jsx (which imports ../NoteSheetGenerator.jsx) via esbuild
 *  - generates Tailwind CSS (scanning the artifact + wrapper) via PostCSS
 *  - copies index.html + wrapper.js into www/
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "tailwindcss";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const www = path.join(root, "www");
fs.mkdirSync(www, { recursive: true });

/* 1. bundle JS */
await build({
  entryPoints: [path.join(root, "src/entry.jsx")],
  bundle: true,
  format: "iife",
  loader: { ".jsx": "jsx" },
  jsx: "transform",
  nodePaths: [path.join(root, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(www, "app.bundle.js"),
  logLevel: "info",
});

/* 2. Tailwind CSS */
const css = await postcss([
  tailwind({
    content: [
      path.join(root, "../NoteSheetGenerator.jsx"),
      path.join(root, "src/**/*.{jsx,js,html}"),
    ],
    theme: { extend: {} },
    corePlugins: { preflight: true },
  }),
]).process("@tailwind base;@tailwind components;@tailwind utilities;", {
  from: "input.css",
  to: "www/app.css",
});
fs.writeFileSync(path.join(www, "app.css"), css.css);

/* 3. static files (with cache-busting so browsers never serve stale assets) */
const v = Date.now().toString(36);
let html = fs.readFileSync(path.join(root, "src/index.html"), "utf8");
html = html
  .replace('href="app.css"', 'href="app.css?v=' + v + '"')
  .replace('src="wrapper.js"', 'src="wrapper.js?v=' + v + '"')
  .replace('src="app.bundle.js"', 'src="app.bundle.js?v=' + v + '"');
fs.writeFileSync(path.join(www, "index.html"), html);
fs.copyFileSync(path.join(root, "src/wrapper.js"), path.join(www, "wrapper.js"));

console.log("Web build complete ->", www, "(asset version " + v + ")");
