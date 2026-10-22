# Round-13 return — WO-34, WO-35 (2026-10-22)

Labels: Implemented / Tested / Passed / Failed / Not Tested.
I decide no pass/fail — only raw evidence. Full files + raw logs in this zip.

## Commits
- 7156657 — WO-34 (version 2.2.11) + WO-35 (async nvidia-smi)
- 48ab2fd — WO-34: docs/VERSIONS.md + version-uniqueness check (CI)
- 5ea1810 — WO-34: record 2.2.11 build in docs/VERSIONS.md (HEAD)

## WO-34 — Implemented + Tested
package.json 2.2.10 → 2.2.11 (unique version per build).
docs/VERSIONS.md (new): one line per build — version, commit, exe sha256, CI run.
Both 2.2.10 builds recorded, sha256 CI-computed, never by hand:
- 2.2.10 @ 35db3825b42e6718b1be6610a8725b6fdedb05c9 → ae536efc…7c184a6dc, run 39710499911 (round 11; temp hash-artifact workflow downloaded the CI artifact and hashed it in CI — the workflow was deleted after use)
- 2.2.10 @ c2104927cc137567fcfc7c625eaa967716cb16f5 → a520273d…13cca3f6, run 39739633597 (round 12; from the CI-built SHA256.txt)
- 2.2.11 @ 48ab2fd0e0ba3eb15b974aeebf4ec0bdfe036991 → 8580b22b…8503a3, run 39742914169 (this round; artifact "TakeOne-Studio-2.2.11-run4", 120,831,113 bytes)
Uniqueness enforced: tools/check-version-unique.js fails (exit 1) if package.json's
version already exists in VERSIONS.md with a different commit sha — wired as the first
step of build-installer.yml, so CI fails the build. Tests: test/version-unique.test.js
3/3 (new version passes, same sha passes, different sha fails with "Bump the version").
Also fixed in passing: my first VERSIONS.md draft had a hand-typed (wrong) sha for
48ab2fd — caught and corrected to the real `git rev-parse` value before committing.

## WO-35 — Implemented + Tested
nvidia-smi is now async (promisified execFile) with a hard 5 s timeout enforced by
Promise.race — not just execFile's own timeout option, so it holds even if the exec
implementation hangs. buildDiagnosticsReport is async; the takeone:diagnostics IPC
handler awaits it. The UI thread can never block on a missing/hung nvidia-smi.
Tests: test/diagnostics.test.js — "missing nvidia-smi" (rejects at once → report fast,
'no NVIDIA GPU detected'), "hung nvidia-smi" (fake hangs forever → report still arrives
in ~5 s AND a 100 ms timer fires promptly, proving the event loop was never blocked),
"working nvidia-smi" (name + driver parsed). 13/13 diagnostics tests pass.
Full suite 150/150 green locally. CI: verify 39743297684 SUCCESS,
catalog-gate 39743297689 SUCCESS.

## Decisions I made (Claude review karega)
1. The temp hash-artifact workflow was deleted after one use (it existed only to get
   the round-11 sha256 from CI). Alternative: keep it — rejected (single-purpose
   machinery, lean rule).
2. The 2.2.11 .exe is NOT in this zip (WO-33's "full file" requirement was fulfilled
   for 2.2.10 in round 12; WO-34 only asks for the named artifact + VERSIONS.md).
   The artifact "TakeOne-Studio-2.2.11-run4" is downloadable from CI run 39742914169.
3. Uniqueness check lives in build-installer.yml (not verify.yml): it guards builds,
   and VERSIONS.md is the builds ledger.

## What I did NOT do
- tools/audit-catalog.js untouched. No GitHub release. No version beyond 2.2.11.

Fingerprint (HEAD 5ea1810b72b73ec10b4ce52180e33193658d1dc2, CI Evidence step,
verify 39743297684 — full block in logs/verify-39743297684-SUCCESS.log):
392807f18ceedea24251a6b536ffc7c637362fb0c90c00f4bbffa71f00bdd290  main/diagnostics.js
70873f9f0cbf08b4ccf16e63d3d8a64ec457fd37fa7c5acc5242c0c7e9ce81dc  tools/check-version-unique.js
4231795f3caafd847fb2c09995ab11c712168e8fe33da1849c02297bfc04b611  .github/workflows/build-installer.yml
691ba65e33459f2034d42332ed299d97c29136bc033a4131a62d614338f3dde3  package.json
