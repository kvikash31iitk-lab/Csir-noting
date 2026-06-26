/*
 * CSIR Note Sheet — backend "brain" for the note-sheet app
 * --------------------------------------------------------
 * Runs the `claude` CLI (logged in with a Claude Max subscription, so NO
 * ANTHROPIC_API_KEY is needed) and keeps a small, file-based memory so the app
 * becomes a growing institutional assistant.
 *
 * Endpoints
 *   GET  /health                      liveness
 *   POST /generate {system,user}      stateless text/JSON generation (unchanged)
 *   POST /extract  {dataUrl|base64}   OCR a scan/image/PDF via Claude vision
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
 *   PORT, ALLOWED_ORIGIN, CLAUDE_BIN, CLAUDE_MODEL, SYSTEM_PROMPT_FLAG,
 *   CLAUDE_MAX_TURNS, CLAUDE_DISABLE_TOOLS, CLAUDE_EXTRA_ARGS, TIMEOUT_MS,
 *   APP_PASSWORD   password gating the /brain + /extract routes (unset = open)
 *   APP_SECRET     HMAC secret for tokens (defaults derived from APP_PASSWORD)
 *   DATA_DIR       where brain.json lives (default ./data)
 *   OCR_TOOLS      tools the OCR call may use (default "Read")
 *   OCR_MAX_TURNS  (default 6)   OCR_TIMEOUT_MS (default 180000)
 */
const express = require("express");
const { spawn } = require("child_process");
const crypto = require("crypto");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8787", 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "";
const SYSTEM_PROMPT_FLAG = process.env.SYSTEM_PROMPT_FLAG || "--system-prompt";
const MAX_TURNS = process.env.CLAUDE_MAX_TURNS || "1";
const DISABLE_TOOLS = process.env.CLAUDE_DISABLE_TOOLS !== "0";
const EXTRA_ARGS = (process.env.CLAUDE_EXTRA_ARGS || "").split(" ").filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "120000", 10);

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

// Neutral, empty working dir so /generate has no project/code to "look at".
const NEUTRAL_CWD =
  process.env.CLAUDE_CWD || path.join(os.tmpdir(), "csir-note-api-cwd");
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
  const paras = clean.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
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
 *  Claude CLI runner (used by /generate and /extract)
 * ------------------------------------------------------------------ */
function runClaude({ args, stdin, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const fullArgs = args.slice();
    if (CLAUDE_MODEL && fullArgs.indexOf("--model") === -1) fullArgs.push("--model", CLAUDE_MODEL);
    fullArgs.push(...EXTRA_ARGS);
    const env = Object.assign({}, process.env);
    delete env.ANTHROPIC_API_KEY; // force subscription auth

    let child;
    try { child = spawn(CLAUDE_BIN, fullArgs, { env, cwd: cwd || NEUTRAL_CWD }); }
    catch (e) { return reject(new Error("could not start claude: " + e.message)); }

    let out = "", err = "", finished = false;
    const fin = (fn) => { if (!finished) { finished = true; fn(); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      fin(() => reject(new Error("claude timed out")));
    }, timeoutMs || TIMEOUT_MS);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); fin(() => reject(new Error("claude spawn error: " + e.message))); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out)
        return fin(() => reject(new Error("claude exited " + code + ": " + err.slice(0, 400))));
      let text = out;
      try {
        const j = JSON.parse(out);
        text = j.result || j.text || (j.content && j.content[0] && j.content[0].text) || out;
      } catch (_) {}
      fin(() => resolve(text));
    });

    try { if (stdin != null) child.stdin.write(stdin); child.stdin.end(); }
    catch (e) { clearTimeout(timer); fin(() => reject(new Error("failed writing prompt: " + e.message))); }
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

app.get("/health", (_req, res) =>
  res.json({ ok: true, users: USERS.length, google: !!GOOGLE_CLIENT_ID }));

// --- generation (now authenticated + rate-limited; was previously open) ---
app.post("/generate", rateLimit({ windowMs: 60000, max: 40 }), requireAuth, async (req, res) => {
  const body = req.body || {};
  const system = typeof body.system === "string" ? body.system : "";
  const user = typeof body.user === "string" ? body.user : "";
  if (!user) return res.status(400).json({ error: "missing 'user' prompt" });

  const args = ["-p", "--output-format", "json"];
  if (system) args.push(SYSTEM_PROMPT_FLAG, system);
  args.push("--max-turns", String(MAX_TURNS));
  if (DISABLE_TOOLS) args.push("--tools", "");

  try {
    const text = await runClaude({ args, stdin: user, cwd: NEUTRAL_CWD, timeoutMs: TIMEOUT_MS });
    res.json({ content: [{ type: "text", text }] });
  } catch (e) {
    console.error("[generate] error:", (e && e.stack) || e);
    const msg = String((e && e.message) || e);
    // Surface quota/limit distinctly so the UI can tell the operator; never leak stderr.
    if (/limit|quota|usage|429|rate/i.test(msg))
      return res.status(429).json({ error: "AI usage limit reached — try again later", code: "quota" });
    if (/timed out/i.test(msg))
      return res.status(504).json({ error: "AI timed out — try a shorter note", code: "timeout" });
    res.status(500).json({ error: "generation failed", code: "error" });
  }
});

// --- OCR via Claude vision (Read tool on a temp file) ---
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  const fname = "page." + ext;
  const fpath = path.join(dir, fname);
  try {
    fs.writeFileSync(fpath, Buffer.from(raw, "base64"));
    const prompt =
      "Read the file ./" + fname + " in the current directory and transcribe ALL of " +
      "its text verbatim, preserving line breaks and layout where reasonable. It may " +
      "contain a mix of English and Hindi (Devanagari) — transcribe both faithfully. " +
      "Do not summarise, translate, or add commentary. Output ONLY the transcribed text.";
    const text = await runClaude({
      args: [
        "-p", "--output-format", "json",
        "--max-turns", process.env.OCR_MAX_TURNS || "6",
        "--tools", process.env.OCR_TOOLS || "Read",
      ],
      stdin: prompt,
      cwd: dir,
      timeoutMs: parseInt(process.env.OCR_TIMEOUT_MS || "180000", 10),
    });
    res.json({ text: String(text || "").trim() });
  } catch (e) {
    console.error("[extract] error:", (e && e.stack) || e);
    res.status(500).json({ error: "ocr failed" });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
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
    ", data: " + DATA_DIR + ")"
  );
});
