# note-api — use your Gemini subscription (no API key)

A tiny Node service that the CSIR Note Sheet web app calls for AI generation.
It runs the **`gemini` CLI** (Gemini CLI) in headless mode, so generation uses
the **Gemini subscription** already logged in on your VPS — **no
`GEMINI_API_KEY`, no per-call cost.**

```
Browser (notesheet.cheetsheet.tech)
        │  POST /generate { system, user }
        ▼
note-api (this service, on your VPS)
        │  gemini --output-format json ...   (prompt piped over STDIN)
        ▼
Gemini (billed to your subscription)
```

## Prerequisites (on the VPS — the same one running Cheatsheet)
- Node.js 18+ (`node -v`)
- The `gemini` CLI installed **and logged in** for the user that will run this
  service (matches whatever user pm2 runs `note-api` as — check with
  `pm2 info note-api`). Verify it works and uses the subscription:
  ```bash
  unset GEMINI_API_KEY
  echo "say hello in 3 words" | gemini --output-format json | head
  ```
  If that prints a JSON result with a `"response"` field, you're good. If not
  logged in yet, run `gemini` interactively as that user, then `/login` and
  choose **"Login with Google"** (this is the option that uses your Gemini
  subscription rather than an API key).

## Install & run
```bash
# from the repo on your VPS
cd note-api
npm install
cp .env.example .env
# edit .env: set ALLOWED_ORIGIN=https://notesheet.cheetsheet.tech

# test it
node server.js
# in another shell:
curl -s localhost:8787/health
curl -s -X POST localhost:8787/generate \
  -H 'Content-Type: application/json' \
  -d '{"system":"Return only raw JSON.","user":"Return {\"ok\":true} as JSON."}'
```

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
session. The app now generates notes through your Gemini subscription.
(Leaving Backend URL blank means the app has no way to generate — there is no
built-in fallback.)

## Notes
- The service strips `GEMINI_API_KEY` from the environment so it always uses
  the subscription (OAuth "Login with Google"), never per-call API billing.
- Your subscription quota is personal — great for internal office use, not a
  high-traffic public service.
- The fixed system prompt (identity + output-format rules) is written once to
  `<NEUTRAL_CWD>/system.md` and passed via `GEMINI_SYSTEM_MD`; the caller's
  (possibly large) rule/context payload is combined with the user message and
  sent over STDIN on every request, never as a CLI argument — this avoids the
  OS argument-length limit (E2BIG) that large rulebooks can hit.
