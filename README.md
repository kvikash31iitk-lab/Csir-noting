# AI-Powered Note Sheet Generator (CSIR TKDL Unit / CSIR IPU)

A single self-contained React artifact that helps government office users
generate formal **"noting"** documents (internal office note sheets). It:

1. **Learns** style and format from uploaded reference noting documents
2. **Extracts** facts from a user-uploaded source document
3. **Generates** a formatted note sheet via the note-api backend's AI
4. Allows **chat-based iteration** and refinement
5. **Exports** the final note as a downloadable DOCX file

## Files

| File | Purpose |
| --- | --- |
| `NoteSheetGenerator.jsx` | The canonical single-file React artifact (the deliverable). |
| `index.html` | A thin local-preview harness that loads React, Tailwind, mammoth.js, docx.js, and a `window.storage` shim so the artifact runs in a plain browser. |

## How it works

- **UI:** three-column layout — Library (25%), Note Instructions / chat (40%),
  Note Preview (35%). Each column scrolls independently; the page itself does
  not scroll.
- **Storage:** uses `window.storage` (shared keys for the learned library,
  personal keys for the working session). It **never** uses `localStorage` /
  `sessionStorage` — the `index.html` harness provides a `window.storage` shim
  for local testing only.
- **AI:** calls the configured `note-api` backend (`/generate`), which uses a
  provider selected by `AI_PROVIDER` — the Antigravity CLI (`agy`, subscription,
  no per-call cost, the default) or the OpenAI Responses API with
  `OPENAI_API_KEY`; see `note-api/README.md`. The Android/web wrapper keeps a
  legacy browser interception hook only for demo/offline compatibility.
- **Documents:** reads `.docx` via mammoth.js and `.pdf`/text via the
  `FileReader` API; writes `.docx` via docx.js (falling back to `.txt` if DOCX
  generation fails).

## Baseline data

On first load the app seeds the shared library (`lib:patterns`,
`lib:signatures`) with CSIR-specific tone rules, structure rules, subject
patterns, a phrasebook, and common Finance signature chains — so it is usable
immediately, even with an empty library.

## Running locally

Serve the folder over HTTP (module imports require it):

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

Real AI generation requires the `note-api` backend to be running with an
`AI_PROVIDER` configured (see `note-api/README.md`). Document reading, DOCX
export, library learning UI, versioning, and diff view work in the local
harness regardless.

## Local ChatGPT Subscription Mode

If you want to use your ChatGPT web subscription instead of an OpenAI API key,
run the local browser bridge on your own PC:

```powershell
cd "C:\Users\HP\VIkash\Data bento\Csir-noting\chatgpt-bridge"
npm.cmd install
npm.cmd start
```

Then set the app Backend URL to `http://localhost:8790/generate` or click
`Local ChatGPT` in the settings panel. This mode is local-only and depends on a
visible browser logged in to ChatGPT.

## Local Obsidian Memory (optional)

If you keep an Obsidian vault on your PC, `obsidian-bridge/` connects it to
the app: every generated note and "Teach this" lesson gets exported into the
vault as markdown, and future generations can search the vault for relevant
past context. See `obsidian-bridge/README.md` for setup — in short:

```bash
cd obsidian-bridge
npm install
cp .env.example .env   # set VAULT_PATH to your vault's folder
npm start
```

Then set **Obsidian Bridge URL** to `http://localhost:8791` in the app's
settings panel (⚙). Like the ChatGPT bridge, this is local-only and optional —
leaving it blank changes nothing.

## Using the app

1. (Optional) Add one or more **reference notings** to improve output quality.
2. Upload a **source document** — the app extracts editable facts.
3. Verify the facts, pick a language and signature chain, then
   **Generate Note Sheet**.
4. Refine via the chat box (e.g. *"Add GFR rule reference"*); each turn creates
   a new version. Use **Show changes** to diff versions.
5. **Download DOCX** or **Copy Text** when satisfied.
