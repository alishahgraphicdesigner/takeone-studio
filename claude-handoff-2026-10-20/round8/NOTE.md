# Round-8 return — Claude ke WO-15 … WO-19 (2026-10-20)

Labels: Implemented / Tested / Passed / Failed / Not Tested.
Fingerprint hashes CI ke raw logs se — haath se kuch nahi likha.

## Commits (pushed to main)
- fa98b62 — WO-16/WO-17/WO-19: unavailableUser plain-words + Coming soon grey badge; voice-lite+slow-motion unavailable (NOT_AUDITABLE=0); shipped-python-spike workflow
- 075bb0e — WO-16 fix: suggestions group logic — group with an offered tool stays, fully coming-soon group vanishes
- 57db73b — WO-16: drop duplicated 'Coming soon.' prefix in soonbox
- c28c83e — WO-19 fix 2: wheelhouse builder as committed script (pwsh has no heredoc); pip specs via splatted array

---

## WO-15 — Tested (saboot poora)
1. `git show 20100af:.github/workflows/engine-spike.yml` aur `git show 20100af:engine-lock.json` ki committed copies is package me hain: `wo15/engine-spike.yml@20100af`, `wo15/engine-lock.json@20100af`. (Dono 20100af ke baad unchanged — git diff empty.)
2. 3-line summary — script se, haath se nahi:
```
wheelCount: 86
totalBytes: 3529035908
torch 2.11.0+cu128 | https://download-r2.pytorch.org/whl/cu128/torch-2.11.0%2Bcu128-cp311-cp311-win_amd64.whl | sha256: 90ef0c2454e5296a9fb021ddd42252e4ce1abe2c0a4988a173ef90a6cded0bf5
torchaudio 2.11.0+cu128 | https://download-r2.pytorch.org/whl/cu128/torchaudio-2.11.0%2Bcu128-cp311-cp311-win_amd64.whl | sha256: 0f2995101f526a2220dc348d35b153f327ed59b247fa249adddc4c478cece566
torchvision 0.26.0+cu128 | https://download-r2.pytorch.org/whl/cu128/torchvision-0.26.0%2Bcu128-cp311-cp311-win_amd64.whl | sha256: d26091b15cd6e3c74c148d9b68c9a901ad6fb9b0f66fa3ea3ab09f04132a07d3
```
3. CI raw log: Round-7 ka `engine-spike-run5-39390192996-PASSED.log` (is package me nahi, Round-7 package me hai) — wahi run jis ne engine-lock.json banaya tha. Fingerprint sirf CI ke raw log se.

## WO-16 — Implemented + Tested + Passed
- Catalog me har unavailable tool par ab DO fields: `unavailable` (dev/audit) aur `unavailableUser` (plain, 2 jumle: "Coming soon. We’re still making sure this works smoothly on your PC. Nothing for you to do."). Script se verify: 7/7 unavailable tools par dono fields, user text me dev wording ("Not available yet", "CI-measured", "run 39", "Withheld") ZERO leak.
- Renderer sirf `unavailableUser` dikhata hai — dev `unavailable` ab UI me kahin nahi jata.
- Badge: neutral grey "Coming soon" (`.badge.coming` — #1e2126/#b8bcc4; laal nahi).
- "Remaining GB" total (renderMeter) aur "Complete your pipeline" suggestions se unavailable tools nikal diye. Suggestions logic me ek bug khud pakra aur fix kiya: pehle group ka representative agar coming-soon hota to poora group gayab ho jata tha (Audio/music-studio case) — ab group tabhi suggest hota hai jab us me kam az kam ek offered tool ho.
- Image Lite card: `.tmeta` pills ko `overflow:hidden + text-overflow:ellipsis + min-width:0` — "OpenRAIL++-M" pill ab spill nahi karti (viewport capture se verify; full_page screenshot me jo spill dikhta hai wo Playwright ke full_page capture ka repaint artifact hai, DOM me cw==sw — probe se measured).
- Sidebar: `railfoot` ka misleading "v…" placeholder hata diya — version ab sirf inject hone par dikhta hai.
- Audit note: tools/audit-catalog.js ko NAHI chhua (instruction). Current audit (v3) dono fields check nahi karta — "dono zaroori" wala enforcement Claude ke naye version ka intezar karega. Acceptance "audit PASS" = current CI audit.
- ACCEPTANCE: UI test `wo16-models-ui-test.py` — **7/7 cards**: "Coming soon" badge, grey (no red), plain user text, dev wording zero, koi Install button nahi; groups fully coming-soon (Voice) suggestions se bahar; meter 121.0 GB (coming-soon tools excluded); Brain card still shows Download; zero page errors. Screenshot: `wo16-models-coming-soon.png`.

## WO-17 — Implemented + Tested + Passed
- voice-lite aur slow-motion dono par `unavailable` (dev, saboot ke saath) + `unavailableUser` lag gaya.
- voice-lite dev reason: external fetch (Piper + espeak-ng official page se, bundled nahi); real PC par hand-installed copy ki detection unverified; in-app path sirf official page kholta hai, voice engine kuch nahi chalata.
- slow-motion dev reason: adopt-type — TakeOne files copy karta hai, lekin RIFE chalane wala koi code nahi (execution path none — WO-18 me confirm).
- Gate: **NOT_AUDITABLE = 0**. CI catalog-gate --hash: **GATE: PASS — VERIFIED 14 · UNAVAILABLE 7 · NOT_AUDITABLE 0** (run 39417120332 @fa98b62; run 39417560898 @f87fe4c — dono success).

## WO-18 — Tested (kuch fix nahi kiya, instruction ke mutabiq)
- `wo18/wired-table.md`: 21 tools ki table. Method: execution path grep (subprocess, ComfyUI prompt, IPC handler) in main/comfy-workflows.js, main/comfy.js, main/pipeline.js, main/library.js, main/brain.js, main/deps.js, main.js, renderer/*.js, preload.js.
- **WIRED (3):** brain (main/brain.js:16; main.js:986-1009 IPC; renderer/pipeline.js:201,218), image-studio (comfy-workflows.js:26; main.js:961-978; comfy.js:39-61; renderer/pipeline.js:223), image-lite (wahi shared path — catalog me alag entry, code me alag workflow nahi).
- **none (18):** video-studio, video-quality, video-pro, voice-studio, transcribe, music-studio, upscaler, face-restore, vision, smart-select, erase, depth-fx, pose-lock, bg-remove, voice-cleanup, slow-motion (adoptPick sirf copy), stem-split — download/install/adopt/detection code hai, execution path koi nahi. voice-lite: in-app sirf official page khulti hai.
- Bheji hui files: `wo18/` me comfy-workflows.js, pipeline.js, library.js, brain.js, studio-renderer.js + wired-table.md.

## WO-19 — Implemented + Tested + Passed (4 disclosed failures ke baad)
- Naya workflow `.github/workflows/shipped-python-spike.yml` (manual dispatch): resources tarball extract → shipped python se `-m venv` → `tools/build-wheelhouse.py` se engine-lock.json ka wheelhouse (har wheel sha256-verified) → venv me `--no-index --find-links` install → pip check → `torch.version.cuda == '12.8'` assert → ComfyUI (pinned b1a247c9, sha-verified) boot `--cpu --quick-test-for-ci` exit 0.
- Run 1 (39417137729): **Failed** — mera workflow bug: tarball `python/` subdir me extract hota hai (python.exe ka path ghalat tha). Raw: `wo19-shipped-python-39417137729-FAILED.log`.
- Run 2 (39417566971): **Failed** — (a) venv BAN GAYA THA (`.spike-venv/Scripts/python.exe --version` = Python 3.11.17 — ensurepip kaam karta hai, ye good news hai); (b) mera doosra bug: PowerShell me bash heredoc (`<<'PYEOF'`) ParserError; (c) pip specs pipe me ghalat ja rahe thay. Dono fix: `tools/build-wheelhouse.py` committed script + splatted `@specs` array. Raw: `wo19-shipped-python-39417566971-FAILED.log`.
- Run 3 (39417819990): **Failed** — meri helper script me key ghalat thi: lock entries me `filename` nahi, `file` hai (KeyError). Fix commit 40046e0. Raw: `wo19-shipped-python-39417819990-FAILED.log`.
- Run 4 (39418163616 @40046e0): **SUCCESS** (11:52:34Z → 11:56:06Z). Raw: `wo19-shipped-python-39418163616-PASSED.log`.
  - Shipped python extract: Python 3.11.17; `-m venv` OK — **ensurepip kaam karta hai** (WO-19 ka asal sawal: jawab HAAN).
  - Wheelhouse: `wheels: 86 mismatches: 0` — engine-lock.json se rebuild, har wheel sha256+bytes verified.
  - pip install `--no-index --find-links` rc=0; pip check rc=0.
  - `cuda: 12.8` — assert **PASSED** (koi AssertionError nahi).
  - Report: `torch 2.11.0+cu128 | cuda 12.8`.
  - ComfyUI boot exit 0 (step me `$LASTEXITCODE` check; job success = boot pass). Boot ke doran ek WARNING aya: "You need pytorch with cu130 or higher to use optimized CUDA operations" — ComfyUI ki taraf se informational warning hai, failure nahi (boot exit 0).
  - `##[error]` count: 0. Venv ka total size step summary me gaya, raw log me capture nahi hua — honestly note kar raha hoon.
- Labels: Implemented / Tested / Passed (run 4). Runs 1–3: Implemented / Tested / Failed (disclosed, raw logs attached).

## Fingerprint (final HEAD = `40046e0`, verify run 39418157330 — CI ke raw log se)

```
### Evidence fingerprint
commit: 40046e0d52bb01a757aafd857d6fd26d81929885
bfe8a30b033455e74a2ee5f25c01470d510757c6903112f4841a2da047d6650a  .github/workflows/catalog-gate.yml
9876d875e342f47a675cca3be174e4cc8921a6f450a40453d945639f32e2d00a  .github/workflows/engine-spike.yml
cd1a18855fcd4f115ec97db5ffbfe17cadcb26437f4f923c9f8970e4aa7e87d4  .github/workflows/pip-tools.yml
b00c6197e253e4b0db92fec2c52376dfbf2f00351fe348633f430037d63e3f88  .github/workflows/shipped-python-spike.yml
df40a0ffd66070784193352ca8ded94bdb23d706c7c7aa1fe15af1de28f8dc5a  .github/workflows/verify.yml
7bfa2a4537d2d62f2d4aba2051a068c09232335c638b27330043c8b2684fa2e9  main.js
303c46faffa08a381ee4e0184674ebf5fb8440ee8309cc7184de4142b0d52c00  main/brain.js
494db2d79124fe62644358250b092e4c819c8c333efef15d96fd5dce5a0e8349  main/catalog.js
3fa57c8c2054e0170f754f7b8ec610b2e31194864e0aef056aa0694e275bc1a1  main/comfy-workflows.js
fe5a08d8b41f1bfd74f123698f6332e97799590ee8d09181fec5a86ac8053d2f  main/comfy.js
f4f87258ae1c550bc42d926d3dc62ed485a22d6519465afba87ef6755bbb4787  main/deps.js
7813a420603741a393c24c29e278569f99dd60664bd1a2623762d3a2293e3ce4  main/downloads.js
6986a588fcc4ad91aa1173a51489f88dbd0c5b984e712ec688ea49de94620bd5  main/downloads.v2.2.bak
c3fadf39cdf119e96d3af69493674c7d218d6535bdfdba6748906345aa9e7654  main/downloads.v2.3.bak
e86171fcb8725be476c9f4ad7e35786e91c9e05c07f0789bd8ec1eb5d6d54324  main/hf-install-check.js
806abb31682d52b958a3ce19e8a1d374d1480e2a4395cee6a0338300e4eb51b5  main/library.js
f33d0578fc9d3c2a5240c971c07800717e22df8d74c66931dc8a9db14717aacf  main/pipeline.js
bf70c8766a013aef53b94d76a5d9998367a4d53ab31f90d9b6df0153f8b4828b  package.json
3d5aa617e918caa6684ece55976b305807e701e98f914add4d9e307f8c6a0f02  tests/deps-ensurepip.test.js
7bf3ebcae020ebb9f9c4c666febe694ae93a33964710637d6e5415cac5d93f89  tests/downloads.behavior.test.js
d2c23e4ab235117065336040e4d9ad4a5a6d60cb05a66a9ebdfe300143a6d79f  tests/downloads.real-aria2.test.js
300b6fb084e5cbb0c9394e79b2b1013f854f51054df384a6fa3ce4a5906cb738  tests/hf-install-check.test.js
055c3883539c683710e43a80ef364b93d561c8fb78dbaf11bf6113f966dcbe77  tests/mock-aria2c.js
b8fcd9b14207ca50e231b240a5bbd48ade799e1ce5e88a93a303590c1227c3a2  tests/mock-aria2c.v2.2.bak
2db7b6aac95232a3b2b49239ffdd2edd6f607cb358d993e96fde13525ff3451e  tools/audit-catalog-v1-backup.js
9fe3838b407e30ed04579981527457a52bee8260139a07dd212453d11d48d8e6  tools/audit-catalog-v2.js
884c48b31d3593effb995d2dd81b84cf46c1f89dced3c2fac68553adca7d3539  tools/audit-catalog.js
6087c1f134b6860702fb809cccb4909eefe0b832df99e2f1746640469e83df4e  tools/audit-report-v1-backup.json
5a1357c8cae03862214cdec3c67f999c7b87ecef3bda423654b63eae78026c64  tools/audit-report.json
```
(Printed by the verify job's own Evidence fingerprint step at commit
40046e0d52bb01a757aafd857d6fd26d81929885. NOTE: ye fingerprint set tools/build-wheelhouse.py
ko include nahi karta — wo file commit c28c83e me aayi thi aur 40046e0 me maujood hai; fingerprint
step ki file list static hai. tools/build-wheelhouse.py is package ke files/ me poori copy ke tor par hai.)

## What I did NOT do
- tools/audit-catalog.js ko haath nahi lagaya (WO-16 instruction — Claude ka naya version aayega).
- WO-18 me koi fix nahi kiya — sirf table.
- koi version bump, koi installer, koi release — Claude decide karega.
