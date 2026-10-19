# Install Queue System — Deep Audit
**Date:** 2026-10-16
**Scope:** `main.js` (depInstall, depCancel, queueInstall, installQueueDepth, installCancels, installCancelled), `main/deps.js` (pipInstall, hfSnapshot, runPython, parsePipProgress)
**Method:** Full code-path tracing. Assumed adversarial conditions: user cancels at worst moment, network fails mid-install, process hangs.

---

## Critical (queue can deadlock or cancel is lost)

### C1. Cancellation is silently dropped during prep phases — user waits up to 30 min
**File:** `main/deps.js` lines 62–99

`pipInstall(root, pkg, onProgress, onCancel)` passes `onCancel` to the main pip `runPython` (line 69) but **not** to `ensurePip()` (line 63). `ensurePip` calls `runPython` without `onCancel`, so during the ensurepip phase (up to 120s timeout) the cancel button does nothing visible — the UI already flipped the card to `not-installed` (depCancel line 1034-1036) while pip keeps running in the background.

`hfSnapshot` is worse. It passes `onCancel` to the final snapshot `runPython` (line 99) but **not** to:
- `ensurePip()` (line 78)
- the `import huggingface_hub` probe (line 80, 30s timeout, no onCancel)
- the `huggingface_hub` pip install (lines 83–86, **default 30-minute timeout, no onCancel**)

If the user cancels during the `huggingface_hub` helper install, nothing happens for up to 30 minutes. The queue is blocked the entire time. The card says `not-installed` but the process is still running and holding the queue slot.

**Why it matters:** This is exactly the "I cancelled everything and the new install is still stuck" complaint. The queue head is occupied by a zombie the user cannot kill.

**Fix:** Thread `onCancel` through every `runPython` call in `pipInstall` and `hfSnapshot`, including `ensurePip`, the hub probe, and the hub install. Alternatively, make `runPython` accept an `AbortSignal`-style token created once per install and shared across all phases.

---

### C2. `installQueueDepth` drifts if `setToolStatus` throws between increment and queue
**File:** `main.js` lines 984–989

```js
installQueueDepth++;
await setToolStatus(r, toolId, { status: 'queued', ... });  // if this throws…
return queueInstall(async () => { ... });                    // …never reached
```

`setToolStatus` is mostly safe (disk write has `.catch`), but the in-memory merge and `JSON.stringify(snapshot)` can throw on pathological input. If it throws, `depInstall` rejects, the depth stays incremented forever, and no queued fn ever decrements it. Every such failure permanently inflates the counter by 1.

**Why it matters:** The counter is already known-drifty (user saw "Waiting for 17"). This is another drift source that `Math.max(0, …)` cannot fix because it only drifts upward.

**Fix:** Move `installQueueDepth++` to after the `await setToolStatus`, or wrap in try/finally:
```js
installQueueDepth++;
try {
  await setToolStatus(...);
} catch { installQueueDepth = Math.max(0, installQueueDepth - 1); throw; }
```

---

### C3. Stale `installCancelled` entry can eat the depth count of a *new* install
**File:** `main.js` lines 989–993

Scenario:
1. Tool A queued (depth=1). User cancels A → `installCancelled.add('A')`, card → `not-installed`.
2. User immediately clicks Install on A again → `depInstall` → depth=2, status → `queued`, fn2 chained behind fn1.
3. fn1 runs, sees `installCancelled.has('A')`, deletes it, does `depth--` (depth=1), returns `cancelled`.
4. fn2 runs, `installCancelled` no longer has 'A', proceeds to install. Its `finally` does `depth--` → depth=0. Correct final value, but step 3 decremented the count that logically belonged to fn2's queue entry.

The counter is display-only so the blast radius is small, but under rapid cancel/re-install cycles the number shown ("Queued — N ahead") is meaningless. Combined with C2, the counter cannot be trusted.

**Why it matters:** The user already distrusts the queue numbers. Any inaccuracy reinforces "yeh app jhoot bolta hai."

**Fix:** Replace the integer counter with a real queue-position tracker: keep an ordered array of queued toolIds, derive position from index. Or drop the counter entirely (already done for the label) and ensure no logic depends on it.

---

### C4. `depCancel` reports success even when the kill didn't happen yet (race window)
**File:** `main.js` lines 996–1001 (after the 2026-10-15 cancel-race fix)

The fix added `cancelRequested` so a cancel arriving before `runPython` registers `cancelFn` will fire when `onCancel` is eventually called. This closes the *lost* cancel, but there is still a window:

1. `installCancels[toolId]` is assigned (line 999).
2. `pipInstall` → `ensurePip` → `runPython` (no onCancel — see C1).
3. User cancels → `cancelRequested = true`, `cancelFn` is null → nothing happens.
4. `ensurePip` takes up to 120s. During this time the card says `not-installed` but the queue slot is held.
5. Only when the *main* pip phase starts does `onCancel` fire the deferred kill.

So the cancel is *deferred*, not *lost* — but the user experience is "I pressed Cancel, nothing happened for 2 minutes." Combined with C1 (30-min hub install), the deferral can be 30 minutes.

**Why it matters:** Deferred cancel == stuck queue from the user's perspective.

**Fix:** Same as C1 — every phase must be cancellable. Additionally, `depCancel` should return whether the kill actually executed vs. was deferred, so the UI can say "Cancelling…" honestly instead of flipping to `not-installed` immediately.

---

### C5. Card flips to `not-installed` while the install is still running (state lie)
**File:** `main.js` lines 1033–1036

```js
if (st[toolId] && (st[toolId].status === 'queued' || st[toolId].status === 'installing')) {
  await setToolStatus(r, toolId, { status: 'not-installed', detail: null, error: null });
}
```

`depCancel` sets the card to `not-installed` *optimistically*, before the kill is confirmed. If the kill is deferred (C4) or the process ignores SIGTERM, the card says "not installed" while pip is still running and still holding the queue. If the user then clicks Install again, a second queue entry is created behind the zombie. When the zombie eventually finishes (or times out), it writes `installed`/`failed` status, clobbering whatever the new entry did.

**Why it matters:** State lies compound. The user sees "not installed," clicks Install, and now two installs for the same tool are in flight sequentially — the second may fail because the first partially installed.

**Fix:** Introduce a `cancelling` status. Card shows "Cancelling…" until the queued fn actually settles, then transitions to `not-installed`. Only allow re-install after the settle.

---

## High (broken UX, data risk, or long hangs)

### H1. `hfSnapshot` progress is fake — UI shows 0% for the entire multi-GB download
**File:** `main/deps.js` lines 90–99, `main.js` lines 956–965

The snapshot Python snippet prints nothing until `SNAPSHOT_OK`. `parsePipProgress` returns `null` for every chunk, so `depProgress` writes `fraction: null`. The renderer computes `Math.round((0 || 0) * 100)` → **0% for the entire download**, which for a 5GB model can be 30+ minutes. The user sees a 0% progress bar and "Downloading…" with no movement — indistinguishable from frozen.

`pipInstall` is slightly better (pip prints `%` in its progress bar) but pip buffers output and the regex only matches chunks containing a literal `%`. During "Collecting" and "Building wheels" phases there are no percentages — again 0% for minutes.

**Why it matters:** The user's #1 complaint pattern is "atka hua hai" (it's stuck). A 0% bar for 30 minutes *is* "stuck" from their perspective, even when it's working.

**Fix:** For `hfSnapshot`, use `tqdm`-style progress via `huggingface_hub`'s `tqdm` integration or poll `destDir` size vs. expected size. At minimum, report bytes-written-so-far as a fraction of the repo's known total size (fetch via Hub API before downloading). For pip, also surface the *current line* (e.g. "Collecting torch…") as the `note` so the UI can show *what* it's doing even when no percentage exists.

---

### H2. `runPython` `child.kill()` may not kill pip's children on Windows
**File:** `main/deps.js` line 30

```js
if (onCancel) onCancel(() => { try { child.kill(); } catch { } done({ ok: false, code: -4, error: 'Cancelled.' }); });
```

On Windows, `child.kill()` terminates the direct child (python.exe) but pip spawns setuptools/wheel subprocesses that can survive. The orphaned grandchildren keep writing to site-packages. Worse, `done()` resolves immediately with `code: -4` while grandchildren are still mutating the environment. The queue advances and the next install starts pip while the orphan is still writing — the exact concurrent-pip corruption the queue exists to prevent.

Additionally, if `child.kill()` fails to terminate (pip ignoring SIGTERM on Windows is rare but possible with `--no-input` hangs), `child.on('close')` never fires — but `done()` was already called, so the promise resolved. The process leaks.

**Why it matters:** Silent environment corruption. The next install may fail with bizarre errors ("file in use", half-written metadata) that look like new bugs.

**Fix:** On Windows, kill the process *tree*: `spawn('taskkill', ['/pid', child.pid, '/T', '/F'])`. Wait for `close` (with a short grace timeout) before resolving the cancel, so the queue doesn't advance into a still-dying process.

---

### H3. No cleanup of partial pip installs — env can be left inconsistent
**File:** `main/deps.js` lines 62–74

If pip is killed mid-install (cancel or timeout), site-packages may contain:
- partially extracted files,
- a `.dist-info` without the package files (or vice versa),
- a half-written `__pycache__`.

There is no `pip uninstall -y <pkg>` or verification on the next attempt. The next `pip install` will usually repair it, but not always — a half-written `.dist-info/RECORD` causes pip to believe the package is installed when files are missing, leading to `ImportError` at runtime that the "Verify" button may or may not catch.

`hfSnapshot` has the same shape: cancelled mid-download leaves partial files in `destDir`. `snapshot_download` on retry *usually* resumes, but a torn write of a large `.bin` can fail hash checks repeatedly.

**Why it matters:** "Install succeeded but tool doesn't work" is the hardest class of bug for the user to report and for us to diagnose.

**Fix:** On cancel/timeout/failure, run a best-effort cleanup: `pip uninstall -y <pkg>` for pip installs; for hf, delete files that fail size/hash check before retry (or wipe `destDir` and start over — models are re-downloadable, correctness beats resume).

---

### H4. Timeout error messages are generic — user can't tell *why* it failed
**File:** `main/deps.js` lines 70, 100

```js
if (!r.ok) return { ok: false, error: 'Installation did not finish. Check your connection and try again.' };
```

`runPython` distinguishes codes: `-1` (python missing), `-2` (timeout), `-3` (spawn error), `-4` (cancelled), non-zero exit. `pipInstall`/`hfSnapshot` collapse everything except `-4` into one generic string. A 30-minute timeout, a DNS failure, disk-full, and "package not found" all produce the identical message. The user retries a timeout the same way they'd retry a typo'd package name — blindly.

**Why it matters:** The user cannot self-triage. Every failure becomes a support conversation.

**Fix:** Map codes to specific messages:
- `-1`: "The Python environment isn't ready. Restart the app and try again."
- `-2`: "It took longer than 30 minutes — your connection may be slow. Try again when the network is better."
- non-zero exit: include the last few lines of pip's stderr (pip's own error, e.g. "No matching distribution", "Disk full") — pip's errors are actually informative.

---

### H5. `parsePipProgress` matches the *wrong* percentage
**File:** `main/deps.js` lines 39–45

```js
const m = chunk.match(/(\d+)%/);
if (m) return Math.min(1, parseInt(m[1], 10) / 100);
```

pip output contains percentages that are *not* overall progress: `"Downloading torch-2.0.0 (123.4 MB)"` followed by a progress bar, but also lines like `"100% |██████████| 5.2/5.2 MB"` for a *single small file* while the overall install is at 5%. The regex takes the first `%` in the chunk, so the bar jumps to 100% when a tiny dependency finishes downloading, then drops back. The progress bar visibly *goes backwards*.

**Why it matters:** A progress bar that jumps to 100% then falls to 12% looks broken and destroys trust in every other progress indicator.

**Fix:** Only treat a percentage as progress if it comes from pip's carriage-return progress bar line (starts with `\r` or contains `|██`), or track the *maximum* seen and never report a decrease. Better: parse pip's `--progress-bar=raw` format if available, or use `pip install --report` for structured output.

---

### H6. `hfSnapshot` has no timeout on the helper pip install (30-min default) and no size guard
**File:** `main/deps.js` lines 83–86

The `huggingface_hub` install uses the default 30-minute timeout — far too long for a ~50MB helper. More importantly, there is no check that `destDir` has enough free space *before* downloading a multi-GB model. `diskFreeGB` exists in the download manager but is not consulted here. A 5GB model on a disk with 2GB free will download for 20 minutes then fail with a generic error.

**Why it matters:** 20 minutes of user time wasted on a failure that was predictable in 1 second.

**Fix:** Pass an explicit short timeout (5 min) for the helper install. Before `snapshot_download`, query the repo size via the Hub API (`list_repo_files` + sizes, or `model_info`) and compare against `diskFreeGB`. Refuse early with "Not enough disk space — need X GB, have Y GB."

---

## Medium (correctness gaps, edge cases)

### M1. Double-install of the same tool creates two queue entries
**File:** `main.js` lines 978–989

Nothing prevents `depInstall` being called twice for the same `toolId` (double-click, or click Install on card + click "get it" in Studio). Both increment depth, both queue, both run sequentially. The second install is redundant but harmless — except it doubles the wait and the UI shows two identical rows.

**Fix:** At the top of `depInstall`, check current status: if `installing` or `queued`, return `{ ok: false, reason: 'already-queued' }` so the UI can say "Already in the queue" instead of adding a duplicate.

---

### M2. `installCancels[toolId]` can be clobbered by a concurrent same-tool install
**File:** `main.js` lines 997–999

If two installs for the same toolId are queued (see M1), the second fn overwrites `installCancels[toolId]` when it starts. The first fn's `finally` does `delete installCancels[toolId]`, removing the second fn's cancel handle. Cancelling the second install then does nothing (falls to the `installCancelled` set path only if status is still `queued`, which it isn't — it's `installing`).

**Fix:** Key `installCancels` by a per-run token, not toolId. Or fix M1 so this can't happen.

---

### M3. `depProgress` sends IPC even when the window is gone — and `setToolStatus` write queue can grow unbounded
**File:** `main.js` lines 956–966

`depProgress` calls `setToolStatus` on every pip output chunk (pip can emit dozens per second). Each call appends to `toolStatusWriteQ` and does a full `JSON.stringify` + `writeFile` of the entire status file. During a long install this is hundreds of disk writes of a growing JSON file. The `.catch(() => {})` on the write chain means a failing disk fills the queue silently.

Not a deadlock, but it's wasteful and a slow disk will make the write queue lag behind reality — the status file on disk can be minutes stale, which matters for the boot-recovery logic (line 732) after a crash.

**Fix:** Throttle `depProgress` disk writes (e.g. at most 1/sec; in-memory cache is already fresh). Coalesce: only enqueue a write if the previous one completed.

---

### M4. Boot recovery doesn't verify partial pip installs
**File:** `main.js` lines 732–744

On boot, `installing`/`queued` → `not-installed`. Correct — no pip survives restart. But if the app *crashed* mid-pip-install (not a clean cancel), site-packages may be half-written (see H3). The tool shows `not-installed`, user clicks Install, pip says "Requirement already satisfied" (because `.dist-info` exists), and the tool is marked `installed` while actually broken.

**Fix:** After boot-reset, for any tool that was `installing` at crash time, run `pip show <pkg>` / import check before trusting a fresh `pip install`'s "already satisfied". Or always `pip install --force-reinstall` after a crash-interrupted install.

---

### M5. `ensurePip` failure message is misleading
**File:** `main/deps.js` lines 51–60

```js
if (!prep.ok) return { ok: false, error: 'Could not prepare the installer.' };
```

If `ensurepip` fails (e.g. bundled Python is corrupt), the user gets "Could not prepare the installer" with no action. They'll retry forever. This is likely unrecoverable without re-running the Python bootstrap.

**Fix:** Specific message: "The Python environment needs repair. Restart the app — it will set Python up again." And actually trigger `ensurePython` on next boot if this flag is set.

---

### M6. `hfSnapshot` repo/dir injection is safe but the error path leaks the dest path
**File:** `main/deps.js` lines 91–96

`JSON.stringify(repo)` and `JSON.stringify(destDir)` — injection-safe. But on failure, `res.error` is generic (H4), so no leak in practice. Noting for completeness: if H4 is fixed by including stderr, ensure the absolute `destDir` (which contains the Windows username) is redacted before display — the codebase already masks usernames elsewhere.

---

### M7. No guard against starting an install when Python isn't ready
**File:** `main.js` lines 978–989, `main/deps.js` line 26

`depInstall` doesn't check `pythonExe` exists before queueing. The queued fn runs, `pipInstall` → `ensurePip` → `pipWorks` → `runPython` resolves `{code: -1}` immediately. Harmless but the user waited through the queue for an instant failure. If the queue is long, that's a long wait for "Python is not ready yet."

**Fix:** In `depInstall`, before queueing, `fs.existsSync(pythonExe(r))` — if missing, return `{ok: false, reason: 'python-not-ready'}` immediately so the UI can say "Still setting up — try again in a minute" without queueing.

---

## Low (polish, observability)

### L1. `installQueue` chain has no observability
**File:** `main.js` lines 972–976

If the queue ever *does* wedge (e.g. a future code change introduces a non-settling promise), there is no logging, no watchdog, no way to diagnose. `slog` exists in main.js — the queue should log enqueue/dequeue/settle with timestamps.

**Fix:** Add `slog` lines in `queueInstall`, on fn settle, and on cancel. Add a watchdog: if the head fn hasn't settled in 2× its timeout, log loudly.

### L2. `parsePipProgress` is untested for real pip output shapes
There are unit tests (`test/unit.test.js` — 98 pass) but `parsePipProgress`'s contract with real pip output (progress bars with `\r`, `--no-input` mode, non-ASCII) isn't covered by a fixture test with captured pip output.

**Fix:** Add a fixture test with real `pip install` stderr captures (small package) asserting monotonic-ish fractions.

### L3. Magic timeout numbers with no rationale
`30*60*1000` (pip), `6*60*60*1000` (hf), `120000` (ensurepip), `30000` (probes) — no comments explaining why. The next person to touch these can't tell which are load-bearing.

**Fix:** Named constants with one-line rationale each.

---

## Summary table

| ID | Severity | What | User-visible symptom |
|----|----------|------|----------------------|
| C1 | Critical | Cancel dropped during prep phases (up to 30 min) | "Cancel doesn't work, queue stuck" |
| C2 | Critical | Depth drifts on setToolStatus throw | Wrong queue numbers forever |
| C3 | Critical | Stale cancelled entry eats new install's count | Queue numbers lie after cancel+retry |
| C4 | Critical | Cancel deferred (not lost) during ensurePip | "Pressed Cancel, nothing happened" |
| C5 | Critical | Card lies: not-installed while still running | Double-install, clobbered state |
| H1 | High | HF progress always 0% | "It's frozen" (it's not) |
| H2 | High | child.kill() orphans pip grandchildren | Env corruption, mystery failures |
| H3 | High | No cleanup of partial installs | "Installed but doesn't work" |
| H4 | High | All errors → one generic string | User can't self-triage |
| H5 | High | Progress bar goes backwards | "The app is lying to me" |
| H6 | High | No disk-space check before GB downloads | 20-min doomed download |
| M1–M7 | Medium | Duplicate queue entries, clobbered cancel handles, write spam, crash-recovery trust, misleading messages, no pre-flight Python check | Various confusion |
| L1–L3 | Low | No queue observability, untested parser, magic numbers | Maintainer pain |

## The single most important fix

**C1 + C4 + C5 together are the "queue is stuck" bug the user keeps hitting.** The through-line: *cancellation is not a first-class operation*. It's bolted onto `runPython` as an optional callback that three of the five Python invocations don't receive, the UI lies about the state transition, and the queue has no way to force-advance past a zombie head.

The robust fix is a per-install `AbortController`-style token created in the queued fn, passed to *every* `runPython` call in that install's lifetime, with `runPython` racing the child against the abort signal and doing a process-*tree* kill on Windows. `depCancel` sets the token, flips the card to `cancelling` (not `not-installed`), and the queued fn's settle path — which already exists and already decrements — does the final state transition. No new state machine, just making the existing one honest.
