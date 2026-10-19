/* TakeOne Studio — Download Manager (v3, review fixes on top of 2.2.x).
 * aria2c sidecar (JSON-RPC) with pause/resume/cancel, SHA-256 post-check,
 * one auto-retry, resume-after-restart, and honest failure states.
 *
 * Changes vs the reviewed version (each one has a test in tests/downloads.behavior.test.js):
 *  - A finished download that was interrupted before verify/move is ADOPTED on restart, never deleted.
 *  - HF multi-file jobs resume (restart, cancel+re-add, Try again) from the files already verified.
 *  - poll() cannot overlap itself; verification runs in the background and cannot run twice.
 *  - poll() can no longer resurrect a cancelled/paused entry from a stale RPC answer.
 *  - Verification fails CLOSED (unreadable file / missing hash = failure, not a pass).
 *  - Exact byte match when the catalog has exact sizeBytes (95% tolerance only for estimates).
 *  - "Try again" keeps the partial file after network failures; only a corrupt file is discarded.
 *  - downloads.json is written atomically and serialized.
 *  - Progress events carry doneBytes / totalBytes / etaSec and a real verify progress.
 * Pure helpers stay exported for unit tests; the class needs a real aria2c.
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
const IN_FLIGHT = ['downloading', 'queued', 'paused', 'verifying', 'cancelling'];

function r1(n) { return Math.round(n * 10) / 10; }
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const exists = (p) => fsp.access(p).then(() => true, () => false);
const sizeOf = (p) => fsp.stat(p).then((s) => (s.isFile() ? s.size : null), () => null);

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

/** SHA-256 of a file, streamed. `shouldAbort()` (optional) stops it early (rejects with 'aborted'). */
function sha256File(filePath, onProgress, shouldAbort) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let seen = 0, total = 0;
    try { total = fs.statSync(filePath).size; } catch { /* ignore */ }
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => {
      if (shouldAbort && shouldAbort()) { s.destroy(); reject(new Error('aborted')); return; }
      seen += c.length; hash.update(c);
      if (onProgress) onProgress(total ? seen / total : 0);
    });
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

/** Post-check: exists, non-zero, size, optional hash. `exact` = size must match exactly. Pure. */
function postCheckResult({ exists: ex, size, expectedBytes, sha256, actualSha, exact }) {
  if (!ex) return { ok: false, reason: 'The file did not arrive.' };
  if (size <= 0) return { ok: false, reason: 'The download is empty (0 bytes).' };
  if (expectedBytes && exact && size !== expectedBytes) {
    return { ok: false, reason: `Wrong size: got ${size} bytes, expected ${expectedBytes} bytes.` };
  }
  if (expectedBytes && !exact && size < expectedBytes * 0.95) {
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
  constructor({ root, aria2cPath, onEvent, diskFreeGB, pollMs }) {
    this.root = root;
    this.aria2cPath = aria2cPath;
    this.onEvent = onEvent || (() => {});
    this.diskFreeGB = diskFreeGB || (async () => null);
    this.pollMs = pollMs || POLL_MS;
    this.secret = crypto.randomBytes(16).toString('hex');
    this.rpcPort = null; // picked at start()
    this.proc = null;
    this.rpcId = 0;
    this.entries = new Map(); // toolId -> entry
    this.pollTimer = null;
    this.started = false;
    this.polling = false;
    this.stopping = false;
    this._bg = new Set();
    this._persistChain = Promise.resolve();
  }

  stagingDir() { return path.join(this.root, '.staging', 'downloads'); }
  statePath() { return path.join(this.stagingDir(), 'downloads.json'); }
  modelsDir() { return path.join(this.root, 'Models'); }
  _hfDest(e, f) { return path.join(this.modelsDir(), e.category || 'misc', e.toolId, f.path); }

  emit(type, data) { try { this.onEvent(type, data); } catch { /* never throw into poll */ } }

  /** Resolves when all background verifications have finished (used by tests and shutdown). */
  async idle() { while (this._bg.size) await Promise.all([...this._bg]); }

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
    this.stopping = false;
    await fsp.mkdir(this.stagingDir(), { recursive: true });
    this.rpcPort = await findFreePort(RPC_PORT);
    const args = [
      '--enable-rpc', `--rpc-listen-port=${this.rpcPort}`, `--rpc-secret=${this.secret}`,
      '--rpc-listen-all=false', '--daemon=false',
      `--dir=${this.stagingDir()}`,
      '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=false',
      '--auto-save-interval=10', // write resume (.aria2) data often: a crash must not cost a whole download
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
    await this.recover();            // 1) know what belongs to whom ...
    await this.cleanStaleFiles();    // 2) ... THEN remove only true orphans
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
    this._runPendingVerifies();      // 3) finished-but-unverified downloads continue; they are never re-downloaded
  }

  async stop() {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.proc && !this.proc.killed) {
      try { await this.rpc('shutdown'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 2000)); // let aria2c flush .aria2 files
      try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 1000));
      try { this.proc.kill('SIGKILL'); } catch { /* exited cleanly */ }
    }
    this.started = false;
    try { await this.idle(); } catch { /* ignore */ }
    try { await this.persist(); } catch { /* ignore */ }
  }

  /** Load persisted state; interrupted downloads become resumable, not auto-started. */
  async recover() {
    let saved = null;
    try { saved = JSON.parse(await fsp.readFile(this.statePath(), 'utf8')); } catch { /* none */ }
    if (!saved || !saved.entries) return;
    for (const [toolId, e] of Object.entries(saved.entries)) {
      if (!IN_FLIGHT.includes(e.status)) { this.entries.set(toolId, { ...e }); continue; }
      const entry = { ...e, status: 'interrupted', gid: null, busy: false };
      this.entries.set(toolId, entry);
      await this._adoptStaged(toolId, entry);
      this.emit('state', { toolId, state: entry.pendingVerify ? 'verifying' : 'interrupted' });
    }
  }

  /** A file that fully arrived but was not yet verified/moved is complete work: keep it, verify it. */
  async _adoptStaged(toolId, e) {
    const name = e.isHf ? e.currentFileName : e.fileName;
    if (!name) return;
    const p = path.join(this.stagingDir(), name);
    const size = await sizeOf(p);
    if (size === null || await exists(p + '.aria2')) return; // absent, or aria2 still has it as "in progress"
    const expected = e.isHf ? (e.files[e.currentFileIndex] || {}).bytes : e.expectedBytes;
    if (expected && size === expected) e.pendingVerify = true;
  }

  _runPendingVerifies() {
    for (const [toolId, e] of this.entries) {
      if (e.pendingVerify && e.status === 'interrupted') { e.pendingVerify = false; this._verifyInBackground(toolId, e); }
    }
  }

  /** Remove true orphans only: files in staging that no entry refers to and that have no resume data. */
  async cleanStaleFiles() {
    try {
      const dir = this.stagingDir();
      const referenced = new Set();
      for (const e of this.entries.values()) {
        if (e.fileName) referenced.add(e.fileName);
        if (e.currentFileName) referenced.add(e.currentFileName);
      }
      for (const f of await fsp.readdir(dir)) {
        if (f.endsWith('.aria2') || f === 'downloads.json' || f.startsWith('downloads.json.')) continue;
        if (referenced.has(f)) continue; // belongs to a download we know about: never delete
        const fullPath = path.join(dir, f);
        const stat = await fsp.stat(fullPath).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        if (await exists(fullPath + '.aria2')) continue;
        try { await fsp.unlink(fullPath); this.emit('cleanup', { file: f, reason: 'orphan-no-owner' }); } catch { /* ignore */ }
      }
    } catch { /* never break startup */ }
  }

  /** Atomic + serialized: a crash mid-write can never leave a half-written downloads.json. */
  persist() {
    const run = async () => {
      try {
        const entries = {};
        for (const [k, v] of this.entries) { const { gid, busy, pendingVerify, ...rest } = v; entries[k] = rest; }
        await fsp.mkdir(this.stagingDir(), { recursive: true });
        const tmp = this.statePath() + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
        await fsp.rename(tmp, this.statePath());
      } catch (err) { this.emit('persist-error', { message: String(err.message || err) }); }
    };
    this._persistChain = this._persistChain.then(run, run);
    return this._persistChain;
  }

  expectedBytes(tool) {
    return tool.sizeBytes || Math.round(tool.sizeMB * 1024 * 1024);
  }

  /** Pre-flight. Returns { ok } or { ok:false, reason, suggestion }. */
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

  /** If a partial file exists but aria2 has no resume data for it, it cannot be continued: remove just that file. */
  async _prepOut(toolId, outName) {
    const p = path.join(this.stagingDir(), outName);
    if ((await exists(p)) && !(await exists(p + '.aria2'))) {
      try { await fsp.unlink(p); this.emit('state', { toolId, state: 'note', note: 'Resume data was lost for this file — fetching it again.' }); } catch { /* ignore */ }
    }
  }

  async _failPreflight(tool, pre) {
    const entry = { toolId: tool.id, status: 'failed', error: pre.reason, suggestion: pre.suggestion, progress: 0, failKind: 'preflight' };
    this.entries.set(tool.id, entry);
    this.emit('state', { toolId: tool.id, state: 'failed', error: pre.reason, suggestion: pre.suggestion });
    await this.persist();
    return { ok: false, reason: pre.reason };
  }

  /** Add a 'file'-type tool download. Runs pre-flight first. */
  async addDownload(tool) {
    if (tool.installType !== 'file' || !tool.url) throw new Error('Only direct-file tools go through the download manager.');
    const existing = this.entries.get(tool.id);
    if (existing && ['downloading', 'queued', 'verifying'].includes(existing.status)) return { ok: false, reason: 'Already downloading.' };
    const pre = await this.preflight(tool);
    if (!pre.ok) return this._failPreflight(tool, pre);
    const outName = tool.fileName || path.basename(tool.url.split('?')[0]);
    await this._prepOut(tool.id, outName);
    const gid = await this.rpc('addUri', [[tool.url], { out: outName }]);
    const entry = {
      toolId: tool.id, gid, url: tool.url, fileName: outName,
      category: tool.category || 'misc', sha256: tool.sha256 || null,
      expectedBytes: this.expectedBytes(tool), expectedExact: !!tool.sizeBytes,
      status: 'queued', progress: 0, speedBps: 0, retries: 0,
      addedAt: new Date().toISOString(),
    };
    this.entries.set(tool.id, entry);
    this.emit('state', { toolId: tool.id, state: 'queued' });
    await this.persist();
    return { ok: true, gid };
  }

  /** HF model = multi-file job. Files download one after another via aria2:
   *  https://huggingface.co/<repo>/resolve/<commit>/<path>. Files already verified on disk are reused. */
  async addHfDownload(tool) {
    if (tool.installType !== 'hf' || !tool.files || !tool.files.length || !tool.commit) {
      throw new Error('HF tool needs files[] manifest and commit hash.');
    }
    const existing = this.entries.get(tool.id);
    if (existing && ['downloading', 'queued', 'verifying'].includes(existing.status)) return { ok: false, reason: 'Already downloading.' };
    const totalBytes = tool.files.reduce((s, f) => s + f.bytes, 0);
    const pre = await this.preflight({ ...tool, sizeBytes: totalBytes });
    if (!pre.ok) return this._failPreflight(tool, pre);
    const entry = {
      toolId: tool.id, isHf: true, repo: tool.repo, commit: tool.commit, files: tool.files, totalBytes,
      completedBytes: 0, currentFileIndex: 0, currentFileBytes: 0, gid: null,
      category: tool.category || 'misc',
      status: 'queued', progress: 0, speedBps: 0, retries: 0,
      addedAt: new Date().toISOString(),
    };
    this.entries.set(tool.id, entry);
    this.emit('state', { toolId: tool.id, state: 'queued' });
    await this.persist();
    await this._startNextHfFile(tool.id);
    return { ok: true };
  }

  /** Start (or restart) the current file of an HF job, skipping files that are already installed. */
  async _startNextHfFile(toolId) {
    const e = this.entries.get(toolId);
    if (!e || !e.isHf) return;
    if (e.status === 'cancelled' || e.status === 'paused') return;
    while (e.currentFileIndex < e.files.length) { // reuse verified files (resume after restart / cancel / retry)
      const f = e.files[e.currentFileIndex];
      if ((await sizeOf(this._hfDest(e, f))) === f.bytes) { e.completedBytes += f.bytes; e.currentFileIndex++; continue; }
      break;
    }
    if (e.currentFileIndex >= e.files.length) return this._finishHf(toolId, e);
    const f = e.files[e.currentFileIndex];
    const url = `https://huggingface.co/${e.repo}/resolve/${e.commit}/${encPath(f.path)}`;
    const outName = `hf_${toolId}_${e.currentFileIndex}_${path.basename(f.path)}`;
    await this._prepOut(toolId, outName);
    e.status = 'downloading';
    e.currentFile = f;
    e.currentFileName = outName;
    e.currentFileBytes = 0;
    e.progress = e.completedBytes / e.totalBytes;
    this.emit('state', { toolId, state: 'downloading', phase: 'downloading', fileIndex: e.currentFileIndex + 1, fileCount: e.files.length, fileName: f.path });
    const gid = await this.rpc('addUri', [[url], { out: outName }]);
    e.gid = gid;
    await this.persist();
  }

  /** Current HF file arrived: verify size + sha256, move it into place, start the next one. */
  async _completeHfFile(toolId, e) {
    const f = e.files[e.currentFileIndex];
    const filePath = path.join(this.stagingDir(), e.currentFileName);
    e.gid = null;
    e.status = 'verifying';
    this.emit('state', { toolId, state: 'verifying', phase: 'verifying', fileIndex: e.currentFileIndex + 1, fileCount: e.files.length, fileName: f.path });
    const size = await sizeOf(filePath);
    if (size !== f.bytes) return this._failHf(toolId, e, `File ${f.path}: wrong size (got ${size === null ? 0 : size}, expected ${f.bytes})`, true);
    if (f.sha256) {
      let actual = null;
      try { actual = await sha256File(filePath, this._verifyProgress(toolId, e), () => e.status === 'cancelled' || this.stopping); }
      catch (err) { if (err.message === 'aborted') return this._discardIfCancelled(e, filePath); }
      if (e.status === 'cancelled') return this._discardIfCancelled(e, filePath);
      if (!actual) return this._failHf(toolId, e, `File ${f.path}: could not be read for verification`, false);
      if (actual.toLowerCase() !== f.sha256.toLowerCase()) return this._failHf(toolId, e, `File ${f.path}: checksum mismatch (the file is corrupt)`, true);
    }
    if (e.status === 'cancelled') return this._discardIfCancelled(e, filePath);
    const dest = this._hfDest(e, f);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try { await fsp.rename(filePath, dest); } catch { await fsp.copyFile(filePath, dest); await fsp.unlink(filePath); }
    try { await fsp.unlink(filePath + '.aria2'); } catch { /* ignore */ }
    e.completedBytes += f.bytes;
    e.currentFileIndex++;
    e.currentFileBytes = 0;
    e.progress = e.completedBytes / e.totalBytes;
    this.emit('progress', { toolId, state: 'downloading', progress: e.progress, phase: 'downloading', doneBytes: e.completedBytes, totalBytes: e.totalBytes, fileIndex: Math.min(e.currentFileIndex + 1, e.files.length), fileCount: e.files.length });
    await this.persist();
    await this._startNextHfFile(toolId);
  }

  /** Only a user CANCEL discards the staged file. App shutdown leaves it for the next start to adopt. */
  async _discardIfCancelled(e, filePath) {
    if (e.status !== 'cancelled') return;
    for (const s of ['', '.aria2']) { try { await fsp.unlink(filePath + s); } catch { /* ignore */ } }
  }

  _verifyProgress(toolId, e) {
    let last = 0;
    return (p) => {
      if (p - last < 0.02 && p < 1) return;
      last = p;
      this.emit('progress', { toolId, state: 'verifying', phase: 'verifying', verifyProgress: p, progress: e.isHf ? e.progress : 1, totalBytes: e.isHf ? e.totalBytes : e.expectedBytes });
    };
  }

  async _finishHf(toolId, e) {
    e.status = 'done'; e.progress = 1; e.gid = null; e.error = null;
    this.emit('state', { toolId, state: 'done', phase: 'done' });
    await this.persist();
  }

  /** HF failure: say WHICH file and WHY. Verified files stay; only a corrupt file is discarded. */
  async _failHf(toolId, e, reason, corrupt = false) {
    e.status = 'failed'; e.error = reason; e.gid = null; e.failKind = corrupt ? 'verify' : 'network';
    if (corrupt && e.currentFileName) {
      const p = path.join(this.stagingDir(), e.currentFileName);
      for (const s of ['', '.aria2']) { try { await fsp.unlink(p + s); } catch { /* ignore */ } }
    }
    this.emit('state', { toolId, state: 'failed', error: reason, failKind: e.failKind });
    await this.persist();
  }

  async pause(toolId) {
    const e = this.entries.get(toolId);
    if (!e) return { ok: false };
    e.status = 'paused'; e.pauseHeld = true; // optimistic: the button works even if aria2c is hung
    this.emit('state', { toolId, state: 'paused' });
    await this.persist();
    if (e.gid) { try { await this.rpc('forcePause', [e.gid]); } catch { /* held locally */ } }
    return { ok: true };
  }

  async resume(toolId) {
    const e = this.entries.get(toolId);
    if (!e) return { ok: false, reason: 'Nothing to resume.' };
    if (e.status === 'done') return { ok: true };
    e.pauseHeld = false;
    if (e.isHf) {
      if (e.gid && e.status === 'paused') { await this.rpc('unpause', [e.gid]); e.status = 'downloading'; return { ok: true }; }
      e.status = 'queued'; e.error = null; e.gid = null;
      this.emit('state', { toolId, state: 'queued' });
      await this._startNextHfFile(toolId);
      return { ok: true, resumed: true };
    }
    if (e.status === 'interrupted' || !e.gid) {
      await this._prepOut(toolId, e.fileName);
      const gid = await this.rpc('addUri', [[e.url], { out: e.fileName }]);
      e.gid = gid; e.status = 'queued'; e.error = null;
      this.emit('state', { toolId, state: 'queued' });
      await this.persist();
      return { ok: true, resumed: true };
    }
    await this.rpc('unpause', [e.gid]);
    return { ok: true };
  }

  /** Cancel is instant for the user (state flips first); the partial file of THIS download is discarded.
   *  Files of an HF job that were already verified stay and are reused by the next install. */
  async cancel(toolId) {
    const e = this.entries.get(toolId);
    if (!e) return { ok: false };
    const gid = e.gid;
    e.status = 'cancelled'; e.gid = null; e.progress = 0; e.pauseHeld = false;
    this.emit('state', { toolId, state: 'cancelled' });
    await this.persist();
    if (gid) { try { await this.rpc('forceRemove', [gid]); } catch { try { await this.rpc('remove', [gid]); } catch { /* already gone */ } } }
    const partial = e.isHf ? e.currentFileName : e.fileName;
    // Ali verdict 2026-10-17: cancel = delete the ACTIVE partial only (disk freed);
    // verified HF files stay and are reused by the next install. Report freed bytes to the UI.
    let freedBytes = 0;
    if (partial) for (const s of ['', '.aria2']) {
      const p = path.join(this.stagingDir(), partial + s);
      try { freedBytes += (await fsp.stat(p)).size; } catch { /* missing — nothing freed */ }
      try { await fsp.unlink(p); } catch { /* ignore */ }
    }
    this.emit('state', { toolId, state: 'cancelled', freedBytes });
    return { ok: true, freedBytes };
  }

  /** "Try again" after a failure. Network failures continue from the partial file; only corrupt files restart. */
  async retry(toolId, tool) {
    const e = this.entries.get(toolId);
    if (!e || e.status !== 'failed') return { ok: false, reason: 'Nothing to retry.' };
    if (e.isHf) { e.status = 'queued'; e.error = null; e.retries = 0; await this._startNextHfFile(toolId); return { ok: true, resumed: true }; }
    if (e.failKind === 'verify' && e.fileName) {
      for (const s of ['', '.aria2']) { try { await fsp.unlink(path.join(this.stagingDir(), e.fileName + s)); } catch { /* ignore */ } }
    }
    this.entries.delete(toolId);
    await this.persist();
    return this.addDownload(tool);
  }

  async poll() {
    if (this.polling) return; // never overlap
    this.polling = true;
    try { await this._pollOnce(); } finally { this.polling = false; }
  }

  async _pollOnce() {
    let rpcOk = false;
    for (const [toolId, e] of this.entries) {
      if (e.busy || !e.gid || !['queued', 'downloading', 'paused'].includes(e.status)) continue;
      if (e.pauseHeld && e.status === 'paused') continue; // a user-held pause stays paused
      const gid = e.gid;
      let st;
      try { st = await this.rpc('tellStatus', [gid]); rpcOk = true; } catch { continue; }
      // The answer is stale if the user acted while we were waiting: never overwrite their action.
      if (this.entries.get(toolId) !== e || e.gid !== gid || e.status === 'cancelled' || (e.pauseHeld && e.status === 'paused')) continue;
      if (st.status === 'complete') { this._verifyInBackground(toolId, e); continue; }
      if (st.status === 'error') { await this.fail(toolId, e, st.errorMessage || st.errorCode || 'Download failed.'); continue; }
      const uiState = mapAriaStatus(st.status);
      const total = parseInt(st.totalLength || '0', 10);
      const done = parseInt(st.completedLength || '0', 10);
      const speed = parseInt(st.downloadSpeed || '0', 10);
      let progress, emitTotal, emitDone;
      if (e.isHf) {
        e.currentFileBytes = done;
        emitDone = e.completedBytes + done; emitTotal = e.totalBytes;
        progress = emitDone / emitTotal;
      } else {
        emitDone = done; emitTotal = total || e.expectedBytes;
        progress = total > 0 ? done / total : 0;
      }
      if (uiState !== e.status || Math.abs(progress - (e.progress || 0)) > 0.004) {
        e.status = uiState; e.progress = progress; e.speedBps = speed;
        this.emit('progress', {
          toolId, state: uiState, progress, speedBps: speed, totalBytes: emitTotal, doneBytes: emitDone,
          etaSec: speed > 0 ? Math.round((emitTotal - emitDone) / speed) : null, phase: 'downloading',
          ...(e.isHf ? { fileIndex: e.currentFileIndex + 1, fileCount: e.files.length, fileName: e.currentFile && e.currentFile.path } : {}),
        });
      }
    }
    // Watchdog: if ANY entry needed polling and every RPC failed, aria2c is hung.
    const needsPoll = [...this.entries.values()].some((e) => !e.busy && e.gid && ['queued', 'downloading', 'paused'].includes(e.status) && !(e.pauseHeld && e.status === 'paused'));
    if (needsPoll) {
      this.rpcFailStreak = rpcOk ? 0 : (this.rpcFailStreak || 0) + 1;
      if (this.rpcFailStreak >= 4) {
        this.rpcFailStreak = 0;
        this.emit('state', { toolId: null, state: 'daemon-restart', note: 'Download engine restarted — resuming.' });
        try { await this.restartDaemon(); } catch { /* next poll retries */ }
      }
    } else this.rpcFailStreak = 0;
  }

  /** Verification runs OUTSIDE the poll loop, once per entry. */
  _verifyInBackground(toolId, e) {
    if (e.busy) return;
    e.busy = true; e.gid = null;
    const p = (async () => {
      try { if (e.isHf) await this._completeHfFile(toolId, e); else await this.finish(toolId, e); }
      catch (err) {
        e.status = 'failed'; e.error = `The verification step crashed: ${err.message || err}`; e.failKind = 'verify';
        this.emit('state', { toolId, state: 'failed', error: e.error });
        await this.persist();
      } finally { e.busy = false; this._bg.delete(p); }
    })();
    this._bg.add(p);
  }

  /** Kill and restart aria2c. In-flight downloads resume from .aria2 files. */
  async restartDaemon() {
    if (this.restarting) return;
    this.restarting = true;
    try {
      try {
        if (this.proc) {
          this.proc.kill('SIGTERM');
          await new Promise((r) => setTimeout(r, 3000));
          try { this.proc.kill('SIGKILL'); } catch { /* exited cleanly */ }
        }
      } catch { /* already dead */ }
      this.started = false;
      for (const e of this.entries.values()) {
        if (['downloading', 'queued'].includes(e.status)) { e.status = 'queued'; e.gid = null; }
      }
      await this.persist();
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      await this.start();
    } finally {
      this.restarting = false;
      if (!this.pollTimer) this.pollTimer = setInterval(() => this.poll().catch(() => {}), this.pollMs);
    }
    for (const [toolId, e] of this.entries) {
      if (e.status === 'interrupted' && !e.pauseHeld) {
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          try { await this.resume(toolId); ok = true; } catch { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
        }
      }
    }
  }

  /** Single-file download arrived: verify (fail closed), move into the library. */
  async finish(toolId, e) {
    e.status = 'verifying'; e.gid = null;
    this.emit('state', { toolId, state: 'verifying', phase: 'verifying' });
    const filePath = path.join(this.stagingDir(), e.fileName);
    const size = await sizeOf(filePath);
    let actualSha = null;
    if (size !== null && e.sha256) {
      try { actualSha = await sha256File(filePath, this._verifyProgress(toolId, e), () => e.status === 'cancelled' || this.stopping); }
      catch (err) { if (err.message === 'aborted') return this._discardIfCancelled(e, filePath); }
      if (!actualSha) return this.fail(toolId, e, 'The file could not be read for verification.', true);
    }
    if (e.status === 'cancelled') return this._discardIfCancelled(e, filePath);
    const check = postCheckResult({ exists: size !== null, size: size || 0, expectedBytes: e.expectedBytes, exact: e.expectedExact, sha256: e.sha256, actualSha });
    if (!check.ok) return this.fail(toolId, e, check.reason, true);
    const destDir = path.join(this.modelsDir(), e.category || 'misc');
    await fsp.mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, e.fileName);
    try { await fsp.rename(filePath, dest); } catch { await fsp.copyFile(filePath, dest); await fsp.unlink(filePath); }
    try { await fsp.unlink(filePath + '.aria2'); } catch { /* ignore */ }
    e.status = 'done'; e.gid = null; e.progress = 1; e.installedPath = dest; e.error = null;
    this.emit('state', { toolId, state: 'done', path: dest });
    await this.persist();
  }

  /** One automatic retry for network errors (keeps the partial), then an honest error card. */
  async fail(toolId, e, reason, fromVerify = false) {
    if ((e.retries || 0) < 1 && !fromVerify) {
      e.retries = (e.retries || 0) + 1;
      this.emit('state', { toolId, state: 'retrying', attempt: e.retries });
      try { if (e.gid) await this.rpc('remove', [e.gid]); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        if (e.isHf) { e.gid = null; await this._startNextHfFile(toolId); }
        else {
          await this._prepOut(toolId, e.fileName);
          const gid = await this.rpc('addUri', [[e.url], { out: e.fileName }]);
          e.gid = gid; e.status = 'queued';
          this.emit('state', { toolId, state: 'queued', retried: true });
          await this.persist();
        }
        return;
      } catch { /* fall through to failed */ }
    }
    e.status = 'failed'; e.gid = null; e.failKind = fromVerify ? 'verify' : 'network';
    e.error = reason || (fromVerify ? 'Download completed but verification failed.' : 'Download failed.');
    this.emit('state', { toolId, state: 'failed', error: e.error, failKind: e.failKind });
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
