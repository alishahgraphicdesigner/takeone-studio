# PHASE C CHECKLIST — Library + Studio REAL (2026-10-15)

Builds on the Phase B tree at `~/workspace/takeone-v22/`. Windows target, built/tested on Linux VM.
Source of truth for the pipeline: `takeone-ui-demo` (decision #61). The demo's pipeline
is 6 steps (Prompt Brief → Image → Animate → Director → Voice → Final); the task brief
said "5-step" but the demo + deep dive both say 6 — 6 shipped, discrepancy noted.

## What was built

**Backend**
- `main/library.js` — Library FS service. The file system is the source of truth;
  `project.json` carries metadata + a hash index that is rebuilt from disk, never
  trusted over it. Projects (`Projects/<id>/project.json` + images/videos/audio/exports/),
  Trash with 30-day recovery (`Trash/projects/`, `Trash/assets/`), SHA-256 duplicate
  guard on import ("Already in Library — no second copy"), restore, delete-forever,
  empty-trash, and `purgeExpiredTrash` (runs silently on every Studio launch).
  Fixed during testing: same-second project-id collision (random suffix added).
- `main/pipeline.js` — 6-step state machine (empty/ready/failed, outputs, settings
  snapshots, timestamps, per-step errors), Variations ×4 select/deselect toggle state,
  `projectThread` (idea/locks/current/what's-left), `resumeState`, deterministic
  **script analyzer** (`analyzeScript`: scenes, dialogue, ambiguity flags with
  suggestions — real, no AI needed), Taste Lock rule helpers, `suggestNextMoves`
  (deterministic, project-aware), `engineGateText` (honest per-step gate copy).
- `main.js` — Phase C IPC (26 handlers: projects, assets, trash, steps, taste,
  script analysis, suggestions, engine gates, displayPath), `maskPersonalPath`
  (username masking for UI display), trash auto-purge on Studio launch.
- `preload.js` — all Phase C APIs exposed.

**Frontend**
- `renderer/library.js` + `renderer/library.css` — Library view: New project
  (header + empty state), project cards (real counts from disk), Open/Show in
  folder/Delete, per-type asset browser with thumbnails, Import (duplicate
  caught → "already in Library"), Trash (days-left, Restore/Delete forever/
  Empty trash), zero-projects empty state. Purpose line on the view.
- `renderer/pipeline.js` + `renderer/pipeline.css` — Studio view: real Project
  Thread strip (editable idea, add/remove lock chips, current step, what's left,
  project switcher), real Resume strip (from last actual state), 6 step buttons
  with real status badges + timestamps, per-step panels with **persisted forms**,
  honest viewer (empty states, no fake art), Script-to-Film analyzer UI (step 1),
  template-based Inspire helper (labelled as such), ONE real Variations ×4
  select/deselect control (feedback #2; Generate is separate and never instant),
  per-step failure card with Retry/Dismiss, context-assist moves with "Why this?",
  7 standalone tool cards with honest gates, custom-style NAME field (feedback #1),
  "From my films" thumbnail picker tab in Step 2 (feedback #3).
- `renderer/studio.html` — rail now Studio/Library/Models/Settings; old "full
  Studio arrives later" home removed (this update IS the Studio).
- `renderer/studio.js` — Settings gains Niche lens chips (via `setNiche`, which
  no longer rebuilds config from scratch) and a real Taste Lock editor
  (add/edit/remove Always/Never rules).
- `renderer/studio.css` — taste/niche styles.

**Privacy (new audit item, Phase C)**
- `maskPersonalPath`: `C:\Users\<name>\…` → `C:\Users\•••\…` on every UI surface
  that shows the storage path (wizard storage step, wizard review, Settings card).
  Real path still used for all file ops + "Show in folder". Sweep: no
  `os.userInfo`/`hostname`/`USERNAME` anywhere; installer is oneClick (no
  install-mode page, no OS username shown — per parent note).
- `build.nsis.oneClick=true`, `allowToChangeInstallationDirectory=false`
  (set by parent; verified present before build).
- **Niche out of wizard** (parent change, integrated): "What kind of films do you
  make?" now appears once, contextually, when the FIRST project is created
  (Studio + Library flows), with Skip always available. Tunes suggestions only,
  locks nothing. `niche:'none'` default preserved.

**Deep-dive dispositions closed in Phase C**
- Variations trio (T) → ONE real Variations ×4 toggle; "More like this"/"4-grid" gone.
- Step-1 Overview toast (T) → removed; the Project Thread strip IS the real overview.
- Viewer grain/frame/red dot (D) → never built.
- Publish dead end (T) → removed (not wired; stays out per #50 disposition).
- "New project" (M) → header button + empty-state button + pipeline dialog.
- Zero-projects / zero-assets / zero-voices empty states (M) → designed (voices: honest gate note in step 5).
- Per-step failure/retry (M) → real failed state + Retry/Dismiss UI.
- Taste Lock editing (F-weak) → real add/remove/edit.
- Custom style naming (feedback #1) → NAME prompt, persisted per project.
- From-my-films pickers (feedback #3) → thumbnail tab, real picker.
- Purpose lines (feedback #6) → one-line purpose on Studio, Library, tools, taste, niche.
- Etihad demotion (feedback #5) → no Etihad default/mode anywhere (grep-clean).
- SQLite index → **deliberately skipped**: FS scan is the index; no sync drift possible. Documented here.

## Gate evidence

- **Torture test:** `test/library.test.js` — 100 unique files imported; all 100
  re-imports caught as duplicates (zero dupes); 100/100 listed and on disk
  (zero orphans); stray on-disk files still listed (marked external).
- **Script analyzer:** sample script → 1 scene, 2 dialogue lines, BAKER/MARA
  extracted, delivery-note + unintroduced-character flags with suggestions.
- **Full suite: 103/103 green** (`npm test`) — 53 Phase A+B unchanged, 50 new.
- **Honesty sweeps:** no LTX/RealESRGAN; no terminal words in user strings;
  English-only (0 Urdu chars); no fake "Tested" claims; no personal identifiers
  in UI strings.
- **All modules `node --check` clean.**
- **Installer rebuilt with Phase C** (see below).

## Installer

- `dist/TakeOne-Studio-2.2.0-setup.exe` — **111,974,014 bytes (106.8 MB)**,
  built 2026-10-15 18:32 PKT via `npm run dist` (TAKEONE_SKIP_WINE=1).
  oneClick=true (no install-mode page, no OS username shown).
  asar verified: `main/library.js`, `main/pipeline.js`, `renderer/pipeline.js`,
  `renderer/library.js` present; `maybeAskNiche`, `Menu.setApplicationMenu(null)`,
  `SPEED_PROBE_URLS`, `maskPersonalPath` all in the packed app.
  Unsigned — SmartScreen warning will appear (stated honestly).

## UNTESTED (needs the Windows gate on the target PC)

1. Library + Studio views have never rendered — no Electron run on Windows.
   Layout, thread strip, step panels, pickers, trash UI are code-reviewed, not seen.
2. `dialog.showOpenDialog` (import picker) — Windows-only path.
3. `file://` thumbnails in the renderer on Windows (path encoding).
4. `shell.showItemInFolder` on the new Library/Studio buttons.
5. `displayPath` masking against a real `C:\Users\<name>` path (regex proven on
   strings, not on a live Windows profile path).
6. Trash auto-purge timing on real clocks (logic unit-tested).
7. The full 5-cycle install → wizard → Studio → Library → uninstall Windows gate
   (Phase A+B carryover) — now with the complete Phase C surface.
8. Generation itself: every Generate button honestly gates (tool missing →
   Model Manager; tool present → "engine connects in the next update"). Real
   generation is Phase D.

## Files changed/added (Phase C)

- Added: `main/library.js`, `main/pipeline.js`, `renderer/pipeline.js`,
  `renderer/pipeline.css`, `renderer/library.js`, `renderer/library.css`,
  `test/library.test.js`, `test/pipeline.test.js`, this file.
- Edited: `main.js` (requires, exports, 27 IPC handlers, maskPersonalPath,
  trash purge; parent's `Menu.setApplicationMenu(null)` + `SPEED_PROBE_URLS`
  preserved untouched), `preload.js` (Phase C APIs), `renderer/studio.html` (new views),
  `renderer/studio.js` (niche + taste, home removal), `renderer/studio.css`
  (taste/niche), `renderer/wizard.js` (masked path display; parent's niche
  removal preserved untouched), `renderer/pipeline.js` (first-project niche
  prompt), `renderer/library.js` (first-project niche trigger),
  `test/pipeline.test.js` (mask tests).

## Ready for Phase D

Phase D (Engine, honest) can now: read real `project.json` step settings as
generation intents, write real outputs via `addStepOutput`, flip steps to failed
with real errors (the retry UI already exists), and resolve engine gates through
`toolInstalled` (already wired). No Phase C UI needs rework for this.
