/*
 * Local Obsidian bridge for CSIR Note Sheet.
 *
 * Runs on YOUR PC, next to your Obsidian vault (a vault is just a folder of
 * .md files — this does not need Obsidian itself to be running). Exposes a
 * small localhost API the app can call to:
 *   - export generated notes and "Teach this" learning into the vault
 *   - search the vault for context to feed back into generation
 *
 * Intentionally local-only, like chatgpt-bridge/ — it never leaves your PC.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

function loadDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!m || process.env[m[1]] !== undefined) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) value = value.slice(1, -1);
      process.env[m[1]] = value;
    }
  } catch (_) {}
}
loadDotEnv(path.join(__dirname, ".env"));

const PORT = parseInt(process.env.PORT || "8791", 10);
const HOST = process.env.HOST || "127.0.0.1";
const VAULT_PATH = process.env.VAULT_PATH || "";
const SUBFOLDER = process.env.OBSIDIAN_SUBFOLDER || "CSIR Notes";
const SEARCH_MAX_FILES = parseInt(process.env.SEARCH_MAX_FILES || "2000", 10);

if (!VAULT_PATH) {
  console.warn(
    "[obsidian-bridge] VAULT_PATH is not set. Copy .env.example to .env and " +
    "point it at your Obsidian vault folder (e.g. C:\\Users\\you\\Documents\\MyVault)."
  );
} else if (!fs.existsSync(VAULT_PATH)) {
  console.warn("[obsidian-bridge] VAULT_PATH does not exist: " + VAULT_PATH);
}

const notesDir = () => path.join(VAULT_PATH, SUBFOLDER);
function ensureNotesDir() {
  fs.mkdirSync(notesDir(), { recursive: true });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/* Sanitize a string into a filesystem-safe filename fragment (works on
 * Windows, macOS, Linux). */
function safeFilenamePart(s, maxLen) {
  const cleaned = String(s || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Untitled").slice(0, maxLen || 80);
}

/* Render a generated note's structured fields as readable markdown. Falls
 * back to raw JSON if it isn't the expected shape (still useful, just less
 * pretty), so nothing is ever silently dropped. */
function noteToMarkdownBody(json1) {
  let note = null;
  try { note = JSON.parse(json1); } catch (_) { return String(json1 || ""); }
  if (!note || typeof note !== "object") return String(json1 || "");
  const lines = [];
  const head = [note.header, note.department].filter(Boolean).join(" — ");
  if (head) lines.push("**" + head + "**", "");
  if (note.date) lines.push("**Date:** " + note.date);
  if (note.subject) lines.push("**Subject:** " + note.subject);
  if (note.hindiSubject) lines.push("**हिंदी विषय:** " + note.hindiSubject);
  if (note.reference) lines.push("**Reference:** " + note.reference);
  lines.push("");
  if (Array.isArray(note.paragraphs)) {
    for (const p of note.paragraphs) if (p) lines.push(String(p), "");
  }
  if (Array.isArray(note.detailsBlock) && note.detailsBlock.length) {
    lines.push("| Field | Value |", "|---|---|");
    for (const d of note.detailsBlock) {
      lines.push(
        "| " + String((d && d.label) || "").replace(/\|/g, "/") +
        " | " + String((d && d.value) || "").replace(/\|/g, "/") + " |"
      );
    }
    lines.push("");
  }
  if (note.closingLine) lines.push(String(note.closingLine), "");
  if (Array.isArray(note.signatureChain) && note.signatureChain.length) {
    lines.push("**Signature Chain:** " + note.signatureChain.join(" → "));
  }
  return lines.join("\n").trim();
}

function yamlEscape(s) {
  return String(s || "").replace(/"/g, '\\"');
}

/* ---------------- export: notes ---------------- */
function exportNote(body) {
  ensureNotesDir();
  const title = body.title || "Untitled note";
  const addedAt = body.addedAt || Date.now();
  const dateStr = new Date(addedAt).toISOString().slice(0, 10);
  const fname = dateStr + " - " + safeFilenamePart(title) + ".md";
  const fpath = path.join(notesDir(), fname);

  const parts = [];
  parts.push("---");
  parts.push('title: "' + yamlEscape(title) + '"');
  parts.push("date: " + new Date(addedAt).toISOString());
  parts.push("tags: [csir-note]");
  if (body.language) parts.push('language: "' + yamlEscape(body.language) + '"');
  if (Array.isArray(body.chain) && body.chain.length) {
    parts.push("signatureChain: " + JSON.stringify(body.chain));
  }
  parts.push("---", "");
  parts.push("# " + title, "");
  if (body.instructions) {
    parts.push("## Instructions", "", String(body.instructions), "");
  }
  if (body.final) {
    parts.push("## Final", "", noteToMarkdownBody(body.final), "");
  } else if (body.draft) {
    parts.push("## Draft", "", noteToMarkdownBody(body.draft), "");
  }

  fs.writeFileSync(fpath, parts.join("\n"), "utf8");
  return { file: path.join(SUBFOLDER, fname) };
}

/* ---------------- export: learning (append-only log) ---------------- */
function exportLearning(body) {
  ensureNotesDir();
  const fpath = path.join(notesDir(), "Learning.md");
  const text = String(body.text || "").trim();
  if (!text) throw new Error("empty text");
  const addedAt = body.addedAt || Date.now();
  const line = "- [" + new Date(addedAt).toISOString().slice(0, 10) + "] " + text;
  if (!fs.existsSync(fpath)) {
    fs.writeFileSync(fpath, "# Standing Instructions (Learning)\n\ntags: [csir-note]\n\n" + line + "\n", "utf8");
  } else {
    fs.appendFileSync(fpath, line + "\n", "utf8");
  }
  return { file: path.join(SUBFOLDER, "Learning.md") };
}

/* ---------------- search: simple recursive full-text over the vault ---------------- */
function walkMdFiles(dir, out, budget) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (out.length >= budget.max) return;
    if (e.name.startsWith(".")) continue; // skip .obsidian/ and other dotfolders
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMdFiles(full, out, budget);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(full);
  }
}

function searchVault(q, k) {
  const terms = String(q || "").toLowerCase().match(/[a-z0-9ऀ-ॿ]{3,}/g) || [];
  if (!terms.length) return [];
  const files = [];
  walkMdFiles(VAULT_PATH, files, { max: SEARCH_MAX_FILES });

  const scored = [];
  for (const fpath of files) {
    let text;
    try { text = fs.readFileSync(fpath, "utf8"); } catch (_) { continue; }
    const hay = text.toLowerCase();
    let score = 0, firstIdx = -1;
    for (const t of terms) {
      let idx = 0, c = 0;
      while ((idx = hay.indexOf(t, idx)) !== -1) {
        c++;
        if (firstIdx === -1) firstIdx = idx;
        idx += t.length;
      }
      score += c;
    }
    if (score > 0) {
      const start = Math.max(0, firstIdx - 150);
      const snippet = text.slice(start, start + 500).trim();
      scored.push({
        score,
        file: path.relative(VAULT_PATH, fpath),
        snippet,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k || 5);
}

/* ---------------- HTTP server ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Private-Network": "true",
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      vault: VAULT_PATH || null,
      vaultExists: !!VAULT_PATH && fs.existsSync(VAULT_PATH),
      subfolder: SUBFOLDER,
    });
  }

  if (req.method === "GET" && url.pathname === "/search") {
    if (!VAULT_PATH) return json(res, 500, { error: "VAULT_PATH is not configured" });
    try {
      const q = url.searchParams.get("q") || "";
      const k = parseInt(url.searchParams.get("k") || "5", 10);
      return json(res, 200, { results: searchVault(q, k) });
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) });
    }
  }

  if (req.method === "POST" && url.pathname === "/export/note") {
    if (!VAULT_PATH) return json(res, 500, { error: "VAULT_PATH is not configured" });
    return readBody(req)
      .then((body) => json(res, 200, exportNote(body)))
      .catch((e) => json(res, 400, { error: String((e && e.message) || e) }));
  }

  if (req.method === "POST" && url.pathname === "/export/learning") {
    if (!VAULT_PATH) return json(res, 500, { error: "VAULT_PATH is not configured" });
    return readBody(req)
      .then((body) => json(res, 200, exportLearning(body)))
      .catch((e) => json(res, 400, { error: String((e && e.message) || e) }));
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(
    "obsidian-bridge listening on http://" + HOST + ":" + PORT +
    " (vault: " + (VAULT_PATH || "NOT SET") + ")"
  );
});
