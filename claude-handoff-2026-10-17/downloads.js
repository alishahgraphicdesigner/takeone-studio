/* TakeOne Studio 2.2.0 — Phase B: Download Manager.
 * aria2c sidecar (JSON-RPC) with pause/resume/cancel, SHA-256 post-check,
 * one auto-retry, resume-after-restart, and honest failure states.
 * Pure helpers are exported for unit tests; the class needs a real aria2c.
 */
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const net = require('net');
const path = require('path');

const RPC_PORT = 16701; // preferred; a free port is picked if busy
const POLL_MS = 500;
const HEADROOM = 1.15; // download needs 15% more than its size

function r1(n) { return Math.round(n * 10) / 10; }

/** Find a free localhost port, starting at `preferred`. */
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    tryPort(preferred);
  });
}

/** SHA-256 of a file, streamed. Resolves to hex string. Pure-ish (fs only). */
function sha256File(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let seen = 0, total = 0;
    try { total = fs.statSync(filePath).size; } catch { /* ignore */ }
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => { seen += c.length; hash.update(c); if (onProgress) onProgress(total ? seen / total : 0); });
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

/** Gate 1 post-check: exists, non-zero, sane size, optional hash. Pure logic on stats. */
function postCheckResult({ exists, size, expectedBytes, sha256, actualSha }) {
  if (!exists) return { ok: false, reason: 'The file did not arrive.' };
  if (size <= 0) return { ok: false, reason: 'The download is empty (0 bytes).' };
  if (expectedBytes && size < expectedBytes * 0.95) {
    return { ok: false, reason: `Incomplete: got ${r1(size / 1048576)} MB of about ${r1(expectedBytes / 1048576)} MB.` };
  }
  if (sha256 && actualSha && sha256.toLowerCase() !== actualSha.toLowerCase()) {
    return { ok: false, reason: 'Checksum mismatch — the file is corrupt.' };
  }
  return { ok: true };
}

/** Map aria2c status → our UI state. Pure. */
function mapAriaStatus(s) {
  if (s === 'active') return 'downloading';
  if (s === 'waiting') return 'queued';
  if (s === 'paused') return 'paused';
  if (s === 'error') return 'failed';
  if (s === 'removed') return 'cancelled';
  if (s === 'complete') return 'verifying';
  return 'queued';
}

class DownloadManager {
  constructor({ root, aria2cPath, onEvent, diskFreeGB }) {
    this.root = root;
    this.aria2cPath = aria2cPath;
    this.onEvent = onEvent || (() => {});
    this.diskFreeGB = diskFreeGB || (async () => null);
    this.secret = crypto.randomBytes(16).toString('hex');
    this.rpcPort = null; // picked at start()
    this.proc = null;
    this.rpcId = 0;
    this.entries = new Map(); // toolId -> entry
    this.pollTimer = null;
    this.started = false;
  }

  stagingDir() { return path.join(this.root, '.staging', 'downloads'); }
  statePath() { return path.join(this.stagingDir(), 'downloads.json'); }
  modelsDir() { return path.join(this.root, 'Models'); }

  emit(type, data) { try { this.onEvent(type, data); } catch { /* never throw into poll */ } }

  async rpc(method, params = []) {
    // aria2c requires the "aria2." prefix on every method name.
    const m = method.startsWith('aria2.') ? method : 'aria2.' + method;
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method: m, params: [`token:${this.secret}`, ...params] });
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: this.rpcPort || RPC_PORT, path: '/jsonrpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.error) return reject(new Error(j.error.message || 'aria2c RPC error'));
            resolve(j.result);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('aria2c RPC timeout')); });
      req.end(body);
    });
  }

  async start() {
    if (this.started) return;
    await fsp.mkdir(this.stagingDir(), { recursive: true });
    this.rpcPort = await findFreePort(RPC_PORT);
    const args = [
      '--enable-rpc', `--rpc-listen-port=${this.rpcPort}`, `--rpc-secret=${this.secret}`,
      '--rpc-listen-all=false', '--daemon=false',
      `--dir=${this.stagingDir()}`,
      '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=false',
      '--max-concurrent-downloads=1', '--split=5', '--max-connection-per-server=4',
      '--min-split-size=5M', '--file-allocation=none', '--check-certificate=true',
      '--max-tries=5', '--retry-wait=10', '--connect-timeout=30', '--timeout=120',
      `--stop-with-process=${process.pid}`,
    ];
    this.proc = spawn(this.aria2cPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => this.emit('daemon-error', { message: String(e.message || e) }));
    // Wait for the RPC port to answer.
    const t0 = Date.now();
    for (;;) {
      try { await this.rpc('getGlobalStat'); break; }
      catch {
        if (Date.now() - t0 > 20000) throw new Error('The download engine did not start.');
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.started = true;
    await this.cleanStaleFiles();
    await this.recover();
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), POLL_MS);
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.proc && !this.proc.killed) {
      try { await this.rpc('shutdown'); } catch { /* ignore */ }
      // C5: Wait for aria2c to flush .aria2 files before SIGTERM.
      await new Promise((r) => setTimeout(r, 2000));
      try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 1000));
      try { this.proc.kill('SIGKILL'); } catch { /* exited cleanly */ }
    }
    this.started = false;
    // C5: Persist final state so resume works after restart.
    try { await this.persist(); } catch { /* ignore */ }
  }

  /** Load persisted state; interrupted downloads become resumable, not auto-started. */
  async recover() {
    let saved = null;
    try { saved = JSON.parse(await fsp.readFile(this.statePath(), 'utf8')); } catch { /* none */ }
    if (!saved || !saved.entries) return;
    for (const [toolId, e] of Object.entries(saved.entries)) {
      if (e.status === 'done') { this.entries.set(toolId, { ...e }); continue; }
      if (['downloading', 'queued', 'paused', 'verifying', 'cancelling'].includes(e.status)) {
        // Self-healing: any in-flight state (including stuck 'cancelling') resets to
        // 'interrupted' on startup so the user can retry. Never leave the user stuck.
        this.entries.set(toolId, { ...e, status: 'interrupted', gid: null });
        this.emit('state', { toolId, state: 'interrupted' });
      } else {
        this.entries.set(toolId, { ...e });
      }
    }
  }

  /**
   * Self-healing: remove stale download files that have no .aria2 control file.
   * These are leftovers from interrupted downloads that aria2 refuses to resume.
   * The user should never have to delete these manually.
   */
  async cleanStaleFiles() {
    try {
      const dir = this.stagingDir();
      const files = await fsp.readdir(dir);
      for (const f of files) {
        // Skip control files, state files, and directories
        if (f.endsWith('.aria2') || f === 'downloads.json') continue;
        const fullPath = path.join(dir, f);
        const stat = await fsp.stat(fullPath).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        // If there's no .aria2 control file, this is a stale leftover — remove it
        // so the next download starts clean instead of failing.
        const controlPath = fullPath + '.aria2';
        const hasControl = await fsp.access(controlPath).then(() => true).catch(() => false);
        if (!hasControl) {
          // Only clean files in the downloads staging dir, never elsewhere.
          // This is safe: these are incomplete downloads, not user data.
          try {
            await fsp.unlink(fullPath);
            this.emit('cleanup', { file: f, reason: 'stale-no-control-file' });
          } catch { /* ignore */ }
        }
      }
    } catch { /* never break startup */ }
  }

  async persist() {
    const entries = {};
    for (const [k, v] of this.entries) entries[k] = { ...v, gid: undefined };
    await fsp.writeFile(this.statePath(), JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
  }

  expectedBytes(tool) {
    return tool.sizeBytes || Math.round(tool.sizeMB * 1024 * 1024);
  }

  /** Gate 1 pre-flight. Returns { ok } or { ok:false, reason, suggestion }. */
  async preflight(tool) {
    const need = this.expectedBytes(tool) * HEADROOM;
    const freeGB = await this.diskFreeGB(this.stagingDir());
    if (freeGB === null) return { ok: true, warned: 'disk-unknown' };
    if (freeGB * 1073741824 < need) {
      return {
        ok: false,
        reason: `Not enough disk space — needs about ${r1(need / 1073741824)} GB free, this drive has ${r1(freeGB)} GB.`,
        suggestion: 'Free up space or choose a different storage folder in Settings, then try again.',
      };
    }
    return { ok: true };
  }

  /** Add a 'file'-type tool download. Runs pre-flight first. */
  async addDownload(tool) {
    if (tool.installType !== 'file' || !tool.url) throw new Error('Only direct-file tools go through the download manager.');
    const existing = this.entries.get(tool.id);
    if (existing && ['downloading', 'queued', 'verifying'].includes(existing.status)) {
      return { ok: false, reason: 'Already downloading.' };
    }
    const pre = await this.preflight(tool);
    if (!pre.ok) {
      const entry = { toolId: tool.id, status: 'failed', error: pre.reason, suggestion: pre.suggestion, progress: 0 };
      this.entries.set(tool.id, entry);
      this.emit('state', { toolId: tool.id, state: 'failed', error: pre.reason, suggestion: pre.suggestion });
      await this.persist();
      return { ok: false, reason: pre.reason };
    }
    const outName = tool.fileName || path.basename(tool.url.split('?')[0]);
    const gid = await this.rpc('addUri', [[tool.url], { out: outName }]);
    const entry = {
      toolId: tool.id, gid, url: tool.url, fileName: outName,
      category: tool.category || 'misc', sha256: tool.sha256 || null,
      expectedBytes: this.expectedBytes(tool),
      status: 'queued', progress: 0, speedBps: 0, retries: 0,
      addedAt: new Date().toISOString(),
    };
    this.entries.set(tool.id, entry);
    this.emit('state', { toolId: tool.id, state: 'queued' });
    await this.persist();
    return { ok: true, gid };
  }

  /** HF model = multi-file job. Downloads manifest files sequentially via aria2.
   *  Each file: https://huggingface.co/<repo>/resolve/<commit>/<path>
   *  Progress = (completed files bytes + current file bytes) / manifest total.
   *  Status: Implemented, syntax-checked, behavior Not Tested.
   */
  async addHfDownload(tool) {
    if (tool.installType !== 'hf' || !tool.files || !tool.files.length || !tool.commit) {
      throw new Error('HF tool needs files[] manifest and commit hash.');
    }
    const existing = this.entries.get(tool.id);
    if (existing && ['downloading', 'queued', 'verifying'].includes(existing.status)) {
      return { ok: false, reason: 'Already downloading.' };
    }
    const totalBytes = tool.files.reduce((s, f) => s + f.bytes, 0);
    const pre = await this.preflight({ ...tool, sizeBytes: totalBytes });
    if (!pre.ok) {
      const entry = { toolId: tool.id, status: 'failed', error: pre.reason, suggestion: pre.suggestion, progress: 0 };
      this.entries.set(tool.id, entry);
      this.emit('state', { toolId: tool.id, state: 'failed', error: pre.reason, suggestion: pre.suggestion });
      await this.persist();
      return { ok: false, reason: pre.reason };
    }
    const entry = {
      toolId: tool.id,
      isHf: true,
      repo: tool.repo,
      commit: tool.commit,
      files: tool.files,
      totalBytes,
      completedBytes: 0,      // bytes of fully verified files
      currentFileIndex: 0,
      currentFileBytes: 0,    // bytes downloaded of current file
      gid: null,
      category: tool.category || 'misc',
      status: 'queued', progress: 0, speedBps: 0, retries: 0,
      addedAt: new Date().toISOString(),
    };
    this.entries.set(tool.id, entry);
    this.emit('state', { toolId: tool.id, state: 'queued' });
    await this.persist();
    // Start first file
    await this._startNextHfFile(tool.id);
    return { ok: true };
  }

  /** Start downloading the next file in an HF manifest. */
  async _startNextHfFile(toolId) {
    const e = this.entries.get(toolId);
    if (!e || !e.isHf) return;
    if (e.status === 'cancelled' || e.status === 'paused') return;
    if (e.currentFileIndex >= e.files.length) {
      // All files done — verify complete
      return this._finishHf(toolId, e);
    }
    const f = e.files[e.currentFileIndex];
    const url = `https://huggingface.co/${e.repo}/resolve/${e.commit}/${f.path}`;
    const outName = `hf_${toolId}_${e.currentFileIndex}_${path.basename(f.path)}`;
    e.status = 'downloading';
    e.currentFile = f;
    e.currentFileName = outName;
    this.emit('state', {
      toolId, state: 'downloading',
      phase: 'downloading',
      fileIndex: e.currentFileIndex + 1,
      fileCount: e.files.length,
      fileName: f.path,
    });
    const gid = await this.rpc('addUri', [[url], { out: outName }]);
    e.gid = gid;
    await this.persist();
  }

  /** Called when current HF file completes. Verify sha256, move to next. */
  async _completeHfFile(toolId, e) {
    const f = e.currentFile;
    const filePath = path.join(this.stagingDir(), e.currentFileName);
    // Verify size
    let stat = null;
    try { stat = await fsp.stat(filePath); } catch { /* missing */ }
    if (!stat || stat.size !== f.bytes) {
      return this._failHf(toolId, e, `File ${f.path}: size mismatch (got ${stat ? stat.size : 0}, expected ${f.bytes})`);
    }
    // Verify sha256 if available
    if (f.sha256) {
      let actualSha = null;
      try { actualSha = await sha256File(filePath); } catch { /* unreadable */ }
      if (!actualSha || actualSha.toLowerCase() !== f.sha256.toLowerCase()) {
        return this._failHf(toolId, e, `File ${f.path}: checksum mismatch`);
      }
    }
    // Move to final destination preserving path structure
    const destDir = path.join(this.modelsDir(), e.category || 'misc', toolId);
    const dest = path.join(destDir, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try { await fsp.rename(filePath, dest); }
    catch {
      await fsp.copyFile(filePath, dest);
      await fsp.unlink(filePath);
    }
    try { await fsp.unlink(filePath + '.aria2'); } catch { /* ignore */ }
    // Update progress
    e.completedBytes += f.bytes;
    e.currentFileIndex++;
    e.currentFileBytes = 0;
    e.gid = null;
    e.progress = e.completedBytes / e.totalBytes;
    this.emit('progress', {
      toolId, state: 'downloading',
      progress: e.progress,
      phase: 'downloading',
      fileIndex: e.currentFileIndex + 1,
      fileCount: e.files.length,
    });
    await this.persist();
    // Next file
    await this._startNextHfFile(toolId);
  }

  /** All HF files downloaded and verified. */
  async _finishHf(toolId, e) {
    e.status = 'done';
    e.progress = 1;
    e.gid = null;
    this.emit('state', { toolId, state: 'done', phase: 'done' });
    await this.persist();
  }

  /** HF failure: report which file, why. Keep .part files for resume. */
  async _failHf(toolId, e, reason) {
    e.status = 'failed';
    e.error = reason;
    e.gid = null;
    // Do NOT delete partial files — user can "Try again" to resume
    this.emit('state', { toolId, state: 'failed', error: reason });
    await this.persist();
  }

  async pause(toolId) {
    const e = this.entries.get(toolId);
    if (!e) return { ok: false };
    // Optimistic: the button works even if aria2c is hung. Poll will confirm.
    e.status = 'paused'; e.pauseHeld = true;
    this.emit('state', { toolId, state: 'paused' });
    await this.persist();
    if (e.gid) { try { await this.rpc('forcePause', [e.gid]); } catch { /* held locally */ } }
    return { ok: true };
  }

  async resume(toolId) {
    const e = this.entries.get(toolId);
    if (!e) return { ok: false, reason: 'Nothing to resume.' };
    e.pauseHeld = false;
    if (e.status === 'interrupted' || !e.gid) {
      // Resume-after-restart: re-add; aria2c picks up its .aria2 control file.
      // If the .aria2 is missing but the partial file exists, aria2c will refuse
      // (allow-overwrite=false). Delete the orphan so we start fresh instead of failing.
      const outName = e.fileName;
      const filePath = path.join(this.stagingDir(), outName);
      try {
        await fsp.stat(filePath);
        try { await fsp.stat(filePath + '.aria2'); }
        catch {
          // Orphaned partial — unusable without control file. Remove it.
          await fsp.unlink(filePath);
          this.emit('state', { toolId, state: 'note', note: 'Resume data was lost — starting fresh.' });
        }
      } catch { /* no partial file, normal fresh start */ }
      const gid = await this.rpc('addUri', [[e.url], { out: outName }]);
      e.gid = gid;
      e.status = 'queued';
      this.emit('state', { toolId, state: 'queued' });
      await this.persist();
      return { ok: true, resumed: true };
    }
    await this.rpc('unpause', [e.gid]);
    return { ok: true };
  }

  async cancel(toolId) {
    const e = this.entries.get(toolId);
    if (!e) return { ok: false };
    if (e.gid) { try { await this.rpc('remove', [e.gid]); } catch { /* already gone */ } }
    // Clean partials — never leave junk behind.
    for (const suffix of ['', '.aria2']) {
      try { await fsp.unlink(path.join(this.stagingDir(), e.fileName + suffix)); } catch { /* ignore */ }
    }
    e.status = 'cancelled'; e.gid = null; e.progress = 0;
    this.emit('state', { toolId, state: 'cancelled' });
    await this.persist();
    return { ok: true };
  }

  /** Manual retry after a failure (distinct from the one automatic retry). */
  async retry(toolId, tool) {
    const e = this.entries.get(toolId);
    if (!e || e.status !== 'failed') return { ok: false, reason: 'Nothing to retry.' };
    for (const suffix of ['', '.aria2']) {
      try { await fsp.unlink(path.join(this.stagingDir(), e.fileName + suffix)); } catch { /* ignore */ }
    }
    this.entries.delete(toolId);
    await this.persist();
    return this.addDownload(tool);
  }

  async poll() {
    let rpcOk = false;
    for (const [toolId, e] of this.entries) {
      if (!e.gid || !['queued', 'downloading', 'paused', 'verifying'].includes(e.status)) continue;
      // A user-held pause stays paused — aria2c's stale word doesn't override it.
      if (e.pauseHeld && e.status === 'paused') continue;
      let st;
      try { st = await this.rpc('tellStatus', [e.gid]); rpcOk = true; }
      catch { continue; }
      // Terminal states are owned by finish()/fail() — never assign them here,
      // or a transient 'failed' would be visible before the retry/error text.
      if (st.status === 'complete') {
        if (e.isHf) { await this._completeHfFile(toolId, e); }
        else { await this.finish(toolId, e); }
        continue;
      }
      if (st.status === 'error') { await this.fail(toolId, e, st.errorMessage || st.errorCode || 'Download failed.'); continue; }
      const uiState = mapAriaStatus(st.status);
      const total = parseInt(st.totalLength || '0', 10);
      const done = parseInt(st.completedLength || '0', 10);
      const speed = parseInt(st.downloadSpeed || '0', 10);
      let progress, emitTotal;
      if (e.isHf) {
        // Combined progress: completed files + current file
        e.currentFileBytes = done;
        progress = (e.completedBytes + done) / e.totalBytes;
        emitTotal = e.totalBytes;
      } else {
        progress = total > 0 ? done / total : 0;
        emitTotal = total;
      }
      if (uiState !== e.status || Math.abs(progress - (e.progress || 0)) > 0.004) {
        e.status = uiState; e.progress = progress; e.speedBps = speed;
        this.emit('progress', {
          toolId, state: uiState, progress, speedBps: speed, totalBytes: emitTotal,
          phase: 'downloading',
          ...(e.isHf ? { fileIndex: e.currentFileIndex + 1, fileCount: e.files.length, fileName: e.currentFile?.path } : {}),
        });
      }
    }
    // Watchdog: if ANY entry needed polling and every RPC failed, aria2c is hung.
    const needsPoll = [...this.entries.values()].some((e) => e.gid && ['queued', 'downloading', 'paused', 'verifying'].includes(e.status) && !(e.pauseHeld && e.status === 'paused'));
    if (needsPoll) {
      this.rpcFailStreak = rpcOk ? 0 : (this.rpcFailStreak || 0) + 1;
      if (this.rpcFailStreak >= 4) {
        this.rpcFailStreak = 0;
        this.emit('state', { toolId: null, state: 'daemon-restart', note: 'Download engine restarted — resuming.' });
        try { await this.restartDaemon(); } catch { /* next poll retries */ }
      }
    } else this.rpcFailStreak = 0;
  }

  /** Kill and restart aria2c. In-flight downloads resume from .aria2 files. */
  async restartDaemon() {
    if (this.restarting) return; // prevent re-entrant watchdog fires
    this.restarting = true;
    try {
      try {
        if (this.proc) {
          this.proc.kill('SIGTERM'); // let aria2c save .aria2 resume state
          await new Promise((r) => setTimeout(r, 3000));
          try { this.proc.kill('SIGKILL'); } catch { /* exited cleanly */ }
        }
      } catch { /* already dead */ }
      this.started = false;
      // Mark in-flight entries as queued — recover() re-adds them on start.
      for (const e of this.entries.values()) {
        if (['downloading', 'queued'].includes(e.status)) { e.status = 'queued'; e.gid = null; }
      }
      await this.persist();
      await this.start();
    } finally {
      this.restarting = false;
      // C2: Guarantee the poll timer is alive. If start() threw, re-arm it
      // so the watchdog isn't permanently dead.
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => this.poll().catch(() => {}), this.pollMs || 2000);
      }
    }
    // Auto-resume what was in flight — the user never asked to stop.
    // Retry with backoff: aria2c may not be ready on the first attempt.
    for (const [toolId, e] of this.entries) {
      if (e.status === 'interrupted' && !e.pauseHeld) {
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          try { await this.resume(toolId); ok = true; }
          catch { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
        }
        // Still failing after retries — stays resumable, user can hit Resume.
      }
    }
  }

  async finish(toolId, e) {
    e.status = 'verifying';
    this.emit('state', { toolId, state: 'verifying' });
    const filePath = path.join(this.stagingDir(), e.fileName);
    let stat = null;
    try { stat = await fsp.stat(filePath); } catch { /* missing */ }
    let actualSha = null;
    if (stat && e.sha256) {
      this.emit('progress', { toolId, state: 'verifying', progress: 1, verifying: true });
      try { actualSha = await sha256File(filePath); } catch { /* unreadable */ }
    }
    const check = postCheckResult({
      exists: !!stat, size: stat ? stat.size : 0,
      expectedBytes: e.expectedBytes, sha256: e.sha256, actualSha,
    });
    if (!check.ok) return this.fail(toolId, e, check.reason, true);
    // Move into the Library — deterministic, verified.
    const destDir = path.join(this.modelsDir(), e.category || 'misc');
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, e.fileName);
    try { await fsp.rename(filePath, dest); }
    catch {
      await fsp.copyFile(filePath, dest);
      await fsp.unlink(filePath);
    }
    try { await fsp.unlink(filePath + '.aria2'); } catch { /* ignore */ }
    e.status = 'done'; e.gid = null; e.progress = 1; e.installedPath = dest;
    this.emit('state', { toolId, state: 'done', path: dest });
    await this.persist();
  }

  /** One automatic retry, then an honest error card. */
  async fail(toolId, e, reason, fromVerify = false) {
    if ((e.retries || 0) < 1 && !fromVerify) {
      e.retries = (e.retries || 0) + 1;
      this.emit('state', { toolId, state: 'retrying', attempt: e.retries });
      try { if (e.gid) await this.rpc('remove', [e.gid]); } catch { /* ignore */ }
      // NEVER delete the partial file. Re-add the URI with --continue=true
      // and let aria2c resume from whatever exists. Deleting progress is
      // what caused "Try again" to start from zero — a betrayal after 93%.
      // aria2c will start fresh on its own if resume is truly impossible.
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const gid = await this.rpc('addUri', [[e.url], { out: e.fileName }]);
        e.gid = gid; e.status = 'queued';
        this.emit('state', { toolId, state: 'queued', retried: true });
        await this.persist();
        return;
      } catch { /* fall through to failed */ }
    }
    // Verify failure: NEVER silently delete and restart. The user just watched
    // 100% complete — silently restarting is a betrayal. Show what happened.
    if (fromVerify) {
      e.status = 'failed';
      e.error = reason || 'Download completed but verification failed.';
      e.gid = null;
      // Keep the file for inspection — do NOT delete. The user decides.
      this.emit('state', { toolId, state: 'failed', error: e.error });
      await this.persist();
      return;
    }
    e.status = 'failed'; e.error = reason; e.gid = null;
    this.emit('state', { toolId, state: 'failed', error: reason });
    await this.persist();
  }

  getState(toolId) { return this.entries.get(toolId) || null; }
  allStates() {
    const o = {};
    for (const [k, v] of this.entries) o[k] = { ...v };
    return o;
  }
}

module.exports = { DownloadManager, sha256File, postCheckResult, mapAriaStatus, RPC_PORT };
