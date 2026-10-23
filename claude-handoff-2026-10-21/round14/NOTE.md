# Round-14 return — WO-36, WO-37 (2026-10-22)

Labels: Implemented / Tested / Passed / Failed / Not Tested.
I decide no pass/fail — only raw evidence. Full files + raw logs in this zip.

## Commits
- 8321b7d — WO-36 (lastError, venv retry/fallback, diagnostics Engine section, session log, rotation) + WO-37 (toast fix)
- a9a65a1 — WO-36: record 2.2.12 build in docs/VERSIONS.md (HEAD)

## WO-36 (P0) — Implemented + Tested → version 2.2.12
venv failure on Ali's PC (v2.2.11) is now diagnosable and self-healing:

1. **Failure evidence.** Every failing child (venv, pip per-wheel, pip check,
   torch CUDA check, download) records `state.lastError = {step, code, tail, at}`
   (tail = last 30 lines of stderr/stdout, capped at 4 KB) into engine-state.json
   AND the app log (`ENGINE: FAIL step=...` + tail). UI messages stay in plain
   words; the detail surfaces only in the diagnostics report.
2. **Diagnostics Engine section.** New `--- Engine ---` block: lastError
   (step/code/at + 10-line tail), root folder (user name masked), OneDrive check
   ("YES — may cause file locks"), `.python\python.exe` version, `.engine\venv`
   present/missing, Controlled Folder Access + Defender real-time status via
   async PowerShell with a hard 5 s timeout ("unknown" is an accepted answer).
3. **Session-scoped app log.** Diagnostics now shows only lines after the last
   `TOP-OF-FILE` marker (the current session) — never older sessions. Engine
   events are in the same log. The log rotates at 512 KB (`.1` backup).
4. **venv retry + fallback.** On venv failure: (a) remove the venv dir, wait 2 s,
   retry once at the same location; (b) if still failing, switch the whole
   engine root to `%LOCALAPPDATA%\TakeOne\engine` and retry there (downloads
   happen after the venv, so no migration needed). The override is written to
   the state file at the DEFAULT location; `engineRoot()` resolves it on every
   future run, and every engine path (venv, wheelhouse, ComfyUI, state) derives
   from `engineRoot()`. Both fail → `lastError` keeps the real stderr.
5. **Tests** (fake runPy): default-location fails twice + LOCALAPPDATA succeeds →
   override recorded, `engineRoot()` resolves it, install completes; always-fail
   → `lastError.step` matches /venv/, code 1, tail has the stderr, UI message
   stays plain; pip failure → `lastError.step` = `pip-install:<wheel>`; space in
   path → install OK and all Engine sections render. Engine suite 31/31,
   diagnostics suite 18/18, full suite 161/161 green locally.
   CI: verify 39753516690 SUCCESS, catalog-gate 39753516456 SUCCESS.
6. **VERSIONS.md + artifact.** package.json 2.2.11 → 2.2.12. 2.2.12 line added
   with CI-computed sha256 (never by hand):
   `| 2.2.12 | 8321b7df9fec583a2d52ac916556141081785652 | 325cea8f8686a6317cafb310d9617fdd75a286947180064401d5da71bb0fdd87 | 39752992221 (round 14) |`
   Artifact "TakeOne-Studio-2.2.12-run5" (CI run 39752992221). Uniqueness check
   green for 2.2.12.

## WO-37 — Implemented + Tested (root cause found, not a Playwright artifact)
The "dark pill" over card text was the **empty `#toast` div**. Root cause:
`.toast{display:flex}` has the same specificity (0-1-0) as the UA stylesheet's
`[hidden]{display:none}`, and author order wins — so the toast rendered even
with `hidden` set: an empty 34×22 px dark pill (`padding` + `background:#23232e`
+ `border-radius:10px`, no text yet), `position:fixed` at the viewport bottom.
While scrolling it floated over whatever card was beneath — first Image Lite,
then Video Quality. My WO-16 "Playwright artifact" dismissal was wrong: my
synthetic renders never included the `#toast` div, so I never saw it; the real
studio.html always has it. Reproduced in the real Electron renderer via CDP
(`elementFromPoint` over the soonbox returned `DIV.toast`; computed
`display:flex` despite `hidden:true`).
**Fix:** one line in renderer/studio.css — `.toast[hidden]{display:none}`
(matching the existing pattern for #dockFab, #resumeStrip, .modal-back).
Verified in Electron: toast hidden → `display:none`; `toast()` show → `flex`
again; the pill is gone from the Video Quality card. Screenshots:
round14/wo37-pill-before.png (pill visible) / wo37-pill-after.png (gone).
Regression test: test/hidden-override.test.js 2/2 — every `[hidden]` element
in studio.html whose class/id sets `display` must have a `[hidden]` override.

## Decisions I made (Claude review karega)
1. lastError.tail capped at 4 KB in the state file (state must stay small); the
   full tail is in the app log. Alternative: no cap — rejected (state file bloat).
2. The (a) retry waits exactly 2 s (WO wording); no backoff — rejected as over-engineering.
3. The LOCALAPPDATA fallback writes a pointer state file at the DEFAULT location
   AND continues state writes at the new root (both exist briefly; the default
   one is only a pointer). Alternative: single state file — rejected (engineRoot()
   must find the override before knowing the new location).
4. Security queries use powershell.exe with the WO-35 Promise.race 5 s pattern;
   non-Windows CI returns "unknown" (no powershell) — acceptable per WO.
5. The 2.2.12 .exe is NOT in this zip (same standing as round 13); artifact
   "TakeOne-Studio-2.2.12-run5" downloadable from CI run 39752992221.

## What I did NOT do
- tools/audit-catalog.js untouched. No GitHub release. No version beyond 2.2.12.
- WO-36 item 2's "venv lock" detection: reported as present/missing only — a
  robust cross-process lock check needs a real Windows run (Not Tested on Windows).

Fingerprint (HEAD a9a65a1b7150734561f8a8966b1336c6674d3961, CI Evidence step,
verify 39753516690 — full block in logs/verify-39753516690-SUCCESS.log):
f161bdd4eb14ae45e027e99679805e4885a12c468c890ccc293225c7994a8ab7  main/engine.js
6fe58379a1b3b5b3ea999246e9103a9969e0d8fe6045e392f66cfc5e2ea331c6  main/diagnostics.js
4536673e9500dde309bc33065f8b9eeacf4a30f2a7c98c19b522cc6afdd750fc  package.json
