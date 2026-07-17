# obsidian-bridge — local memory for CSIR Note Sheet

A tiny local-only Node service (no dependencies) that connects the CSIR Note
Sheet app to your **local Obsidian vault**, so it remembers what you've done:

- **Export:** every generated note, and every "Teach this" standing
  instruction, gets written into your vault as markdown — browsable and
  searchable in Obsidian like any other note.
- **Import:** when generating, the app can search your vault for relevant
  past notes/instructions and fold them into the AI's context (clearly
  labelled as background, never cited as an official rule).

Like `chatgpt-bridge/`, this runs on **your own PC** next to your vault — a
vault is just a folder of `.md` files, so this bridge doesn't need Obsidian
itself to be running, only installed (or not even that).

```
Browser (notesheet.cheetsheet.tech)
        │  POST /export/note, /export/learning, GET /search
        ▼
obsidian-bridge (this service, on your PC)
        │  reads/writes .md files directly
        ▼
Your Obsidian vault (CSIR Notes/ subfolder)
```

## Setup

```bash
cd obsidian-bridge
npm install          # no-op today (zero dependencies) but keeps this future-proof
cp .env.example .env
# edit .env: set VAULT_PATH to your vault's folder, e.g.
#   VAULT_PATH=C:\Users\you\Documents\MyVault
npm start
```

Verify it found your vault:

```bash
curl -s localhost:8791/health
```

Should show `"vaultExists":true`.

## Point the app at it

Open the note app, tap the **⚙ settings** button, and set **Obsidian Bridge
URL** to:

```
http://localhost:8791
```

Save. From then on:
- Every note you generate is also saved into `<vault>/CSIR Notes/` as
  `YYYY-MM-DD - <subject>.md`, with the instructions, final note (rendered
  readably, not raw JSON), date, and signature chain in frontmatter.
- Every "Teach this" correction is appended to `<vault>/CSIR Notes/Learning.md`
  as a dated bullet.
- Fact retrieval before generation also searches your vault for relevant
  past notes and folds short snippets into context.

## Limits

- Must be running (this Node process) whenever you want export/search to
  work — if it's not running, the app just silently skips it (same
  best-effort pattern as the OpenAI/Antigravity backend calls).
- Search is a simple keyword scorer over your `.md` files (same technique the
  server-side rule library uses) — not semantic search, and it re-reads every
  file in the vault on each search call, so very large vaults (thousands of
  notes) will be slower. `SEARCH_MAX_FILES` in `.env` caps how many files it
  will scan.
- It binds to `127.0.0.1` only — nothing outside your PC can reach it.
