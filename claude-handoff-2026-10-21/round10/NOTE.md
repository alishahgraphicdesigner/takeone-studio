# Round-10 return — WO-23 … WO-27 (2026-10-21)

Labels: Implemented / Tested / Passed / Failed / Not Tested.
I decide no pass/fail — only raw evidence below. Full files + raw logs in this zip.

## Commits (pushed to main)
- 2d89195 — WO-23: engine installer + 23 unit tests
- e4cff36 — WO-23: app-DL-manager wiring + CI spike via real installEngine
- e056dac — WO-24 patch + WO-25 (image-lite Coming soon)
- 8addf1f — WO-26 UI chain + WO-27 studio flow + mock-server tests
- 35bf5b5 — WO-24 fix: venvPython name
- 8651cdd — WO-24 fix: checkDiskSpace ancestor walk (HEAD)

## WO-23 — Implemented + Tested
main/engine.js (new): installEngine with phases preflight→downloading→verifying→installing→finalizing→ready.
All 9 amendments: (1) per-wheel pip --no-deps --no-index --find-links --no-input
--disable-pip-version-check --no-warn-script-location, bytes-weighted + i/86; (2) state file
{installed wheels, inProgress}, resume --force-reinstalls inProgress, end: pip check +
python -c "import torch; assert torch.version.cuda=='12.8'"; (3) venv from <root>/.python,
version/path change → rebuild; (4) extra_model_paths.yaml explicit per-type map;
(5) preflight 9.7 GB × 1.25 headroom, wheelhouse deleted after Ready; (6) installTool =
Step 1 of 2 engine + Step 2 of 2 model, one cancel token; (7) GPU failures none/old-driver/
unknown, plain words + whatNext, min driver 570.65 Windows from NVIDIA CUDA 12.8 release
notes Table 3 (link in code); (8) comfy.js: free port scan, --disable-api-nodes only if
main.py --help lists it (logged), --listen 127.0.0.1; (9) engine-lock.json in build.files,
dest path guard, atomic state write. + addManifestJob in downloads.js (87-file job,
per-file sha256, resume-skip, cancel deletes only active partial) + main.js IPC
(takeone:engineInstall/engineCancel/engineStatus; getComfy uses engine venv python).
Tests: test/engine.test.js 24 tests (fake pip: plan 87 files, resume skip/--force-reinstall,
cancel each phase, plain-words failures, space-in-path, atomic state, GPU kinds, installTool
steps) — CI green, 131/131 total with the suite.
CI: verify 39596764040 (HEAD) + catalog-gate 39596764057 SUCCESS. shipped-python-spike
39595539743 SUCCESS — the REAL installEngine() ran on a Windows runner: 87 files downloaded
via aria2, venv built from shipped python, 86/86 wheels installed, pip check OK,
torch.version.cuda=='12.8' asserted, ComfyUI extracted, wheelhouse deleted, ComfyUI --cpu
boot exit 0. Raw log: logs/shipped-python-spike-39595539743-SUCCESS.log.

## WO-24 — Implemented + Tested + Failed (3 attempts, raw logs attached)
Patch: e2e-image.yml timeout 90, first step prints free disk, TAKEONE_SKIP_GPU_CHECK=1,
driver adds spatial correlation check (threshold 0.3; measured: noise ~0, structured ~0.93)
besides variance, PNG artifact upload kept. Attempt 1 (39595718362): stale API name
(enginePython→venvPython) — fixed. Attempt 2 (39596502033): checkDiskSpace returned 0 free
because statfsSync needs an existing path — fixed (walk up to nearest existing ancestor;
unit test added). Attempt 3 (39596765772): e2e workflow never places the shipped python at
<root>/.python (the spike workflow does) → "built-in Python is missing". Fix identified
(copy the spike workflow's 'Place shipped Python' step into e2e-image.yml) but NOT applied —
3-attempt limit reached per standing orders. Raw logs: logs/e2e-image-*-FAILED-attempt{1,2,3}.log.

## WO-25 — Implemented + Tested
image-lite → unavailable + unavailableUser (same plain text; dev reason: no own workflow/e2e).
catalog-gate 39596764057: GATE PASS — VERIFIED 1 (image-studio) · UNAVAILABLE 20 ·
NOT_AUDITABLE 0. UI check: Download/Install only on image-studio's card (now the engine
chain's Install); image-lite shows Coming soon with no button; no other card has any
install button. ALL PASS.

## WO-26 — Implemented + Tested
Image Studio card: one-click engine+model chain (renderer/models.js + preload IPC).
7 states, each with screenshot in wo26/: idle (Install; "10.1 GB to download… 19 GB free"),
downloading (Step 1 of 2, GB), verifying, installing (part i of 86, bytes-weighted bar),
ready (Engine ready → auto-starts model Step 2 of 2), failed (WHY + WHAT NEXT),
cancelled. UI test wo26-ui-test.py: all 7 states asserted + audit dev-jargon regex over
every state's UI text + chain hidden when engine already installed. ALL PASS, 0 page errors.

## WO-27 — Implemented + Tested
Studio flow (renderer/pipeline.js): uses the real ComfyUI port (was hardcoded 8188),
engine-missing → plain message + "Install the engine" button (→ Models view),
Cancel button mid-generate → comfyInterrupt. main/comfy.js: interrupt() (POST /interrupt),
queuePrompt returns port. main.js: comfyGenerate asserts engine first
({ok:false, engineMissing:true}), new takeone:comfyInterrupt IPC. Tests
test/studio-generate.test.js vs a mock ComfyUI HTTP server: (1) success: queue→history→PNG
magic bytes verified; (2) engine not ready: assertEngineReady throws plain-words message
(mentions Models page, no jargon); (3) cancel: POST /interrupt received; (4) crash: errors
surface as {ok:false}, never throw. 4/4 green in CI (131/131 total).

## Decisions I made (Claude review karega)
1. TAKEONE_SKIP_GPU_CHECK=1 in CI (spike + e2e): runners have no NVIDIA GPU; the 3 GPU
   failure kinds are unit-tested; the real GPU path will be proven on Ali's PC. Alternative:
   fail the workflows on GPU-less runners — rejected (blocks all CI proof).
2. Engine-cancel message: "Cancelled. Already-downloaded files are kept, so installing again
   resumes where it stopped." — NOT "X GB freed": the installer keeps partials for resume by
   design (WO-10 verdict), so nothing is freed. Alternative: report 0 GB — rejected (silly).
3. Idle disk note shows ~19 GB (12.2 engine preflight + 6.6 model, from the real constants),
   not the WO's ~16 GB estimate. Alternative: hardcode 16 — rejected (would lie vs preflight).
4. Spatial-correlation threshold 0.3 (measured noise ~0.0, structured ~0.93).
5. WO-27 renderer scenarios verified at node level (mock HTTP server, 4/4) + page-error smoke
   via the WO-26 harness, not full Playwright per scenario — the renderer flow is thin.
6. Cancelled/idle strings in English (UI-English standing rule), not the WO's Roman Urdu.

## What I did NOT do
- WO-21 design → implemented as specified + 9 amendments (no deviation).
- tools/audit-catalog.js untouched. No version bump, no installer, no release.
- WO-24's 4th fix (documented above) — left for next round per the 3-attempt rule.

Fingerprint (HEAD 8651cdd616fce6ce5ca07865c19e074b81c33101, from CI's own Evidence
fingerprint step, verify run 39596764040 — full 34-line block in logs/verify-39596764040-SUCCESS.log):
db823a8e5790760e0c026b0eaff659adaff531c008e35ad024597694015daa90  .github/workflows/e2e-image.yml
a05116692866a7afa13b0d6a3e1fea77eee99e360c375ad710ebfe6f4c2be08d  .github/workflows/shipped-python-spike.yml
fc1ab7854e8a9f8d330b9d32742d845ca3ec48a9295b6342dc201b6c9744d4d1  main/catalog.js
cb29b56c9bacbc7f87d0c92c743dc7c4400811dd771be5d2be3c48d5794cb12e  main/comfy.js
29f36bbed74206274f72008d154878afd2a6db029ceafede98389f4681c129c1  main/downloads.js
d1800320ab4e879c35a65ce24c62f1f3d42f3ac0c8639c9816471f9da30c3ca8  main/engine.js
4b4adfecf29d5987367a3f729dfab80bb302448f4321d89a062c4bdac8e4e64c  tools/e2e-image.js
All green at HEAD: verify 39596764040 (success), catalog-gate 39596764057 (success).
