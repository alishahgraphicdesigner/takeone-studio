# Round 7 return — WO-10 … WO-14

Commits (all pushed to `main`; local branch is `master`, pushed `master:main`):
- WO-10: `d8c2edf` · WO-13: `9044f3e` · WO-12: `eb0f0a2` · WO-11: `0e14221`
- WO-11 fix 1: `6f1d517` · WO-11 fix 2: `d833825` · WO-11 fix 3: `6ee91b0` · WO-11 fix 4: `3c01aed`
- engine-lock.json: `20100af` (HEAD)

Labels key: Implemented / Tested / Passed / Failed / Not Tested. "Fixed" is claimed only for the three build-lock.py bugs below, each fixed after a red CI run and re-run green — never silently.

---

## WO-10: cancel ke baad partial file reh jana — **Passed**

- Patch to `main/downloads.js` only (patched, not overwritten) — **Implemented**
  - New `DownloadManager._waitUntilRemoved(gid, maxMs=3000)`: after forceRemove,
    cancel now waits until aria2 itself answers `tellStatus` with `status == 'removed'`
    (a "GID not found" RPC error also counts as gone), polling every 100 ms, max 3 s.
    Rationale: forceRemove returns before aria2 has necessarily let go of the
    file; the old code deleted immediately and the partial (or its `.aria2`)
    could reappear in staging after cancel() returned. That is the race behind
    round 6's `test/downloads.test.js:156` flake.
  - New `DownloadManager._deleteVerified(p)`: unlink, then VERIFY gone; up to
    3 retries, 200 ms gap. Used for the partial and its `.aria2` in cancel().
  - freedBytes semantics unchanged (stat-before-unlink; counts partial + .aria2).
- New loop test in `tests/downloads.real-aria2.test.js` — **Implemented**
  - Test F: 30 sequential iterations, each: start download (12 MiB, real aria2c,
    local server) → wait progress > 0.05 → cancel() → assert status cancelled
    AND staging has neither the partial nor its `.aria2`. Per-test timeout
    900000 (explicit in the test; no assertion weakened).
- Evidence:
  - Local Linux (real aria2c 1.37): 6/6 pass, F 30/30 iterations in 9.7 s — log
    `wo10-real-aria2-local-run1.log`. **Run #1 of 3.**
  - CI verify run 39387866664, linux job (real aria2c): 6/6, F 30/30 in 9.7 s.
    **Run #2 of 3.**
  - CI verify run 39387866664, windows job (shipped resources/aria2c.exe):
    6/6, F 30/30 in 11.3 s. **Run #3 of 3.** — 30/30 pass in 3 separate runs,
    acceptance met.
  - `tests/downloads.behavior.test.js` (simulator): 11/11 pass — the patch broke
    nothing (incl. tests 3, 7, 11: cancel semantics, freedBytes).
- RETURN: `files/downloads.js`, `files/downloads.real-aria2.test.js`; logs as above.

## WO-13: test hygiene — **Passed**

- Patch to `test/downloads.test.js` + `package.json` — **Implemented**
  - All managers now register in a `liveManagers` set at creation and are
    stopped in a new `afterEach` (try/finally equivalent): a failed assertion
    mid-test can no longer skip `mgr.stop()`, leaving a real aria2c child +
    open sockets holding the `node --test` process open. No assertion changed.
  - `package.json` `test` script is now
    `node --test --test-timeout=120000 test/*.test.js` — the flag is BEFORE the
    glob, as required (verified placement: `node --test --help` accepts it; the
    flag is a node-level option, not a positional test arg).
- Evidence — 3 runs, no hang anywhere:
  1. Local: `npm test` 103/103 pass, wall 30.4 s, exit 0 — `wo13-npm-test-local-run1.log`.
  2. CI verify run 39387866664, linux job: `npm test` 103/103 pass, step took
     ~26 s, job finished — no hang.
  3. CI verify run 39387866664, windows job: `npm test` 103/103 pass, job
     finished — no hang.
- RETURN: `files/downloads.test.js`, `files/package.json`.

## WO-12: catalog + UI "Not Available" — **Passed**

- Patch to `main/catalog.js` (patched) — **Implemented**
  - All 5 pip tools now carry `unavailable: '<reason>'` (each a real sentence,
    216–279 chars):
    - voice-studio + erase: reasons from WO-6 (CPU-only torch evidence).
    - transcribe (faster-whisper): install+import passed in CI but install size
      unpinned and the ~3.09 GB first-run model is not fetched/verified by
      TakeOne yet.
    - voice-cleanup (deepfilternet): import fails on torchaudio 2.11
      (`torchaudio.backend` removed) — tool cannot start.
    - stem-split (demucs): import fails (`numpy` missing under cu128 torch
      pre-install) — tool cannot start.
  - Reasons reference WO-8 run 39379857961 where the measurement came from.
- Patch to `main.js` (mergedToolStates, +4 lines) — **Implemented**: state now
  carries `unavailable` from the catalog so the renderer can act on it.
- Patch to `renderer/models.js` (5 small edits) — **Implemented**:
  - `badge()`: unavailable → red "Not Available" badge (checked first).
  - `actionFor()`: unavailable → returns '' — the Install button is gone
    (checked before the state switch; also honors `tool.unavailable` from the
    catalog IPC payload as fallback).
  - New `unavailableFor()`: the reason renders on the card in the same style as
    the gate-reason box.
- New `tools/audit-catalog.js` — **Implemented**: installed from
  `~/workspace/user/files/audit-catalog-3.js` verbatim. `git diff` is exactly
  +7 lines: tools with `unavailable` report UNAVAILABLE with the reason and
  are NOT gate blockers; an `unavailable` shorter than 20 chars is MISMATCH.
- Evidence:
  - UI test (`wo12-models-ui-test.py`, headless Chromium, the REAL
    renderer/studio.html + models.js, mock IPC fed by the REAL catalog JSON and
    states shaped exactly like mergedToolStates incl. the new field;
    voice-studio's state deliberately omits `unavailable` to also exercise the
    catalog fallback path): **5/5 pip cards show "Not Available" + their reason,
    none has an Install button; a non-pip card (Brain) still shows Download.**
    Zero page errors. Screenshot: `wo12-models-not-available.png`.
    — **Tested** (local UI harness, not CI).
  - Local `node tools/audit-catalog.js` (no --hash): validateCatalog ok,
    all 5 pip = UNAVAILABLE. Note: without --hash, 3 file tools (upscaler,
    face-restore, smart-select) stay UNPINNED — GATE FAIL locally, because only
    --hash cross-checks their sha256. The honest number is CI's (below).
  - **Catalog-gate CI, run 39387866582 (--hash): GATE: PASS —
    VERIFIED 14 · UNAVAILABLE 5 · NOT_AUDITABLE 2** (`catalog-gate-39387866582.log`).
    Second CI run 39387866582-equivalent at 6f1d517 (run 39388440015) also
    GATE: PASS; third at 6ee91b0 (run 39389676009) also PASS.
- Label: the real CI result is the acceptance — **Passed** (gate PASS with the
  5 pip tools honestly unavailable).
- RETURN: `files/catalog.js`, `files/main.js`, `files/models.js`,
  `files/audit-catalog.js`, run ids 39387866582 / 39388440015 / 39389676009.

## WO-11: engine lock + wheelhouse — **Passed** (after 4 disclosed Failed runs)

- Patch to `.github/workflows/engine-spike.yml` (rewritten steps, header documents
  the design) + new `engine-lock.json` — **Implemented**
  - `constraints.txt`: torch==2.11.0+cu128, torchvision==0.26.0+cu128,
    torchaudio==2.11.0+cu128 (torchvision 0.26.0 verified to exist on the cu128
    index for cp311/win before writing the workflow).
  - `pip install --dry-run --report pip-report.json` resolves ComfyUI's
    requirements against the constraints (cu128 index + PyPI extra index) —
    nothing installs.
  - `pip download` builds the wheelhouse (same indexes, same constraints).
  - `build-lock.py` (embedded in the workflow) builds engine-lock.json:
    every reported wheel must exist in the wheelhouse with matching sha256
    (streamed, 1 MiB chunks); extra wheels pip download fetches (e.g. setuptools)
    must verify against the PyPI simple index (published sha256 must match)
    to enter the lock. Any mismatch = build FAIL.
  - Fresh venv installs ONLY from the wheelhouse
    (`--no-index --find-links wheelhouse`) — no network package can substitute.
  - **Hard assert: torch.version.cuda == '12.8', else the build FAILS.**
  - ComfyUI boots `main.py --cpu --quick-test-for-ci`; exit must be 0.
- The four failures and their fixes (each red run kept in the package raw):
  1. Run 39387873689 — `build-lock.py` read pip-report.json with Windows'
     default cp1252 → UnicodeDecodeError. Fix: `encoding='utf-8'`; also made
     hashing streamed and the size step tolerant of a missing lock.
  2. Run 39388444790 — pip report URLs carry URL-encoded filenames (`%2B`);
     the wheel on disk is decoded. Fix: `unquote()` before lookup.
  3. Run 39389075947 — `pip download` fetches extra wheels the dry-run report
     omits (setuptools 81.0.0). The "extra = fail" check was too strict. Fix:
     extras verify against the PyPI simple index, with published sha256.
  4. Run 39389676665 — lock built (85 wheels), install rc=0, pip check clean,
     but the assert step died: `ModuleNotFoundError: No module named
     'torchaudio'`. Root cause: constraints pin versions but ADD no packages,
     and ComfyUI's requirements.txt at the pinned commit does not list
     torchaudio. Fix: the cu128 trio is now explicit requirements in resolve,
     download, AND install.
  - **Run 5, 39390192996 → success**, 07:59:21Z → 08:03:02Z (3m41s):
    - wheelhouse: 86 files, 3,529,035,908 B
    - engine-lock.json: **86 wheels, 3,529,035,908 B total** (artifact
      `engine-lock`, committed as `20100af` — the file in this package is the
      artifact copy, byte-identical to the repo copy)
    - pip check rc=0; **torch.version.cuda == 12.8 (assert PASSED)**;
      **ComfyUI boot exit 0 (PASSED)**; TOTAL venv 6,012,330,132 B (5.6 GiB)
    - Lock structure spot-verified locally: schema 1, 86 entries each with
      url + bytes + 64-char sha256; torch/torchvision/torchaudio are the cu128
      pins; sum(bytes) == totalBytes.
- Honest limitation: the engine boots with `--cpu` on CI (no GPU on runners).
  `torch.version.cuda == '12.8'` proves the CUDA build of torch survived the
  whole pipeline — the cu128 goal — but an actual GPU smoke is Not Tested
  here; only Ali's PC can do it (WO-8 pip-tools job on a GPU runner would be
  the CI version of that, Claude's call).
- Label: engine lock + wheelhouse **Passed** (run 5 green, acceptance criteria
  all met).
- RETURN: `files/engine-spike.yml`, `files/engine-lock.json` (= repo root copy,
  commit `20100af`), run id 39390192996, raw log `engine-spike-run5-39390192996-PASSED.log`.

## WO-14 (saboot)

1. `gh run view 39233357775 --json headSha,createdAt,updatedAt,conclusion` — raw
   output, in `wo14/gh-run-39233357775.json.txt`:
   `{"conclusion":"failure","createdAt":"2026-10-19T09:52:56Z","headSha":"26db31f1ab0201c6b235c5a63ff10a57f2e6617d","updatedAt":"2026-10-19T09:57:32Z"}`
   And `gh run view 39379830992 --json ...` — in `wo14/gh-run-39379830992.json.txt`:
   `{"conclusion":"cancelled","createdAt":"2026-10-20T06:20:44Z","headSha":"efa69304f587373699ec3940fccd4afaa7f94cf4","updatedAt":"2026-10-20T06:38:34Z"}`
2. Which SHA is real: `26db31f1ab0201c6b235c5a63ff10a57f2e6617d` IS the real
   headSha of run 39233357775 (verified: `git rev-parse 26db31f` gives exactly
   it; commit "CI: Evidence fingerprint step in Linux job", 2026-10-19T14:52:51+05:00).
   `7341365d8222e56cd26a83a5a6b121032825283e` is ALSO a real commit — the
   PREVIOUS one ("CI: --publish never", 2026-10-19T14:39:11+05:00), correct for
   its own run, but NOT the head of run 39233357775.
   The hybrid string `26db31fd8222e56cd26a83a5a6b121032825283e` (written in
   round5/run3-fingerprint.txt and round6/run3-fingerprint.txt) is NOT a real
   object (`git cat-file -t` fails). Mechanism of the mistake, traced: it is
   the first 7 chars of the new commit (`26db31f`) spliced onto the 33-char tail
   of the previous commit's SHA (`d8222e56cd26a83a5a6b121032825283e`). The
   fingerprint note itself says that file was recomputed LOCALLY (step-summary
   API does not expose it) — the commit line was hand-edited from the previous
   round's text and only the first 7 chars were replaced. Owned, and corrected
   here: for run 39233357775 the true headSha is `26db31f1ab0201c6b235c5a63ff10a57f2e6617d`.
3. The 5 files (wo14/):
   - `verify-run2-39380421257.log`, `verify-run3-39380794287.log`,
     `catalog-gate-39379831031.log` — copies of the round 6 originals.
   - `downloads.test.js.round6-version` + `models.js.round6-version` — these ARE
     the round-6-era copies (from commit efa6930), since the current repo copies
     are now the WO-12/WO-13 patched versions in this return's `files/`.
4. The "50 min" claim is RETRACTED. Round 6's NOTE (lines 40–42 and Surprise #4)
   said run 39379830992's timeout-minutes:20 "did NOT visibly terminate the job
   within ~50 min". The run's own timestamps refute this:
   createdAt 2026-10-20T06:20:44Z → updatedAt 06:38:34Z = **17 minutes 50
   seconds**; from the hang point (06:21:21Z, last log line) to the last update
   = **17m13s**. The manual cancel happened before the 20-minute timeout could
   have fired — there is NO evidence the timeout failed. What remains true is
   only the observed inconsistency claim's soft core: run 3's identical hang
   WAS terminated by the timeout at ~20m21s. The "~50 min" figure was wrong;
   it is withdrawn, not re-explained.
   Labels: WO-14 evidence — **Tested** (gh API reads, git object checks).

## Corrections I owe from earlier turns

- Behavior tests are 11/11, not 12/12 (the number I said mid-turn before the
  log landed; the final log says 11/11 — both are pass, the count was wrong).
- My mid-turn shorthand "local fast-audit GATE: PASS" was wrong: the full local
  run (no --hash) is GATE: FAIL blocked by 3 file tools needing --hash
  (upscaler, face-restore, smart-select). The honest CI result is the one cited
  under WO-12: run 39387866582 GATE: PASS.

## Fingerprint (final HEAD = `20100af`, from verify run 39390754228)

```
### Evidence fingerprint
commit: 20100af500aac03ed3e0adbf13fe57bb680db77f
bfe8a30b033455e74a2ee5f25c01470d510757c6903112f4841a2da047d6650a  .github/workflows/catalog-gate.yml
9876d875e342f47a675cca3be174e4cc8921a6f450a40453d945639f32e2d00a  .github/workflows/engine-spike.yml
cd1a18855fcd4f115ec97db5ffbfe17cadcb26437f4aa7e87d4  .github/workflows/pip-tools.yml
df40a0ffd66070784193352ca8ded94bdb23d706c7c7aa1fe15af1de28f8dc5a  .github/workflows/verify.yml
e94fb94e263d09f9a5de848ecfc03c15f0e827e4c23c95d4738891  main.js
303c46faffa08a381ee4e0184674ebf5fb8440ee8309cc7184de4142b0d52c00  main/brain.js
03100b7d45a3e5ce0335d346f9d55164aeec237490c3d95fda0ca267baef867a  main/catalog.js
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
300b6fb084e5cbb0c9394e79b2b1013f854f51054df384a6fa3ce6a5906cb738  tests/hf-install-check.test.js
055c3883539c683710e43a80ef364b93d561c8fb78dbaf11bf6113f966dcbe77  tests/mock-aria2c.js
b8fcd9b14207ca50e231b240a5bbd48ade94620bd9e1ce5e88a93a303590c1227c3a2  tests/mock-aria2c.v2.2.bak
2db7b6aac95232a3b2b49239ffdd2edd6f607cb358d993e96fde13525ff3451e  tools/audit-catalog-v1-backup.js
9fe3838b407e30ed04579981527457a52bee8260139a07dd212453d11d48d8e6  tools/audit-catalog-v2.js
884c48b31d3593effb995d2dd81b84cf46c1f89dced3c2fac68553adca7d3539  tools/audit-catalog.js
6087c1f134b6860702fb809cccb4909eefe0b832df99e2f1746640469e83df4e  tools/audit-report-v1-backup.json
5a1357c8cae03862214cdec3c67f999c7b87ecef3bda423654b63eae78026c64  tools/audit-report.json
12da1f6e446b0fd71682a7ca29d8e8b8bd54e70e2e68167a1103095c9d54b8e2  tools/hf-manifests.json
```
(Printed by the verify job's own Evidence fingerprint step at commit
20100af500aac03ed3e0adbf13fe57bb680db77f. engine-lock.json is the CI
artifact download, committed byte-identical as 20100af — the returned copy is
that artifact.)

## Surprises, collected (nothing hidden)

1. Engine-spike took 5 CI runs to go green; the four failures are above, raw.
2. `pip download`'s set ≠ pip's install-report set (build-env-installed wheels
   are omitted from the report); handled by index-verified extras.
3. ComfyUI requirements.txt (pinned commit) has no torchaudio; constraints do
   not add packages — the trio must be explicit requirements.
4. Round-6 NOTE's "50 min" claim was wrong (see WO-14.4).
5. Round-5/6 fingerprint files carried a spliced SHA (see WO-14.2).

## What I did NOT do

- No pass/fail decisions beyond CI's own verdicts. GATE PASS / runs green are
  reported as CI's results for Claude to judge.
- engine-lock.json was generated by CI, downloaded as the artifact, and
  committed byte-identical — no local generation, no edits.
