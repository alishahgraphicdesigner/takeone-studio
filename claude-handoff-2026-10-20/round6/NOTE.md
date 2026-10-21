# Round 6 return — WO-4 … WO-9 (+ fingerprint addendum)

Commits (all pushed to `main`; local branch is `master`, pushed `master:main` as before):
- WO-4: `93c1b18` · WO-5: `1abaa73` · WO-6: `0162449` · WO-7: `9fc8032` · WO-8: `e82eed1` · WO-9: `efa6930` (HEAD)
Labels key: Implemented / Tested / Passed / Failed / Not Tested. "Fixed" is claimed nowhere below.

---

## WO-4: toolInstalled ko sasta banao

- hfInstalledStatus now `hfInstalledStatus(dir, files, opts)` — **Implemented**
  - Default (`deep:false`): stat-only — missing / not-a-file / exact-bytes checks, NO hashing.
  - `{deep:true}`: additionally verifies each file's SHA-256 against the manifest.
  - main.js needed NO change: its hf branch already calls `hfInstalledStatus(d, tool.files)` with no opts, so it now uses the cheap default exactly as the WO requires.
- Tests (tests/hf-install-check.test.js) — changed, disclosed per rules:
  - The old 'checksum mismatch' test now passes `{deep:true}`. Its assertion is unchanged in strength (a wrong sha still fails); only the mode is named, because sha-checking is now the deep mode by the WO's own design.
  - New acceptance test, verbatim name: 'WO-4 acceptance: right size + wrong content -> default complete true, deep false'.
  - The 'complete' test now asserts BOTH modes pass. Nothing was removed or loosened.
- Local: `node --test tests/hf-install-check.test.js` → 7/7 — **Tested**
- CI run 39380421257, step 'HF install-check + ensurePip regression tests': 9/9 ✔ — **Passed**
  - incl. '✔ WO-4 acceptance: right size + wrong content -> default complete true, deep false' and '✔ checksum mismatch -> complete false (deep only; WO-4)'.
- RETURN files: `files/hf-install-check.js`, `files/hf-install-check.test.js`; run id 39380421257.

## WO-5: CI hang ko wazeh karo

- Patch to `.github/workflows/verify.yml` (patched, not overwritten) — **Implemented**
  - `timeout-minutes: 20` added to all 3 jobs.
  - `--test-timeout=120000 --test-reporter=spec` on all four direct `node --test` steps. Flags were placed BEFORE the file arguments on purpose: verified locally that node IGNORES them after the filename (a 5 s test with `--test-timeout=300` placed after the file ran the full 5 s and passed).
  - Evidence fingerprint step now `| tee -a "$GITHUB_STEP_SUMMARY"` — it prints to stdout as well. Verified in run 39380421257's raw log: `commit: efa69304f587373699ec3940fccd4afaa7f94cf4` plus the per-file sha256 lines are in the log itself.
- One honest limit: the two `npm test` steps could NOT take the flags. `npm test -- --test-timeout=…` appends them AFTER the `test/*.test.js` glob, where node ignores them (same experiment). Adding them inside the `test` script needs package.json — outside WO-5's FILES list. So `npm test` is covered by the job-level timeout only. This matters below.
- The 3 runs:
  | run | id | wall | conclusion | jobs |
  |---|---|---|---|---|
  | 1 (push) | 39379830992 | 06:20:44Z → 06:38:34Z | **cancelled** (manual, by me) | windows-installer Passed; linux HUNG (below) |
  | 2 (dispatch) | 39380421257 | 06:27:00Z → 06:31:30Z (4m30s) | **success** | both Passed |
  | 3 (dispatch) | 39380794287 | 06:30:47Z → 06:51:08Z (20m21s) | **cancelled** (timeout) | windows-installer Passed; linux HUNG, killed by timeout-minutes:20 at ~06:50:52Z |
- The hang, localized — **evidence from run 1's post-cancel log** (`verify-run1-39379830992.log`):
  - The linux job stuck at step 5 'Run npm test' from 06:20:58Z (run of 2026-10-19 #39234436467 stuck at the same step).
  - TAP in the log: suite 'DownloadManager (real aria2c)' (`test/downloads.test.js:91`) closed at 06:21:21Z with **subtest 'cancel removes partials — nothing half-written left behind' (test/downloads.test.js:156) FAILED**: assertion at line 167, `assert.equal(fs.existsSync(partial), false)` — expected false, got true: after `mgr.cancel()`, `.staging/downloads/demo.bin` still existed at assert time (then the '.aria2' assert never ran).
  - Mechanism, read from the test source: the throw at line 167 skips the `await mgr.stop()` on line 169 (the test has no try/finally), so the manager — real aria2c child process + open sockets — is never torn down, the event loop stays alive, and `node --test` never exits even though the suite result already printed. After 06:21:21Z the log is silent for ~50 minutes.
  - Intermittency: the same test passed in run 2 and passes locally; the partial-still-exists assert is a CI timing flake. The hang-after-failure is deterministic given that flake.
  - Run 1 anomaly, reported as observed: its timeout-minutes:20 did NOT visibly terminate the job within ~50 min (the run's `updated_at` stayed frozen at creation). I cancelled it manually. Run 3's identical hang WAS terminated by the timeout (≈20m21s). Whether run 1 was a runner-side enforcement failure is GitHub-internal — Not Tested / unknown.
- Not fixed here, by scope: the flake + missing teardown in `test/downloads.test.js` (outside WO-5's FILES), and `--test-timeout` inside the npm test script (needs package.json). Both are Claude's call.
- Label: WO-5 changes **Passed** (run 2 fully green; run 3 shows a hang now terminating visibly instead of spinning); the npm-test hang itself reproduced 2 of 3 runs and is handed over with evidence, NOT fixed.
- RETURN: `files/verify.yml`; logs `verify-run1-39379830992.log`, `verify-run2-39380421257.log`, `verify-run3-39380794287.log`.

## WO-6: catalog ko saboot ke mutabiq karo

- Patch to `main/catalog.js` only — **Implemented**
  - Header comment now documents the `unavailable` field.
  - voice-studio + erase: `unavailable: '<reason>'` added — the reason names the CI evidence (run 39242332869: Windows pip installs CPU-only torch; erase's in-app invocation also not wired) and the condition for return (WO-8 evidence). Their `installBytes` / `installScope` / `firstRunBytes` nulled.
  - transcribe, voice-cleanup, stem-split: `installBytes: null`, `firstRunBytes: null`, `installScope: null` — every Linux-era pip number is out until WO-8's real Windows numbers exist.
  - `sizeMB` left untouched: the header already defines it as a planning estimate, and the WO named only the three byte/scope fields.
- `validateCatalog(CATALOG)` → ok, no errors (local) — **Tested**; local `npm test` → fail 0.
- Honest scope note: `unavailable` is a catalog data field today. Nothing in renderer/main.js reads it yet (those files were outside WO-6's FILES), so the UI still renders Install buttons for those two cards. The catalog no longer asserts unbacked numbers; making the UI show "Not Available" needs a follow-up WO touching `renderer/models.js` (and `mergedToolStates` in main.js).
- ACCEPTANCE — real audit output, local `node tools/audit-catalog.js --hash` (2026-10-20T06:18:19Z; full log `audit-catalog-local.log`):
  - catalog structure check: ok
  - VERIFIED 14 · UNPINNED 5 · NOT_AUDITABLE 2
  - **GATE: FAIL (blocked by: voice-studio, transcribe, erase, voice-cleanup, stem-split)**
  - Label: **Failed** — that is the true state the WO asked to surface; the gate stays FAIL until WO-8-derived numbers are pinned in.
- RETURN: `files/catalog.js`, `audit-catalog-local.log`.

## WO-7: ComfyUI engine install ka CI spike

- New file `.github/workflows/engine-spike.yml` (verify.yml untouched) — **Implemented**
- Run 39379854775 → **success**, 06:20:59Z → 06:24:18Z (3m19s). Raw log: `engine-spike-39379854775.log`.
- Evidence from the log:
  - torch cu128 pre-install: 80.3 s; `torch 2.11.0+cu128 | cuda 12.8`, torchaudio 2.11.0 — the exact pins resolve from the cu128 index.
  - ComfyUI pinned commit `b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c`; zip = **13,509,383 bytes**; sha256 `14d2ffe3775d656ebe3d9a6f684b5f1874ac89992ca296ee3c4646c14ebe4e1e` verified in CI (same value measured locally before pinning).
  - **ComfyUI license: GPL-3.0** (the zip's LICENSE file is the GNU GPL v3 text).
  - `pip install -r requirements.txt`: 85 s, rc=0. `pip check` rc=0.
  - ⚠️ **SURPRISE (raw): `torch after requirements: 2.14.1+cpu | cuda None`** — the requirements step REPLACED the pinned cu128 torch with PyPI's CPU torch (requirements.txt carries unpinned torch + torchvision; pip resolved torchvision against PyPI and upgraded torch). The boot below therefore ran on CPU torch, not the pinned one.
  - Boot: `python main.py --cpu --quick-test-for-ci` → **exit code 0** — ComfyUI boots after full init on a clean Windows runner, no GPU.
  - TOTAL venv size: **2,101,237,339 bytes (1.96 GiB)** — total, not delta.
- Labels: engine install + boot **Passed** (on CPU torch). The pinned-cu128-survives-requirements goal **Failed** (torch swapped silently). A fix (install torchvision from the cu128 index in the same step, or pin torch via a constraints file) was NOT attempted — Claude's call.
- RETURN: `files/engine-spike.yml`, `engine-spike-39379854775.log`, license GPL-3.0, zip 13,509,383 bytes.

## WO-8: pip tools ka asli Windows saboot

- New file `.github/workflows/pip-tools.yml` — **Implemented**. Run 39379857961 → **failure**, 06:21:01Z → 06:25:15Z. Raw log: `pip-tools-39379857961.log`.
- Method per the WO: each tool in its OWN fresh venv; the install command is the app's (deps.js): `python -m pip install --disable-pip-version-check --no-input <pkg>`; demucs + deepfilternet got `torch==2.11.0+cu128 torchaudio==2.11.0+cu128` first.
- Per-tool verdicts (install rc / import rc / TOTAL venv size):
  | tool | install | import | TOTAL venv |
  |---|---|---|---|
  | chatterbox-tts==0.1.7 | Passed (86.8 s, rc=0) | `chatterbox.tts` **Passed** | 2,187,503,576 B (2.04 GiB) |
  | faster-whisper==1.2.1 | Passed (22.9 s, rc=0) | `faster_whisper` **Passed** | 302,091,283 B (0.28 GiB) |
  | lama-cleaner==1.2.5 | Passed (97 s, rc=0) | `lama_cleaner` **Passed** | 1,343,979,911 B (1.25 GiB) |
  | demucs==4.1.0 | Passed (235.1 s, rc=0) | `demucs.separate` **Failed** | 4,591,494,367 B (4.28 GiB, incl. pre-installed cu128 torch) |
  | deepfilternet==0.5.6 | Passed (163.7 s, rc=0) | `df.enhance` **Failed** | 4,638,480,769 B (4.32 GiB, incl. pre-installed cu128 torch) |
- The two failures, raw:
  - demucs: `ModuleNotFoundError: No module named 'numpy'` — with cu128 torch pre-installed, neither torch 2.11's nor demucs 4.1.0's metadata pulled numpy in, and `demucs.separate` imports it.
  - deepfilternet: `ModuleNotFoundError: No module named 'torchaudio.backend'` — df imports `torchaudio.backend`, which torchaudio 2.11 no longer ships.
- First-run models (researched 2026-10-20 from the packages' own source + host metadata; **Not Tested** in CI):
  - transcribe: Hugging Face `Systran/faster-whisper-large-v3` — model.bin 3,087,284,237 B; repo total 3,090,839,273 B (HF API). https://huggingface.co/Systran/faster-whisper-large-v3
  - voice-studio: Hugging Face `ResembleAI/chatterbox` — runtime files t3_cfg.safetensors 2,129,653,744 + s3gen.safetensors 1,056,484,620 + ve.safetensors 5,695,784 + conds.pt/tokenizer; Linux-measured total (2026-10-17) 3,191,966,992 B.
  - stem-split (demucs, default model htdemucs): https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th — 84,141,911 B (server Content-Length today). Note: the 2026-10-17 Linux measurement was 84,025,440 B — 116,471 B less; discrepancy unexplained (possible re-upload).
  - voice-cleanup (DeepFilterNet2): https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet2.zip — zip 8,629,708 B (GitHub API today); Linux-measured extracted content ≈ 7,986,207 B.
  - erase (LaMa): https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt — 205,669,692 B (Content-Length; matches the 2026-10-17 Linux measurement exactly).
- RETURN: `files/pip-tools.yml`, `pip-tools-39379857961.log`.

## WO-9: catalog gate CI mein

- New file `.github/workflows/catalog-gate.yml` — **Implemented**: ubuntu job runs `node tools/audit-catalog.js --hash`, tees the output to `audit-output.txt`, and uploads `audit-output.txt` + `tools/audit-report.json` as the `catalog-audit-report` artifact (if: always()).
- Run 39379831031 (push) → **failure**, 06:20:44Z → 06:21:00Z. The audit step exited 1 on GATE: FAIL and the artifact uploaded. Raw log: `catalog-gate-39379831031.log`.
- Labels: the workflow **Passed** its purpose — the gate is now CI's result, FAIL = red. The gate itself stands **Failed** (exactly the 5 pip tools UNPINNED) until numbers earned from WO-8 are pinned into the catalog.
- RETURN: `files/catalog-gate.yml`, run id 39379831031, gate output in the log + artifact.

## Addendum (fingerprint + run3-fingerprint.txt)

- Fingerprint step now also prints to stdout via `tee` (see WO-5). `run3-fingerprint.txt` is attached again, plus `fingerprint-run-39380421257.txt` for the current head `efa69304f587373699ec3940fccd4afaa7f94cf4`.
- Caught while preparing that file: the local WO-6 audit run had regenerated `tools/audit-report.json` in the working tree, so a plain working-tree hash of it differs from CI's. The attached fingerprint was therefore computed from COMMITTED content (`git show HEAD:<path>`, same file set as CI) and spot-matches run 2's log: `tools/audit-report.json` = `5a1357c8cae03862214cdec3c67f999c7b87ecef3bda423654b63eae78026c64`, `main/hf-install-check.js` = `e86171fcb8725be476c9f4ad7e35786e91c9e05c07f0789bd8ec1eb5d6d54324`.
- The working tree still holds that regenerated audit-report.json uncommitted; no WO asked to commit it, so it was left alone.

## Surprises / failed-or-unexpected, collected

1. `pip install -r ComfyUI/requirements.txt` silently swaps the pinned cu128 torch for PyPI CPU torch 2.14.1 (WO-7) — install and boot still pass, on the wrong torch.
2. demucs import fails on missing numpy; deepfilternet import fails on the removed `torchaudio.backend` (WO-8) — installs pass, the tools cannot start in these configurations.
3. `npm test` hang localized: a timing flake in `test/downloads.test.js:156` + a missing teardown that turns that flake into a never-exiting process (WO-5). Reproduced 2 of 3 runs.
4. Run 1's 20-minute timeout did not visibly fire in ~50 min; run 3's identical hang was terminated by the same timeout. GitHub-side inconsistency, reported as observed.
5. demucs' first-run model file is 116,471 B larger on the server today than the 2026-10-17 measurement (WO-8 note).
