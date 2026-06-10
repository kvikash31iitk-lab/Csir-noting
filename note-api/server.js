/*
 * CSIR Note Sheet — backend bridge to Claude Code
 * ------------------------------------------------
 * One endpoint, POST /generate, that takes { system, user } and runs the
 * `claude` CLI in headless print mode to produce the text. Because `claude`
 * is logged in with a Claude Max subscription on this server, generation uses
 * the subscription — NO ANTHROPIC_API_KEY required.
 *
 * The response is shaped like the Anthropic Messages API
 * ({ content: [{ type:"text", text }] }) so the web app's existing code works
 * unchanged.
 *
 * Config via environment variables (see .env.example):
 *   PORT                Port to listen on (default 8787)
 *   ALLOWED_ORIGIN      CORS origin allowed to call this (e.g. https://notesheet.cheetsheet.tech)
 *   CLAUDE_BIN          Path to the claude binary (default "claude")
 *   CLAUDE_MODEL        Optional model (e.g. "sonnet", "opus")
 *   SYSTEM_PROMPT_FLAG  "--append-system-prompt" (default) or "--system-prompt"
 *   CLAUDE_EXTRA_ARGS   Optional extra CLI args, space-separated
 *   TIMEOUT_MS          Per-request timeout (default 120000)
 */
const express = require("express");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || "8787", 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "";
const SYSTEM_PROMPT_FLAG = process.env.SYSTEM_PROMPT_FLAG || "--append-system-prompt";
const EXTRA_ARGS = (process.env.CLAUDE_EXTRA_ARGS || "").split(" ").filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "120000", 10);

const app = express();
app.use(express.json({ limit: "8mb" }));

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/generate", (req, res) => {
  const body = req.body || {};
  const system = typeof body.system === "string" ? body.system : "";
  const user = typeof body.user === "string" ? body.user : "";
  if (!user) return res.status(400).json({ error: "missing 'user' prompt" });

  // Build the claude command. User prompt goes via stdin (handles large
  // documents safely); system prompt via flag.
  const args = ["-p", "--output-format", "json"];
  if (system) args.push(SYSTEM_PROMPT_FLAG, system);
  if (CLAUDE_MODEL) args.push("--model", CLAUDE_MODEL);
  args.push(...EXTRA_ARGS);

  // Ensure subscription auth is used, never an accidental API key.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { env });
  } catch (e) {
    return res.status(500).json({ error: "could not start claude: " + e.message });
  }

  let out = "", err = "", finished = false;
  const done = (fn) => { if (!finished) { finished = true; fn(); } };

  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch (_) {}
    done(() => res.status(504).json({ error: "claude timed out" }));
  }, TIMEOUT_MS);

  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", (e) => {
    clearTimeout(timer);
    done(() => res.status(500).json({ error: "claude spawn error: " + e.message }));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0 && !out) {
      return done(() => res.status(500).json({
        error: "claude exited with code " + code,
        stderr: err.slice(0, 800),
      }));
    }
    // The --output-format json envelope has the assistant text in .result.
    let text = out;
    try {
      const j = JSON.parse(out);
      text = j.result || j.text ||
        (j.content && j.content[0] && j.content[0].text) || out;
    } catch (_) { /* fall back to raw stdout */ }
    done(() => res.json({ content: [{ type: "text", text }] }));
  });

  // Send the user prompt on stdin, then close it.
  try {
    child.stdin.write(user);
    child.stdin.end();
  } catch (e) {
    clearTimeout(timer);
    done(() => res.status(500).json({ error: "failed writing prompt: " + e.message }));
  }
});

app.listen(PORT, () => {
  console.log(`csir-note-api listening on :${PORT} (origin: ${ALLOWED_ORIGIN})`);
});
