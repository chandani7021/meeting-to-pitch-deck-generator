# Codeck — working notes

Local-first meeting → deck app. Electron + vanilla JS renderer + Express + SQLite + local models.
**Nothing leaves the machine.** Keep it that way.

## Runtime trap

The server must run on **Electron's bundled Node 24**, not system Node, because the store uses
the built-in `node:sqlite` (system Node here is v20 and lacks it).

- `npm run dev` — Electron spawns the server itself. Correct.
- `npm run server` — server alone, on Electron's Node. Correct.
- `node server/index.js` — **fails.** Never document or script this.

`ELECTRON_RUN_AS_NODE` is set by some editor hosts (VS Code), which makes the `electron`
binary behave as plain Node. That is why the dev script clears it (`env ELECTRON_RUN_AS_NODE=''`).
If Electron "won't open a window", check that variable first.

## Invariants — breaking these breaks the product

**1. `builder.js` is the only place slide geometry lives.**
It is handed either a pptxgenjs deck or a recorder (`slideSpec.js`) and cannot tell the
difference. The `.pptx` and the HTML preview come from that one pass. Never add layout to
`electron/renderer/preview.js` — it converts units (inches × 96, points × 96/72) and nothing else.
If the preview looks wrong, the bug is in `builder.js` and the export is wrong too.

**2. A prompt must be able to name its own target.**
`slideDirectory.js` maps rendered slide numbers and slide names onto deck paths,
and both tiers use the same map: Tier 1 to act, Tier 2 because the edit prompt
carries the numbered directory plus a literal `path = "value"` listing of every
editable string on the named slides. Users say "deck 4, 5 and 6" — never make
them click first. If an edit only works with something selected, the directory
is not reaching it.

**A named slide is never silently swapped for another.** "Add an image to slide 3" answering
"Put your image on slide 4" is indistinguishable from a bug. Only the overview, the challenges
and the solution slides have room for a visual, so a request naming any other slide is refused
with the list of ones that work — `pickVisualTarget()` returns `{refuse}` rather than a
fallback whenever the prompt named a slide at all.

A verb needs an object as well as a target. `resolveField()` works out which
*part* of a slide is being acted on — the key stat, the bullets, the visual, the
heading — and a delete only takes the whole slide when no part was named.
Deciding by keyword presence instead is how "in slide 4 remove key stat" deleted
slide 4, and how "remove the key stat below the image" removed the image. When a
prompt names two parts, the one the verb reaches first is the object and the
other is a locator that narrows which slide is meant.

Two model failures are repaired rather than rejected (`repairOps` in
`editRouter.js`): writing the slide number as an array index, and `replace` at
an append path. A repair only fires when there is nothing to guess. And an edit
that produced no ops must never echo the model's reply — with an empty ops array
a small model reliably claims a change it did not make.

**History is for tone, never for targeting.** With "change slide 4" a few turns
back, a request about slide 5 came back editing slide 4 — the single most
confusing failure the chat had, because the edit looks successful. Slide numbers
in old turns are blurred to "an earlier slide" (`blurSlideRefs`), and when THIS
prompt names slides by number, `confineToTargets()` drops or remaps any op that
lands outside them. Wording alone does not bind a 3B model, so the constraint is
enforced after the fact, not merely requested. "Now do the same on slide 5" must
still work — the instruction comes from history, the target never does.

**3. Deck edits go through ops, never a whole-deck rewrite.**
`ops.js` applies JSON Pointer ops to a copy, atomically, and returns an exact inverse. Undo
replays that inverse; redo replays the original ops forward, which is why no
second inverse has to be computed. Anything that mutates a deck must produce ops,
or undo and the audit trail silently rot.

Batches are identified by `deck_ops.batch`, a uuid — **not** by the prompt text.
Grouping by prompt meant the same instruction typed twice looked like one batch,
so undo reverted both. A new edit deletes the undone rows: the branch a redo
would have replayed onto no longer exists. Redo takes the *earliest* undone batch,
because undo always removes the newest live one, so undone rows are a suffix of
the log. Both endpoints peek before committing, for the reason in the gotchas below.
The server reports `canUndo` / `canRedo` on every mutating response — the renderer
must never infer them from a local counter, which is what it used to do and why
the button could be enabled with nothing to undo.

**4. Prompt order is load-bearing.**
Section-invariant content (rules, intent, retrieved evidence, transcript) comes first and must
be **byte-identical across the four section calls**; only the per-section task varies, and it
goes in the user turn. This lets llama.cpp reuse its KV cache — measured at 77% less redundant
prefill on sections 2-4. Moving anything section-specific earlier silently costs ~20s/section.
`timing.cacheHit` in `/api/studio/status` is the canary.

**5. `whyCopods` is not generated.**
It was 53% of all model output while the profile already had every field the slides need.
`caseStudies.js` builds it. If you find yourself adding case-study fields to a schema in
`deckSchema.js`, stop — add them to `copods-profile.json` instead.

**6. Four privacy layers, all keyed off `OFFLINE_MODE`.**
Provider gate (`routes/ai.js`), renderer network jail (`electron/main.js`), boot assertion
(`server/index.js`), local Calendar instead of Google. Adding a network call means defeating
all four deliberately — don't do it incidentally.

**`AI_PROVIDER` says which client, `OLLAMA_HOST` says where.** Three of the four layers only
ever checked the provider name and the cloud API keys, so
`OLLAMA_HOST=https://a-box-somewhere:11434` with `AI_PROVIDER=local` sent every transcript and
deck off the machine for inference *and* embedding while the boot log printed "local-only mode".
A false assurance is worse than no assurance. The boot assertion now requires the Ollama host to
be loopback unless `OFFLINE_MODE=0`. Any future setting that names a destination — an embedding
host, a remote whisper server — needs the same treatment; checking the provider name is not
enough.

**7. The chat reply is derived from the ops — and an inert op is not a change.**
`describe.js` turns applied ops into English using the slide directory, so a
reply says "Rewrote two bullets on slide 5", not `updated proposedSolutions ›
1 › keyPoints › 0`. It is not just phrasing: with an empty ops array a small
model still writes "Rewrote the bullets to lead with the outcome", and passing
that through tells the user a change happened when none did. The reply can be
plainer than the model's; it cannot be false.

Deriving the reply from applied ops is necessary but not sufficient. Asked to
"add the heading on slide 4, 5 and 6" — slides that already have headings — the
model replaces each title with the value it was just shown. Three ops apply, the
deck is byte-identical, and the reply says "Rewrote the heading on slide 4, 5 and
6". `dropNoOps()` discards any replace whose value already equals what is there,
and an all-inert batch reports what the slide already says instead. `addFieldNotice()`
catches the common case in Tier 1 so it costs no round trip and names every slide
asked about. A list is never "already there" — adding a bullet to a slide that has
bullets is an ordinary request, so only single-valued fields qualify.

**8. Visuals are drawn, never fetched.**
Images come from the user's own library at `<DATA_DIR>/assets/images`, matched on
filename words and `images.json` tags. Charts and the generated motif are built
from the same rects and text as every other block, so invariant 1 still holds —
a pptxgenjs native chart would have no equivalent in the preview and the two
would drift. A visual attaches either to an array item (`solution.visual`) or to
the deck-level `visuals` map keyed by slide path, for slides whose source is a
bare string; `visualFor()` in `builder.js` hides the difference.

Chart data comes from the prompt or from numbers already on the slide. When
there are none, the chat says so and asks — it does not invent figures for a
client deck. Adding an image search would defeat all four privacy layers for
decoration; don't.

An image attached in the chat (button, paste or drag) uploads to the library
first and arrives at `/studio/edit` as `attachment`, which outranks every other
source — "add this to deck 4" needs no image word in it. Uploads are sniffed for
magic bytes, never overwrite an existing file, and are renamed from the
surrounding prompt when the filename says nothing ("Screenshot 2026-09-21 at
10.21.33.png" → `warehouse-logistics-floor.png`). The name is not cosmetic:
`findImage()` matches on filename words, so a screenshot keeping its own name
would be unfindable forever.

**9. Transcription must never block the recorder, and `-ac` must never exceed the segment.**
Each segment is a fresh `MediaRecorder` (a timesliced WebM chunk after the first
has no header and cannot be decoded alone), so recording genuinely stops between
segments. The loop used to `await` the transcription inside that gap — fine at
~0.5s against cloud Whisper, fatal at ~11s against local whisper.cpp: the mic sat
stopped for 11 of every 16 seconds and **~70% of every meeting was never
captured**. Segments now go on a queue; `flushQueue()` drains it on stop.

Three things make it fast, in order of size:
- `-ac` shrinks the encoder window. Whisper encodes a full 30s regardless of
  input, so a 15s clip pays double. Measured 35.6s → 17.5s.
- the q5_1 quantisation, ~2.5x faster than fp16 for the same words.
- `whisper-server` instead of `whisper-cli`, which reloads ~470 MB per call
  (~10s of fixed cost). Together: 35.6s → ~6s for a 15s clip.

**`-ac` is the dangerous one.** Audio longer than the window does not get
clipped, it degenerates — 17.5s through a 15s context produced "and a band
quarter and a band quarter and a band". `WHISPER_WINDOW_S`, the `-ac` frames and
`SEGMENT_MS` in `app.js` are one setting in three places; `transcribeAudio()`
probes duration and routes anything longer to full-context `whisper-cli`. Raise
one without the others and transcripts rot silently.

whisper-server rejects flags whisper-cli accepts (`--no-prints` killed it at
startup) and the CLI fallback hid that as "just slow" — so the server's exit
reason is logged.

**10. A styled slide recolours itself; nothing hardcodes around it.**
Every colour here is a brand token, so "make slide 5 black" had nowhere to go.
Rather than thread a palette through nine hundred lines of drawing code,
`newSlide()` paints the background first and returns a wrapper that checks every
later draw call against it: anything falling under ~3:1 contrast is swapped for a
legible equivalent, card fills become tints of the background, and brand accents
that already stand out are left alone. Verified at 0 unreadable text items on a
black slide, where the purple wordmark flips to white by itself.

Two traps: `hdr()` repaints the whole slide white before drawing, so a full-bleed
white rect maps to the background rather than a card tint or the chosen colour is
never seen; and `addCaseStudySlide()` lives outside `buildPresentation`, so it
takes the factory as an argument. Every slide must be created through
`newSlide()` — a stray `pptx.addSlide()` silently opts that slide out of styling.

**11. `npm run eval` is how accuracy is judged.**
`scripts/eval-edits.mjs` runs ~57 prompts against a fixed deck and asserts which
deck paths each edit may touch, the slide-count delta, and that undo restores the
deck exactly. `--t1` skips the model (fast, deterministic); `--only=<group>`
narrows. Run it before and after touching the router, the edit prompt, or the
model — "it feels better" is not a measurement, and the model tier needs three
runs to distinguish a fix from a lucky sample.

Writing it immediately paid for itself. It found: an insert past the end of a
list **throwing** and taking the whole request with it; out-of-range slide
numbers ("slide 99") being silently dropped so a field handler picked a slide of
its own; and three undo bugs, of which two meant the change could be made but
never taken back.

The parsing one is worth naming. `"change the key stat on slide 4 to 6 weeks"`
parsed as the RANGE slides 4–6, because `to` was treated as a range word — it hit
the right slide only by luck, and `"slide 99 to 6 weeks"` expanded to
ninety-four slides. A span is written in the plural ("slides 4 to 6") and a value
in the singular, so that is the discriminator; the dash form needs no plural.

## Deliberate non-choices

- **No vector database.** ~79 chunks today; brute-force cosine over Float32 blobs is ~20ms.
  sqlite-vec / LanceDB / Chroma would be overhead. Revisit past ~50k chunks.
- **No React, no bundler.** The studio pane is one CSS grid and ~390 lines. `app.js` is a
  classic script and `studio.js` is an ES module; they meet on `window.__studio` / `window.__navigate`.
- **Carlito is bundled** (`electron/renderer/fonts/`). It is metric-compatible with Calibri,
  which the text-fit estimator assumes and macOS does not ship. Remove it and the preview
  wraps differently from the export.
- **Text overflow in the preview is `visible`, not hidden.** PowerPoint spills rather than
  clipping; hiding it would conceal layout bugs.

## Hardware reality

Tuned for a 2020 Intel MacBook Pro (4 cores, no GPU, Ollama reports ~4 GB free). Hence a 3B
model, not 7B+. The chassis **thermally throttles under sustained inference** — decode drifts
from ~9 tok/s to ~4.5 tok/s across a long run, so A/B timing comparisons on this machine are
unreliable. Judge optimizations by their direct signal (`prefillTps`, `cacheHit`, token counts),
not wall clock. Nothing in the architecture changes on faster silicon; only the model id does.

## Gotchas already paid for

- Array `insert` must reject an index past the end. Clamping made an out-of-range `move`
  look successful while recording an inverse that could not replay. Tier 1 builds its own ops,
  so this throw is a bug in `editRouter.js` — but it is caught there and reported in the chat,
  because a 500 loses the user's request as well as the edit.
- **An inverse has to be applicable, not merely correct-looking.** Removing an object property
  recorded `replace` as its inverse, and `replace` refuses a path that no longer exists — so
  undoing a removed key stat, subtitle, visual or style threw every time. It is `insert`.
  Appending to a list recorded `remove` at `.../-`, and `-` resolves to the END of the list, so
  the inverse of every append was out of range; it must name the index the item landed at.
  Both survived for a while because nothing tested the reverse direction — the eval now checks
  undo on every case, not in a group of its own.
- Undo must apply the inverse **before** marking the op undone, or a failed revert leaves the
  log claiming a change was undone while the deck still has it.
- The legacy `/analyze` path needs a schema; `local.complete()` returns `{text}` without one
  and `{data}` with one.
- **A spec item without `h` becomes `height:0` in the preview.** pptxgenjs derives a table's
  height from its row heights, so `builder.js` passes none — and `.sl-table-wrap` has
  `overflow:hidden`, so every table clipped to nothing. The Next Steps slide rendered blank
  while the `.pptx` was perfectly correct, which sends you hunting in the wrong file.
  `renderTable()` now falls back to the sum of `rowH`. Any future item kind whose size is
  implicit needs the same treatment.
- **`.view-bar` is a `-webkit-app-region: drag` strip**, so the window can be moved by its
  toolbar — and that region swallows mouse input for everything inside it. Any control added
  there must set `-webkit-app-region: no-drag` or it is dead to the pointer. Buttons look fine
  only because `.tool-btn` opts out for itself; the zoom slider inherited `drag` and could not
  be moved at all, while still looking perfectly normal. Verified with `getComputedStyle(el)
  ['-webkit-app-region']`, which reads `drag` on an affected control.

## Packaging and distribution

`npm run build` (universal) / `npm run build:intel` (x64, much faster to build).

**The build must never ship a `.env`.** `extraResources` excludes `.env` and
`.env.*` explicitly. The packaged app needs no config at all — `AI_PROVIDER`
defaults to `local`, `OFFLINE_MODE` to on, `DATA_DIR` to `~/.codeck`. Before the
exclusion existed, a build bundled the live Groq key and Google OAuth secret
into the `.dmg`.

**Cloud SDKs are pruned from the build**: `googleapis` (202 MB), `openai`,
`@anthropic-ai`, `@google`, `groq-sdk` — 216 MB of the 249 MB in
`server/node_modules`, for code paths that never run in offline mode. This is
only safe because `routes/calendar.js` imports `googleapis` **lazily**; a
top-level import there would break the whole server in a pruned build. If you
add a cloud provider, keep its import dynamic and inside the offline gate.

**`extendInfo` is mandatory, not cosmetic.** macOS terminates a hardened-runtime
app that requests the microphone or sends Apple events without
`NSMicrophoneUsageDescription` / `NSAppleEventsUsageDescription`. Screen
Recording has no plist key — it is granted in System Settings.

**There is no signing identity on this machine**, so `mac.identity` is `null`
and `notarize` is false. The `.dmg` is unsigned and Gatekeeper blocks it until
the recipient runs `xattr -dr com.apple.quarantine /Applications/Codeck.app`.
Proper signing needs an Apple Developer account.

**The app being x64 does not slow inference.** Ollama is a separate native
process, so only the Electron shell runs under Rosetta on Apple Silicon.

`npm run doctor` checks every local dependency and prints the fix for each
failure; Settings shows the same inside the app. The doctor validates the
whisper model's **size and ggml magic**, not just that the file exists — an
interrupted download otherwise looks installed and fails much later.
