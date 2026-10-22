# Round-12 return — WO-32, WO-33 (2026-10-22)

Labels: Implemented / Tested / Passed / Failed / Not Tested.
I decide no pass/fail — only raw evidence. Full files + raw logs + the full
installer .exe + SHA256.txt in this zip.

## Commits
- c210492 — WO-32 + WO-33 (HEAD)

## WO-32 — Implemented + Tested
Settings now has a "Copy diagnostics" button: one click puts a plain-text report on
the clipboard (Ali cannot read logs). Report contents: app version, Windows version,
GPU name + driver (nvidia-smi), engine-state.json summary (installed wheels, python),
free disk, last 100 lines of the app log + last 100 lines of the ComfyUI log.
Privacy: user names in paths masked (C:\Users\<name> → C:\Users\...), anything shaped
like an assigned secret (api_key/token/password) scrubbed. ComfyUI child output is now
persisted to <root>/.engine/comfyui.log (rotated at 512 KB) by main/comfy.js so the
report has something to show.
Wiring: main/diagnostics.js (new: buildDiagnosticsReport/maskReport/tailFile/
appendComfyLog) + takeone:diagnostics IPC (main.js) + preload bridge + Settings card
+ button (renderer/studio.js, clipboard.writeText, "Copied — paste it anywhere.").
Tests: test/diagnostics.test.js 10/10 — masking (Windows + unix paths), secret
scrubbing, every required section present, a hostile report (real-looking user name +
api key + token) comes out clean, tailFile, appendComfyLog+rotation. Full suite
144/144 green locally. CI: verify 39739631254 SUCCESS, catalog-gate 39739631342 SUCCESS.

## WO-33 — Implemented + Tested
build-installer.yml now names the artifact "TakeOne-Studio-<version>-run<N>" (version
read from package.json in CI) and writes dist/SHA256.txt ("<hash>  <exe name>", lowercase
hex) next to the .exe; both files uploaded. Build run 39739633597 SUCCESS → artifact
"TakeOne-Studio-2.2.10-run3" (120,830,940 bytes). The FULL file is in this zip:
round12/TakeOne-Studio-2.2.10-setup.exe + round12/SHA256.txt. I downloaded the CI
artifact and re-hashed locally: a520273d345f63d3cacd38cc4276f2daf9fdd7e043bd692ca2c9d94b13cca3f6 — MATCHES SHA256.txt.

## Decisions I made (Claude review karega)
1. ComfyUI log rotation at 512 KB (keep last 256 KB): unbounded growth would eat disk;
   100 tail lines only need the recent past. Alternative: no rotation — rejected.
2. GPU query is synchronous execFileSync with a 15 s timeout: the report must not hang
   the UI on a slow nvidia-smi. Alternative: async — rejected (IPC round-trip complexity).
3. Secret scrubbing is pattern-based (api_key/token/password assignments), not a
   denylist of known keys: future log lines stay covered. It can over-scrub a line like
   "password: hunter2" in a legit context — accepted, safety first.

## What I did NOT do
- tools/audit-catalog.js untouched. No version bump (stays 2.2.10). No GitHub release.

Fingerprint (HEAD c2104927cc137567fcfc7c625eaa967716cb16f5, CI Evidence step,
verify 39739631254 — full block in logs/verify-39739631254-SUCCESS.log):
b85211ad919b8649efdc20283c9b9f597b4e876ec8562bdb67b4a334618ec91a  main/diagnostics.js
7ac0a350127ceb77e25a02cc288aa31181dbb110b7d3f04053ece14cf0db6849  main/comfy.js
11193e845656754661f5cd3c7a34e447018343911edd160649f2c63a93e5bd22  .github/workflows/build-installer.yml
b3bb3b90a55ffe9ee48e7856f748274d596bfac9e1b91c38bf6b585c8b0be78c  package.json
