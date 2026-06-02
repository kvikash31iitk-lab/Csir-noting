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
  try {
    if (typeof text !== "string") return null;
    let cleaned = text.trim();
    // remove leading/trailing ``` fences (```json ... ```)
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    // if there is still a fenced block somewhere, grab the first {...}
    if (cleaned[0] !== "{" && cleaned[0] !== "[") {
      const m = cleaned.match(/[{[][\s\S]*[}\]]/);
      if (m) cleaned = m[0];
    }
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
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

/** Read .docx (mammoth) or .pdf / text (FileReader) into raw text. */
async function readFileAsText(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".docx")) {
    await loadScript(MAMMOTH_CDN);
    if (!window.mammoth) throw new Error("mammoth unavailable");
    const arrayBuffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    return (result && result.value) || "";
  }
  // .pdf (text layer only) and any other file -> read as text
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let txt = reader.result || "";
      if (name.endsWith(".pdf")) {
        // crude text-layer extraction from raw pdf bytes
        const matches = String(txt).match(/\(([^()]{2,})\)/g) || [];
        const extracted = matches
          .map((m) => m.slice(1, -1))
          .join(" ")
          .replace(/\\[rn]/g, " ")
          .trim();
        if (extracted) txt = extracted;
      }
      resolve(String(txt));
    };
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
  const [tabOffset, setTabOffset] = useState(0);

  const sessionIdRef = useRef(generateUUID());
  const chatEndRef = useRef(null);
  const refFileInput = useRef(null);

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

        await refreshLibrary();
        await refreshSignatures();
        await restoreSession();
      } catch (e) {
        showToast("Storage error — changes may not persist", "error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* auto-scroll chat */
  useEffect(() => {
    if (chatEndRef.current)
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, aiTyping]);

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
      items.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
      setRefNotings(items);
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    }
  }

  async function refreshSignatures() {
    const sigs = await storageGet("lib:signatures", true);
    if (Array.isArray(sigs)) setSignatures(sigs);
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
    if (!file) return;
    setRefLoading(true);
    let rawText = "";
    try {
      rawText = await readFileAsText(file);
    } catch (e) {
      setRefLoading(false);
      showToast(
        "Could not read this file. Please try a different .docx or .pdf file.",
        "error"
      );
      return;
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
      return;
    }

    if (!analysis) {
      setRefLoading(false);
      showToast("AI call failed — please retry", "error");
      return;
    }

    try {
      // Step C — store ref noting
      const uuid = Date.now();
      const record = {
        id: uuid,
        filename: file.name,
        uploadedAt: Date.now(),
        styleRules: analysis.styleRules || {},
        signatureChain: analysis.signatureChain || [],
        language: analysis.language || "English",
        tags: analysis.tags || [],
        rawText,
      };
      await storageSet("lib:ref:" + uuid, record, true);

      // Step D — merge into lib:patterns
      const existing =
        (await storageGet("lib:patterns", true)) || {
          toneRules: [],
          structureRules: [],
          subjectPatterns: [],
          phrasebook: [],
        };
      const dedupe = (arr) => Array.from(new Set(arr.filter(Boolean)));
      const sr = analysis.styleRules || {};
      if (sr.tone)
        existing.toneRules = dedupe([...(existing.toneRules || []), sr.tone]);
      if (analysis.subjectLinePattern)
        existing.subjectPatterns = dedupe([
          ...(existing.subjectPatterns || []),
          analysis.subjectLinePattern,
        ]);
      if (Array.isArray(analysis.keyPhrases))
        existing.phrasebook = dedupe([
          ...(existing.phrasebook || []),
          ...analysis.keyPhrases,
        ]);
      if (sr.openingPhrase || sr.closingPhrase)
        existing.structureRules = dedupe([
          ...(existing.structureRules || []),
          sr.openingPhrase ? "Opens with: " + sr.openingPhrase : null,
          sr.closingPhrase ? "Closes with: " + sr.closingPhrase : null,
        ]);
      await storageSet("lib:patterns", existing, true);

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
    } catch (e) {
      showToast("Storage error — changes may not persist", "error");
    } finally {
      setRefLoading(false);
    }
  }

  async function deleteRef(id) {
    try {
      await storageDelete("lib:ref:" + id, true);
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
    if (!file) return;
    setSourceProcessing(true);
    setSourceFilename(file.name);
    let rawText = "";
    try {
      rawText = await readFileAsText(file);
    } catch (e) {
      setSourceProcessing(false);
      setSourceFilename("");
      showToast(
        "Could not read this file. Please try a different .docx or .pdf file.",
        "error"
      );
      return;
    }

    try {
      const sys =
        "You are extracting structured facts from a government office document. Return only raw JSON with no markdown, no backticks, no preamble.";
      const userMsg =
        "Extract all key facts from this document and return this exact JSON structure:\n" +
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
        rawText;
      const resp = await callClaude(sys, userMsg);
      const parsed = parseJSON(resp);
      if (!parsed) {
        showToast("AI call failed — please retry", "error");
        setSourceProcessing(false);
        return;
      }
      const normalized = normalizeFacts(parsed);
      setFacts(normalized);
      setFactCardHidden(false);
      persistSession({ extractedFacts: normalized, sourceFilename: file.name });
      showToast("Facts extracted — please verify above", "success");
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

  /* ============================================================== *
   *  STYLE-PATTERN INJECTION (shared by generation + iteration)
   * ============================================================== */
  async function buildSystemPrompt() {
    const patterns = (await storageGet("lib:patterns", true)) || SEED_PATTERNS;
    const sigs = (await storageGet("lib:signatures", true)) || SEED_SIGNATURES;
    return (
      "You are a senior government office noting writer for CSIR TKDL Unit Finance and Accounts section. You write formal office noting documents in the exact style of this organization. You have learned these style patterns from reference documents: " +
      JSON.stringify(patterns) +
      ". Known signature chains: " +
      JSON.stringify(sigs) +
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
    if (!facts) return;
    setGenerating(true);
    try {
      const sys = await buildSystemPrompt();
      const chain =
        signatures[selectedChainIdx] && signatures[selectedChainIdx].chain
          ? signatures[selectedChainIdx].chain
          : [];
      const instruction =
        chatInput.trim() || "Generate a noting";
      const userMsg =
        "Create a formal noting based on these verified facts: " +
        JSON.stringify(facts) +
        ". User instruction: " +
        instruction +
        ". Language preference: " +
        language +
        ". Use signature chain: " +
        JSON.stringify(chain) +
        ".";
      const resp = await callClaude(sys, userMsg);
      const note = normalizeNote(parseJSON(resp));
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

    const userMsgEntry = { role: "user", text: msg };
    const newChatWithUser = [...chatHistory, userMsgEntry];
    setChatHistory(newChatWithUser);
    setChatInput("");
    setAiTyping(true);

    try {
      const sys = await buildSystemPrompt();
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
      const resp = await callClaude(sys, userMsg);
      const note = normalizeNote(parseJSON(resp));
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
      const FONT = "Arial";

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
            new TextRun({ text: label, bold: true, font: FONT, size: 22 }),
            new TextRun({ text: value || "", font: FONT, size: 22 }),
          ],
        });

      const children = [];
      children.push(titleP(note.header, 28));
      children.push(titleP(note.department, 24));
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
            alignment: AlignmentType.JUSTIFIED,
            indent: { firstLine: 720 },
            spacing: { after: 120 },
            children: [new TextRun({ text: p, font: FONT, size: 22 })],
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
                size: 22,
              }),
              new TextRun({ text: d.value || "", font: FONT, size: 22 }),
            ],
          })
        );
      });

      children.push(
        new Paragraph({
          spacing: { before: 200 },
          children: [
            new TextRun({ text: note.closingLine, font: FONT, size: 22 }),
          ],
        })
      );

      (note.signatureChain || []).forEach((r) => {
        children.push(
          new Paragraph({
            spacing: { before: 280 },
            children: [new TextRun({ text: r, font: FONT, size: 22 })],
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

  const visibleTabs = (() => {
    const total = versions.length;
    const start = Math.min(tabOffset, Math.max(0, total - 5));
    return { start, items: versions.slice(start, start + 5) };
  })();

  /* ============================================================== *
   *  JSX
   * ============================================================== */
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white font-sans text-sm text-gray-800">
      {/* ===================== LEFT COLUMN ===================== */}
      <div className="flex w-1/4 flex-col overflow-y-auto border-r border-gray-200 bg-gray-50 p-4">
        <h2 className="mb-3 text-lg font-bold">📚 Library</h2>

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
            accept=".docx,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (f) handleRefUpload(f);
              e.target.value = "";
            }}
          />
          <button
            disabled={refLoading}
            onClick={() => refFileInput.current && refFileInput.current.click()}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-600 bg-white py-1.5 text-xs font-medium text-blue-600 transition-all duration-200 hover:bg-blue-50 disabled:opacity-50"
          >
            {refLoading ? <Spinner /> : null}
            {refLoading ? "Processing…" : "+ Add Reference Noting"}
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
                const f = e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) handleSourceUpload(f);
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
                accept=".docx,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (f) handleSourceUpload(f);
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
                    Drag &amp; drop or click to upload
                  </span>
                  <span className="text-[10px] text-gray-400">.docx / .pdf</span>
                </>
              )}
            </label>
          )}
        </div>
      </div>

      {/* ===================== MIDDLE COLUMN ===================== */}
      <div className="flex w-2/5 flex-col border-r border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-4">
          <h2 className="text-lg font-bold">💬 Note Instructions</h2>
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
              Upload a source document and generate a note to start the
              conversation.
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
            placeholder="Refine the note... e.g. Add GFR rule reference, change the date, add Hindi subject line"
            className="max-h-32 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm transition-all duration-200 focus:border-blue-400 focus:outline-none"
            style={{ minHeight: "3rem" }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-gray-400">Ctrl+Enter to send</span>
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

      {/* ===================== RIGHT COLUMN ===================== */}
      <div className="flex w-[35%] flex-col bg-white">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <h2 className="text-lg font-bold">📄 Note Preview</h2>
          {versions.length > 1 && (
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
function NotePreview({ note, prev, showDiff }) {
  const labelStyle = { fontWeight: 700 };
  return (
    <div className="mx-auto max-w-prose text-gray-900">
      <p className="text-center font-bold" style={{ fontSize: "14pt" }}>
        {note.header}
      </p>
      <p className="text-center font-bold" style={{ fontSize: "12pt" }}>
        {note.department}
      </p>
      <hr className="my-3 border-t-2 border-gray-800" />

      <p style={{ fontSize: "11pt" }}>
        <span style={labelStyle}>DATE: </span>
        {note.date}
      </p>
      {note.hindiSubject ? (
        <p style={{ fontSize: "11pt" }}>
          <span style={labelStyle}>विषय: </span>
          {note.hindiSubject}
        </p>
      ) : null}
      <p style={{ fontSize: "11pt" }}>
        <span style={labelStyle}>Subject: </span>
        {note.subject}
      </p>
      <p style={{ fontSize: "11pt" }}>
        <span style={labelStyle}>Ref: </span>
        {note.reference}
      </p>

      <div className="mt-3 space-y-2">
        {(note.paragraphs || []).map((p, i) => (
          <p
            key={i}
            className="text-justify"
            style={{ textIndent: "2em", fontSize: "11pt" }}
          >
            {showDiff ? (
              <DiffText oldStr={(prev.paragraphs || [])[i] || ""} newStr={p} />
            ) : (
              p
            )}
          </p>
        ))}
      </div>

      {(note.detailsBlock || []).length > 0 && (
        <div className="mt-3 space-y-1" style={{ fontSize: "11pt" }}>
          {note.detailsBlock.map((d, i) => {
            const oldItem = (prev && prev.detailsBlock && prev.detailsBlock[i]) || {};
            return (
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
        </div>
      )}

      {note.closingLine ? (
        <p className="mt-4" style={{ fontSize: "11pt" }}>
          {note.closingLine}
        </p>
      ) : null}

      <div className="mt-6 space-y-3">
        {(note.signatureChain || []).map((r, i) => (
          <p key={i} style={{ fontSize: "11pt" }}>
            {r}
          </p>
        ))}
      </div>
    </div>
  );
}
