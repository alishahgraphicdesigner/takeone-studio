# Claude return — Round 5 (WO format, per WORKING-RULES.md)

Covers your 7-point message (round-4 reply) + the A/B measure experiment.

Commit: `c78faab870020ac09db50791b267c2264bda97c1`
CI run: **39242332869** — conclusion: **success** (workflow_dispatch, measure_pip=true)
Repo: github.com/alishahgraphicdesigner/takeone-studio, branch main

## Per-item return

### 1. Fix: HF half-download must not read as installed
- **Implemented.** Evidence: `main/hf-install-check.js` (NEW, full copy attached), `main.js` diff (toolInstalled hf branch now `(await hfInstalledStatus(d, tool.files)).complete`; old `entries.length > 0` removed).
- **Tested.** `tests/hf-install-check.test.js` (NEW, 6 tests) — local: 6/6 pass. Includes the critical case: truncated file → `complete: false`.
- **Passed** (CI). New tests ran in run 39242332869's Linux job step "HF install-check + ensurePip regression tests" — job conclusion success.

### 2. Fix: ensurePip onCancel ReferenceError
- **Implemented.** Evidence: `main/deps.js` diff — `ensurePip(root, onProgress)` → `ensurePip(root, onProgress, onCancel)`; `pipInstall` now passes `onCancel` through. (2 lines.)
- **Tested.** `tests/deps-ensurepip.test.js` (NEW, 2 tests) — local: 2/2 pass. PROOF the test guards the bug: with the fix stashed, both tests fail with `ReferenceError: onCancel is not defined`; with the fix, they pass.
- **Passed** (CI). Same Linux job as item 1 — success.

### 3. A/B measure experiment (plain vs cu128 torch pre-install)
- **Implemented.** Evidence: `verify.yml` — `pip-measure-windows` now has matrix `variant: [plain, cu128]`; cu128 variant runs `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128` first; each variant reports installBytes + `pip check` + `python -c "import torch;print(torch.__version__, torch.version.cuda)"`; torch probe is non-fatal (reports "torch NOT installed" as data); all three outputs also Write-Hosted into the log.
- **Passed** (CI). Run 39242332869: **10/10 pip-measure jobs Passed**, rc=0 everywhere. `pip check` = "No broken requirements found" in all 10.
- Raw evidence: `measure-ab-raw.log` (57 lines — every job's installBytes, pip-check, torch-info, verbatim from `gh run view --log`).

### 4. Files you asked for (full copies, attached — no overwrite by me)
- `downloads.js` (current, with freedBytes fix), `catalog.js` (current), `comfy.js` (current).

### 5. Evidence fingerprints
- `fingerprint-run-39242332869.txt` — this run's commit, same command as the CI step.
- `run3-fingerprint.txt` — run 3's commit (recomputed; step summary is not exposed via API — labeled in file).
- NOTE: I cannot paste the step summary from the GitHub UI via API; both files are the exact CI command re-run at the exact commit, clearly labeled.

## Changed files this round (full copies attached) + what/why
- `.github/workflows/verify.yml` — (a) wired the 2 new test files into the Linux job; (b) A/B matrix for measure (your spec); (c) fixed PowerShell ParserError (backtick is the escape char — single-quoted the markdown fences); (d) torch probe non-fatal + `$LASTEXITCODE = 0`; (e) Write-Host pip-check/torch-info into the log. No test weakened.
- `main.js` — require hf-install-check; toolInstalled hf branch → byte-exact check.
- `main/deps.js` — ensurePip signature + pass-through (2 lines).
- `main/hf-install-check.js`, `tests/hf-install-check.test.js`, `tests/deps-ensurepip.test.js` — new.

## Anything that failed or surprised me (raw, no verdict from me)
1. **chatterbox-tts [cu128]: installBytes = -2263.6 MiB (NEGATIVE).** Torch probe: `2.6.0+cpu None`. The pre-installed 2.11.0+cu128 torch was REPLACED by pip with the package's pinned CPU torch.
2. **lama-cleaner [cu128]: installBytes = -3058.2 MiB (NEGATIVE).** Torch probe: `2.14.1+cpu None`. Same replacement.
3. **demucs [cu128]: installBytes = +30 MiB.** Torch probe: `2.11.0+cu128 12.8` — demucs KEPT the pre-installed cu128 torch.
4. **deepfilternet / faster-whisper [plain]: torch NOT installed** (packages don't depend on torch). In their cu128 variants torch 2.11.0+cu128 is present but unused by the package.
5. Plain-variant sizes: chatterbox 2063.5 MiB (torch 2.6.0+cpu), demucs 636.5 MiB (2.14.1+cpu), lama-cleaner 1258.9 MiB (2.14.1+cpu), faster-whisper 265.8 MiB (no torch), deepfilternet 151.5 MiB (no torch).
6. **Run 39234436467 (round-4 fixes push): windows-installer Passed; logic-and-real-aria2-linux STUCK 1h+ at the "Run npm test" step** (no output; logs unavailable while in progress). I cancelled the run. The identical test suite (including the 2 new test files) **Passed** in run 39242332869's Linux job on the newer commit, so the hang looks runner-side, not code-side — your call.

## Labels used
Implemented / Tested / Passed are CI's or local test's own conclusions, quoted above. "Fixed" not claimed anywhere — only green runs reported.
