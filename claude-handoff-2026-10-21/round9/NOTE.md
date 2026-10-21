# Round-9 return — Claude ke WO-20 … WO-22 (2026-10-21)

Labels: Implemented / Tested / Passed / Failed / Not Tested.

## Commits (pushed to main)
- 3e879de — WO-20: 12 more tools unavailable+unavailableUser (brain + 11 unwired); audit-catalog v4 installed verbatim
- 2887581 — WO-22: e2e-image.yml + tools/e2e-image.js driver (fails honestly until WO-21 engine.js lands)
- 9f64d2b — WO-20 fix: reword video unavailable reasons ('sdxlTxt2Img' contains 'ltx' substring, broke the no-LTX catalog test) — HEAD

## WO-20 — Implemented + Tested + Passed (1 disclosed CI failure, fixed)
- 12 tools par `unavailable` + `unavailableUser` (wahi plain text): brain, video-studio, video-quality, video-pro, music-studio, upscaler, face-restore, vision, smart-select, depth-fx, pose-lock, bg-remove. Dev reasons evidence-based hain (WO-18 ke execution-path findings par): video/music tools — koi workflow/code nahi; upscaler/face-restore/vision/smart-select/depth-fx/pose-lock/bg-remove — model fetch ho sakta hai lekin run path koi nahi; brain — catalog entry 'Brain (Qwen3 8B)' hai lekin main/brain.js Qwen3 load nahi karta (TakeOneBrain associative suggestions model hai, LLM nahi).
- Naya tools/audit-catalog.js (audit-catalog-4.js) **verbatim** lagaya — diff vs v3 sirf 17 lines: unavailable≥20 chars + unavailableUser 20–240 chars + "Coming soon" se shuru + dev-jargon regex (run/CI/WO/pip/torch/cu\d{3}/venv/sha/import/ModuleNotFound/exit code/rc=/==/.py). Hamare 19 user texts: sab "Coming soon" se shuru, 20–240 chars, jargon ZERO (script se verify).
- wired-table.md: brain ki entry **theek ki** — pehle "WIRED" likha tha, ghalat tha. TakeOneBrain wired hai (IPC suggestions) lekin catalog ka 'Brain (Qwen3 8B)' tool wired nahi (koi Qwen3 load/run path nahi). Table ab: WIRED (2): image-studio, image-lite; none (19). File: `wo20/wired-table.md` (corrected).
- ACCEPTANCE:
  - catalog-gate CI --hash run 39583397391: **GATE: PASS — VERIFIED 2 · UNAVAILABLE 19** (NOT_AUDITABLE 0). Raw: `wo20-catalog-gate-39583397391.log`.
  - UI test `wo20-ui-test.py`: **19/19** coming-soon cards (grey badge, plain text, no dev wording, no Install); **sirf image-studio + image-lite par Download**; suggestions me sirf Image group; meter 12.9 GB (coming-soon excluded); zero page errors. Screenshot: `wo20-models-wired-only.png` (full-page).
  - Ek false alarm khud pakra: test ne pehle AI Brain/Video groups ko suggestions me "leak" bataya — asal me test ka segment poori page le raha tha (group headings match ho gaye thay); `.suggest` element par scope karne par app sahi nikli.
- **Disclosed CI failure:** verify run 39583395130 (@3e879de) **Failed** — `test/catalog.test.js` ka "has no LTX or RealESRGAN references anywhere": meri 3 video dev-reasons me lafz "sdxlTxt2Img" tha, jisme substring "ltx" hai (naive `includes('ltx')` check). Fix commit 9f64d2b: wording → "the single SDXL text-to-image workflow". Local 103/103 pass; verify run 39584082281 (@9f64d2b) **SUCCESS**. Raw log package me hai. (Note: catalog ka apna validateCatalog word-boundary check use karta hai — sdxlTxt2Img us se kabhi nahi takrata; sirf test ka naive check takraya.)

## WO-21 — Design DELIVERED (koi implementation nahi — acceptance ke mutabiq)
- File: `wo21/ENGINE-DESIGN.md`. Layout `<root>/.engine/` (wheelhouse, comfyui.zip, ComfyUI/, venv/, extra_model_paths.yaml, engine-state.json). Manifest = 87 files (86 wheels + ComfyUI zip), ≈3.54 GB download; shipped python tarball installer ke saath ata hai.
- Function signatures (exact): engineRoot, engineStatePath, readEngineState, writeEngineState, planEngineInstall, installEngine(root, {onEvent}), cancelEngineInstall, enginePython, venvExists, assertEngineReady, writeModelPaths, runPipWheels.
- downloads.js patch: addHfDownload → generalize `addManifestJob({id, files:[{url,dest,bytes,sha256}], category})` (HF is ka caller; cancel path WO-10 wala).
- comfy.js patch: pythonExe = enginePython(root); start() se pehle writeModelPaths + --extra-model-paths-config; assertEngineReady false → plain-words refuse.
- main.js patch: IPC takeone:engineInstall / engineCancel / engineStatus; getComfy enginePython use karega.
- Installing phase: per-wheel pip install (86 invocations, local files, no resolution) — exact i/86 counter, honest. Fail → WHY + WHAT NEXT (plain words). Cancel har phase me.
- Khula sawal Claude ke liye design doc ke aakhir me: per-wheel vs single pip call.

## WO-22 — Implemented + Tested + FAILED (honest — design gate ki wajah se)
- Naya `.github/workflows/e2e-image.yml` (manual dispatch) + driver `tools/e2e-image.js`: engine ko **main/engine.js ki functions se** install karta (installEngine/enginePython/engineRoot — wahi code jo app chalayegi), Image Studio checkpoint manifest se (URL+sha256 catalog se: ByteDance/SDXL-Lightning, 6.6 GB), ComfyUI --cpu, **asli** sdxlTxt2Img workflow (comfy-workflows.js se), 1 prompt, 512x512, 4 steps. PNG checks: exist + 512x512 + pixel variance > 50 (dependency-free PNG decoder: node:zlib + unfilter; kaali/solid tasveer fail).
- Run 39583679095: **FAILED** — check step par: "WO-21 IMPLEMENTATION PENDING: main/engine.js does not exist yet". Ye expected hai: WO-21 acceptance "pehle sirf design doc + function signatures" tha, is liye engine.js implement nahi kiya. Workflow structure ready hai; WO-21 implementation (agle round, Claude ke design review ke baad) land hote hi yehi workflow asli run karega. Raw: `wo22-e2e-image-39583679095-FAILED.log`. Labels: Implemented / Tested / Failed.

## Fingerprint (final HEAD = `9f64d2b`, verify run 39584082281 — CI ke raw log se)

```
commit: 9f64d2bc0c9a9a954c2216e2de4b30fa6dcefd76
a1b9401b9dfc9d4b404358fdb1620b43ebc54fc25470e22dbf75df8d68b391ff  .github/workflows/e2e-image.yml
c67f46ca470e8dda568b7c766bd696e14c4dc4e2964ff4545f23580850bf6180  main/catalog.js
7c82c50b02e2cc038500f4dc368f8b0b2b628787ca5f99987074cc02b9fb304a  tools/audit-catalog.js
41b9dc06cd25be5acf5180c26315d0fdd4f8ec8e2803e08801ab0063af95c3b7  tools/e2e-image.js
```
(Full 34-line fingerprint CI ke raw log `verify-final-39584082281.log` me hai — printed by the
verify job's own Evidence fingerprint step. Upar sirf is round ki changed files.)
Teeno workflows final HEAD par green: verify 39584082281 (success), catalog-gate 39584082124 (success), e2e-image 39583679095 (Failed — honest, WO-21 pending; @2887581 par chala tha, workflow tab se unchanged).

## What I did NOT do
- WO-21 ki implementation (design gate).
- tools/audit-catalog.js me apni marzi se koi tabdeeli (v4 verbatim).
- Koi version bump / installer / release.
