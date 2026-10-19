# PHASE B CHECKLIST — Model Manager REAL (2026-10-15)

Builds on the Phase A tree at `~/workspace/takeone-v22/`. Windows target, built/tested on Linux VM.

## What was built

- `main/catalog.js` — signed 21-tool catalog (SHA-256 over canonical JSON, verified on load).
  Honest sizes (SwinIR/GFPGAN/SAM2 measured from real files), licenses, VRAM, source URLs.
  SwinIR (not RealESRGAN); NO LTX card anywhere. One tool has the 24GB tier: Video Pro.
- `main/downloads.js` — DownloadManager: aria2c sidecar over JSON-RPC (secret token, dynamic
  free port), pause/resume/cancel, SHA-256 post-check, one auto-retry then honest failed state,
  resume-after-restart via persisted state + .aria2 control files, pre-flight disk check with
  15% headroom, cancel cleans partials (file + .aria2).
- `main/deps.js` — in-app dependency installer: pip packages and Hugging Face snapshots run
  through the bundled Python with progress events. No terminal, no commands for the user.
- `renderer/models.js` + `renderer/models.css` — Model Manager view in Studio: 21 cards in
  6 groups, honest badges ("Untested on this PC" until an on-PC smoke test passes), storage
  meter, offline banner, download dock, failure cards with Try again, VRAM-gated cards
  (disabled + one-line reason + Why? expander), keyboard/ARIA basics.
- `main.js` — Phase B IPC: catalog, installPlan, toolStates, checkOnline, dlStart/Pause/Resume/
  Cancel/Retry, depInstall, openExternal, adoptPick; dl-event/dep-event forwarding to Studio.
- `preload.js` — all Phase B APIs exposed.
- `resources/aria2c.exe` — real Windows binary 1.37.0 (5.6 MB), wired into extraResources.
- `renderer/wizard.js` — tool list now loads from the signed catalog (single source of truth);
  hardcoded list kept as fallback with corrected numbers.
- `scripts/demo-phase-b.js` — quality-gate demo script.

## Gate evidence

- **Gate 1 (pre-flight + post-check):** `test/downloads.test.js` — pre-flight blocks on
  0.001 GB free with plain-words reason + suggestion (316 ms); real 2 MB download → pause →
  resume → SHA-256 green → file lands in `Models/` (2.0 s); cancel removes partials;
  interrupted download resumes after manager restart (2.3 s); bad URL → one auto-retry →
  honest failed state with error text (1.3 s).
- **Gate 1 (real 65 MB):** `scripts/demo-phase-b.js` — SwinIR (67,869,037 bytes) downloaded,
  checksum GREEN, landed at `Models/fix/SwinIR_classical_x4.pth`. Bad-URL demo: auto-retry →
  "Failed to establish connection, cause: Connection refused" → manual retry with good URL → done.
- **Gate 2 (poka-yoke):** `test/catalog.test.js` — `vramAllowed` blocks Video Pro on a
  16 GB card with "needs a 24 GB card — this PC has 15.9 GB"; allows on 24 GB; permissive
  when VRAM unknown (measured later, not blocked). Wizard keeps the Phase A zero-tools
  acknowledgment gate.
- **Catalog integrity:** 21 tools, self-validation green, signature verifies, no LTX /
  RealESRGAN references anywhere, installPlan copy has no terminal words (grep-verified).
- **Zero terminal:** grep over renderer + main — the only user-facing "terminal" is the
  reassurance "nothing here needs a terminal". `showSetupHint` pattern is gone.
- **English-only:** all new UI strings English (sweep done 2026-10-15).
- **ARIA/keyboard:** progressbar roles with values, aria-expanded on Why? toggles,
  Escape closes detail boxes, all actions native buttons.

## Test results

- Full suite: **53/53 green** (`node --test "test/*.test.js"`) — 26 catalog, 5 downloads
  (real aria2c), 22 Phase A (unchanged).
- Installer rebuilt with Phase B: `dist/TakeOne-Studio-2.2.0-setup.exe` (112.0 MB,
  2026-10-15 ~09:38 UTC) — app.asar verified to contain `main/catalog.js`,
  `main/downloads.js`, `main/deps.js`, `renderer/models.js/css`; `resources/aria2c.exe`
  (Windows 1.37.0) ships beside it. Built via `npm run dist` (TAKEONE_SKIP_WINE=1).
  Unsigned — SmartScreen warning will appear (stated honestly, Phase A carryover).

## UNTESTED (needs the Windows gate on the target PC)

1. The Models view has never rendered — no Electron run on Windows. Card layout, dock,
   meter, badges, Why? toggles, Escape handling are all code-reviewed, not seen.
2. aria2c.exe (Windows binary) has never executed — RPC startup, pause/resume, and the
   `--stop-with-process` flag are proven on Linux aria2c 1.37.0 only.
3. depInstall (pip/hf) has never run — needs the bundled Windows Python on the target PC.
4. adoptPick folder scan + copy — Windows-only path (dialog + file copy).
5. checkOnline DNS behavior on the user's network.
6. "Untested on this PC" badges are correct as shown — no on-PC smoke test exists yet
   (that's Phase 0's pattern: the badge flips only after a real pass).
7. The 5-cycle install→wizard→Studio→uninstall Windows gate (Phase A carryover) still pending —
   now with more substance to test (this phase).

## Files changed/added (Phase B)

- Added: `main/catalog.js`, `main/downloads.js`, `main/deps.js`, `renderer/models.js`,
  `renderer/models.css`, `test/catalog.test.js`, `test/downloads.test.js`,
  `scripts/demo-phase-b.js`, `resources/aria2c.exe`, this file.
- Edited: `main.js` (Phase B section + IPC + exports), `preload.js` (Phase B APIs),
  `package.json` (aria2c.exe extraResource, `main/**/*` in files),
  `renderer/studio.html` (Models rail button + view + copy), `renderer/wizard.js`
  (catalog as source of truth).
