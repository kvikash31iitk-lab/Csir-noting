# note-api — use your Antigravity/Gemini subscription (no API key)

A tiny Node service that the CSIR Note Sheet web app calls for AI generation.
It runs the **`agy` (Antigravity CLI)** binary in headless/print mode, so
generation uses your **Antigravity/Gemini subscription** already logged in on
your VPS — **no per-call API billing.**

```
Browser (notesheet.cheetsheet.tech)
        │  POST /generate { system, user }
        ▼
note-api (this service, on your VPS)
        │  agy -p "<prompt>" ...   (prompt passed as a CLI argument)
        ▼
Antigravity (billed to your subscription)
```

## Why Antigravity CLI, not Gemini CLI

This backend previously ran Google's `gemini` CLI, but Google discontinued
free/individual-subscription ("Login with Google") access to it — it now only
works with an API key or an enterprise Code Assist license. Individual
subscribers are redirected to **Antigravity CLI (`agy`)**, its replacement,
which still supports Google-account login. If Google deprecates *this* tool
too, `note-api/server.js`'s `runAgy()` function is the only place that needs
to change again — the rest of the app talks to `/generate` and doesn't know
or care which CLI runs behind it.

## ⚠️ Known limitation: `--dangerously-skip-permissions`

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
though this combination is not independently verified safe.

If Antigravity ships a scoped "allow file reads only" permission mechanism in
the future, prefer that over `--dangerously-skip-permissions`.

## Prerequisites (on the VPS — the same one running Cheatsheet)
- Node.js 18+ (`node -v`)
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
  binary (e.g. `/root/.local/bin/agy`) in `AGY_BIN` below — pm2's process
  environment often does not carry the interactive shell's `PATH` additions.

## Install & run
```bash
# from the repo on your VPS
cd note-api
npm install
cp .env.example .env
# edit .env: set ALLOWED_ORIGIN=https://notesheet.cheetsheet.tech and AGY_BIN

# test it
node server.js
# in another shell:
curl -s localhost:8787/health
curl -s -X POST localhost:8787/generate \
  -H 'Content-Type: application/json' \
  -d '{"system":"Return only raw JSON.","user":"Return {\"ok\":true} as JSON."}'
```
(That last call needs a Bearer token from `/login` first — see `server.js` for
the built-in dev credentials, or set `USERS`/`APP_PASSWORD`.)

Keep it running with pm2:
```bash
npm i -g pm2
pm2 start server.js --name note-api
pm2 save
```

## Expose it on a subdomain (HTTPS)
1. **DNS:** add an **A record** for `noteapi.cheetsheet.tech` → your VPS IP.
2. **nginx:** copy `nginx.example.conf` to
   `/etc/nginx/sites-available/noteapi.cheetsheet.tech`, symlink into
   `sites-enabled/`, then `sudo nginx -t && sudo systemctl reload nginx`.
3. **HTTPS:** `sudo certbot --nginx -d noteapi.cheetsheet.tech`

Now `https://noteapi.cheetsheet.tech/generate` is your endpoint.

## Point the app at it
Open **https://notesheet.cheetsheet.tech**, click the **⚙ button**, and set
**Backend URL** to:
```
https://noteapi.cheetsheet.tech/generate
```
Save, then sign in (top of Library) — `/generate` requires a signed-in
session. The app now generates notes through your subscription. (Leaving
Backend URL blank means the app has no way to generate — there is no
built-in fallback.)

## Notes
- Your subscription quota is personal — great for internal office use, not a
  high-traffic public service.
- The fixed system prompt (identity + output-format rules) is prepended to
  every prompt in code (`BASE_SYSTEM` in `server.js`) — Antigravity CLI has no
  confirmed separate system-prompt flag/file.
- Prompts under `AGY_INLINE_LIMIT` characters (default 100000) go straight on
  the CLI argument; larger ones (big rulebook/RAG context) are written to a
  temp file and referenced with `@/abs/path` instead, to stay clear of the OS
  argument-length limit (E2BIG) — `agy -p` has no STDIN fallback to fall back
  on for this, unlike the Claude/Gemini CLIs this backend used previously.
