/*
 * CSIR Note Sheet — backend "brain" for the note-sheet app
 * --------------------------------------------------------
 * Generation is provider-selectable via AI_PROVIDER:
 *   "antigravity" (default) — runs the `agy` (Antigravity CLI) binary, logged
 *     in via "Login with Google" against a Gemini/Antigravity subscription,
 *     so no per-call API billing. See the runAgy() block below for its known
 *     quirks (argv-only prompt, permission-gated file reads, etc).
 *   "openai" — calls the OpenAI Responses API directly with OPENAI_API_KEY
 *     (real per-call billing).
 * Also keeps a small, file-based memory so the app becomes a growing
 * institutional assistant.
 *
 * Endpoints
 *   GET  /health                      liveness + active provider info
 *   POST /generate {system,user}      stateless text/JSON generation (unchanged)
 *   POST /extract  {dataUrl|base64}   OCR a scan/image/PDF via the active provider
 *   POST /login    {password}         -> { token }  (Bearer for the routes below)
 *   GET  /brain                       full memory (learning, references, rules, notes)
 *   POST /brain/learning {text}       add a standing instruction
 *   DELETE /brain/learning/:id
 *   POST /brain/reference {name,...}  remember a reference-noting style analysis
 *   DELETE /brain/reference/:id
 *   POST /brain/rule {name,text}      add a rulebook (GFR/CCS/...) -> chunked + indexed
 *   DELETE /brain/rule/:id
 *   GET  /brain/rules/search?q=&k=    keyword retrieval over rule sections (RAG)
 *   POST /brain/note {title,...}      save a generated/edited note to history
 *   GET  /backup                      download the whole brain as JSON
 *
 * Config (environment variables):
 *   PORT, ALLOWED_ORIGIN, AI_PROVIDER (antigravity|openai), TIMEOUT_MS,
 *   OCR_TIMEOUT_MS,
 *   AGY_BIN, AGY_MODEL, AGY_EXTRA_ARGS, AGY_INLINE_LIMIT   (antigravity)
 *   OPENAI_API_KEY, OPENAI_MODEL, OPENAI_VISION_MODEL,
 *   OPENAI_BASE_URL, OPENAI_MAX_OUTPUT_TOKENS               (openai)
 *   APP_PASSWORD   password gating the /brain + /extract routes (unset = open)
 *   APP_SECRET     HMAC secret for tokens (defaults derived from APP_PASSWORD)
 *   DATA_DIR       where brain.json lives (default ./data)
 */
const express = require("express");
const { spawn } = require("child_process");
const crypto = require("crypto");
const https = require("https");
const os = require("os");
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

const PORT = parseInt(process.env.PORT || "8787", 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "120000", 10);

// Which backend generates text: "antigravity" (subscription CLI, no per-call
// billing — the default) or "openai" (real API-key billing).
const AI_PROVIDER = (process.env.AI_PROVIDER || "antigravity").trim().toLowerCase();

// --- antigravity (agy) config ---
// Prefer an absolute path here (e.g. /root/.local/bin/agy) — pm2's environment
// often doesn't carry the interactive shell's PATH additions.
const AGY_BIN = process.env.AGY_BIN || "agy";
const AGY_MODEL = process.env.AGY_MODEL || ""; // must exactly match a name from `agy models`
const AGY_EXTRA_ARGS = (process.env.AGY_EXTRA_ARGS || "").split(" ").filter(Boolean);
// Prompts at or under this many characters go straight on the CLI argv; longer
// ones are written to a temp file and referenced via @/abs/path instead, to
// stay well clear of the OS arg-length limit (E2BIG), which is typically ~2MB
// on Linux but shrinks with a large environment block.
const AGY_INLINE_LIMIT = parseInt(process.env.AGY_INLINE_LIMIT || "100000", 10);

// --- openai config ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_MODEL;
const OPENAI_MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "4000", 10);
const OPENAI_OCR_MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_OCR_MAX_OUTPUT_TOKENS || "6000", 10);
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "";

// Fixed identity/formatting instruction prepended to every /generate prompt,
// regardless of provider.
const BASE_SYSTEM =
  "You are a precise writing assistant for Indian government office notings. " +
  "Follow the instructions in the user message exactly and output ONLY what is " +
  "requested (raw JSON when asked) — no preamble, no markdown, no code fences.";

// --- accounts ---
// Built-in users (override with a USERS env var: JSON array of
// {username,password,role}). Roles: "admin" (full control incl. deleting rules
// and downloading backups) or "general" (use everything, contribute rules &
// learning, but not delete the shared library or export it).
const DEFAULT_USERS = [
  { username: "vikash", password: "vikash", role: "general" },
  { username: "admin", password: "admin1", role: "admin" },
];
let USERS = DEFAULT_USERS;
try { if (process.env.USERS) USERS = JSON.parse(process.env.USERS); } catch (_) {}
// Optional legacy single password -> admin login.
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const APP_SECRET =
  process.env.APP_SECRET ||
  crypto
    .createHash("sha256")
    .update(
      "csir-note::" +
        USERS.map((u) => u.username + ":" + u.password + ":" + u.role).join("|") +
        "::" + APP_PASSWORD
    )
    .digest("hex");
// Google sign-in (general users). Set GOOGLE_CLIENT_ID to enable; optionally
// restrict to GOOGLE_ALLOWED_EMAILS (comma-separated). Empty allowlist means any
// Google account with a verified email is accepted as a general user.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_ALLOWED_EMAILS = (process.env.GOOGLE_ALLOWED_EMAILS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// Google accounts that should sign in with the admin role.
const GOOGLE_ADMIN_EMAILS = (process.env.GOOGLE_ADMIN_EMAILS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// --- startup security warnings (loud, but non-fatal so the app never bricks) ---
if (!process.env.USERS) {
  console.warn(
    "[SECURITY] Using built-in default users (vikash/vikash, admin/admin1). " +
    "Set the USERS env var to strong credentials in production."
  );
}
if (!process.env.APP_SECRET) {
  console.warn(
    "[SECURITY] APP_SECRET is unset and is being DERIVED from the user list — " +
    "tokens are forgeable from the source. Set APP_SECRET=$(openssl rand -hex 32)."
  );
}

if (AI_PROVIDER === "openai" && !OPENAI_API_KEY) {
  console.warn("[AI] AI_PROVIDER=openai but OPENAI_API_KEY is unset. /generate and /extract will fail until it is configured.");
} else if (AI_PROVIDER !== "openai" && AI_PROVIDER !== "antigravity") {
  console.warn("[AI] Unknown AI_PROVIDER '" + AI_PROVIDER + "' — falling back to antigravity behavior.");
}
if (AI_PROVIDER !== "openai") {
  console.warn(
    "[SECURITY] Requests that reference a file (oversized /generate prompts, all " +
    "/extract OCR calls) run agy with --dangerously-skip-permissions, which " +
    "auto-approves ALL tool calls, not just the file read — a prompt-injection " +
    "risk from untrusted uploaded document text. Ordinary /generate calls do not " +
    "use this flag. See note-api/README.md."
  );
}

// Neutral, empty working dir so agy's /generate calls have no project/code to
// "look at" (antigravity only).
const NEUTRAL_CWD = process.env.AGY_CWD || path.join(os.tmpdir(), "csir-note-api-cwd");
try { fs.mkdirSync(NEUTRAL_CWD, { recursive: true }); } catch (_) {}

/* ------------------------------------------------------------------ *
 *  File-based memory ("the brain")
 * ------------------------------------------------------------------ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const BRAIN_FILE = path.join(DATA_DIR, "brain.json");

const EMPTY_BRAIN = { learning: [], references: [], rules: [], notes: [] };
function loadBrain() {
  try {
    const b = JSON.parse(fs.readFileSync(BRAIN_FILE, "utf8"));
    return Object.assign({}, EMPTY_BRAIN, b);
  } catch (_) { return JSON.parse(JSON.stringify(EMPTY_BRAIN)); }
}
let brain = loadBrain();
function saveBrain() {
  const tmp = BRAIN_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(brain, null, 2));
  fs.renameSync(tmp, BRAIN_FILE);
}
const newId = () => crypto.randomBytes(8).toString("hex");

/* Split a rulebook into searchable sections. Detects "Rule/Section/Para N"
 * headings where possible and otherwise packs ~1200-char windows. */
function chunkRuleText(text) {
  const clean = String(text).replace(/\r/g, "");
  // Split into paragraphs, then HARD-split any paragraph longer than ~1500 chars
  // (scanned/PDF rulebooks often have almost no blank lines -> one giant block).
  const paras = [];
  for (let p of clean.split(/\n{2,}/)) {
    p = p.trim();
    if (!p) continue;
    while (p.length > 1500) { paras.push(p.slice(0, 1500)); p = p.slice(1500); }
    paras.push(p);
  }
  const headRe =
    /\b(Rule|Section|Para(?:graph)?|Article|Clause|Regulation|GFR|FR|SR)\s+([0-9]+[A-Za-z()\-.]*)/i;
  const chunks = [];
  let buf = "", label = "";
  const flush = () => { if (buf.trim()) { chunks.push({ label, text: buf.trim() }); buf = ""; } };
  for (const p of paras) {
    const m = p.match(headRe);
    if (m && buf.length > 400) flush();
    if (m) label = (m[1] + " " + m[2]).replace(/\s+/g, " ").trim();
    buf += (buf ? "\n\n" : "") + p;
    if (buf.length >= 1200) flush();
  }
  flush();
  return chunks.map((c, i) => ({ idx: i, label: c.label || "", text: c.text }));
}

/* Keyword retrieval over all rule sections (the "R" in RAG, phase-1 simple). */
function searchRules(q, limit) {
  const terms = (String(q || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 30);
  if (!terms.length) return [];
  const out = [];
  for (const rule of brain.rules) {
    for (const ch of rule.sections || []) {
      const hay = ((ch.label || "") + " " + ch.text).toLowerCase();
      let score = 0;
      for (const t of terms) {
        let idx = 0, c = 0;
        while ((idx = hay.indexOf(t, idx)) !== -1) { c++; idx += t.length; }
        if (c) score += c;
        if ((ch.label || "").toLowerCase().indexOf(t) !== -1) score += 3;
      }
      if (score > 0)
        out.push({ score, ruleId: rule.id, ruleName: rule.name, label: ch.label, text: ch.text });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit || 6);
}

/* ------------------------------------------------------------------ *
 *  Auth (single-user password -> stateless HMAC token)
 * ------------------------------------------------------------------ */
function signToken(user) {
  const body = Buffer.from(
    JSON.stringify({ u: user.username, r: user.role, t: Date.now() })
  ).toString("base64url");
  const payload = "v2." + body;
  const sig = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("hex");
  return payload + "." + sig;
}
function verifyToken(tok) {
  const parts = String(tok || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  const payload = parts[0] + "." + parts[1];
  const expect = crypto.createHmac("sha256", APP_SECRET).update(payload).digest("hex");
  const a = Buffer.from(parts[2]); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return { username: d.u, role: d.r || "general" };
  } catch (_) { return null; }
}
function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const tok = h.indexOf("Bearer ") === 0 ? h.slice(7) : "";
  const u = verifyToken(tok);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user && req.user.role === "admin") return next();
    return res.status(403).json({ error: "admin only" });
  });
}

/* Verify a Google ID token via Google's tokeninfo endpoint (no extra deps). */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      })
      .on("error", reject);
  });
}
async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) throw new Error("google sign-in not configured");
  const info = await httpsGetJson(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)
  );
  if (!info || info.error || info.error_description) throw new Error("invalid google token");
  if (info.aud !== GOOGLE_CLIENT_ID) throw new Error("google token audience mismatch");
  const verified = info.email_verified === true || info.email_verified === "true";
  if (!info.email || !verified) throw new Error("google email not verified");
  const email = String(info.email).toLowerCase();
  if (GOOGLE_ALLOWED_EMAILS.length && GOOGLE_ALLOWED_EMAILS.indexOf(email) === -1)
    throw new Error("this Google account is not allowed");
  return email;
}

/* ------------------------------------------------------------------ *
 *  OpenAI Responses client (used by /generate and /extract)
 * ------------------------------------------------------------------ */
function outputTextFromResponse(data) {
  if (data && typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of (data && data.output) || []) {
    for (const part of item.content || []) {
      if (typeof part.text === "string") chunks.push(part.text);
      else if (typeof part.output_text === "string") chunks.push(part.output_text);
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAIResponses({ instructions, input, model, maxOutputTokens, timeoutMs }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  if (typeof fetch !== "function") throw new Error("Node.js 18+ fetch is required");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  const payload = {
    model: model || OPENAI_MODEL,
    input,
    store: false,
    max_output_tokens: maxOutputTokens || OPENAI_MAX_OUTPUT_TOKENS,
  };
  if (instructions) payload.instructions = instructions;
  if (OPENAI_REASONING_EFFORT) payload.reasoning = { effort: OPENAI_REASONING_EFFORT };

  try {
    const response = await fetch(OPENAI_BASE_URL + "/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}

    if (!response.ok) {
      const detail =
        (data && data.error && (data.error.message || data.error.code)) ||
        raw.slice(0, 400) ||
        "OpenAI request failed";
      throw new Error("openai HTTP " + response.status + ": " + detail);
    }

    const text = outputTextFromResponse(data);
    if (!text) throw new Error("openai returned no text");
    return text;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("openai timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 *  Antigravity CLI (`agy`) runner (used by /generate and /extract when
 *  AI_PROVIDER=antigravity)
 *
 *  `-p` takes the prompt as a literal argv string — there is no STDIN
 *  support (confirmed: piping without an explicit -p value errors with
 *  "flag needs an argument: -p"). Output is plain text on stdout, not JSON.
 *  needsFileTools must be true whenever promptText contains an `@/abs/path`
 *  reference, since reading it is permission-gated and headless mode cannot
 *  answer the interactive approval prompt (it hangs otherwise). A RELATIVE
 *  @path triggers a slow whole-filesystem search in this CLI version —
 *  always use absolute paths.
 * ------------------------------------------------------------------ */
function runAgy({ promptText, cwd, timeoutMs, needsFileTools }) {
  return new Promise((resolve, reject) => {
    const effTimeout = timeoutMs || TIMEOUT_MS;
    const args = ["-p", promptText, "--print-timeout", Math.ceil(effTimeout / 1000) + "s"];
    if (AGY_MODEL) args.push("--model", AGY_MODEL);
    if (needsFileTools) args.push("--dangerously-skip-permissions", "--sandbox");
    args.push(...AGY_EXTRA_ARGS);
    const env = Object.assign({}, process.env);

    let child;
    try { child = spawn(AGY_BIN, args, { env, cwd: cwd || NEUTRAL_CWD }); }
    catch (e) { return reject(new Error("could not start agy: " + e.message)); }

    let out = "", err = "", finished = false;
    const fin = (fn) => { if (!finished) { finished = true; fn(); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      fin(() => reject(new Error("agy timed out")));
    }, effTimeout);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); fin(() => reject(new Error("agy spawn error: " + e.message))); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return fin(() => reject(new Error("agy exited " + code + ": " + (err || out).slice(0, 400))));
      fin(() => resolve(out.trim()));
    });

    try { child.stdin.end(); } // -p takes the prompt as an argument, not stdin
    catch (_) {}
  });
}

/* ------------------------------------------------------------------ *
 *  Simple in-memory per-IP rate limiter (no external dependency)
 * ------------------------------------------------------------------ */
const _rlBuckets = new Map();
function rateLimit(opts) {
  const windowMs = opts.windowMs;
  const max = opts.max;
  return (req, res, next) => {
    const id = (req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0] || "unknown").trim();
    const now = Date.now();
    let b = _rlBuckets.get(id);
    if (!b || now - b.start >= windowMs) { b = { start: now, count: 0 }; _rlBuckets.set(id, b); }
    b.count++;
    if (b.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((b.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: "too many requests — please slow down" });
    }
    next();
  };
}
const _rlCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rlBuckets) if (now - v.start > 600000) _rlBuckets.delete(k);
}, 600000);
if (_rlCleanup.unref) _rlCleanup.unref();

/* ------------------------------------------------------------------ *
 *  HTTP app
 * ------------------------------------------------------------------ */
const app = express();
app.set("trust proxy", 1); // behind nginx — use X-Forwarded-For for req.ip
app.use(express.json({ limit: "30mb" })); // large enough for base64 scans

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => {
  const info = {
    ok: true,
    users: USERS.length,
    google: !!GOOGLE_CLIENT_ID,
    ai: AI_PROVIDER,
  };
  if (AI_PROVIDER === "openai") {
    info.model = OPENAI_MODEL;
    info.visionModel = OPENAI_VISION_MODEL;
    info.openaiConfigured = !!OPENAI_API_KEY;
  } else {
    info.agyBin = AGY_BIN;
    info.model = AGY_MODEL || "(agy default)";
  }
  res.json(info);
});

// --- generation (now authenticated + rate-limited; was previously open) ---
app.post("/generate", rateLimit({ windowMs: 60000, max: 40 }), requireAuth, async (req, res) => {
  const body = req.body || {};
  const system = typeof body.system === "string" ? body.system : "";
  const user = typeof body.user === "string" ? body.user : "";
  if (!user) return res.status(400).json({ error: "missing 'user' prompt" });

  let tmpFile = null;
  try {
    let text;
    if (AI_PROVIDER === "openai") {
      text = await callOpenAIResponses({
        instructions: BASE_SYSTEM + (system ? "\n\n" + system : ""),
        input: user,
        model: OPENAI_MODEL,
        maxOutputTokens: OPENAI_MAX_OUTPUT_TOKENS,
        timeoutMs: TIMEOUT_MS,
      });
    } else {
      const combined = system ? system + "\n\n=====\n\n" + user : user;
      const full = BASE_SYSTEM + "\n\n=====\n\n" + combined;
      // Small enough to go straight on argv; oversized prompts (big rulebook/RAG
      // context) are written to a temp file and referenced via @/abs/path instead,
      // to stay clear of the OS arg-length limit (E2BIG) — agy's -p has no STDIN
      // fallback, so this is the only way to keep large payloads off argv.
      let promptText = full, needsFileTools = false;
      if (full.length > AGY_INLINE_LIMIT) {
        tmpFile = path.join(NEUTRAL_CWD, "prompt-" + newId() + ".txt");
        fs.writeFileSync(tmpFile, full);
        promptText = BASE_SYSTEM + "\n\nFollow the instructions in @" + tmpFile + " exactly.";
        needsFileTools = true;
      }
      text = await runAgy({ promptText, cwd: NEUTRAL_CWD, timeoutMs: TIMEOUT_MS, needsFileTools });
    }
    res.json({ content: [{ type: "text", text }] });
  } catch (e) {
    console.error("[generate] error:", (e && e.stack) || e);
    const msg = String((e && e.message) || e);
    // Surface quota/limit distinctly so the UI can tell the operator; never leak stderr.
    if (/OPENAI_API_KEY/i.test(msg))
      return res.status(500).json({ error: "OpenAI API key is not configured", code: "config" });
    if (/limit|quota|usage|429|rate|insufficient_quota/i.test(msg))
      return res.status(429).json({ error: "AI usage limit reached - try again later", code: "quota" });
    if (/timed out|timeout/i.test(msg))
      return res.status(504).json({ error: "AI timed out - try a shorter note", code: "timeout" });
    res.status(500).json({ error: "generation failed", code: "error" });
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
  }
});

// --- OCR via the active provider's vision/file input ---
app.post("/extract", rateLimit({ windowMs: 60000, max: 20 }), requireAuth, async (req, res) => {
  const b = req.body || {};
  let raw = b.dataUrl || b.imageBase64 || b.base64 || "";
  let mime = b.mimeType || "";
  const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
  if (m) { mime = mime || m[1]; raw = m[2]; }
  if (!raw) return res.status(400).json({ error: "missing image/file data" });

  // Prefer the real file extension (handles PDFs); fall back to the mime type.
  let ext = "";
  const fe = String(b.filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (fe) ext = fe[1];
  if (!ext) ext = (b.ext || mime.split("/")[1] || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  if (!ext) ext = "png";

  const ocrPrompt =
    "Transcribe ALL text from the attached " + (ext === "pdf" ? "PDF" : "image") +
    " verbatim, preserving line breaks and layout where reasonable. It may " +
    "contain a mix of English and Hindi (Devanagari) — transcribe both faithfully. " +
    "Do not summarise, translate, or add commentary. Output ONLY the transcribed text.";
  const ocrTimeoutMs = parseInt(process.env.OCR_TIMEOUT_MS || "180000", 10);

  let dir = null;
  try {
    let text;
    if (AI_PROVIDER === "openai") {
      if (!mime) mime = ext === "pdf" ? "application/pdf" : "image/" + ext;
      const dataUrl = "data:" + mime + ";base64," + raw;
      const filename = String(b.filename || ("upload." + ext)).replace(/[^\w.\- ()]/g, "_");
      const filePart = ext === "pdf"
        ? { type: "input_file", filename, file_data: dataUrl, detail: "high" }
        : { type: "input_image", image_url: dataUrl };
      text = await callOpenAIResponses({
        input: [{ role: "user", content: [filePart, { type: "input_text", text: ocrPrompt }] }],
        model: OPENAI_VISION_MODEL,
        maxOutputTokens: OPENAI_OCR_MAX_OUTPUT_TOKENS,
        timeoutMs: ocrTimeoutMs,
      });
    } else {
      // agy needs a real file to @-reference (absolute path — a relative one
      // triggers a slow whole-filesystem search in this CLI version).
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
      const fpath = path.join(dir, "page." + ext);
      fs.writeFileSync(fpath, Buffer.from(raw, "base64"));
      const prompt = "Transcribe ALL of the text in @" + fpath + " verbatim. " + ocrPrompt;
      text = await runAgy({ promptText: prompt, cwd: dir, timeoutMs: ocrTimeoutMs, needsFileTools: true });
    }
    res.json({ text: String(text || "").trim() });
  } catch (e) {
    console.error("[extract] error:", (e && e.stack) || e);
    const msg = String((e && e.message) || e);
    if (/OPENAI_API_KEY/i.test(msg))
      return res.status(500).json({ error: "OpenAI API key is not configured", code: "config" });
    if (/limit|quota|usage|429|rate|insufficient_quota/i.test(msg))
      return res.status(429).json({ error: "AI usage limit reached - try again later", code: "quota" });
    if (/timed out|timeout/i.test(msg))
      return res.status(504).json({ error: "OCR timed out - try a smaller file", code: "timeout" });
    res.status(500).json({ error: "ocr failed", code: "error" });
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  }
});

// --- auth ---
app.get("/auth/config", (_req, res) => {
  res.json({
    google: !!GOOGLE_CLIENT_ID,
    googleClientId: GOOGLE_CLIENT_ID,
    usersEnabled: USERS.length > 0,
  });
});

app.post("/login", rateLimit({ windowMs: 60000, max: 10 }), (req, res) => {
  const b = req.body || {};
  const username = String(b.username || "").trim();
  const password = String(b.password || "");
  if (username) {
    const u = USERS.find(
      (x) => x.username.toLowerCase() === username.toLowerCase() && x.password === password
    );
    if (!u) return res.status(401).json({ error: "wrong username or password" });
    return res.json({ token: signToken(u), user: { username: u.username, role: u.role } });
  }
  // legacy password-only -> admin
  if (APP_PASSWORD && password === APP_PASSWORD) {
    const u = { username: "admin", role: "admin" };
    return res.json({ token: signToken(u), user: u });
  }
  return res.status(401).json({ error: "wrong username or password" });
});

app.post("/login/google", async (req, res) => {
  try {
    const credential = (req.body && req.body.credential) || "";
    if (!credential) return res.status(400).json({ error: "missing credential" });
    const email = await verifyGoogleCredential(credential);
    const role = GOOGLE_ADMIN_EMAILS.indexOf(email) !== -1 ? "admin" : "general";
    const u = { username: email, role };
    res.json({ token: signToken(u), user: u });
  } catch (e) {
    res.status(401).json({ error: String((e && e.message) || e) });
  }
});

// --- brain: read everything (rule full text trimmed out of the list) ---
app.get("/brain", requireAuth, (_req, res) => {
  res.json({
    learning: brain.learning,
    references: brain.references,
    rules: brain.rules.map((r) => ({
      id: r.id, name: r.name, addedAt: r.addedAt,
      sectionCount: (r.sections || []).length, chars: r.chars || 0,
    })),
    notes: brain.notes.slice(-50),
  });
});

// standing instructions (permanent learning)
app.post("/brain/learning", requireAuth, (req, res) => {
  const text = ((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  const item = { id: newId(), text, addedAt: Date.now() };
  brain.learning.push(item); saveBrain(); res.json(item);
});
app.delete("/brain/learning/:id", requireAuth, (req, res) => {
  brain.learning = brain.learning.filter((x) => x.id !== req.params.id);
  saveBrain(); res.json({ ok: true });
});

// reference-noting style memory
app.post("/brain/reference", requireAuth, (req, res) => {
  const b = req.body || {};
  const item = {
    id: newId(), name: b.name || "reference",
    analysis: b.analysis || null, summary: b.summary || "", addedAt: Date.now(),
  };
  brain.references.push(item); saveBrain(); res.json(item);
});
app.delete("/brain/reference/:id", requireAuth, (req, res) => {
  brain.references = brain.references.filter((x) => x.id !== req.params.id);
  saveBrain(); res.json({ ok: true });
});

// rule library
app.post("/brain/rule", requireAuth, (req, res) => {
  const b = req.body || {};
  const text = (b.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty rule text" });
  const sections = chunkRuleText(text);
  const item = {
    id: newId(), name: b.name || "Rule document", addedAt: Date.now(),
    chars: text.length, sections,
  };
  brain.rules.push(item); saveBrain();
  res.json({ id: item.id, name: item.name, addedAt: item.addedAt, sectionCount: sections.length, chars: item.chars });
});
app.delete("/brain/rule/:id", requireAdmin, (req, res) => {
  brain.rules = brain.rules.filter((x) => x.id !== req.params.id);
  saveBrain(); res.json({ ok: true });
});
app.get("/brain/rules/search", requireAuth, (req, res) => {
  res.json({ results: searchRules(req.query.q || "", parseInt(req.query.k || "6", 10)) });
});

// note history
app.post("/brain/note", requireAuth, (req, res) => {
  const b = req.body || {};
  const item = {
    id: newId(), title: b.title || "", instructions: b.instructions || "",
    draft: b.draft || "", final: b.final || "", addedAt: Date.now(),
  };
  brain.notes.push(item);
  if (brain.notes.length > 500) brain.notes = brain.notes.slice(-500);
  saveBrain(); res.json(item);
});

// full backup (admin only)
app.get("/backup", requireAdmin, (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="note-brain-backup.json"');
  res.json(brain);
});

app.listen(PORT, () => {
  console.log(
    "csir-note-api listening on :" + PORT +
    " (origin: " + ALLOWED_ORIGIN + ", users: " + USERS.length +
    ", google: " + (GOOGLE_CLIENT_ID ? "on" : "off") +
    ", ai: " + AI_PROVIDER +
    ", data: " + DATA_DIR + ")"
  );
});
