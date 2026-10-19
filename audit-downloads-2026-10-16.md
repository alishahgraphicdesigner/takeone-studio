# Download Engine Deep Audit — 2026-10-16

**Scope:** `main/downloads.js` (DownloadManager, 438 lines) + aria2c-related code in `main.js`
**Method:** Full line-by-line read of both files. No fixes applied — findings only.
**Assumption:** User has unstable network; every edge case WILL be hit.

---

## CRITICAL (data loss / permanent deadlock / user-visible breakage)

### C1. Auto-retry DELETES 90% progress on transient failure
**File:** `main/downloads.js`, lines 381–401 (`fail()`)

```js
async fail(toolId, e, reason, fromVerify = false) {
  if ((e.retries || 0) < 1 && !fromVerify) {
    e.retries = (e.retries || 0) + 1;
    ...
    for (const suffix of ['', '.aria2']) {
      try { await fsp.unlink(path.join(this.stagingDir(), e.fileName + suffix)); } catch { /* ignore */ }
    }
    // ... re-adds from zero
```

**What's wrong:** When a download fails (e.g., server resets connection at 90%), the ONE automatic retry deletes BOTH the partial file AND the `.aria2` control file, then restarts from 0%.

**Why it matters:** On an unstable network, transient failures are common. A 5 GB file failing at 90% loses 4.5 GB of progress and restarts from zero. The user watches the same 90% download repeatedly. This is the single most user-hostile behavior in the engine.

**Fix:** Don't delete on retry. Re-add the URI and let aria2c resume from the existing `.aria2`/partial. Only delete if the specific error indicates corruption (e.g., checksum mismatch after verify, or the "control file does not exist" orphan case). Distinguish "transient network error → resume" from "corrupt state → restart fresh."

---

### C2. Watchdog death: if `restartDaemon()` → `start()` throws, polling never resumes
**File:** `main/downloads.js`, lines 307–327 (`poll()` + `restartDaemon()`)

```js
// poll():
if (this.rpcFailStreak >= 4) {
  this.rpcFailStreak = 0;
  ...
  try { await this.restartDaemon(); } catch { /* next poll retries */ }
}

// restartDaemon():
this.started = false;
clearInterval(this.pollTimer);   // <-- timer killed here
// ...
await this.persist();
await this.start();              // <-- if THIS throws...
// pollTimer is never re-created; no further poll() runs; watchdog is dead
```

**What's wrong:** `restartDaemon()` clears the poll timer BEFORE calling `this.start()`. If `start()` throws (aria2c binary missing/corrupt, port exhaustion, permission denied on staging dir), the catch in `poll()` swallows the error with the comment "next poll retries" — but there IS no next poll, because the timer was cleared and never restarted.

**Why it matters:** The entire download subsystem becomes permanently dead with zero user-visible error. Downloads sit at their last progress forever. "Try again" / "Resume" buttons call `resume()` → `rpc('addUri')` → fails (no aria2c) → error. The only recovery is app restart. On an unstable network where the watchdog fires often, this is a matter of time.

**Fix:** Wrap the restart in try/finally that guarantees the poll timer is re-armed. Or: don't clear the timer until `start()` succeeds; use a `restarting` flag to prevent re-entrant watchdog fires instead of killing the timer.

---

### C3. `getDLM()` caches a rejected promise forever after `start()` failure
**File:** `main.js`, lines 577–596 (`getDLM()`)

```js
async function getDLM(root) {
  if (dlm && dlmRoot === root) return dlm;
  if (dlmStarting) return dlmStarting;   // <-- returns stale rejection
  dlmStarting = (async () => {
    ...
    await mgr.start();                    // <-- if this throws, dlmStarting stays rejected
    dlm = mgr; dlmRoot = root; dlmStarting = null;
    return mgr;
  })();
  return dlmStarting;
}
```

**What's wrong:** If `mgr.start()` throws (e.g., "The download engine did not start." after 20s), `dlmStarting` remains a rejected promise. Every subsequent `getDLM()` call hits `if (dlmStarting) return dlmStarting` and returns the SAME rejection. The IPC handlers (`dlStart`, `dlPause`, etc.) catch it and return `{ ok: false, reason }`, so every download button fails permanently.

**Why it matters:** A single transient startup failure (slow disk, antivirus scanning aria2c.exe on first launch) permanently disables all downloads until the user restarts the entire app. The error message gives no hint that a restart is needed.

**Fix:** Reset `dlmStarting = null` in a `catch`/`finally` inside the IIFE, so the next call retries fresh.

---

### C4. `before-quit` doesn't await `dlm.stop()` — shutdown is fire-and-forget
**File:** `main.js`, line 1290

```js
app.on('before-quit', () => { if (dlm) { dlm.stop().catch(() => {}); } });
```

**What's wrong:** `before-quit` handlers CAN be async if you call `event.preventDefault()` and re-quit later, but this one just fires the promise and returns. Electron may terminate the process before `stop()` finishes its `rpc('shutdown')` + `proc.kill()` sequence.

**Why it matters:** aria2c may be killed mid-write while flushing `.aria2` control files, producing corrupt resume state (feeds into C5 / Issue 2.3). Also, if `--stop-with-process` doesn't work reliably on Windows (unverified), an orphaned aria2c keeps running, holding the RPC port and file locks. Next app launch picks a different port via `findFreePort`, spawns a SECOND aria2c, and both fight over the same staging files.

**Fix:** Use the proper async quit pattern: `event.preventDefault()`, `await dlm.stop()`, then `app.quit()`. Verify `--stop-with-process` actually works on Windows; if not, track the PID and kill orphans on startup.

---

### C5. `stop()` doesn't wait for graceful shutdown, doesn't persist final state
**File:** `main/downloads.js`, lines 150–159

```js
async stop() {
  if (this.pollTimer) clearInterval(this.pollTimer);
  this.pollTimer = null;
  if (this.proc && !this.proc.killed) {
    try { await this.rpc('shutdown'); } catch { /* ignore */ }
    this.proc.kill();   // <-- immediate SIGTERM, no wait for .aria2 flush
  }
  this.started = false;  // <-- no persist() call; in-memory progress lost
}
```

**What's wrong:** Two problems: (1) After `rpc('shutdown')`, we immediately `proc.kill()` without waiting for the process to exit. aria2c's `shutdown` is graceful but not instantaneous — it needs time to flush `.aria2` files. The immediate kill can interrupt this. (Contrast `restartDaemon()` which waits 3s after SIGTERM.) (2) `stop()` never calls `persist()`, so the last in-memory progress (e.g., 47%) is lost; `downloads.json` has whatever was last persisted (e.g., 30%).

**Why it matters:** Corrupt/incomplete `.aria2` files cause resume failures on next launch ("control file" errors, silent 0% restarts). The progress jump (47% → 30% in UI) is confusing but not data loss — aria2c resumes from the real `.aria2`, not our JSON.

**Fix:** After `rpc('shutdown')`, wait for `proc` 'exit' event with a timeout (e.g., 5s), then `kill()` only if still alive. Call `await this.persist()` before shutdown.

---

## HIGH (broken resume, stuck states, misleading UI)

### H1. `addDownload()` doesn't handle orphaned partials — "Download" button can fail immediately
**File:** `main/downloads.js`, lines 205–230 (`addDownload()`)

The orphan-cleanup fix exists in `resume()` (lines ~247–260) but NOT in `addDownload()`. If a previous attempt left `file.gguf` without `file.gguf.aria2` (crash, failed retry cleanup, manual interference), clicking "Download" calls `rpc('addUri')` directly → aria2c refuses (`--allow-overwrite=false`) → immediate FAILED card with the cryptic "control file does not exist" message.

**Fix:** Extract the orphan check into a helper and call it from both `resume()` and `addDownload()` before `addUri`.

---

### H2. Paused downloads keep a stale `gid` across watchdog restarts → Resume silently fails
**File:** `main/downloads.js`, lines 333–337 (`restartDaemon()`)

```js
for (const e of this.entries.values()) {
  if (['downloading', 'queued'].includes(e.status)) { e.status = 'queued'; e.gid = null; }
}
```

**What's wrong:** Entries with `status === 'paused'` (and `pauseHeld === true`) are NOT reset. Their `gid` refers to a download in the OLD, now-dead aria2c process. When the user later clicks Resume:

```js
// resume():
e.pauseHeld = false;
if (e.status === 'interrupted' || !e.gid) { ... re-add ... }
await this.rpc('unpause', [e.gid]);   // <-- gid is dead → "No such download" RPC error
```

The RPC error propagates to the IPC handler → user sees an error, download stays stuck as "paused" with a dead gid. Clicking Resume again repeats the failure.

**Fix:** In `restartDaemon()`, also null out `gid` for paused entries (keep `status: 'paused'` and `pauseHeld: true`). In `resume()`, treat "paused with dead/null gid" as needing re-add: change the condition to `if (e.status === 'interrupted' || !e.gid)` — it already handles `!e.gid`, so just ensuring gid is nulled on restart fixes it.

---

### H3. `persist()` is not atomic — crash mid-write loses ALL download state
**File:** `main/downloads.js`, lines 182–186

```js
async persist() {
  const entries = {};
  for (const [k, v] of this.entries) entries[k] = { ...v, gid: undefined };
  await fsp.writeFile(this.statePath(), JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
}
```

**What's wrong:** Direct `writeFile` to `downloads.json`. If the app crashes / power loss occurs mid-write, the file contains truncated JSON. On next launch, `recover()` does `JSON.parse` → throws → caught → `saved` is null → `recover()` returns early. ALL download state is lost: the app doesn't know about any in-progress downloads. The `.aria2` files and partials remain in staging as orphans (see H6 — no startup sweep).

**Why it matters:** User had 3 downloads at 60%/40%/20%. After a crash, Models page shows "not installed" for all three. The partial files sit in `.staging/downloads/` wasting gigabytes. Clicking Download starts from 0% (and may hit the orphan problem in H1).

**Fix:** Write to `downloads.json.tmp` then `fsp.rename()` (atomic on same filesystem). On `recover()`, if main file is corrupt, try a `.bak` copy.

---

### H4. No `proc.on('exit')` handler — unexpected aria2c death detected only via 2s RPC timeout
**File:** `main/downloads.js`, `start()` (lines 139–148)

`this.proc.on('error', ...)` is registered (spawn failure), but there is no `this.proc.on('exit', ...)` / `on('close', ...)`. If aria2c is killed externally (Task Manager, OOM, antivirus quarantine), detection relies on the poll loop's `rpcFailStreak >= 4` (4 × 500ms = 2s of failed RPCs). During those 2s, every `tellStatus` fails and `poll()` silently `continue`s. Not fatal, but a 2s blind window where Pause/Cancel clicks go into the void (their RPCs also fail silently — `pause()` catches and relies on "optimistic" local state, which is fine, but `cancel()`'s `rpc('remove')` fails silently leaving the gid dangling).

**Fix:** Add `proc.on('exit', (code, signal) => ...)` that immediately emits a `daemon-dead` event and triggers `restartDaemon()` (with re-entrancy guard, see H5) instead of waiting for the RPC streak.

---

### H5. No re-entrancy guard on `restartDaemon()` if triggered from multiple paths
**File:** `main/downloads.js`, lines 307–327

Currently `restartDaemon()` is only called from `poll()`'s watchdog, and the poll timer is cleared first, so re-entrancy can't happen TODAY. But if H4's fix adds an `on('exit')` trigger, or if a future "Restart engine" button is added, two concurrent `restartDaemon()` calls would: both SIGTERM the same proc, both call `start()` (double `findFreePort`, double spawn — port race), both run `recover()`, both run the retry loops. The second `start()` would find the port taken by the first and pick another — two aria2c processes, split-brain on the same staging dir.

**Fix:** Add `this.restarting` boolean guard: `if (this.restarting) return; this.restarting = true; try { ... } finally { this.restarting = false; }`.

---

### H6. No startup sweep for orphaned staging files — disk space leaks silently
**File:** `main/downloads.js`, `recover()` / `start()`

If `downloads.json` is lost/corrupt (H3), or entries were deleted without cleaning files (`retry()` deletes entry then `addDownload()` — if `addDownload()` throws after delete but before add, files are already gone, fine), or the user manually deleted `downloads.json`, the staging dir accumulates `.gguf` / `.aria2` files no entry references. Nothing ever deletes them. A 5 GB orphan is invisible in the UI (Models page shows "not installed", disk meter doesn't break out staging usage).

**Fix:** On `start()`, list staging dir files; delete any `*.aria2` whose base file has no entry AND any base file with no entry and no `.aria2` (true orphans). Log what was cleaned. Alternatively, surface "X GB of leftover partials" in the UI with a "Clean up" button.

---

### H7. Progress is 0% when server omits Content-Length — looks permanently stuck
**File:** `main/downloads.js`, lines 296–299 (`poll()`)

```js
const total = parseInt(st.totalLength || '0', 10);
const done = parseInt(st.completedLength || '0', 10);
const progress = total > 0 ? done / total : 0;
```

If the server doesn't send `Content-Length` (chunked transfer, some CDNs), `totalLength` is 0 → progress stays 0 → UI shows "0%" indefinitely while megabytes flow. The user (already burned by 90%→0%) sees 0% and assumes it's broken, hits Cancel, loses real progress.

**Fix:** When `total === 0` but `done > 0`, report an indeterminate state: emit `progress: null` / `totalBytes: 0` and let the UI show "↓ 340 MB downloaded" (bytes-so-far) instead of "0%". aria2c also reports `completedLength` — use it.

---

## MEDIUM (incorrect behavior, poor errors, wasted work)

### M1. `fail()` retry path: `addUri` failure after delete falls through correctly, but the fromVerify path doesn't catch
**File:** `main/downloads.js`, lines 381–418

The non-verify retry wraps `rpc('addUri')` in try/catch ("fall through to failed"). The `fromVerify` retry path (lines ~404–416) does NOT wrap it:

```js
if (fromVerify && (e.retries || 0) < 1) {
  ...
  const gid = await this.rpc('addUri', [[e.url], { out: e.fileName }]);  // <-- uncaught
```

If aria2c died between the unlink and the re-add, this throws out of `fail()`, which was called from `poll()`'s `if (st.status === 'error')` branch — `poll()` has `.catch(() => {})` on the interval, so it's swallowed, but `e.status` was never set to 'failed' (it's still whatever it was, likely 'verifying' or the aria2 'error' wasn't mapped). The entry is now in limbo: not failed, not queued, gid possibly stale.

**Fix:** Wrap in try/catch and fall through to the `failed` assignment like the other path.

---

### M2. Raw aria2c `errorMessage` shown to users — often cryptic, sometimes misleading
**File:** `main/downloads.js`, line 294

```js
if (st.status === 'error') { await this.fail(toolId, e, st.errorMessage || st.errorCode || 'Download failed.'); continue; }
```

Examples of raw aria2c messages users have seen: the "control file(*.aria2) does not exist... add --allow-overwrite=true" wall of text (mentions a CLI flag the user can't set — it's baked into our spawn args). Others: "Failed to open file", "Connection timed out", "The response status is not successful". None say what the USER should do.

**Fix:** Map known aria2c error substrings to plain-words + action: "control file" → "Resume data was lost. [Start fresh]"; "timed out" → "Connection timed out — check your internet and Try again"; 404 → "The file isn't on the server anymore (link may have moved)". Keep the raw message in a collapsible "Details".

---

### M3. `preflight()` doesn't account for in-progress downloads — disk can fill mid-download
**File:** `main/downloads.js`, lines 192–203

```js
async preflight(tool) {
  const need = this.expectedBytes(tool) * HEADROOM;
  const freeGB = await this.diskFreeGB(this.stagingDir());
  ...
  if (freeGB * 1073741824 < need) { return { ok: false, ... }; }
```

Only the NEW download's size is checked. With 3 concurrent 5 GB downloads, the second and third each check "5 GB × 1.15 < free" independently — 15 GB total can exceed free space even though each check passed. Mid-download disk-full produces an aria2c "Failed to open file" error (see M2), not a clear "disk full" message.

**Fix:** Sum `expectedBytes × (1 - progress)` over active entries and require `free > sum + need × HEADROOM`. Also handle the disk-full error string explicitly in `fail()`.

---

### M4. `finish()` — cross-device `rename` fallback can leave duplicates; `.aria2` deleted only on success path
**File:** `main/downloads.js`, lines 358–378

```js
try { await fsp.rename(filePath, dest); }
catch {
  await fsp.copyFile(filePath, dest);
  await fsp.unlink(filePath);   // <-- if THIS throws, both copies exist
}
try { await fsp.unlink(filePath + '.aria2'); } catch { /* ignore */ }
```

If `unlink(filePath)` fails after a successful copy (AV lock, permission), both staging and Models copies exist — 5 GB wasted, and the staging copy becomes an orphan (H6). Also, if `rename`/`copyFile` throws (disk full at destination), the error propagates out of `finish()` → caught by `poll()`'s `.catch(() => {})` → entry stuck at 'verifying' forever with no FAILED card and no retry.

**Fix:** Wrap the move in try/catch → `fail(toolId, e, 'Could not move the finished file — disk may be full.')`. Verify `dest` exists and size matches before unlinking source.

---

### M5. `sha256File` reads entire file even when `e.sha256` is null — no, actually it doesn't. But: verification has no progress for large files
**File:** `main/downloads.js`, lines 348–354

```js
if (stat && e.sha256) {
  this.emit('progress', { toolId, state: 'verifying', progress: 1, verifying: true });
  try { actualSha = await sha256File(filePath); } catch { /* unreadable */ }
}
```

`sha256File` accepts an `onProgress` callback, but `finish()` doesn't pass one — it emits a single `progress: 1, verifying: true` then goes silent for the (potentially minutes-long) hash of a 5 GB file. UI shows "Checking…" with no movement. Also, if the file is unreadable, `actualSha` stays null → `postCheckResult` skips the hash comparison (`sha256 && actualSha && ...`) → a corrupt file PASSES verification as long as size looks right.

**Fix:** Pass `onProgress` to update the UI during hashing. If hash was expected but couldn't be computed, treat as verification failure with "couldn't read the file" rather than silently skipping.

---

### M6. `expectedBytes()` trusts catalog metadata; `postCheckResult` 95% threshold can pass a truncated file
**File:** `main/downloads.js`, lines 188–190 and 56–68

```js
expectedBytes(tool) { return tool.sizeBytes || Math.round(tool.sizeMB * 1024 * 1024); }
// postCheckResult:
if (expectedBytes && size < expectedBytes * 0.95) { return { ok: false, ... }; }
```

If the catalog's `sizeMB` is wrong (stale metadata, server now serves a larger file), a 94%-complete download of the REAL file could be rejected, or a truncated file could pass. More importantly: when the server reports a real `totalLength` via aria2c, we ignore it in favor of catalog metadata. The ground truth should be `max(catalog, aria2c totalLength)` once known.

**Fix:** In `finish()`, prefer the aria2c-reported total (`e.totalBytes` captured during poll) over catalog metadata when available.

---

### M7. Poll emits progress only when delta > 0.4% OR state is downloading — the `|| uiState === 'downloading'` makes the delta check dead code
**File:** `main/downloads.js`, lines 301–304

```js
if (uiState !== e.status || Math.abs(progress - (e.progress || 0)) > 0.004 || uiState === 'downloading') {
```

The third condition (`uiState === 'downloading'`) is true for every poll tick of an active download, so progress events fire every 500ms regardless of the 0.4% delta. That's 2 events/sec × 3 downloads = 6 IPC events/sec to the renderer, each triggering `refreshStates()` (throttled to 800ms in the renderer, but the IPC traffic and main-process work remain). Minor perf issue; the delta check was presumably meant to reduce traffic.

**Fix:** Remove `|| uiState === 'downloading'` or replace with a time-based throttle (emit at most 2/sec).

---

### M8. `cancel()` sets status 'cancelled' but `mergedToolStates` has no 'cancelled' branch
**File:** `main/downloads.js` line 274; `main.js` lines 634–644

`cancel()` sets `e.status = 'cancelled'` and persists it. But `mergedToolStates()` in main.js:

```js
else if (dl) {
  state = dl.status; progress = dl.progress || 0; ...
```

It passes `dl.status` through directly, so 'cancelled' reaches the renderer. Whether the renderer handles 'cancelled' is outside this audit's scope, but: on next app start, `recover()` sees status 'cancelled' → falls to `else { this.entries.set(toolId, { ...e }); }` → kept as 'cancelled' forever. It's never cleaned up (H6's sweep should include terminal 'cancelled'/'failed' entries older than X).

**Fix:** Either map 'cancelled' → treat as clean slate on recover (delete the entry), or document the renderer's handling.

---

## LOW (robustness, minor UX)

### L1. `findFreePort` has no upper bound — port scan can run away
**File:** `main/downloads.js`, lines 26–36. If ports 16701–16750 are all taken (unlikely but possible in a test/CI environment), it recurses indefinitely. Add a cap (e.g., try 20 ports, then throw).

### L2. RPC `timeout: 10000` with no retry — a single slow RPC counts toward the watchdog streak
**File:** `main/downloads.js`, lines 104–126. `tellStatus` during heavy disk I/O can exceed 10s → counts as a failure → 4 of these in a row (possible on a thrashing disk) triggers a spurious daemon restart, interrupting healthy downloads.

### L3. `--max-tries=5 --retry-wait=10` inside aria2c can mask failures the app should surface
aria2c will internally retry a failed connection 5 times with 10s waits (up to ~50s of silence) before reporting 'error'. During this, `downloadSpeed` is 0 and the UI shows "0% · stalled?" — the user may hit Cancel during aria2c's internal retry, not knowing it's already retrying. Consider `--max-tries=2` and letting the app's own retry logic (C1-fixed to resume, not restart) own the retry policy.

### L4. `--min-split-size=5M` with `--split=10` on small files
For a 50 MB file, 10 splits × 5 MB min = fine. For files < 50 MB, aria2c silently uses fewer connections — no bug, just noting the effective concurrency is lower than configured for small files.

### L5. `resume()` re-add uses only `{ out: outName }` — drops per-download options
The initial `addDownload()` also passes only `{ out }`, so they're consistent. But neither passes `--continue=true` explicitly per-download (it's a global flag, so fine). No bug.

### L6. `checkOnline()` DNS probe is unused by the download manager
**File:** `main.js`, lines 653–659. There's a `checkOnline()` helper (DNS lookup of huggingface.co) but `DownloadManager` never consults it. When offline, downloads fail with aria2c connection errors instead of the friendly offline banner the Models page shows. The engine could pre-check and set a clear "You're offline" state instead of burning the auto-retry (C1) on a doomed attempt.

### L7. `secret` is generated per DownloadManager instance but never rotated
Fine for localhost RPC. Noted for completeness — no action needed.

### L8. `POLL_MS = 500` — half-second polling of 3 downloads is chatty but acceptable
Each `tellStatus` is a localhost HTTP round-trip; ~6 req/sec total. Fine on modern hardware.

---

## Summary table

| ID | Severity | One-line description |
|----|----------|----------------------|
| C1 | Critical | Auto-retry deletes 90% partial and restarts from 0 on transient failure |
| C2 | Critical | Watchdog `restartDaemon()` failure kills poll timer permanently — silent dead engine |
| C3 | Critical | `getDLM()` caches rejected promise — all downloads broken until app restart |
| C4 | Critical | `before-quit` doesn't await `stop()` — corrupt `.aria2`, orphaned aria2c |
| C5 | High | `stop()` kills aria2c without waiting for `.aria2` flush; doesn't persist |
| H1 | High | `addDownload()` lacks orphan-partial check that `resume()` has |
| H2 | High | Paused downloads keep dead `gid` across watchdog restart — Resume fails |
| H3 | High | `persist()` not atomic — crash mid-write loses all download state |
| H4 | High | No `proc.on('exit')` — external kill detected only after 2s blind window |
| H5 | High | No re-entrancy guard on `restartDaemon()` (needed if H4 fixed) |
| H6 | High | No startup sweep — orphaned staging files leak disk silently |
| H7 | High | Unknown Content-Length → permanent "0%" display while data flows |
| M1 | Medium | `fromVerify` retry path missing try/catch around `addUri` |
| M2 | Medium | Raw aria2c errors shown to users (e.g., `--allow-overwrite` CLI jargon) |
| M3 | Medium | `preflight()` ignores in-progress downloads — disk can fill mid-download |
| M4 | Medium | `finish()` move failure leaves entry stuck at 'verifying' forever |
| M5 | Medium | SHA-256 gives no progress; unreadable file silently skips hash check |
| M6 | Medium | Catalog size trusted over aria2c's actual totalLength |
| M7 | Medium | Progress-emit delta check is dead code (`\|\| downloading` always true) |
| M8 | Medium | 'cancelled' status never cleaned from persisted state |
| L1–L8 | Low | Port scan unbounded, RPC timeout feeds watchdog, aria2c internal retries mask app retry, etc. |

## Recommended fix order (by user pain)

1. **C1** — resume, don't restart, on transient failure (the 90% nightmare).
2. **C3** — reset `dlmStarting` on failure (one bad launch shouldn't brick downloads).
3. **C2** — guarantee poll timer survives a failed restart (no silent dead engine).
4. **H2** — null dead gids on watchdog restart (Resume must work after engine restart).
5. **H1** — orphan check in `addDownload()` (Download button must not instant-fail).
6. **H3** — atomic `persist()` (crash shouldn't wipe download state).
7. **C4+C5** — proper async shutdown with `.aria2` flush wait.
8. **M2** — map aria2c errors to plain-words + actions.
9. **H7** — bytes-so-far display when total size unknown.
10. **M3** — preflight sums in-progress downloads.
