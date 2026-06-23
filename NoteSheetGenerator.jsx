import React, { useState, useEffect, useRef, useCallback } from "react";

/**
 * AI-Powered Note Sheet Generator
 * ---------------------------------
 * A single self-contained React artifact that helps CSIR TKDL Unit / CSIR IPU
 * office users generate formal "noting" documents.
 *
 * - Learns style/format from uploaded reference notings
 * - Extracts facts from a source document
 * - Generates a formatted note sheet via Claude
 * - Allows chat-based iterative refinement
 * - Exports the final note as a DOCX file
 *
 * Storage: window.storage (NOT localStorage / sessionStorage)
 * AI:      fetch -> https://api.anthropic.com/v1/messages
 * DOCX in: mammoth.js (CDN)   DOCX out: docx.js (CDN)
 */

/* ------------------------------------------------------------------ *
 *  CONSTANTS
 * ------------------------------------------------------------------ */
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const CLAUDE_MAX_TOKENS = 2000;

const MAMMOTH_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
const DOCX_CDN = "https://unpkg.com/docx@8.5.0/build/index.umd.js";
const PDFJS_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_CDN =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const XLSX_CDN =
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
const TESSERACT_CDN =
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
// Bilingual OCR (English + Hindi) for CSIR notings. Language data is fetched
// once by tesseract.js and cached in the browser thereafter.
const OCR_LANGS = "eng+hin";
// Accept string shared by every upload control — "anything" in.
const UPLOAD_ACCEPT =
  ".docx,.pdf,.xlsx,.xls,.csv,.txt,.png,.jpg,.jpeg,.webp,.bmp,.tiff,.tif";

// Phase B — document-level formatting applied to the preview and the DOCX.
const DEFAULT_DOC_STYLE = {
  fontFamily: "Times New Roman",
  fontSize: 12, // points (body); header/department scale relative to this
  lineSpacing: 1.5, // 1 / 1.15 / 1.5 / 2
  align: "justify", // justify | left | center | right
};
const FONT_CHOICES = [
  "Times New Roman",
  "Arial",
  "Calibri",
  "Cambria",
  "Georgia",
  "Mangal", // Devanagari
  "Nirmala UI", // English + Hindi
];
const FONT_SIZE_CHOICES = [10, 11, 12, 13, 14, 16];
const LINE_SPACING_CHOICES = [1, 1.15, 1.5, 2];

const SEED_PATTERNS = {
  toneRules: [
    "Formal third-person government style throughout",
    "Use passive voice constructions: it is submitted, it is requested, it is informed",
    "Observations listed as numbered or bulleted points when multiple",
    "End body with: Submitted for further consideration and necessary action please",
    "Reference bills and documents by their exact numbers",
  ],
  structureRules: [
    "Organization header and department name at top centered",
    "Date on its own line after header",
    "Bold Subject label followed by descriptive subject ending in reg.",
    "Bold Ref label citing source document number and date",
    "Two to four body paragraphs explaining the matter",
    "Optional details block for account numbers amounts and references",
    "Closing line before signature chain",
  ],
  subjectPatterns: [
    "Request for [action] in respect of [subject matter] — reg.",
    "Bill no [number] of M/s [party] — pre-audit observations — reg.",
    "[Matter description] pertaining to [subject] — reg.",
  ],
  phrasebook: [
    "It is submitted that",
    "It is requested that",
    "The matter is placed before the competent authority for kind consideration",
    "Submitted for kind consideration please",
    "Submitted for further consideration and necessary action please",
    "may kindly be accorded",
    "vide bill no",
    "pre-audit observations",
    "in view of the above",
    "it is pertinent to mention that",
    "necessary approval and sanction",
  ],
};

const SEED_SIGNATURES = [
  { chain: ["SO (F&A)", "DFA (F&A)", "DS/DDO (TKDL)"], label: "Finance - TKDL" },
  { chain: ["SO (F&A)", "F&AO", "DDO"], label: "Finance - General" },
  {
    chain: ["ASO (F&A)", "SO (F&A)", "DFA (F&A)", "DS/DDO (TKDL)"],
    label: "Finance - Full Chain",
  },
  {
    chain: ["SO (F&A)", "DFA (F&A)", "Dy. Secy. / DDO"],
    label: "IPU - Finance",
  },
];

const FACT_FIELDS = [
  { key: "subject", label: "Subject" },
  { key: "date", label: "Date" },
  { key: "organization", label: "Organization" },
  { key: "parties", label: "Parties" },
  { key: "amounts", label: "Amounts" },
  { key: "accountNumbers", label: "Account Numbers" },
  { key: "ruleReferences", label: "Rule References" },
  { key: "purpose", label: "Purpose" },
  { key: "requestedAction", label: "Requested Action" },
  { key: "budgetHead", label: "Budget Head" },
];

/* ------------------------------------------------------------------ *
 *  UTILITY FUNCTIONS
 * ------------------------------------------------------------------ */

function generateUUID() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Strip markdown code-fences then JSON.parse. Returns null on failure. */
function parseJSON(text) {
  if (typeof text !== "string") return null;
  let cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      return undefined;
    }
  };
  const stripTrailingCommas = (s) => s.replace(/,\s*([}\]])/g, "$1");

  // 1) straight parse
  let r = tryParse(cleaned);
  if (r !== undefined) return r;
  // 2) tolerate trailing commas
  r = tryParse(stripTrailingCommas(cleaned));
  if (r !== undefined) return r;
  // 3) the model added prose before/after the JSON — grab the {...}/[...] region
  const m = cleaned.match(/[{[][\s\S]*[}\]]/);
  if (m) {
    r = tryParse(m[0]);
    if (r !== undefined) return r;
    r = tryParse(stripTrailingCommas(m[0]));
    if (r !== undefined) return r;
  }
  return null;
}

/* ---- window.storage wrappers (all async, all guarded) ---- */

async function storageGet(key, shared = false) {
  try {
    if (!window.storage || !window.storage.get) return null;
    const raw = await window.storage.get(key, { shared });
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  } catch (e) {
    return null;
  }
}

async function storageSet(key, value, shared = false) {
  try {
    if (!window.storage || !window.storage.set) return false;
    await window.storage.set(key, JSON.stringify(value), { shared });
    return true;
  } catch (e) {
    return false;
  }
}

async function storageList(prefix, shared = false) {
  try {
    if (!window.storage || !window.storage.list) return [];
    const res = await window.storage.list({ shared, prefix });
    if (!res) return [];
    // res may be an array of keys, or of {key} objects, or {keys:[...]}
    const arr = Array.isArray(res) ? res : res.keys || [];
    return arr
      .map((k) => (typeof k === "string" ? k : k && k.key ? k.key : null))
      .filter(Boolean)
      .filter((k) => (prefix ? k.startsWith(prefix) : true));
  } catch (e) {
    return [];
  }
}

async function storageDelete(key, shared = false) {
  try {
    if (!window.storage || !window.storage.delete) return false;
    await window.storage.delete(key, { shared });
    return true;
  } catch (e) {
    return false;
  }
}

/** Call Claude messages API. Throws on failure (callers must try/catch). */
async function callClaude(systemPrompt, userMessage) {
  const res = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    throw new Error("Claude API HTTP " + res.status);
  }
  const data = await res.json();
  const block = data && data.content && data.content[0];
  return block && block.text ? block.text : "";
}

/* Call Claude and parse JSON, retrying a couple of times on a transient error
 * or an unparseable response. Returns the parsed object, or null. */
async function callClaudeJSON(systemPrompt, userMessage, attempts) {
  attempts = attempts || 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await callClaude(systemPrompt, userMessage);
      const parsed = parseJSON(resp);
      if (parsed) return parsed;
    } catch (e) {
      /* transient — fall through to retry */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Brain API client — server-side memory, rule library, Claude OCR.
 *  The base URL is derived from the configured backend (…/generate ->
 *  its root); the login token is kept in localStorage.
 * ------------------------------------------------------------------ */
function apiBase() {
  try {
    const url = (localStorage.getItem("cfg::backendUrl") || "").trim();
    if (!url) return "";
    return url.replace(/\/generate\/?$/, "").replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}
function apiToken() {
  try {
    return localStorage.getItem("cfg::noteToken") || "";
  } catch (_) {
    return "";
  }
}
function setApiToken(t) {
  try {
    if (t) localStorage.setItem("cfg::noteToken", t);
    else localStorage.removeItem("cfg::noteToken");
  } catch (_) {}
}
function getStored(key) {
  try { return localStorage.getItem(key) || ""; } catch (_) { return ""; }
}
function setStored(key, val) {
  try { if (val) localStorage.setItem(key, val); else localStorage.removeItem(key); } catch (_) {}
}
function setSession(user) {
  // user = { username, role } or null to clear
  setStored("cfg::role", user ? user.role || "" : "");
  setStored("cfg::user", user ? user.username || "" : "");
}
async function apiFetch(pathname, opts) {
  opts = opts || {};
  const base = apiBase();
  if (!base) throw new Error("no backend configured");
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const tok = apiToken();
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const res = await fetch(base + pathname, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    setApiToken("");
    const e = new Error("unauthorized");
    e.code = "UNAUTHORIZED";
    throw e;
  }
  if (!res.ok) {
    let msg = "HTTP " + res.status;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch (_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return await res.json();
}
const api = {
  authConfig: () => apiFetch("/auth/config"),
  login: (username, password) =>
    apiFetch("/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  loginGoogle: (credential) =>
    apiFetch("/login/google", { method: "POST", body: JSON.stringify({ credential }) }),
  getBrain: () => apiFetch("/brain"),
  addLearning: (text) =>
    apiFetch("/brain/learning", { method: "POST", body: JSON.stringify({ text }) }),
  delLearning: (id) => apiFetch("/brain/learning/" + id, { method: "DELETE" }),
  addReference: (r) =>
    apiFetch("/brain/reference", { method: "POST", body: JSON.stringify(r) }),
  delReference: (id) => apiFetch("/brain/reference/" + id, { method: "DELETE" }),
  addRule: (name, text) =>
    apiFetch("/brain/rule", { method: "POST", body: JSON.stringify({ name, text }) }),
  delRule: (id) => apiFetch("/brain/rule/" + id, { method: "DELETE" }),
  searchRules: (q, k) =>
    apiFetch("/brain/rules/search?q=" + encodeURIComponent(q) + "&k=" + (k || 6)),
  addNote: (n) => apiFetch("/brain/note", { method: "POST", body: JSON.stringify(n) }),
  backup: () => apiFetch("/backup"),
  extract: (payload) =>
    apiFetch("/extract", { method: "POST", body: JSON.stringify(payload) }),
};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("read fail"));
    r.readAsDataURL(file);
  });
}
/* Claude-vision OCR via the backend (primary engine). Returns "" if no backend
 * is configured or the call is rejected, so the caller can fall back locally. */
async function ocrViaBackend(file, onStatus) {
  if (!apiBase()) return "";
  if (typeof onStatus === "function") onStatus("Reading with Claude vision…");
  const dataUrl = await fileToDataUrl(file);
  const out = await api.extract({
    dataUrl,
    filename: file.name,
    mimeType: file.type || "",
  });
  return (out && out.text) || "";
}

/* ---- CDN script loading ---- */
const scriptCache = {};
function loadScript(src) {
  if (scriptCache[src]) return scriptCache[src];
  scriptCache[src] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("load fail")));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
  return scriptCache[src];
}

/* Extract the text layer of a PDF. Primary path uses PDF.js, which properly
 * decompresses content streams (the common FlateDecode case). Falls back to a
 * crude raw-byte scrape only if PDF.js cannot be loaded (e.g. offline). */
async function extractPdfText(file) {
  try {
    await loadScript(PDFJS_CDN);
    const pdfjs = window.pdfjsLib;
    if (pdfjs) {
      try {
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
      } catch {}
      const data = await file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data }).promise;
      let out = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        out += content.items.map((it) => it.str || "").join(" ") + "\n";
      }
      return out.replace(/[ \t]+/g, " ").trim();
    }
  } catch {
    /* fall through to the crude fallback */
  }
  // Fallback: scrape parenthesised strings from raw bytes (uncompressed PDFs only).
  const raw = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read fail"));
    reader.readAsText(file);
  });
  const matches = raw.match(/\(([^()]{2,})\)/g) || [];
  return matches
    .map((m) => m.slice(1, -1))
    .join(" ")
    .replace(/\\[rn]/g, " ")
    .trim();
}

/* Read a spreadsheet (.xlsx/.xls/.csv) into labelled CSV text, one block per
 * sheet, so the AI sees the tabular data clearly. */
async function readSpreadsheet(file) {
  await loadScript(XLSX_CDN);
  if (!window.XLSX) throw new Error("xlsx unavailable");
  const data = await file.arrayBuffer();
  const wb = window.XLSX.read(data, { type: "array" });
  let out = "";
  (wb.SheetNames || []).forEach((sn) => {
    const ws = wb.Sheets[sn];
    if (!ws) return;
    const csv = window.XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    if (csv && csv.trim()) out += "# Sheet: " + sn + "\n" + csv.trim() + "\n\n";
  });
  return out.trim();
}

/* Local OCR via tesseract.js. Handles image files directly and scanned PDFs by
 * rendering each page to a canvas first (PDF.js). Used as the fallback OCR
 * engine; Claude vision is the primary path (added separately). */
async function ocrWithTesseract(file, onStatus) {
  await loadScript(TESSERACT_CDN);
  if (!window.Tesseract) throw new Error("ocr unavailable");
  const name = (file.name || "").toLowerCase();
  const note = (m) => {
    if (typeof onStatus === "function") onStatus(m);
  };

  if (name.endsWith(".pdf")) {
    await loadScript(PDFJS_CDN);
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error("pdf renderer unavailable");
    try {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
    } catch {}
    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    const maxPages = Math.min(pdf.numPages, 20); // safety cap
    let out = "";
    for (let i = 1; i <= maxPages; i++) {
      note("Reading scanned page " + i + " of " + maxPages + "…");
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const res = await window.Tesseract.recognize(canvas, OCR_LANGS);
      out += ((res && res.data && res.data.text) || "") + "\n";
    }
    return out.trim();
  }

  // single image
  note("Reading scanned image…");
  const res = await window.Tesseract.recognize(file, OCR_LANGS);
  return ((res && res.data && res.data.text) || "").trim();
}

/* OCR dispatcher. Claude vision (the better engine for Hindi / messy govt
 * scans) is the primary path; tesseract.js is the local fallback. */
async function ocrFile(file, onStatus) {
  try {
    const viaClaude = await ocrViaBackend(file, onStatus);
    if (viaClaude && viaClaude.replace(/\s/g, "").length >= 5) return viaClaude;
  } catch (_) {
    /* fall back to local OCR */
  }
  return await ocrWithTesseract(file, onStatus);
}

/* Read ANY supported reference into plain text:
 *   .docx -> mammoth   .xlsx/.xls/.csv -> SheetJS
 *   .pdf  -> PDF.js text layer, falling back to OCR when it's a scan
 *   images -> OCR      anything else -> plain text
 * onStatus(msg) is an optional progress callback for slow OCR work. */
async function readFileAsText(file, onStatus) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  const isImage =
    type.indexOf("image/") === 0 ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name);

  if (name.endsWith(".docx")) {
    await loadScript(MAMMOTH_CDN);
    if (!window.mammoth) throw new Error("mammoth unavailable");
    const arrayBuffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    return (result && result.value) || "";
  }

  if (/\.(xlsx|xls|csv)$/.test(name)) {
    return await readSpreadsheet(file);
  }

  if (name.endsWith(".pdf")) {
    const text = await extractPdfText(file);
    if (text.replace(/\s/g, "").length >= 20) return text;
    // No usable text layer -> it's a scan. OCR it.
    let ocr = "";
    try {
      ocr = await ocrFile(file, onStatus);
    } catch {
      ocr = "";
    }
    if (ocr.replace(/\s/g, "").length >= 20) return ocr;
    const err = new Error("PDF_NO_TEXT");
    err.code = "PDF_NO_TEXT";
    throw err;
  }

  if (isImage) {
    let ocr = "";
    try {
      ocr = await ocrFile(file, onStatus);
    } catch {
      ocr = "";
    }
    if (ocr.replace(/\s/g, "").length >= 5) return ocr;
    const err = new Error("IMAGE_NO_TEXT");
    err.code = "IMAGE_NO_TEXT";
    throw err;
  }

  // any other file -> read as plain text
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read fail"));
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------------ *
 *  SMALL PRESENTATIONAL HELPERS
 * ------------------------------------------------------------------ */

function Spinner({ className = "" }) {
  return (
    <span
      className={
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent " +
        className
      }
    />
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

/* word-level diff for a single string */
function diffWords(oldStr, newStr) {
  const oldW = (oldStr || "").split(/\s+/);
  const newW = (newStr || "").split(/\s+/);
  const out = [];
  const max = Math.max(oldW.length, newW.length);
  for (let i = 0; i < max; i++) {
    const o = oldW[i];
    const n = newW[i];
    if (n === undefined) {
      if (o) out.push({ t: o, k: "del" });
    } else if (o === n) {
      out.push({ t: n, k: "same" });
    } else {
      if (o) out.push({ t: o, k: "del" });
      out.push({ t: n, k: "add" });
    }
  }
  return out;
}

function DiffText({ oldStr, newStr }) {
  const parts = diffWords(oldStr, newStr);
  return (
    <>
      {parts.map((p, i) => {
        if (p.k === "del")
          return (
            <span key={i} className="text-red-500 line-through">
              {p.t}{" "}
            </span>
          );
        if (p.k === "add")
          return (
            <span key={i} className="bg-green-100 text-green-800">
              {p.t}{" "}
            </span>
          );
        return <span key={i}>{p.t} </span>;
      })}
    </>
  );
}

/* ------------------------------------------------------------------ *
 *  MAIN APP
 * ------------------------------------------------------------------ */
export default function App() {
  /* ----- toast system ----- */
  const [toasts, setToasts] = useState([]);
  const showToast = useCallback((message, type = "info") => {
    const id = generateUUID();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3000);
  }, []);

  /* ----- library state ----- */
  const [refNotings, setRefNotings] = useState([]); // [{id, filename, uploadedAt, language, ...}]
  const [signatures, setSignatures] = useState([]); // [{chain, label}]
  const [refLoading, setRefLoading] = useState(false);

  /* ----- rule library (GFR / CCS / ... stored server-side) ----- */
  const [rules, setRules] = useState([]); // [{id, name, addedAt, sectionCount, chars}]
  const [ruleLoading, setRuleLoading] = useState(false);
  const [ruleHits, setRuleHits] = useState([]); // rule sections used by the last generation

  /* ----- cloud login (server-side brain) ----- */
  const [cloudOn, setCloudOn] = useState(!!apiBase());
  const [loggedIn, setLoggedIn] = useState(!!apiToken());
  const [role, setRole] = useState(getStored("cfg::role"));
  const [userName, setUserName] = useState(getStored("cfg::user"));
  const [showLogin, setShowLogin] = useState(false);
  const [loginUser, setLoginUser] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [teaching, setTeaching] = useState(false);
  const googleBtnRef = useRef(null);
  const isAdmin = role === "admin";

  /* ----- permanent learning material (typed/pasted knowledge) ----- */
  const [knowledge, setKnowledge] = useState([]); // [{id, text, addedAt, source?}]
  const [knowledgeInput, setKnowledgeInput] = useState("");
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  const [knowledgeFileLoading, setKnowledgeFileLoading] = useState(false);

  /* ----- signature add form ----- */
  const [showChainForm, setShowChainForm] = useState(false);
  const [chainRoles, setChainRoles] = useState("");
  const [chainLabel, setChainLabel] = useState("");

  /* ----- source document ----- */
  const [sourceFilename, setSourceFilename] = useState("");
  const [sourceProcessing, setSourceProcessing] = useState(false);
  const [facts, setFacts] = useState(null); // editable fact object
  const [dragOver, setDragOver] = useState(false);

  /* ----- generation / fact card ----- */
  const [language, setLanguage] = useState("English");
  const [selectedChainIdx, setSelectedChainIdx] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [factCardHidden, setFactCardHidden] = useState(false);

  /* ----- versions & chat ----- */
  const [versions, setVersions] = useState([]); // [note JSON]
  const [activeVersion, setActiveVersion] = useState(0); // index
  const [chatHistory, setChatHistory] = useState([]); // [{role, text, version?}]
  const [chatInput, setChatInput] = useState("");
  const [aiTyping, setAiTyping] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [editing, setEditing] = useState(false);
  const [docStyle, setDocStyle] = useState(DEFAULT_DOC_STYLE);
  const [showStyle, setShowStyle] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [tabOffset, setTabOffset] = useState(0);
  const [activePanel, setActivePanel] = useState("library"); // mobile: which column is shown
  // On wide screens we show all three columns at once; on phones we show one
  // panel at a time (chosen via the bottom nav). Driven from JS so it never
  // depends on a responsive CSS display override that a stale cache could break.
  const [isDesktop, setIsDesktop] = useState(
    typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 768px)").matches
  );

  const sessionIdRef = useRef(generateUUID());
  const chatEndRef = useRef(null);

  /* track viewport so the 3-column desktop layout is reliable */
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => setIsDesktop(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);
  const refFileInput = useRef(null);
  const knowledgeFileInput = useRef(null);
  const ruleFileInput = useRef(null);

  /* ============================================================== *
   *  MOUNT: load CDN libs, seed baseline, load library + session
   * ============================================================== */
  useEffect(() => {
    // pre-load CDN libs (non-blocking)
    loadScript(MAMMOTH_CDN).catch(() => {});
    loadScript(DOCX_CDN).catch(() => {});

    (async () => {
      try {
        // ---- baseline seeding ----
        const patterns = await storageGet("lib:patterns", true);
        const emptyPatterns =
          !patterns ||
          ((patterns.toneRules || []).length === 0 &&
            (patterns.structureRules || []).length === 0 &&
            (patterns.phrasebook || []).length === 0);
        if (emptyPatterns) {
          await storageSet("lib:patterns", SEED_PATTERNS, true);
        }
        const sigs = await storageGet("lib:signatures", true);
        if (!sigs || !Array.isArray(sigs) || sigs.length === 0) {
          await storageSet("lib:signatures", SEED_SIGNATURES, true);
        }

        const ds = await storageGet("cfg:docStyle", true);
        if (ds) setDocStyle({ ...DEFAULT_DOC_STYLE, ...ds });
        await refreshLibrary();
        await refreshSignatures();
        await refreshKnowledge();
        await restoreSession();
      } catch (e) {
        showToast("Storage error — changes may not persist", "error");
      }
      // ---- cloud brain (server-side memory: rules + shared learning) ----
      if (apiBase()) await refreshCloud();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* auto-scroll chat */
  useEffect(() => {
    if (chatEndRef.current)
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, aiTyping]);

  /* Render the Google sign-in button when login is visible and the backend has
   * GOOGLE_CLIENT_ID configured. */
  useEffect(() => {
    if (!cloudOn || loggedIn) {
      setGoogleAvailable(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.authConfig();
        if (cancelled || !cfg || !cfg.google || !cfg.googleClientId) return;
        setGoogleAvailable(true);
        await loadScript("https://accounts.google.com/gsi/client");
        if (cancelled || !window.google || !window.google.accounts) return;
        window.google.accounts.id.initialize({
          client_id: cfg.googleClientId,
          callback: (resp) =>
            resp && resp.credential && handleGoogleCredential(resp.credential),
        });
        if (googleBtnRef.current) {
          googleBtnRef.current.innerHTML = "";
          window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: "outline",
            size: "large",
            text: "signin_with",
            width: 240,
          });
        }
      } catch (e) {
        /* Google sign-in is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudOn, loggedIn, showLogin]);

  /* ============================================================== *
   *  LIBRARY HELPERS
   * ============================================================== */
  async function refreshLibrary() {
    try {
      const keys = await storageList("lib:ref:", true);
      const items = [];
      for (const k of keys) {
        const obj = await storageGet(k, true);
        if (obj) items.push(obj);
      }
      // Merge server-side style examples so reference notings follow the user
      // across devices (deduped by filename).
      if (apiBase() && apiToken()) {
        try {
          const brain = await api.getBrain();
          const have = new Set(items.map((x) => (x.filename || "").toLowerCase()));
          for (const ref of brain.references || []) {
            if (have.has((ref.name || "").toLowerCase())) continue;
            const a = ref.analysis || {};
            items.push({
              id: ref.id,
              cloud: true,
              filename: ref.name,
              uploadedAt: ref.addedAt,
              language: a.language || "Mixed",
              styleRules: a.styleRules || {},
              tags: a.tags || [],
            });
            if (ref.analysis) await mergeAnalysisIntoPatterns(ref.analysis);
          }
        } catch (e) {
          /* offline / not authed: local only */
        }
      }
      items.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
      setRefNotings(items);
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    }
  }

  /* Merge a reference-noting style analysis into the cumulative style patterns
   * (lib:patterns) that get injected into every generation. */
  async function mergeAnalysisIntoPatterns(analysis) {
    if (!analysis) return;
    const existing =
      (await storageGet("lib:patterns", true)) || {
        toneRules: [],
        structureRules: [],
        subjectPatterns: [],
        phrasebook: [],
      };
    const dedupe = (arr) => Array.from(new Set(arr.filter(Boolean)));
    const sr = analysis.styleRules || {};
    if (sr.tone) existing.toneRules = dedupe([...(existing.toneRules || []), sr.tone]);
    if (analysis.subjectLinePattern)
      existing.subjectPatterns = dedupe([
        ...(existing.subjectPatterns || []),
        analysis.subjectLinePattern,
      ]);
    if (Array.isArray(analysis.keyPhrases))
      existing.phrasebook = dedupe([...(existing.phrasebook || []), ...analysis.keyPhrases]);
    if (sr.openingPhrase || sr.closingPhrase)
      existing.structureRules = dedupe([
        ...(existing.structureRules || []),
        sr.openingPhrase ? "Opens with: " + sr.openingPhrase : null,
        sr.closingPhrase ? "Closes with: " + sr.closingPhrase : null,
      ]);
    await storageSet("lib:patterns", existing, true);
  }

  /* ============================================================== *
   *  CLOUD BRAIN (server-side memory: rule library + shared learning)
   * ============================================================== */
  async function refreshCloud() {
    if (!apiBase()) {
      setCloudOn(false);
      return;
    }
    setCloudOn(true);
    try {
      const brain = await api.getBrain();
      setLoggedIn(true);
      setShowLogin(false);
      setRules(Array.isArray(brain.rules) ? brain.rules : []);
      // Re-merge standing instructions now that we're authed.
      await refreshKnowledge();
    } catch (e) {
      if (e && e.code === "UNAUTHORIZED") {
        setLoggedIn(false);
        setShowLogin(true);
      }
      // any other error: leave cloud features dormant, app still works locally
    }
  }

  function applyLogin(token, user) {
    setApiToken(token);
    setSession(user);
    setRole(user.role || "");
    setUserName(user.username || "");
    setLoggedIn(true);
    setShowLogin(false);
  }

  async function handleLogin() {
    const u = loginUser.trim();
    const pw = loginPassword;
    if (!u || !pw) {
      showToast("Enter username and password", "error");
      return;
    }
    setLoggingIn(true);
    try {
      const { token, user } = await api.login(u, pw);
      applyLogin(token, user);
      setLoginUser("");
      setLoginPassword("");
      await refreshCloud();
      showToast("Signed in as " + user.username + " ✓", "success");
    } catch (e) {
      showToast(
        e && /wrong username|password/i.test(e.message || "")
          ? "Wrong username or password"
          : "Sign-in failed — check the backend URL in settings",
        "error"
      );
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleGoogleCredential(credential) {
    setLoggingIn(true);
    try {
      const { token, user } = await api.loginGoogle(credential);
      applyLogin(token, user);
      await refreshCloud();
      showToast("Signed in as " + user.username + " ✓", "success");
    } catch (e) {
      showToast("Google sign-in failed: " + (e && e.message), "error");
    } finally {
      setLoggingIn(false);
    }
  }

  function handleLogout() {
    setApiToken("");
    setSession(null);
    setRole("");
    setUserName("");
    setLoggedIn(false);
    setRules([]);
    showToast("Signed out", "info");
  }

  /* Phase 4 learning loop: turn the latest correction into a general standing
   * instruction the AI will follow in every future note. */
  async function handleTeach() {
    const lastUser = [...chatHistory].reverse().find((c) => c.role === "user");
    const basis = (chatInput.trim() || (lastUser && lastUser.text) || "").trim();
    if (!basis) {
      showToast("Type or send a correction first, then Teach it", "error");
      return;
    }
    setTeaching(true);
    try {
      let lesson = basis;
      try {
        const sys =
          "You convert a one-off editing instruction for a CSIR government office note into a SHORT, general standing rule the writer wants followed in ALL future notes. Keep the user's intent, make it reusable. Return ONLY the rule text as one sentence — no preamble, no quotes.";
        const resp = await callClaude(sys, basis);
        if (resp && resp.trim()) lesson = resp.trim().replace(/^["']|["']$/g, "");
      } catch (e) {
        /* keep the raw instruction as the lesson */
      }
      const item = await persistLearning(lesson);
      await refreshKnowledge();
      showToast(
        (item.cloud ? "Learned ☁️ — " : "Learned ✓ — ") + lesson.slice(0, 48),
        "success"
      );
    } catch (e) {
      showToast("Could not save lesson", "error");
    } finally {
      setTeaching(false);
    }
  }

  async function handleBackup() {
    try {
      const data = await api.backup();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      triggerDownload(
        blob,
        "note-brain-backup-" + new Date().toISOString().slice(0, 10) + ".json"
      );
      showToast("Brain backup downloaded ✓", "success");
    } catch (e) {
      showToast("Backup failed", "error");
    }
  }

  /* Upload a rulebook (GFR / CCS / ...) -> extract text -> store + index on the
   * server so every future note can cite it. */
  async function handleRuleUpload(file) {
    if (!file) return;
    if (!apiBase()) {
      showToast("Set the backend URL in settings first", "error");
      return;
    }
    setRuleLoading(true);
    let rawText = "";
    try {
      rawText = await readFileAsText(file, (m) => showToast(m, "info"));
    } catch (e) {
      setRuleLoading(false);
      showToast(
        e && (e.code === "PDF_NO_TEXT" || e.code === "IMAGE_NO_TEXT")
          ? "Couldn't read text from this rule file. Try a .docx or text-based PDF."
          : "Could not read this file.",
        "error"
      );
      return;
    }
    try {
      const name = (file.name || "Rule document").replace(/\.[^.]+$/, "");
      const saved = await api.addRule(name, rawText);
      setRules((r) => [...r, saved]);
      showToast("Rule added to the brain ✓ (" + (saved.sectionCount || 0) + " sections)", "success");
    } catch (e) {
      if (e && e.code === "UNAUTHORIZED") {
        setShowLogin(true);
        showToast("Please sign in to add rules", "error");
      } else {
        showToast("Could not save rule: " + (e && e.message), "error");
      }
    } finally {
      setRuleLoading(false);
    }
  }

  async function handleDeleteRule(id) {
    try {
      await api.delRule(id);
      setRules((r) => r.filter((x) => x.id !== id));
      showToast("Rule removed", "info");
    } catch (e) {
      showToast("Could not remove rule", "error");
    }
  }

  async function refreshSignatures() {
    const sigs = await storageGet("lib:signatures", true);
    if (Array.isArray(sigs)) setSignatures(sigs);
  }

  async function refreshKnowledge() {
    const k = await storageGet("lib:knowledge", true);
    let list = Array.isArray(k) ? k : [];
    // When signed in, merge in the server-side standing instructions so they
    // show on every device (deduped by id).
    if (apiBase() && apiToken()) {
      try {
        const brain = await api.getBrain();
        const seen = new Set(list.map((x) => x.id));
        const cloud = (brain.learning || [])
          .filter((x) => !seen.has(x.id))
          .map((x) => ({ id: x.id, text: x.text, addedAt: x.addedAt, cloud: true }));
        list = [...cloud, ...list];
      } catch (e) {
        /* offline / not authed: show local only */
      }
    }
    setKnowledge(list);
  }

  // Persist a standing instruction. When signed in it goes to the server (so it
  // follows the user across devices); a local mirror is always kept too.
  async function persistLearning(text, extra) {
    let item = Object.assign({ id: generateUUID(), text, addedAt: Date.now() }, extra || {});
    if (apiBase() && apiToken()) {
      try {
        const saved = await api.addLearning(text);
        item = Object.assign({}, item, {
          id: saved.id, text: saved.text, addedAt: saved.addedAt, cloud: true,
        });
      } catch (e) {
        /* fall back to local-only */
      }
    }
    const list = (await storageGet("lib:knowledge", true)) || [];
    list.push(item);
    await storageSet("lib:knowledge", list, true);
    return item;
  }

  async function addKnowledge() {
    const text = knowledgeInput.trim();
    if (!text) return;
    setSavingKnowledge(true);
    try {
      const item = await persistLearning(text);
      await refreshKnowledge();
      setKnowledgeInput("");
      showToast(item.cloud ? "Learning saved to your brain ☁️" : "Learning material saved ✓", "success");
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    } finally {
      setSavingKnowledge(false);
    }
  }

  /* Upload an older note file -> distill reusable learnings -> permanent memory */
  async function handleKnowledgeFile(file) {
    if (!file) return;
    setKnowledgeFileLoading(true);
    let rawText = "";
    try {
      rawText = await readFileAsText(file, (m) => showToast(m, "info"));
    } catch (e) {
      setKnowledgeFileLoading(false);
      showToast(
        e && (e.code === "PDF_NO_TEXT" || e.code === "IMAGE_NO_TEXT")
          ? "Couldn't read any text from this scan/image. Try a clearer scan, or upload the .docx (or text-based PDF) version."
          : "Could not read this file. Please try a different .docx or .pdf file.",
        "error"
      );
      return;
    }

    let learnings = null;
    try {
      const sys =
        "You are distilling permanent, reusable learning points from an older government office noting document so future notes match this office's style and rules. Return only raw JSON with no markdown, no backticks, no preamble: { learnings: array of 3 to 7 short instruction strings capturing tone, structure, phrasing, and any rules to always follow }";
      const resp = await callClaude(sys, rawText);
      const parsed = parseJSON(resp);
      learnings =
        parsed && Array.isArray(parsed.learnings) ? parsed.learnings : null;
    } catch (e) {
      // fall through to raw-text fallback below
    }

    try {
      const text = learnings
        ? "From " + file.name + ":\n• " + learnings.join("\n• ")
        : "From " + file.name + ":\n" + rawText.slice(0, 4000);
      await persistLearning(text, { source: file.name });
      await refreshKnowledge();
      showToast(
        learnings
          ? "Learned from " + file.name + " ✓"
          : "Saved text from " + file.name,
        "success"
      );
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    } finally {
      setKnowledgeFileLoading(false);
    }
  }

  async function deleteKnowledge(id) {
    try {
      const list = (await storageGet("lib:knowledge", true)) || [];
      const item = list.find((k) => k.id === id) || knowledge.find((k) => k.id === id);
      const next = list.filter((k) => k.id !== id);
      await storageSet("lib:knowledge", next, true);
      if (apiBase() && apiToken() && (!item || item.cloud)) {
        try { await api.delLearning(id); } catch (e) {}
      }
      await refreshKnowledge();
      showToast("Learning note removed", "info");
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    }
  }

  async function persistSession(partial) {
    try {
      const session = {
        sessionId: sessionIdRef.current,
        sourceFilename,
        extractedFacts: facts,
        chatHistory,
        versions,
        activeVersion,
        ...partial,
      };
      await storageSet("session:current", session, false);
    } catch (e) {
      /* non-fatal */
    }
  }

  async function restoreSession() {
    const s = await storageGet("session:current", false);
    if (s && typeof s === "object") {
      if (s.sessionId) sessionIdRef.current = s.sessionId;
      if (s.sourceFilename) setSourceFilename(s.sourceFilename);
      if (s.extractedFacts) setFacts(s.extractedFacts);
      if (Array.isArray(s.chatHistory)) setChatHistory(s.chatHistory);
      if (Array.isArray(s.versions)) {
        setVersions(s.versions);
        if (s.versions.length > 0) {
          setFactCardHidden(true);
          setActiveVersion(
            typeof s.activeVersion === "number"
              ? s.activeVersion
              : s.versions.length - 1
          );
        }
      }
    }
  }

  /* ============================================================== *
   *  FEATURE 1: REFERENCE NOTING UPLOAD & LEARNING
   * ============================================================== */
  async function handleRefUpload(file) {
    if (!file) return false;
    setRefLoading(true);
    let rawText = "";
    try {
      rawText = await readFileAsText(file, (m) => showToast(m, "info"));
    } catch (e) {
      setRefLoading(false);
      showToast(
        e && (e.code === "PDF_NO_TEXT" || e.code === "IMAGE_NO_TEXT")
          ? "Couldn't read any text from this scan/image. Try a clearer scan, or upload the .docx (or text-based PDF) version."
          : "Could not read this file. Please try a different .docx or .pdf file.",
        "error"
      );
      return false;
    }

    let analysis = null;
    try {
      const sys =
        "You are analyzing a formal government office noting document from CSIR TKDL Unit. Extract the following as strict JSON with absolutely no markdown formatting, no backticks, no preamble. Return only the raw JSON object:\n" +
        "{\n" +
        "  styleRules: {\n" +
        "    tone: description of formality and language style,\n" +
        "    openingPhrase: how the noting begins,\n" +
        "    closingPhrase: how it ends before signatures,\n" +
        "    paragraphCount: number,\n" +
        "    usesHindi: boolean,\n" +
        "    hindiPattern: one of header-only or subject-only or full or none\n" +
        "  },\n" +
        "  signatureChain: array of role strings in order,\n" +
        "  subjectLinePattern: string describing the subject line format,\n" +
        "  keyPhrases: array of 5 important formal phrases found,\n" +
        "  tags: array containing relevant tags from Finance, Admin, Audit, Legal, HR,\n" +
        "  language: one of English or Hindi or Mixed\n" +
        "}";
      const resp = await callClaude(sys, rawText);
      analysis = parseJSON(resp);
    } catch (e) {
      setRefLoading(false);
      showToast("AI call failed — please retry", "error");
      return false;
    }

    if (!analysis) {
      setRefLoading(false);
      showToast("AI call failed — please retry", "error");
      return false;
    }

    try {
      // Step C — store ref noting (and mirror to the server-side brain so the
      // style example is available on every device).
      const uuid = Date.now();
      let cloudId = null;
      if (apiBase() && apiToken()) {
        try {
          const saved = await api.addReference({
            name: file.name,
            analysis,
            summary: (analysis.styleRules && analysis.styleRules.tone) || "",
          });
          cloudId = saved && saved.id;
        } catch (e) {
          /* keep local-only if the server rejects it */
        }
      }
      const record = {
        id: uuid,
        cloudId,
        filename: file.name,
        uploadedAt: Date.now(),
        styleRules: analysis.styleRules || {},
        signatureChain: analysis.signatureChain || [],
        language: analysis.language || "English",
        tags: analysis.tags || [],
        rawText,
      };
      await storageSet("lib:ref:" + uuid, record, true);

      // Step D — merge into lib:patterns (the style knowledge used at generation)
      await mergeAnalysisIntoPatterns(analysis);

      // Step E — merge signature chain
      if (
        Array.isArray(analysis.signatureChain) &&
        analysis.signatureChain.length > 0
      ) {
        const sigs = (await storageGet("lib:signatures", true)) || [];
        const key = analysis.signatureChain.join("|");
        if (!sigs.some((s) => (s.chain || []).join("|") === key)) {
          sigs.push({
            chain: analysis.signatureChain,
            label:
              "Learned - " +
              (analysis.tags && analysis.tags[0] ? analysis.tags[0] : "Custom"),
          });
          await storageSet("lib:signatures", sigs, true);
        }
      }

      await refreshLibrary();
      await refreshSignatures();
      showToast("Reference noting learned ✓", "success");
      return true;
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
      return false;
    } finally {
      setRefLoading(false);
    }
  }

  // Upload several reference notings at once. Each needs its own AI analysis,
  // so process sequentially and report per-file progress.
  async function handleRefUploadMany(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (files.length === 1) {
      await handleRefUpload(files[0]);
      return;
    }
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      showToast(
        "Processing " + (i + 1) + " of " + files.length + ": " + files[i].name,
        "info"
      );
      const success = await handleRefUpload(files[i]);
      if (success) ok++;
    }
    showToast(
      ok + " of " + files.length + " reference noting(s) added",
      ok === files.length ? "success" : "error"
    );
  }

  async function deleteRef(id) {
    try {
      const item = refNotings.find((r) => r.id === id);
      await storageDelete("lib:ref:" + id, true);
      const cloudId = item && (item.cloudId || (item.cloud ? item.id : null));
      if (apiBase() && apiToken() && cloudId) {
        try { await api.delReference(cloudId); } catch (e) {}
      }
      await refreshLibrary();
      showToast("Reference noting removed", "info");
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    }
  }

  /* ---- signature chains ---- */
  async function addCustomChain() {
    const roles = chainRoles
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (roles.length === 0) {
      showToast("Enter at least one role", "error");
      return;
    }
    try {
      const sigs = (await storageGet("lib:signatures", true)) || [];
      sigs.push({ chain: roles, label: chainLabel.trim() || "Custom Chain" });
      await storageSet("lib:signatures", sigs, true);
      await refreshSignatures();
      setChainRoles("");
      setChainLabel("");
      setShowChainForm(false);
      showToast("Signature chain added ✓", "success");
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    }
  }

  async function deleteChain(idx) {
    try {
      const sigs = (await storageGet("lib:signatures", true)) || [];
      sigs.splice(idx, 1);
      await storageSet("lib:signatures", sigs, true);
      await refreshSignatures();
      if (selectedChainIdx >= sigs.length)
        setSelectedChainIdx(Math.max(0, sigs.length - 1));
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    }
  }

  /* ============================================================== *
   *  FEATURE 2: SOURCE DOCUMENT PROCESSING
   * ============================================================== */
  async function handleSourceUpload(file) {
    return handleSourceUploadMany(file ? [file] : []);
  }

  // Read one or more source documents, combine their text, and extract a single
  // set of facts from everything together.
  async function handleSourceUploadMany(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setSourceProcessing(true);
    let combined = "";
    const names = [];
    for (const file of files) {
      try {
        const text = await readFileAsText(file, (m) => showToast(m, "info"));
        if (text && text.trim()) {
          combined += (combined ? "\n\n" : "") + "===== " + file.name + " =====\n" + text;
          names.push(file.name);
        } else {
          showToast(file.name + ": no readable text — skipped", "error");
        }
      } catch (e) {
        showToast(
          e && (e.code === "PDF_NO_TEXT" || e.code === "IMAGE_NO_TEXT")
            ? file.name + ": no readable text (scanned?) — skipped"
            : file.name + ": could not read — skipped",
          "error"
        );
      }
    }
    if (!combined.trim()) {
      setSourceProcessing(false);
      setSourceFilename("");
      showToast("No readable text in the selected file(s).", "error");
      return;
    }
    const displayName =
      names.length === 1 ? names[0] : names[0] + " + " + (names.length - 1) + " more";
    setSourceFilename(displayName);

    try {
      const sys =
        "You are extracting structured facts from one or more government office documents. Return only raw JSON with no markdown, no backticks, no preamble.";
      const userMsg =
        "Extract all key facts from the document(s) below and return this exact JSON structure:\n" +
        "{\n" +
        "  subject: one-line subject suitable for an office noting,\n" +
        "  date: date found in document or todays date,\n" +
        "  organization: organization name,\n" +
        "  parties: array of party names,\n" +
        "  amounts: array of objects each with value and description,\n" +
        "  accountNumbers: array of objects each with bank and number and type,\n" +
        "  ruleReferences: array of rule or regulation references found,\n" +
        "  purpose: what this document is about in one sentence,\n" +
        "  requestedAction: what approval or action is being sought,\n" +
        "  budgetHead: budget head code if found,\n" +
        "  additionalFacts: object with any other important key-value facts\n" +
        "}\n" +
        "Document text: " +
        combined;
      const parsed = await callClaudeJSON(sys, userMsg, 3);
      if (!parsed) {
        showToast("AI call failed — please retry", "error");
        setSourceProcessing(false);
        return;
      }
      const normalized = normalizeFacts(parsed);
      setFacts(normalized);
      setFactCardHidden(false);
      persistSession({ extractedFacts: normalized, sourceFilename: displayName });
      showToast(
        names.length +
          " document" +
          (names.length > 1 ? "s" : "") +
          " read — facts extracted, please verify",
        "success"
      );
    } catch (e) {
      showToast("AI call failed — please retry", "error");
    } finally {
      setSourceProcessing(false);
    }
  }

  /* Convert raw extracted facts -> flat editable strings keyed by FACT_FIELDS */
  function normalizeFacts(p) {
    const join = (v) => {
      if (v == null) return "";
      if (Array.isArray(v))
        return v
          .map((x) =>
            typeof x === "object" && x !== null
              ? Object.values(x).filter(Boolean).join(" - ")
              : String(x)
          )
          .join("; ");
      if (typeof v === "object") return Object.values(v).join(" - ");
      return String(v);
    };
    return {
      subject: join(p.subject),
      date: join(p.date) || new Date().toLocaleDateString("en-GB"),
      organization: join(p.organization) || "CSIR TKDL UNIT",
      parties: join(p.parties),
      amounts: join(p.amounts),
      accountNumbers: join(p.accountNumbers),
      ruleReferences: join(p.ruleReferences),
      purpose: join(p.purpose),
      requestedAction: join(p.requestedAction),
      budgetHead: join(p.budgetHead),
      additionalFacts:
        p.additionalFacts && typeof p.additionalFacts === "object"
          ? Object.entries(p.additionalFacts)
              .map(([k, v]) => `${k}: ${join(v)}`)
              .join("; ")
          : "",
    };
  }

  function clearSource() {
    setSourceFilename("");
    setFacts(null);
    persistSession({ sourceFilename: "", extractedFacts: null });
  }

  function updateFact(key, value) {
    setFacts((f) => ({ ...(f || {}), [key]: value }));
  }

  /* Retrieve the rule provisions most relevant to what's being drafted, from
   * the server-side rule library, and format them as authoritative grounding.
   * Also records them in ruleHits so the UI can show "rules used". */
  async function retrieveRuleContext(queryText) {
    setRuleHits([]);
    if (!apiBase() || !queryText || !queryText.trim()) return "";
    try {
      const out = await api.searchRules(queryText, 6);
      const results = (out && out.results) || [];
      if (!results.length) return "";
      setRuleHits(results);
      const blocks = results.map(
        (r, i) =>
          "[" + (i + 1) + "] " + (r.ruleName || "Rule") +
          (r.label ? " — " + r.label : "") + ":\n" + r.text
      );
      return (
        ". The following official rule provisions were retrieved from the office rule library and are AUTHORITATIVE. When the note relies on a rule, cite it EXACTLY as written here (e.g. 'GFR 2017 Rule 21') and never invent rule numbers. If none are relevant, do not cite any. Provisions:\n" +
        blocks.join("\n\n")
      );
    } catch (e) {
      return ""; // retrieval is best-effort; never block generation
    }
  }

  /* ============================================================== *
   *  STYLE-PATTERN INJECTION (shared by generation + iteration)
   * ============================================================== */
  async function buildSystemPrompt(ruleContext) {
    const patterns = (await storageGet("lib:patterns", true)) || SEED_PATTERNS;
    const sigs = (await storageGet("lib:signatures", true)) || SEED_SIGNATURES;
    const knowledgeList = (await storageGet("lib:knowledge", true)) || [];
    const knowledgeText = Array.isArray(knowledgeList)
      ? knowledgeList.map((k) => (k && k.text) || "").filter(Boolean)
      : [];
    return (
      "You are a senior government office noting writer for CSIR TKDL Unit Finance and Accounts section. You write formal office noting documents in the exact style of this organization. You have learned these style patterns from reference documents: " +
      JSON.stringify(patterns) +
      ". Known signature chains: " +
      JSON.stringify(sigs) +
      (knowledgeText.length
        ? ". You must always follow these standing instructions and permanent learning material provided by the office: " +
          JSON.stringify(knowledgeText)
        : "") +
      (ruleContext ? ruleContext : "") +
      ". Return only raw JSON with no markdown, no backticks, no preamble, using this exact structure:\n" +
      "{\n" +
      "  header: organization header string,\n" +
      "  department: department name string,\n" +
      "  date: date string,\n" +
      "  subject: subject line string,\n" +
      "  hindiSubject: Hindi subject line or empty string,\n" +
      "  reference: reference line string,\n" +
      "  paragraphs: array of body paragraph strings,\n" +
      "  detailsBlock: array of objects each with label and value,\n" +
      "  closingLine: closing sentence string,\n" +
      "  signatureChain: array of role strings,\n" +
      "  language: English or Mixed or Hindi\n" +
      "}"
    );
  }

  function normalizeNote(n) {
    if (!n || typeof n !== "object") return null;
    return {
      header: n.header || "CSIR TKDL UNIT",
      department: n.department || "Finance and Accounts",
      date: n.date || "",
      subject: n.subject || "",
      hindiSubject: n.hindiSubject || "",
      reference: n.reference || "",
      paragraphs: Array.isArray(n.paragraphs)
        ? n.paragraphs
        : n.paragraphs
        ? [String(n.paragraphs)]
        : [],
      detailsBlock: Array.isArray(n.detailsBlock)
        ? n.detailsBlock.filter((d) => d && (d.label || d.value))
        : [],
      closingLine: n.closingLine || "",
      signatureChain: Array.isArray(n.signatureChain) ? n.signatureChain : [],
      language: n.language || language,
      _ts: Date.now(),
    };
  }

  /* ============================================================== *
   *  FEATURE 3: FIRST NOTE GENERATION
   * ============================================================== */
  async function handleGenerate() {
    // A source document is optional — a note can be started from the user's
    // instruction alone. Only block if there's neither facts nor an instruction.
    if (!facts && !chatInput.trim()) {
      showToast("Type what the note should say, then Send", "error");
      return;
    }
    setEditing(false);
    setGenerating(true);
    try {
      const chain =
        signatures[selectedChainIdx] && signatures[selectedChainIdx].chain
          ? signatures[selectedChainIdx].chain
          : [];
      const instruction =
        chatInput.trim() || "Generate a noting";
      const ruleContext = await retrieveRuleContext(
        instruction + " " + (facts ? JSON.stringify(facts) : "")
      );
      const sys = await buildSystemPrompt(ruleContext);
      const userMsg = facts
        ? "Create a formal noting based on these verified facts: " +
          JSON.stringify(facts) +
          ". User instruction: " +
          instruction +
          ". Language preference: " +
          language +
          ". Use signature chain: " +
          JSON.stringify(chain) +
          "."
        : "Create a formal government office noting from scratch based on this instruction: " +
          instruction +
          ". There is no source document; infer reasonable, clearly-labelled placeholder details (date, references, amounts) where specifics are not given, so the user can edit them. Language preference: " +
          language +
          ". Use signature chain: " +
          JSON.stringify(chain) +
          ".";
      const note = normalizeNote(await callClaudeJSON(sys, userMsg, 3));
      if (!note) {
        showToast("AI call failed — please retry", "error");
        setGenerating(false);
        return;
      }
      const newVersions = [note];
      const newChat = [
        ...chatHistory,
        ...(chatInput.trim()
          ? [{ role: "user", text: chatInput.trim() }]
          : []),
        {
          role: "ai",
          text: "Generated v1. You can refine it by typing below.",
          version: 1,
        },
      ];
      setVersions(newVersions);
      setActiveVersion(0);
      setChatHistory(newChat);
      setFactCardHidden(true);
      setChatInput("");
      persistSession({
        versions: newVersions,
        activeVersion: 0,
        chatHistory: newChat,
      });
      // Record in server-side history (best-effort, for audit + future learning).
      if (apiBase() && apiToken()) {
        api
          .addNote({
            title: note.subject || "",
            instructions: instruction,
            draft: JSON.stringify(note),
          })
          .catch(() => {});
      }
    } catch (e) {
      showToast("AI call failed — please retry", "error");
    } finally {
      setGenerating(false);
    }
  }

  /* ============================================================== *
   *  FEATURE 4: CHAT ITERATION
   * ============================================================== */
  async function handleSend() {
    const msg = chatInput.trim();
    if (!msg) return;

    // if no note yet, the send acts as generation trigger
    if (versions.length === 0) {
      await handleGenerate();
      return;
    }

    setEditing(false);
    const userMsgEntry = { role: "user", text: msg };
    const newChatWithUser = [...chatHistory, userMsgEntry];
    setChatHistory(newChatWithUser);
    setChatInput("");
    setAiTyping(true);

    try {
      const ruleContext = await retrieveRuleContext(msg);
      const sys = await buildSystemPrompt(ruleContext);
      const current = versions[activeVersion];
      const n = versions.length;
      const priorInstructions = chatHistory
        .filter((c) => c.role === "user")
        .map((c, i) => `${i + 1}. ${c.text}`)
        .join("\n");
      const userMsg =
        "Here is the current note as JSON (v" +
        n +
        "): " +
        JSON.stringify(current) +
        ". Full instruction history so far: " +
        (priorInstructions || "(none)") +
        ". New instruction: " +
        msg +
        ". Return the complete updated note as JSON applying only the requested change. Do not alter anything that was not mentioned in the new instruction.";
      const note = normalizeNote(await callClaudeJSON(sys, userMsg, 3));
      if (!note) {
        showToast("AI call failed — please retry", "error");
        setAiTyping(false);
        return;
      }
      const newVersions = [...versions, note];
      const newVerNum = newVersions.length;
      const aiEntry = {
        role: "ai",
        text: summarizeChange(msg),
        version: newVerNum,
      };
      const finalChat = [...newChatWithUser, aiEntry];
      setVersions(newVersions);
      setActiveVersion(newVersions.length - 1);
      setChatHistory(finalChat);
      persistSession({
        versions: newVersions,
        activeVersion: newVersions.length - 1,
        chatHistory: finalChat,
      });
    } catch (e) {
      showToast("AI call failed — please retry", "error");
    } finally {
      setAiTyping(false);
    }
  }

  function summarizeChange(instruction) {
    const trimmed = instruction.length > 80
      ? instruction.slice(0, 80) + "…"
      : instruction;
    return `Updated the note as requested: "${trimmed}".`;
  }

  /* ============================================================== *
   *  FEATURE 6: DOCX DOWNLOAD
   * ============================================================== */
  function fallbackTxtDownload(note) {
    try {
      const lines = [];
      lines.push(note.header);
      lines.push(note.department);
      lines.push("----------------------------------------");
      lines.push("DATE: " + note.date);
      if (note.hindiSubject) lines.push("विषय: " + note.hindiSubject);
      lines.push("Subject: " + note.subject);
      lines.push("Ref: " + note.reference);
      lines.push("");
      (note.paragraphs || []).forEach((p) => lines.push(p + "\n"));
      (note.detailsBlock || []).forEach((d) =>
        lines.push("    " + d.label + " : " + d.value)
      );
      lines.push("");
      lines.push(note.closingLine);
      lines.push("");
      (note.signatureChain || []).forEach((r) => lines.push(r));
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      triggerDownload(blob, docxFilename(note).replace(/\.docx$/, ".txt"));
    } catch (e) {
      showToast("Download failed", "error");
    }
  }

  function docxFilename(note) {
    const words = (note.subject || "Note")
      .replace(/[^\w\sऀ-ॿ]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join("_");
    const date = (note.date || "").replace(/[^\w]/g, "-");
    return `Noting_${words || "Note"}_${date || "draft"}.docx`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function handleDownloadDocx() {
    const note = versions[activeVersion];
    if (!note) return;
    try {
      await loadScript(DOCX_CDN);
      const docx = window.docx;
      if (!docx) throw new Error("docx unavailable");
      const {
        Document,
        Packer,
        Paragraph,
        TextRun,
        AlignmentType,
        BorderStyle,
      } = docx;
      const FONT = docStyle.fontFamily;
      const SZ = docStyle.fontSize * 2; // docx sizes are half-points
      const ALIGN =
        {
          justify: AlignmentType.JUSTIFIED,
          left: AlignmentType.LEFT,
          center: AlignmentType.CENTER,
          right: AlignmentType.RIGHT,
        }[docStyle.align] || AlignmentType.JUSTIFIED;
      const lineSp = { line: Math.round(docStyle.lineSpacing * 240), lineRule: "auto" };

      const titleP = (text, size) =>
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text, bold: true, font: FONT, size }),
          ],
        });

      const labelValueP = (label, value, opts = {}) =>
        new Paragraph({
          ...opts,
          children: [
            new TextRun({ text: label, bold: true, font: FONT, size: SZ }),
            new TextRun({ text: value || "", font: FONT, size: SZ }),
          ],
        });

      const children = [];
      children.push(titleP(note.header, (docStyle.fontSize + 3) * 2));
      children.push(titleP(note.department, (docStyle.fontSize + 1) * 2));
      // horizontal rule
      children.push(
        new Paragraph({
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: "000000",
            },
          },
          children: [new TextRun({ text: "" })],
        })
      );
      children.push(labelValueP("DATE: ", note.date));
      if (note.hindiSubject)
        children.push(labelValueP("विषय: ", note.hindiSubject));
      children.push(labelValueP("Subject: ", note.subject));
      children.push(labelValueP("Ref: ", note.reference));

      (note.paragraphs || []).forEach((p) => {
        children.push(
          new Paragraph({
            alignment: ALIGN,
            indent: { firstLine: 720 },
            spacing: { after: 120, ...lineSp },
            children: [new TextRun({ text: p, font: FONT, size: SZ })],
          })
        );
      });

      (note.detailsBlock || []).forEach((d) => {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: "    " + d.label + " : ",
                bold: true,
                font: FONT,
                size: SZ,
              }),
              new TextRun({ text: d.value || "", font: FONT, size: SZ }),
            ],
          })
        );
      });

      children.push(
        new Paragraph({
          spacing: { before: 200 },
          children: [
            new TextRun({ text: note.closingLine, font: FONT, size: SZ }),
          ],
        })
      );

      (note.signatureChain || []).forEach((r) => {
        children.push(
          new Paragraph({
            spacing: { before: 280 },
            children: [new TextRun({ text: r, font: FONT, size: SZ })],
          })
        );
      });

      const doc = new Document({
        sections: [
          {
            properties: {
              page: {
                size: { width: 11906, height: 16838 },
                margin: {
                  top: 1440,
                  right: 1440,
                  bottom: 1440,
                  left: 1440,
                },
              },
            },
            children,
          },
        ],
      });

      const blob = await Packer.toBlob(doc);
      triggerDownload(blob, docxFilename(note));
      showToast("DOCX downloaded ✓", "success");
    } catch (e) {
      showToast("DOCX failed — downloaded .txt instead", "error");
      fallbackTxtDownload(note);
    }
  }

  async function handleCopyText() {
    const note = versions[activeVersion];
    if (!note) return;
    const parts = [
      note.header,
      note.department,
      "DATE: " + note.date,
      note.hindiSubject ? "विषय: " + note.hindiSubject : "",
      "Subject: " + note.subject,
      "Ref: " + note.reference,
      "",
      ...(note.paragraphs || []),
      "",
      ...(note.detailsBlock || []).map((d) => "    " + d.label + " : " + d.value),
      "",
      note.closingLine,
      "",
      ...(note.signatureChain || []),
    ].filter((x) => x !== undefined);
    try {
      await navigator.clipboard.writeText(parts.join("\n"));
      showToast("Copied to clipboard ✓", "success");
    } catch (e) {
      showToast("Copy failed", "error");
    }
  }

  /* ============================================================== *
   *  RENDER HELPERS
   * ============================================================== */
  const currentNote = versions[activeVersion] || null;
  const prevNote =
    activeVersion > 0 ? versions[activeVersion - 1] || null : null;

  /* ---- document style (Phase B): one formatting set for preview + DOCX ---- */
  function updateDocStyle(patch) {
    const next = { ...docStyle, ...patch };
    setDocStyle(next);
    storageSet("cfg:docStyle", next, true);
  }

  /* ---- note history: save the current note and start a fresh one ---- */
  async function startNewNote() {
    const cur = versions[activeVersion];
    if (cur && apiBase() && apiToken()) {
      try {
        const firstInstr =
          (chatHistory.find((c) => c.role === "user") || {}).text || "";
        await api.addNote({
          title: cur.subject || "Untitled note",
          instructions: firstInstr,
          draft: JSON.stringify(cur),
          final: JSON.stringify(cur),
        });
      } catch (e) {
        /* non-fatal — still start fresh */
      }
    }
    sessionIdRef.current = generateUUID();
    setVersions([]);
    setActiveVersion(0);
    setChatHistory([]);
    setChatInput("");
    setFacts(null);
    setSourceFilename("");
    setFactCardHidden(false);
    setEditing(false);
    setRuleHits([]);
    await storageSet("session:current", { sessionId: sessionIdRef.current }, false);
    showToast(cur ? "Saved to history — new note started ✓" : "New note started", "success");
  }

  async function openHistory() {
    if (!apiBase() || !apiToken()) {
      showToast("Sign in to view saved notes", "error");
      return;
    }
    setShowHistory(true);
    setLoadingHistory(true);
    try {
      const brain = await api.getBrain();
      const notes = Array.isArray(brain.notes) ? brain.notes.slice().reverse() : [];
      setHistory(notes);
    } catch (e) {
      showToast("Could not load history", "error");
    } finally {
      setLoadingHistory(false);
    }
  }

  function loadHistoryNote(item) {
    let parsed = null;
    try {
      parsed = JSON.parse(item.final || item.draft || "null");
    } catch (e) {}
    if (!parsed) {
      showToast("Could not open this note", "error");
      return;
    }
    const note = normalizeNote(parsed) || parsed;
    const chat = [
      { role: "ai", text: "Loaded from history. Refine it by typing below.", version: 1 },
    ];
    sessionIdRef.current = generateUUID();
    setVersions([note]);
    setActiveVersion(0);
    setChatHistory(chat);
    setChatInput("");
    setFacts(null);
    setFactCardHidden(true);
    setEditing(false);
    setRuleHits([]);
    setShowHistory(false);
    persistSession({ versions: [note], activeVersion: 0, chatHistory: chat });
    showToast("Note loaded ✓", "success");
  }

  /* ---- inline editing (Phase A): write manual edits back into the active
   * version so the AI, the DOCX export and the session all stay in sync. ---- */
  function updateActiveNote(mutator) {
    const cur = versions[activeVersion];
    if (!cur) return;
    const updated = mutator({ ...cur });
    updated._ts = Date.now();
    const next = versions.slice();
    next[activeVersion] = updated;
    setVersions(next);
    persistSession({ versions: next, activeVersion });
  }
  const edit = {
    setField: (field, value) =>
      updateActiveNote((n) => ({ ...n, [field]: value })),
    setParagraph: (i, value) =>
      updateActiveNote((n) => {
        const paragraphs = (n.paragraphs || []).slice();
        paragraphs[i] = value;
        return { ...n, paragraphs };
      }),
    addParagraph: (i) =>
      updateActiveNote((n) => {
        const paragraphs = (n.paragraphs || []).slice();
        paragraphs.splice(i + 1, 0, "");
        return { ...n, paragraphs };
      }),
    deleteParagraph: (i) =>
      updateActiveNote((n) => {
        const paragraphs = (n.paragraphs || []).slice();
        paragraphs.splice(i, 1);
        return { ...n, paragraphs };
      }),
    setDetail: (i, key, value) =>
      updateActiveNote((n) => {
        const detailsBlock = (n.detailsBlock || []).map((d) => ({ ...d }));
        if (detailsBlock[i]) detailsBlock[i][key] = value;
        return { ...n, detailsBlock };
      }),
    deleteDetail: (i) =>
      updateActiveNote((n) => {
        const detailsBlock = (n.detailsBlock || []).slice();
        detailsBlock.splice(i, 1);
        return { ...n, detailsBlock };
      }),
    addDetail: () =>
      updateActiveNote((n) => ({
        ...n,
        detailsBlock: [...(n.detailsBlock || []), { label: "", value: "" }],
      })),
    setSignature: (i, value) =>
      updateActiveNote((n) => {
        const signatureChain = (n.signatureChain || []).slice();
        signatureChain[i] = value;
        return { ...n, signatureChain };
      }),
  };

  const visibleTabs = (() => {
    const total = versions.length;
    const start = Math.min(tabOffset, Math.max(0, total - 5));
    return { start, items: versions.slice(start, start + 5) };
  })();

  /* ============================================================== *
   *  JSX
   * ============================================================== */
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white font-sans text-sm text-gray-800">
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* ===================== LEFT COLUMN ===================== */}
      <div
        className={
          (isDesktop || activePanel === "library" ? "flex" : "hidden") +
          " w-full flex-col overflow-y-auto border-r border-gray-200 bg-gray-50 p-4 md:w-1/4"
        }
      >
        <h2 className="mb-3 text-lg font-bold">📚 Library</h2>

        {/* Cloud brain status / login */}
        {cloudOn && (
          <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 p-2 text-xs">
            {loggedIn ? (
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 font-medium text-indigo-700">
                  ☁️ {userName || "Signed in"}
                  <span className="ml-1 rounded bg-indigo-100 px-1 text-[10px] uppercase text-indigo-600">
                    {isAdmin ? "admin" : "user"}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {isAdmin && (
                    <button
                      onClick={handleBackup}
                      className="rounded px-2 py-0.5 text-indigo-600 hover:bg-indigo-100"
                      title="Download a full backup of your brain"
                    >
                      Backup
                    </button>
                  )}
                  <button
                    onClick={handleLogout}
                    className="rounded px-2 py-0.5 text-indigo-600 hover:bg-indigo-100"
                  >
                    Sign out
                  </button>
                </span>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="font-medium text-indigo-700">
                  🔒 Sign in to use your shared brain (rules, learning, history)
                </p>
                <input
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                  placeholder="Username"
                  autoComplete="username"
                  className="w-full rounded border border-indigo-200 px-2 py-1"
                />
                <div className="flex gap-1.5">
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                    placeholder="Password"
                    autoComplete="current-password"
                    className="min-w-0 flex-1 rounded border border-indigo-200 px-2 py-1"
                  />
                  <button
                    disabled={loggingIn}
                    onClick={handleLogin}
                    className="shrink-0 rounded bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {loggingIn ? "…" : "Sign in"}
                  </button>
                </div>
                {googleAvailable && (
                  <div className="flex flex-col items-center gap-1 pt-1">
                    <span className="text-[10px] text-gray-400">— or —</span>
                    <div ref={googleBtnRef} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Reference Notings */}
        <div className="mb-2">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Reference Notings
          </h3>
          {refNotings.length === 0 ? (
            <p className="mb-2 rounded bg-white p-2 text-xs text-gray-400">
              No reference notings yet. Add one to improve output quality.
            </p>
          ) : (
            <ul className="mb-2 space-y-1">
              {refNotings.map((r) => (
                <li
                  key={r.id}
                  className="flex items-start justify-between gap-2 rounded bg-white p-2 shadow-sm transition-all duration-200 hover:shadow"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-700">
                      {r.filename}
                    </p>
                    <p className="text-[10px] text-gray-400">
                      {new Date(r.uploadedAt).toLocaleDateString()} ·{" "}
                      <span className="rounded bg-blue-50 px-1 text-blue-600">
                        {r.language}
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => deleteRef(r.id)}
                    className="shrink-0 rounded px-1 text-gray-400 transition-colors duration-200 hover:bg-red-50 hover:text-red-500"
                    title="Delete"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={refFileInput}
            type="file"
            accept={UPLOAD_ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length) handleRefUploadMany(files);
              e.target.value = "";
            }}
          />
          <button
            disabled={refLoading}
            onClick={() => refFileInput.current && refFileInput.current.click()}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-600 bg-white py-1.5 text-xs font-medium text-blue-600 transition-all duration-200 hover:bg-blue-50 disabled:opacity-50"
          >
            {refLoading ? <Spinner /> : null}
            {refLoading ? "Processing…" : "+ Add Reference Noting(s)"}
          </button>
          <p className="mt-1 text-[10px] text-gray-400">
            Select one or more — Word, PDF, Excel, or scanned images.
          </p>
        </div>

        <hr className="my-3 border-gray-200" />

        {/* Rule Library (GFR / CCS / ... — server-side, cited in every note) */}
        <div className="mb-2">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            📖 Rule Library
          </h3>
          {!cloudOn ? (
            <p className="mb-2 rounded bg-white p-2 text-xs text-gray-400">
              Set a backend URL in settings (⚙) to store rulebooks.
            </p>
          ) : !loggedIn ? (
            <p className="mb-2 rounded bg-white p-2 text-xs text-gray-400">
              Sign in above to upload GFR, CCS, FR-SR and other rules.
            </p>
          ) : rules.length === 0 ? (
            <p className="mb-2 rounded bg-white p-2 text-xs text-gray-400">
              No rules yet. Upload GFR / CCS / FR-SR etc. — notes will cite them.
            </p>
          ) : (
            <ul className="mb-2 space-y-1">
              {rules.map((r) => (
                <li
                  key={r.id}
                  className="flex items-start justify-between gap-2 rounded bg-white p-2 shadow-sm hover:shadow"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-700">{r.name}</p>
                    <p className="text-[10px] text-gray-400">
                      {(r.sectionCount || 0) + " sections · "}
                      {Math.round((r.chars || 0) / 1000) + "k chars"}
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => handleDeleteRule(r.id)}
                      className="shrink-0 rounded px-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      title="Remove rule (admin)"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <input
            ref={ruleFileInput}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (f) handleRuleUpload(f);
              e.target.value = "";
            }}
          />
          <button
            disabled={ruleLoading || !cloudOn || !loggedIn}
            onClick={() => ruleFileInput.current && ruleFileInput.current.click()}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-600 bg-white py-1.5 text-xs font-medium text-emerald-700 transition-all duration-200 hover:bg-emerald-50 disabled:opacity-40"
          >
            {ruleLoading ? <Spinner /> : null}
            {ruleLoading ? "Indexing…" : "+ Add Rulebook (GFR / CCS / …)"}
          </button>
          <p className="mt-1 text-[10px] text-gray-400">
            Stored permanently on your server and cited automatically.
          </p>
        </div>

        <hr className="my-3 border-gray-200" />

        {/* Permanent Learning Material */}
        <div className="mb-2">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            🧠 Permanent Learning Material
          </h3>
          <p className="mb-2 text-[10px] text-gray-400">
            Type or paste rules, guidelines, or standard phrasing. The AI will
            always follow these when writing every note.
          </p>

          {knowledge.length === 0 ? (
            <p className="mb-2 rounded bg-white p-2 text-xs text-gray-400">
              No learning notes yet. Add guidance the AI should always follow.
            </p>
          ) : (
            <ul className="mb-2 space-y-1">
              {knowledge.map((k) => (
                <li
                  key={k.id}
                  className="flex items-start justify-between gap-2 rounded bg-white p-2 shadow-sm transition-all duration-200 hover:shadow"
                >
                  <div className="min-w-0">
                    {k.source && (
                      <span className="mb-1 inline-block rounded bg-blue-50 px-1 text-[10px] font-medium text-blue-600">
                        📎 {k.source}
                      </span>
                    )}
                    <p className="whitespace-pre-wrap break-words text-xs text-gray-700">
                      {k.text}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteKnowledge(k.id)}
                    className="shrink-0 rounded px-1 text-gray-400 transition-colors duration-200 hover:bg-red-50 hover:text-red-500"
                    title="Delete"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <textarea
            rows={3}
            value={knowledgeInput}
            onChange={(e) => setKnowledgeInput(e.target.value)}
            placeholder="e.g. Always cite the relevant GFR 2017 rule. Always end the body with 'Submitted for further consideration and necessary action please.'"
            className="w-full resize-none rounded-lg border border-gray-300 px-2 py-1 text-xs transition-all duration-200 focus:border-blue-400 focus:outline-none"
          />
          <button
            disabled={savingKnowledge || !knowledgeInput.trim()}
            onClick={addKnowledge}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg border border-blue-600 bg-white py-1.5 text-xs font-medium text-blue-600 transition-all duration-200 hover:bg-blue-50 disabled:opacity-50"
          >
            {savingKnowledge ? <Spinner /> : null}
            {savingKnowledge ? "Saving…" : "+ Save to Permanent Memory"}
          </button>

          <div className="my-2 flex items-center gap-2">
            <span className="h-px flex-1 bg-gray-200" />
            <span className="text-[10px] text-gray-400">or</span>
            <span className="h-px flex-1 bg-gray-200" />
          </div>

          <input
            ref={knowledgeFileInput}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (f) handleKnowledgeFile(f);
              e.target.value = "";
            }}
          />
          <button
            disabled={knowledgeFileLoading}
            onClick={() =>
              knowledgeFileInput.current && knowledgeFileInput.current.click()
            }
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white py-1.5 text-xs font-medium text-gray-600 transition-all duration-200 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50"
          >
            {knowledgeFileLoading ? <Spinner /> : null}
            {knowledgeFileLoading
              ? "Learning from file…"
              : "📂 Upload Older Note (PDF / DOCX)"}
          </button>
        </div>

        <hr className="my-3 border-gray-200" />

        {/* Signature Chains */}
        <div className="mb-2">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Signature Chains
          </h3>
          <div className="mb-2 space-y-2">
            {signatures.map((s, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-1 rounded bg-white p-2 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-1">
                  {(s.chain || []).map((role, i) => (
                    <React.Fragment key={i}>
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                        {role}
                      </span>
                      {i < s.chain.length - 1 && (
                        <span className="text-gray-400">→</span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
                <button
                  onClick={() => deleteChain(idx)}
                  className="shrink-0 rounded px-1 text-gray-400 transition-colors duration-200 hover:bg-red-50 hover:text-red-500"
                  title="Delete chain"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {showChainForm ? (
            <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-2">
              <input
                value={chainRoles}
                onChange={(e) => setChainRoles(e.target.value)}
                placeholder="Roles, comma-separated"
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
              />
              <input
                value={chainLabel}
                onChange={(e) => setChainLabel(e.target.value)}
                placeholder="Label"
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={addCustomChain}
                  className="flex-1 rounded bg-blue-600 py-1 text-xs font-medium text-white transition-colors duration-200 hover:bg-blue-700"
                >
                  Save
                </button>
                <button
                  onClick={() => setShowChainForm(false)}
                  className="flex-1 rounded bg-gray-100 py-1 text-xs text-gray-600 transition-colors duration-200 hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowChainForm(true)}
              className="w-full rounded-lg border border-gray-300 bg-white py-1.5 text-xs font-medium text-gray-600 transition-all duration-200 hover:border-blue-400 hover:text-blue-600"
            >
              + Add Custom Chain
            </button>
          )}
        </div>

        <hr className="my-3 border-gray-200" />

        {/* Source Document */}
        <div className="mb-2">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Source Document
          </h3>
          {sourceFilename && !sourceProcessing ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3">
              <p className="truncate text-xs font-medium text-gray-700">
                {sourceFilename}
              </p>
              <p className="mt-1 text-xs font-medium text-green-600">
                {facts ? "Facts extracted ✓" : "Uploaded"}
              </p>
              <button
                onClick={clearSource}
                className="mt-2 text-xs text-blue-600 underline transition-colors duration-200 hover:text-blue-800"
              >
                Clear and re-upload
              </button>
            </div>
          ) : (
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const fs = e.dataTransfer.files;
                if (fs && fs.length) handleSourceUploadMany(fs);
              }}
              className={
                "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 text-center transition-all duration-200 " +
                (dragOver
                  ? "border-blue-400 bg-blue-50"
                  : "border-gray-300 hover:border-blue-400 hover:bg-blue-50")
              }
            >
              <input
                type="file"
                accept={UPLOAD_ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => {
                  const fs = e.target.files;
                  if (fs && fs.length) handleSourceUploadMany(fs);
                  e.target.value = "";
                }}
              />
              {sourceProcessing ? (
                <span className="flex items-center gap-2 text-xs text-gray-500">
                  <Spinner /> Processing…
                </span>
              ) : (
                <>
                  <span className="text-2xl">📥</span>
                  <span className="mt-1 text-xs text-gray-500">
                    Drag &amp; drop or click — you can select several files
                  </span>
                  <span className="text-[10px] text-gray-400">
                    Word · PDF · Excel · scanned image
                  </span>
                </>
              )}
            </label>
          )}
        </div>
      </div>

      {/* ===================== MIDDLE COLUMN ===================== */}
      <div
        className={
          (isDesktop || activePanel === "instructions" ? "flex" : "hidden") +
          " w-full flex-col border-r border-gray-200 bg-white md:w-2/5"
        }
      >
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-bold">💬 Note Instructions</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={openHistory}
              className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200"
              title="View and reopen saved notes"
            >
              🕘 History
            </button>
            <button
              onClick={startNewNote}
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
              title="Save the current note to history and start a fresh one"
            >
              ＋ New Note
            </button>
          </div>
        </div>

        {/* Fact Card */}
        {facts && !factCardHidden && (
          <div className="m-3 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
            <p className="mb-2 text-sm font-semibold text-gray-700">
              Extracted Facts — verify before generating
            </p>
            <div className="grid grid-cols-2 gap-2">
              {FACT_FIELDS.map((f) => (
                <div key={f.key} className="flex flex-col">
                  <label className="text-[10px] font-medium text-gray-500">
                    {f.label}
                  </label>
                  <input
                    value={facts[f.key] || ""}
                    onChange={(e) => updateFact(f.key, e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
                  />
                </div>
              ))}
            </div>

            {/* language toggle */}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[10px] font-medium text-gray-500">
                Language:
              </span>
              {["English", "Hindi", "Mixed"].map((l) => (
                <button
                  key={l}
                  onClick={() => setLanguage(l)}
                  className={
                    "rounded px-2 py-0.5 text-xs transition-colors duration-200 " +
                    (language === l
                      ? "bg-blue-600 text-white"
                      : "bg-white text-gray-600 hover:bg-gray-100")
                  }
                >
                  {l}
                </button>
              ))}
            </div>

            {/* signature chain dropdown */}
            <div className="mt-2">
              <label className="text-[10px] font-medium text-gray-500">
                Signature Chain
              </label>
              <select
                value={selectedChainIdx}
                onChange={(e) => setSelectedChainIdx(Number(e.target.value))}
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
              >
                {signatures.map((s, i) => (
                  <option key={i} value={i}>
                    {s.label} ({(s.chain || []).join(" → ")})
                  </option>
                ))}
              </select>
            </div>

            <button
              disabled={generating}
              onClick={handleGenerate}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white transition-all duration-200 hover:bg-blue-700 disabled:opacity-50"
            >
              {generating ? <Spinner className="text-white" /> : null}
              {generating ? "Generating…" : "Generate Note Sheet →"}
            </button>
          </div>
        )}

        {/* Chat thread */}
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {chatHistory.length === 0 && (!facts || factCardHidden) && (
            <p className="mt-8 text-center text-xs text-gray-400">
              Type what you need below and press Send to start a note — e.g.
              “Draft a note seeking approval to purchase 5 laptops under GFR
              2017.” Or upload a source document on the left to auto-extract
              facts first.
            </p>
          )}
          {chatHistory.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-white">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 text-gray-800">
                  {m.version && (
                    <span className="mb-1 mr-1 inline-block rounded bg-blue-100 px-1.5 text-[10px] font-bold text-blue-600">
                      v{m.version}
                    </span>
                  )}
                  {m.text}
                </div>
              </div>
            )
          )}
          {aiTyping && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-sm bg-gray-100 px-4 py-3">
                <TypingDots />
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input area */}
        <div className="border-t border-gray-200 p-3">
          <textarea
            rows={2}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              versions.length === 0
                ? "Describe the note you need... e.g. Draft a note for purchase of 5 laptops under GFR 2017, then press Send"
                : "Refine the note... e.g. Add GFR rule reference, change the date, add Hindi subject line"
            }
            className="max-h-32 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm transition-all duration-200 focus:border-blue-400 focus:outline-none"
            style={{ minHeight: "3rem" }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-gray-400">Ctrl+Enter to send</span>
            <div className="flex items-center gap-2">
              {(chatInput.trim() || chatHistory.some((c) => c.role === "user")) && (
                <button
                  disabled={teaching || aiTyping || generating}
                  onClick={handleTeach}
                  title="Save this correction as a permanent rule the AI always follows"
                  className="flex items-center gap-1 rounded-lg border border-amber-500 bg-white px-3 py-1.5 text-sm font-medium text-amber-700 transition-all duration-200 hover:bg-amber-50 disabled:opacity-50"
                >
                  {teaching ? <Spinner /> : "💡"} Teach this
                </button>
              )}
              <button
                disabled={aiTyping || generating || !chatInput.trim()}
                onClick={handleSend}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-all duration-200 hover:bg-blue-700 disabled:opacity-50"
              >
                {(aiTyping || generating) && <Spinner className="text-white" />}
                Send
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ===================== RIGHT COLUMN ===================== */}
      <div
        className={
          (isDesktop || activePanel === "preview" ? "flex" : "hidden") +
          " w-full flex-col bg-white md:w-[35%]"
        }
      >
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-bold">📄 Note Preview</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowStyle((s) => !s)}
              className={
                "rounded px-2 py-1 text-xs font-medium transition-colors duration-200 " +
                (showStyle
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200")
              }
              title="Document formatting (font, size, spacing, alignment)"
            >
              🅰 Style
            </button>
            {currentNote && (
              <button
                onClick={() => {
                  setEditing((e) => !e);
                  setShowDiff(false);
                }}
                className={
                  "rounded px-2 py-1 text-xs font-medium transition-colors duration-200 " +
                  (editing
                    ? "bg-emerald-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200")
                }
                title="Edit the note text directly"
              >
                {editing ? "✓ Done editing" : "✏️ Edit"}
              </button>
            )}
            {versions.length > 1 && !editing && (
              <button
                onClick={() => setShowDiff((d) => !d)}
                className={
                  "rounded px-2 py-1 text-xs font-medium transition-colors duration-200 " +
                  (showDiff
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200")
                }
              >
                {showDiff ? "Hide changes" : "Show changes"}
              </button>
            )}
          </div>
        </div>

        {showStyle && (
          <div className="flex flex-wrap items-center gap-3 border-b border-indigo-100 bg-indigo-50 px-3 py-2 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-gray-500">Font</span>
              <select
                value={docStyle.fontFamily}
                onChange={(e) => updateDocStyle({ fontFamily: e.target.value })}
                className="rounded border border-indigo-200 bg-white px-1 py-0.5"
              >
                {FONT_CHOICES.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-gray-500">Size</span>
              <select
                value={docStyle.fontSize}
                onChange={(e) => updateDocStyle({ fontSize: parseInt(e.target.value, 10) })}
                className="rounded border border-indigo-200 bg-white px-1 py-0.5"
              >
                {FONT_SIZE_CHOICES.map((s) => (
                  <option key={s} value={s}>{s} pt</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="text-gray-500">Spacing</span>
              <select
                value={docStyle.lineSpacing}
                onChange={(e) => updateDocStyle({ lineSpacing: parseFloat(e.target.value) })}
                className="rounded border border-indigo-200 bg-white px-1 py-0.5"
              >
                {LINE_SPACING_CHOICES.map((s) => (
                  <option key={s} value={s}>{s}×</option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-1">
              <span className="text-gray-500">Align</span>
              {[
                ["left", "⬅"],
                ["center", "⬌"],
                ["right", "➡"],
                ["justify", "☰"],
              ].map(([val, icon]) => (
                <button
                  key={val}
                  onClick={() => updateDocStyle({ align: val })}
                  className={
                    "rounded px-1.5 py-0.5 " +
                    (docStyle.align === val
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-gray-600 ring-1 ring-indigo-200 hover:bg-indigo-100")
                  }
                  title={val}
                >
                  {icon}
                </button>
              ))}
            </div>
            <button
              onClick={() => updateDocStyle({ ...DEFAULT_DOC_STYLE })}
              className="ml-auto rounded px-2 py-0.5 text-indigo-600 hover:bg-indigo-100"
            >
              Reset
            </button>
          </div>
        )}

        {editing && (
          <div className="border-b border-emerald-100 bg-emerald-50 px-3 py-1.5 text-[11px] text-emerald-700">
            ✏️ Editing — type directly to fix text, add or delete paragraphs. Changes
            save automatically, export to DOCX, and the AI builds on them.
          </div>
        )}

        {/* rules referenced in the latest generation (grounded citations) */}
        {versions.length > 0 && ruleHits.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-emerald-100 bg-emerald-50 px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
              Rules referenced:
            </span>
            {Array.from(
              new Set(
                ruleHits.map((r) =>
                  (r.ruleName || "Rule") + (r.label ? " · " + r.label : "")
                )
              )
            )
              .slice(0, 6)
              .map((label, i) => (
                <span
                  key={i}
                  className="rounded bg-white px-1.5 py-0.5 text-[10px] text-emerald-700 ring-1 ring-emerald-200"
                  title="Pulled from your Rule Library and given to the AI as authoritative"
                >
                  {label}
                </span>
              ))}
          </div>
        )}

        {/* version tabs */}
        {versions.length > 0 && (
          <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-1">
            {visibleTabs.start > 0 && (
              <button
                onClick={() => setTabOffset((o) => Math.max(0, o - 1))}
                className="px-1 text-gray-400 hover:text-gray-600"
              >
                ‹
              </button>
            )}
            {visibleTabs.items.map((_, i) => {
              const realIdx = visibleTabs.start + i;
              const active = realIdx === activeVersion;
              return (
                <button
                  key={realIdx}
                  onClick={() => setActiveVersion(realIdx)}
                  className={
                    "border-b-2 px-3 py-1 text-xs font-medium transition-colors duration-200 " +
                    (active
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-gray-500 hover:text-gray-700")
                  }
                >
                  v{realIdx + 1}
                </button>
              );
            })}
            {visibleTabs.start + 5 < versions.length && (
              <button
                onClick={() =>
                  setTabOffset((o) => Math.min(versions.length - 5, o + 1))
                }
                className="px-1 text-gray-400 hover:text-gray-600"
              >
                ›
              </button>
            )}
          </div>
        )}

        {/* preview area */}
        <div className="flex-1 overflow-y-auto p-6">
          {generating && versions.length === 0 ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-4 animate-pulse rounded bg-gray-200"
                  style={{ width: `${90 - i * 15}%` }}
                />
              ))}
            </div>
          ) : currentNote ? (
            <NotePreview
              note={currentNote}
              prev={prevNote}
              showDiff={showDiff && !!prevNote}
              editing={editing}
              edit={edit}
              docStyle={docStyle}
            />
          ) : (
            <p className="mt-20 text-center text-gray-400">
              Note will appear here
            </p>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-2 border-t border-gray-200 p-3">
          <button
            disabled={!currentNote}
            onClick={handleDownloadDocx}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-all duration-200 hover:bg-blue-700 disabled:opacity-50"
          >
            ⬇ Download DOCX
          </button>
          <button
            disabled={!currentNote}
            onClick={handleCopyText}
            className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 transition-all duration-200 hover:bg-gray-200 disabled:opacity-50"
          >
            📋 Copy Text
          </button>
          {currentNote && (
            <span className="ml-auto text-[10px] text-gray-400">
              v{activeVersion + 1} ·{" "}
              {new Date(currentNote._ts || Date.now()).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>
      </div>

      {/* ===== mobile bottom navigation (hidden on desktop) ===== */}
      {!isDesktop && (
      <nav className="flex shrink-0 border-t border-gray-200 bg-white">
        {[
          { id: "library", label: "Library", icon: "📚" },
          { id: "instructions", label: "Note", icon: "💬" },
          { id: "preview", label: "Preview", icon: "📄" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setActivePanel(t.id)}
            className={
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors duration-200 " +
              (activePanel === t.id
                ? "border-t-2 border-blue-600 text-blue-600"
                : "border-t-2 border-transparent text-gray-500")
            }
          >
            <span className="text-base leading-none">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
      )}

      {/* ===================== HISTORY MODAL ===================== */}
      {showHistory && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowHistory(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold">🕘 Saved Notes</h3>
              <button
                onClick={() => setShowHistory(false)}
                className="rounded px-2 text-gray-400 hover:bg-gray-100"
              >
                ✕
              </button>
            </div>
            {loadingHistory ? (
              <p className="py-6 text-center text-sm text-gray-400">Loading…</p>
            ) : history.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">
                No saved notes yet. They appear here after you generate or start a new note.
              </p>
            ) : (
              <ul className="space-y-2">
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => loadHistoryNote(h)}
                      className="w-full rounded-lg border border-gray-200 p-2 text-left transition-colors hover:border-blue-400 hover:bg-blue-50/40"
                    >
                      <p className="truncate text-sm font-medium text-gray-800">
                        {h.title || "Untitled note"}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {h.addedAt ? new Date(h.addedAt).toLocaleString() : ""}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ===================== TOASTS ===================== */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "animate-[slidein_0.2s_ease-out] rounded-lg px-4 py-2 text-sm text-white shadow-lg " +
              (t.type === "success"
                ? "bg-green-600"
                : t.type === "error"
                ? "bg-red-500"
                : "bg-gray-700")
            }
          >
            {t.message}
          </div>
        ))}
      </div>

      <style>{`
        @keyframes slidein {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  NOTE PREVIEW (styled CSIR TKDL format, with optional diff)
 * ------------------------------------------------------------------ */
/* Auto-growing textarea used for editing paragraphs / closing line. */
function AutoTextarea({ value, onChange, style, className, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value || ""}
      placeholder={placeholder || ""}
      onChange={onChange}
      rows={1}
      className={className}
      style={style}
    />
  );
}

function NotePreview({ note, prev, showDiff, editing, edit, docStyle }) {
  const labelStyle = { fontWeight: 700 };
  const ds = docStyle || DEFAULT_DOC_STYLE;
  const bodySize = ds.fontSize + "pt";
  const headerSize = ds.fontSize + 3 + "pt";
  const deptSize = ds.fontSize + 1 + "pt";
  const paraStyle = {
    textIndent: "2em",
    fontSize: bodySize,
    lineHeight: ds.lineSpacing,
    textAlign: ds.align,
  };
  const E = editing && edit ? edit : null;
  const inputCls =
    "w-full rounded border border-dashed border-gray-300 bg-yellow-50/40 px-1 focus:border-blue-400 focus:bg-white focus:outline-none";

  // value that sits inline after a bold label (Subject / Ref / Date …)
  const Inline = ({ field, value, style }) =>
    E ? (
      <input
        value={value || ""}
        onChange={(e) => E.setField(field, e.target.value)}
        className={inputCls}
        style={style}
      />
    ) : (
      <>{value}</>
    );

  return (
    <div
      className="mx-auto max-w-prose text-gray-900"
      style={{ fontFamily: ds.fontFamily }}
    >
      {E ? (
        <input
          value={note.header || ""}
          onChange={(e) => E.setField("header", e.target.value)}
          className={inputCls + " text-center font-bold"}
          style={{ fontSize: headerSize }}
        />
      ) : (
        <p className="text-center font-bold" style={{ fontSize: headerSize }}>
          {note.header}
        </p>
      )}
      {E ? (
        <input
          value={note.department || ""}
          onChange={(e) => E.setField("department", e.target.value)}
          className={inputCls + " mt-1 text-center font-bold"}
          style={{ fontSize: deptSize }}
        />
      ) : (
        <p className="text-center font-bold" style={{ fontSize: deptSize }}>
          {note.department}
        </p>
      )}
      <hr className="my-3 border-t-2 border-gray-800" />

      <p style={{ fontSize: bodySize }}>
        <span style={labelStyle}>DATE: </span>
        <Inline field="date" value={note.date} />
      </p>
      {E || note.hindiSubject ? (
        <p style={{ fontSize: bodySize }}>
          <span style={labelStyle}>विषय: </span>
          <Inline field="hindiSubject" value={note.hindiSubject} />
        </p>
      ) : null}
      <p style={{ fontSize: bodySize }}>
        <span style={labelStyle}>Subject: </span>
        <Inline field="subject" value={note.subject} />
      </p>
      <p style={{ fontSize: bodySize }}>
        <span style={labelStyle}>Ref: </span>
        <Inline field="reference" value={note.reference} />
      </p>

      <div className="mt-3 space-y-2">
        {(note.paragraphs || []).map((p, i) =>
          E ? (
            <div key={i}>
              <AutoTextarea
                value={p}
                onChange={(e) => E.setParagraph(i, e.target.value)}
                className={inputCls + " resize-none text-justify"}
                style={{ fontSize: bodySize }}
              />
              <div className="mt-0.5 flex gap-3 text-[10px] text-gray-400">
                <button onClick={() => E.addParagraph(i)} className="hover:text-blue-600">
                  + paragraph below
                </button>
                <button onClick={() => E.deleteParagraph(i)} className="hover:text-red-600">
                  delete
                </button>
              </div>
            </div>
          ) : (
            <p key={i} style={paraStyle}>
              {showDiff ? (
                <DiffText oldStr={(prev.paragraphs || [])[i] || ""} newStr={p} />
              ) : (
                p
              )}
            </p>
          )
        )}
        {E && (
          <button
            onClick={() => E.addParagraph((note.paragraphs || []).length - 1)}
            className="text-[11px] text-blue-600 hover:underline"
          >
            + Add paragraph
          </button>
        )}
      </div>

      {(note.detailsBlock || []).length > 0 || E ? (
        <div className="mt-3 space-y-1" style={{ fontSize: bodySize }}>
          {(note.detailsBlock || []).map((d, i) => {
            const oldItem = (prev && prev.detailsBlock && prev.detailsBlock[i]) || {};
            return E ? (
              <div key={i} className="flex items-center gap-1" style={{ paddingLeft: "2em" }}>
                <input
                  value={d.label || ""}
                  onChange={(e) => E.setDetail(i, "label", e.target.value)}
                  className={inputCls + " font-bold"}
                  style={{ maxWidth: "45%" }}
                  placeholder="Label"
                />
                <span>:</span>
                <input
                  value={d.value || ""}
                  onChange={(e) => E.setDetail(i, "value", e.target.value)}
                  className={inputCls}
                  placeholder="Value"
                />
                <button
                  onClick={() => E.deleteDetail(i)}
                  className="text-[12px] text-gray-400 hover:text-red-600"
                  title="Remove row"
                >
                  ×
                </button>
              </div>
            ) : (
              <p key={i} style={{ paddingLeft: "2em" }}>
                <span style={labelStyle}>{d.label} : </span>
                {showDiff ? (
                  <DiffText oldStr={oldItem.value || ""} newStr={d.value || ""} />
                ) : (
                  d.value
                )}
              </p>
            );
          })}
          {E && (
            <button
              onClick={() => E.addDetail()}
              style={{ paddingLeft: "2em" }}
              className="text-[11px] text-blue-600 hover:underline"
            >
              + Add detail row
            </button>
          )}
        </div>
      ) : null}

      {E ? (
        <AutoTextarea
          value={note.closingLine}
          onChange={(e) => E.setField("closingLine", e.target.value)}
          className={inputCls + " mt-4 resize-none"}
          style={{ fontSize: bodySize }}
          placeholder="Closing line (optional)"
        />
      ) : note.closingLine ? (
        <p className="mt-4" style={{ fontSize: bodySize }}>
          {note.closingLine}
        </p>
      ) : null}

      <div className="mt-6 space-y-3">
        {(note.signatureChain || []).map((r, i) =>
          E ? (
            <input
              key={i}
              value={r || ""}
              onChange={(e) => E.setSignature(i, e.target.value)}
              className={inputCls}
              style={{ fontSize: bodySize }}
            />
          ) : (
            <p key={i} style={{ fontSize: bodySize }}>
              {r}
            </p>
          )
        )}
      </div>
    </div>
  );
}
