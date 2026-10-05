# Codeck

Native macOS desktop app that records a meeting — microphone or system audio (Zoom, Meet, any app) — transcribes it, turns it into a branded deck, and lets you **preview the deck and refine it by prompt** before exporting a `.pptx`.

**Everything runs on this machine.** No transcript, no audio and no client data reaches a third party.

Built with Electron + plain HTML/CSS/JS (no React, no build step) + Express + SQLite + local models.

---

## Quick start

```bash
npm run install:all
cp server/.env.example server/.env      # then set DATA_DIR to your home path
```

Install the local models (a one-time download; afterwards the machine can stay offline):

```bash
# Ollama — already installed at ~/.ollama/bin on this machine.
# Add it to PATH, or `brew install ollama` for a managed copy.
export PATH="$HOME/.ollama/bin:$PATH"
ollama serve &

ollama pull qwen2.5:3b-instruct     # deck generation + chat edits  (1.9 GB)
ollama pull nomic-embed-text        # retrieval                     (274 MB)

brew install whisper-cpp ffmpeg     # local transcription
mkdir -p ~/.codeck/models
curl -L -o ~/.codeck/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

Then:

```bash
npm run dev
```

> `npm run dev` launches Electron, which spawns the server on **Electron's bundled Node 24**. That matters: the store uses the built-in `node:sqlite`, which system Node 20 does not have. Run the server alone with `npm run server`, never bare `node server/index.js`.

---

## How it works

```
record ──► transcribe ──► generate ──► PREVIEW + CHAT ──► export .pptx
          whisper.cpp    4 small        live, editable
          (local)        local calls    by prompt
```

### One layout, two renderers

`server/lib/builder.js` computes every slide in absolute inches. It is handed either a
real pptxgenjs deck or a **recorder** that captures the same draw calls
(`server/lib/slideSpec.js`). The `.pptx` and the on-screen preview therefore come from
one layout pass and cannot drift. All geometry lives in `builder.js`;
`electron/renderer/preview.js` only converts units.

Carlito is bundled in `electron/renderer/fonts/` because it is metric-compatible with
Calibri, which the text-fit estimator assumes and which macOS does not ship — without it
the preview would wrap differently from the exported file.

### Editing by prompt, in three tiers

| Tier | Handles | Cost |
|---|---|---|
| **1 · deterministic** | `delete slide 4`, `swap case study with Kristal`, `set the title to …`, reorder, remove a section | **no model, instant** |
| **2 · scoped rewrite** | "make these bullets punchier", "rewrite for a CFO" — sends only the selected node | one small model call |
| **3 · regenerate** | "redo this as a kickoff deck" | full pipeline |

Click any slide or bullet in the preview to scope an edit to that JSON path. Edits apply
as JSON-Pointer **ops** with computed inverses, never as a whole-deck rewrite — so untouched
slides are provably untouched, and undo is an exact replay rather than a re-generation.

### Context management

- **Store** — SQLite at `~/.codeck/codeck.db`: clients, meetings, versioned decks, the op log, chunks, embeddings, client dossiers, learned style preferences.
- **Retrieval** — the company profile, past decks and past transcripts are chunked and embedded locally. Vectors are Float32 blobs and search is brute-force cosine: at a few hundred chunks that is ~20ms, so a vector index would be pure overhead. Revisit past ~50k chunks.
- **Budgeted assembly** — prompts are built from priority-ordered blocks and trimmed to a token budget, tuned for *speed* rather than the model's context limit, because prefill dominates on CPU. Section-invariant content comes first so llama.cpp reuses its KV cache across the four section calls.
- **Client dossier** — durable facts (goals, constraints, stakeholders, budget signals) are extracted after each deck and injected into the next deck for that client. Stored as structured, **user-editable** fields: auto-accumulated model memory compounds its own errors, so it is visible and correctable.

### What the model does *not* generate

`whyCopods` and its case-study slides were measured at **53% of all output tokens**, yet the
profile already contains every field the slides need. They are now built directly from
`copods-profile.json` (`server/lib/caseStudies.js`), which halves generation time and makes
the metrics impossible to hallucinate. The model only picks which case studies are relevant —
and retrieval does that better anyway.

---

## Privacy: four independent layers

1. **Provider gate** — `OFFLINE_MODE=1` (the default) makes any cloud provider an error, not a fallback.
2. **Network jail** — the Electron main process cancels every renderer request except `127.0.0.1:3001` and `127.0.0.1:11434`.
3. **Boot assertion** — the server refuses to start if a cloud API key is set while offline mode is on. It fails loudly instead of leaking quietly.
4. **Local calendar** — today's meetings come from macOS Calendar over AppleScript, not the Google Calendar API.

To prove it: **turn off Wi-Fi and generate a deck.**

Model weights download once from ollama.com. That is an inbound fetch, not data egress —
after it, nothing needs the network again.

---

## Performance on CPU-only hardware

Measured on a 2020 Intel MacBook Pro (i5-1038NG7, 4 cores, 16 GB, no GPU) with
`qwen2.5:3b-instruct`:

| | |
|---|---|
| Decode | ~7–10 tok/s under load |
| Prefill | ~40–60 tok/s |
| Full 13-slide deck | see `/api/studio/status` for live timings |
| Tier-1 chat edit | instant (no model) |

Deck generation is a background job that streams section by section, so the deck builds
on screen rather than behind a spinner. The architecture is unchanged on faster hardware —
an Apple Silicon machine with more free RAM runs a 20–30B model at 20–40 tok/s, at which
point local quality is comparable to a cloud API. Ollama reports available memory at
startup; on this machine it is 4 GB, which is why a 3B model is the right size and a 7B is not.

---

## Data

```
~/.codeck/
├── codeck.db          clients · meetings · deck versions · op log · embeddings · dossiers
├── copods-profile.json  company profile (seeded on first run)
├── models/            whisper.cpp weights
└── output/            generated .pptx files
```

`meetings.json` is imported into SQLite once, on first run, and then left alone.

---

## Project structure

```
electron/
├── main.js                 spawns the server, creates the window, enforces the network jail
├── preload.js              contextBridge — capture sources, local calendar, net status
└── renderer/
    ├── index.html          app shell — record · studio · meetings · settings
    ├── app.js              recording, transcript, history, settings
    ├── studio.js           preview + chat controller
    ├── preview.js          slide spec -> HTML (unit translation only)
    ├── styles.css
    └── fonts/              Carlito (Calibri-metric-compatible)

server/
├── index.js                Express, offline assertion, store bootstrap
├── routes/
│   ├── studio.js           generate (streamed) · preview · edit · undo · export · status
│   ├── ai.js               /analyze — provider dispatch + offline gate
│   ├── pptx.js             /generate
│   ├── files.js            meetings CRUD (SQLite-backed)
│   ├── transcribe.js       audio chunk -> local whisper.cpp
│   └── calendar.js         legacy Google Calendar (offline mode uses the local one)
└── lib/
    ├── builder.js          slide layout — the single source of geometry
    ├── slideSpec.js        recorder target + provenance stamps
    ├── generate.js         decomposed 4-section generation
    ├── editRouter.js       three-tier edit dispatch
    ├── ops.js              JSON-Pointer ops, inverses, atomic apply
    ├── context.js          budgeted prompt assembly
    ├── deckSchema.js       JSON Schemas for grammar-constrained decoding
    ├── caseStudies.js      deterministic whyCopods / case studies
    ├── chunker.js          profile · decks · transcripts -> chunks
    ├── embeddings.js       local embeddings + brute-force cosine
    ├── dossier.js          cross-deck client memory
    ├── db.js               node:sqlite schema + migration
    ├── transcribe.js       whisper.cpp wrapper
    ├── profile.js          company profile loader
    └── providers/
        ├── local.js        Ollama, grammar-constrained JSON  ← default
        └── groq.js · claude.js · openai.js · gemini.js   (require OFFLINE_MODE=0)
```


---

## Giving it to someone else

Codeck is a desktop app that must run on the user's own machine — that is what
"nothing leaves the machine" means. There is no server to deploy, and hosting it
somewhere central would defeat the whole design.

So distribution is: **an installer, plus a one-time model download on their Mac.**

### 1. Build the installer

```bash
npm run build          # universal .dmg — runs on Apple Silicon and Intel
npm run build:intel    # x64 only, roughly half the size and much faster to build
npm run build:arm      # arm64 only
```

The output lands in `dist/`. The app bundle is ~300 MB per architecture: the
build prunes the cloud SDKs (`googleapis` alone is 202 MB) because nothing
imports them in offline mode.

The build deliberately **excludes every `.env` file**, so no API keys or OAuth
secrets travel with it. The packaged app needs no configuration: `AI_PROVIDER`
defaults to `local`, `OFFLINE_MODE` to on, and the data directory to `~/.codeck`.

### 2. Gatekeeper

There is no Apple Developer identity on this machine, so the `.dmg` is
**unsigned**. macOS will refuse to open it with "Codeck is damaged or can't be
opened". That is Gatekeeper, not a broken build. Either:

- **Free, internal use** — tell them to run this once after dragging it to Applications:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Codeck.app
  ```
  (Right-click → Open is *not* reliably enough for a quarantined unsigned app.)
  `READ-ME-FIRST.txt` in the disk image already spells this out for them.

- **Proper** — an Apple Developer account ($99/yr) lets you sign and notarize, and
  the app then opens with a normal double-click. Set `mac.identity` to your
  "Developer ID Application" name, `mac.notarize` to true, and export
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` before building.
  Worth it if this goes beyond one or two people.

### 3. On their Mac, once

The disk image contains `READ-ME-FIRST.txt` and `codeck-setup.sh` beside the app.
They run:

```bash
bash "/Volumes/Codeck 1.0.0/codeck-setup.sh"
```

Downloads Ollama and about 2.5 GB of models, installs whisper.cpp and ffmpeg,
and starts the model server. It is idempotent — safe to re-run. After this the
Mac can stay permanently offline.

Then two macOS permissions must be granted by hand, in
**System Settings → Privacy & Security** (relaunch Codeck afterwards):

| Permission | Pane | Needed for |
|---|---|---|
| Microphone | Microphone | recording your own voice |
| Screen Recording | Screen Recording | capturing meeting audio from Zoom / Meet / Teams |
| Automation → Calendar | Automation | reading today's meetings from the Calendar app |

macOS prompts for Automation the first time the meeting list loads. If it is
declined, the sidebar says which pane to fix — the rest of the app still works.

### 4. Check it worked

**Settings** inside the app lists every dependency with a green tick or the exact
command to fix it. From a terminal, `npm run doctor` does the same and also
measures actual tokens/second on that machine.

### What to expect on their hardware

Inference speed is entirely about their Mac, not about Codeck:

| Their machine | Realistic experience |
|---|---|
| Apple Silicon, 24 GB+ | Good. Run a bigger model — `ollama pull qwen2.5:14b-instruct`, then set `LOCAL_MODEL`. Quality approaches a cloud API. |
| Apple Silicon, 16 GB | Fine on the default 3B. |
| Intel, 16 GB | Works, but a deck takes minutes and the chassis throttles under sustained load. |

Chat edits are quick regardless: structural ones ("delete slide 4", "swap case
study with Kristal") use no model at all, and a scoped rewrite is one small call.

### If they need it to be fast and you cannot give them a better Mac

That is the one case for going back to a cloud provider, and it is an explicit,
visible decision rather than a silent default:

```env
OFFLINE_MODE=0
AI_PROVIDER=groq
GROQ_API_KEY=...
```

Their transcript then leaves their machine. The anonymize toggle still strips
client names before the request, but that is mitigation, not privacy.

---

## Switching to a cloud provider

Only if you accept that the transcript leaves the machine:

```env
OFFLINE_MODE=0
AI_PROVIDER=groq
GROQ_API_KEY=...
```

All four privacy layers are keyed off `OFFLINE_MODE`, so this single change is what
re-enables cloud calls — there is no way to do it by accident.
