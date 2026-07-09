# note-api - ChatGPT/OpenAI backend

This Node service is the backend for the CSIR Note Sheet web app. It stores the
shared "brain" data and sends generation/OCR requests to the OpenAI Responses
API using `OPENAI_API_KEY`.

```
Browser (notesheet.cheetsheet.tech)
        |  POST /generate { system, user }
        v
note-api (this service)
        |  OpenAI Responses API
        v
ChatGPT/OpenAI model
```

## Prerequisites

- Node.js 18+ (`node -v`)
- An OpenAI API key in `OPENAI_API_KEY`

## Install & Run

```bash
cd note-api
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...

node server.js
```

In another shell:

```bash
curl -s localhost:8787/health
```

`/generate` requires login/auth, so use the app login flow rather than testing
it unauthenticated with curl.

Keep it running with pm2:

```bash
npm i -g pm2
pm2 start server.js --name note-api
pm2 save
```

## Key Settings

- `OPENAI_API_KEY` - required.
- `OPENAI_MODEL` - default `gpt-5.5`.
- `OPENAI_VISION_MODEL` - default is the same as `OPENAI_MODEL`.
- `OPENAI_BASE_URL` - optional OpenAI-compatible endpoint override.
- `OPENAI_MAX_OUTPUT_TOKENS` and `OPENAI_OCR_MAX_OUTPUT_TOKENS` - output caps.
- `OPENAI_REASONING_EFFORT` - optional, for models that support reasoning effort.

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

After signing in, notes and OCR will run through ChatGPT/OpenAI.
