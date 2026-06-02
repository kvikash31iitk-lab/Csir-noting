# AI-Powered Note Sheet Generator (CSIR TKDL Unit / CSIR IPU)

A single self-contained React artifact that helps government office users
generate formal **"noting"** documents (internal office note sheets). It:

1. **Learns** style and format from uploaded reference noting documents
2. **Extracts** facts from a user-uploaded source document
3. **Generates** a formatted note sheet via Claude
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
- **AI:** posts to `https://api.anthropic.com/v1/messages` with model
  `claude-sonnet-4-20250514`. No API key is referenced anywhere in the code —
  the host environment supplies authentication.
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

Direct Claude API calls from the browser require a host that proxies
authentication (such as the Claude artifact environment); document reading,
DOCX export, library learning UI, versioning, and diff view all work in the
local harness regardless.

## Using the app

1. (Optional) Add one or more **reference notings** to improve output quality.
2. Upload a **source document** — the app extracts editable facts.
3. Verify the facts, pick a language and signature chain, then
   **Generate Note Sheet**.
4. Refine via the chat box (e.g. *"Add GFR rule reference"*); each turn creates
   a new version. Use **Show changes** to diff versions.
5. **Download DOCX** or **Copy Text** when satisfied.
