# note-api — use your Claude subscription (no API key)

A tiny Node service that the CSIR Note Sheet web app calls instead of
`api.anthropic.com`. It runs the **`claude` CLI** (Claude Code) in headless
mode, so generation uses the **Claude Max subscription** already logged in on
your VPS — **no `ANTHROPIC_API_KEY`, no per-call cost.**

```
Browser (notesheet.cheetsheet.tech)
        │  POST /generate { system, user }
        ▼
note-api (this service, on your VPS)
        │  claude -p --output-format json ...
        ▼
Claude (billed to your Max subscription)
```

## Prerequisites (on the VPS — the same one running Cheatsheet)
- Node.js 18+ (`node -v`)
- The `claude` CLI installed **and logged in** for the user that will run this
  service. Verify it works and uses the subscription:
  ```bash
  unset ANTHROPIC_API_KEY
  echo "say hello in 3 words" | claude -p --output-format json | head
  ```
  If that prints a JSON result, you're good. (If you run it as a non-login
  service user, log in once as that user: `sudo -u botuser -i claude` then
  `/login`, OR set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.)

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
Save. The app now generates notes through your subscription. (Leaving Backend
URL blank falls back to an API key if set, otherwise demo mode.)

## Notes
- The service strips `ANTHROPIC_API_KEY` from the environment so it always uses
  the subscription.
- The Max subscription is your personal quota — great for internal office use,
  not a high-traffic public service.
- If generations look like coding-assistant chatter, set
  `SYSTEM_PROMPT_FLAG=--system-prompt` in `.env` to fully replace the default
  system prompt, and restart (`pm2 restart note-api`).
