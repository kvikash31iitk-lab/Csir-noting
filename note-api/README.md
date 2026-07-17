# note-api — provider-selectable backend (Antigravity CLI or OpenAI)

This Node service is the backend for the CSIR Note Sheet web app. It stores
the shared "brain" data and sends generation/OCR requests to whichever AI
provider is configured via `AI_PROVIDER`:

- **`antigravity`** (default) — runs the **`agy` (Antigravity CLI)** binary
  in headless/print mode, billed to a Gemini/Antigravity **subscription** —
  no per-call API cost.
- **`openai`** — calls the **OpenAI Responses API** directly with
  `OPENAI_API_KEY` — real per-call billing.

```
Browser (notesheet.cheetsheet.tech)
        │  POST /generate { system, user }
        ▼
note-api (this service)
        │  AI_PROVIDER=antigravity -> agy -p "<prompt>" ...
        │  AI_PROVIDER=openai      -> OpenAI Responses API
        ▼
Gemini/Antigravity subscription, or OpenAI (per AI_PROVIDER)
```

## Why both providers exist

The app originally ran on Claude Code CLI (subscription-based), then briefly
on Gemini CLI after a Claude account got org-locked — then Google
discontinued individual/free access to Gemini CLI entirely, redirecting to
its replacement, Antigravity CLI (`agy`), which still supports Google-account
login. Separately, an OpenAI API-key backend was built as a simpler
known-quantity fallback. Both now live side by side, selected by
`AI_PROVIDER`, so a future provider outage doesn't require ripping out and
rebuilding the whole backend again — see `runAgy()` and
`callOpenAIResponses()` in `server.js` for the two implementations.

There's also a separate, unrelated **`chatgpt-bridge/`** folder — a
local-only Playwright bridge for using a personal ChatGPT web subscription
from your own PC. It does not run on the VPS and is not part of this
provider selection; see `chatgpt-bridge/README.md`.

## ⚠️ Antigravity known limitation: `--dangerously-skip-permissions`

Antigravity CLI's `-p` (print/headless) mode:
- Takes the prompt **only as a literal CLI argument** — no STDIN support.
- Denies file access (`@/abs/path` references) by default, and **cannot
  prompt for approval in headless mode** — an unapproved file read just hangs
  until the timeout, it doesn't fail fast.

So any request that references a file (an oversized `/generate` prompt that
had to be written to a temp file, and every `/extract` OCR call, which always
reads an uploaded image/PDF) must pass `--dangerously-skip-permissions`. That
flag **auto-approves every tool call, not just file reads** — there is no
narrower "allow file reads only" flag confirmed for this CLI version. This is
a real prompt-injection surface: if user-uploaded document text or note
instructions ever contained an adversarial instruction, nothing would stop a
now-auto-approved tool call from acting on it. Ordinary `/generate` calls
(the common case — no file reference needed) do **not** pass this flag and
keep the default deny-by-default posture. `--sandbox` is also added on the
file-referencing calls as a partial mitigation for shell/terminal actions,
though this combination is not independently verified safe. If you'd rather
avoid this tradeoff entirely, set `AI_PROVIDER=openai` instead.

## Prerequisites

- Node.js 18+ (`node -v`)

### For `AI_PROVIDER=antigravity` (default)
- The `agy` CLI installed **and logged in** for the user that runs this
  service (matches whatever user pm2 runs `note-api` as — check with
  `pm2 info note-api`):
  ```bash
  curl -fsSL https://antigravity.google/cli/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"   # also add this line to ~/.bashrc
  agy --version
  ```
- Log in once, interactively, choosing **"Login with Google"** (not
  "Use Gemini API Key"):
  ```bash
  agy
  # complete Google Sign-In, then exit
  ```
- Verify:
  ```bash
  agy -p "reply with exactly: OK"
  ```
  Should print `OK` with no error. **Use the full absolute path** to the
  binary (e.g. `/root/.local/bin/agy`) in `AGY_BIN` — pm2's process
  environment often does not carry the interactive shell's `PATH` additions.

### For `AI_PROVIDER=openai`
- An OpenAI API key in `OPENAI_API_KEY`.

## Install & Run

```bash
cd note-api
npm install
cp .env.example .env
# edit .env: set AI_PROVIDER, and either AGY_BIN or OPENAI_API_KEY

node server.js
```

In another shell:

```bash
curl -s localhost:8787/health
```

`/health` reports the active provider, e.g.
`{"ok":true,...,"ai":"antigravity","agyBin":"/root/.local/bin/agy",...}`.
`/generate` requires login/auth, so use the app login flow rather than
testing it unauthenticated with curl.

Keep it running with pm2:

```bash
npm i -g pm2
pm2 start server.js --name note-api
pm2 save
```

## Key Settings

- `AI_PROVIDER` — `antigravity` (default) or `openai`.
- **antigravity:** `AGY_BIN` (prefer an absolute path), `AGY_MODEL` (optional,
  must exactly match a name from `agy models`), `AGY_EXTRA_ARGS`,
  `AGY_INLINE_LIMIT` (default 100000 — prompts larger than this go through a
  temp file + `@/abs/path` instead of argv, to stay clear of the OS
  arg-length limit).
- **openai:** `OPENAI_API_KEY` (required for this provider), `OPENAI_MODEL`
  (default `gpt-5.5`), `OPENAI_VISION_MODEL` (default same as
  `OPENAI_MODEL`), `OPENAI_BASE_URL`, `OPENAI_MAX_OUTPUT_TOKENS` /
  `OPENAI_OCR_MAX_OUTPUT_TOKENS`, `OPENAI_REASONING_EFFORT`.
- `TIMEOUT_MS` / `OCR_TIMEOUT_MS` — per-request timeouts (both providers).

## Expose It On A Subdomain

1. Add a DNS A record for `noteapi.cheetsheet.tech` pointing to the VPS IP.
2. Copy `nginx.example.conf` to
   `/etc/nginx/sites-available/noteapi.cheetsheet.tech`, symlink it into
   `sites-enabled/`, then run `sudo nginx -t && sudo systemctl reload nginx`.
3. Enable HTTPS with `sudo certbot --nginx -d noteapi.cheetsheet.tech`.

## Point The App At It

Open `https://notesheet.cheetsheet.tech`, tap the settings button, and set:

```text
https://noteapi.cheetsheet.tech/generate
```

After signing in, notes and OCR will run through whichever `AI_PROVIDER` is
configured.
