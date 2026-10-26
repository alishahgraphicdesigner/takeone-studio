/**
 * ComfyUI Process Manager for TakeOne Studio.
 *
 * Manages the ComfyUI backend as a child process:
 * - Starts ComfyUI on a local port (default 8188)
 * - Health checks via /system_stats
 * - Graceful shutdown
 * - API client for queueing prompts and fetching results
 *
 * This is Phase D (real generation). Untested on Windows GPU — the user
 * will test on their RTX 5070 Ti.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');

const COMFY_PORT = 8188;
const START_TIMEOUT_MS = 300000; // 5 min: CPU boot on a slow CI runner (torch import alone can take minutes)

/** WO-41: the plain message when ComfyUI cannot see the Image Studio model. */
const MODEL_NOT_VISIBLE_MSG = "Image Studio's model isn't visible to the engine. Open Models and tap Check again.";
const VIDEO_NOT_VISIBLE_MSG = "Video Studio's model isn't visible to the engine. Check the Video panel — the model may still be downloading, or the merged model file may be missing.";

/** WO-43: PNG magic bytes (89 50 4E 47 0D 0A 1A 0A) — a /view reply that is
 *  not a PNG (an error page, a redirect target) must never be saved as one. */
function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
}

/** App-log line sink: main.js defines global.__takeoneLog; plain-node use (e2e/tests) has none. */
function logToApp(line) {
  try { if (global.__takeoneLog) global.__takeoneLog(line); } catch { /* logging never breaks boot */ }
}

/**
 * WO-41: pure ComfyUI argv builder (unit-testable — no spawn, no side effects).
 * helpOut is `main.py --help` output ('' when unknown). --disable-api-nodes is
 * only added when main.py --help actually lists it (ComfyUI versions differ).
 * --extra-model-paths-config is what makes ComfyUI see <root>/Models/image:
 * without it, CheckpointLoaderSimple only sees ComfyUI/models/checkpoints
 * (empty on a fresh TakeOne install) and every generate fails with
 * "Value not in list: ckpt_name ... not in []". Always binds 127.0.0.1.
 */
function buildComfyArgs({ mainPy, port, cpu, modelPathsConfig, helpOut }) {
  const args = [mainPy, '--port', String(port), '--listen', '127.0.0.1', '--disable-auto-launch'];
  if (cpu) args.push('--cpu');
  if (modelPathsConfig) args.push('--extra-model-paths-config', modelPathsConfig);
  if (helpOut && helpOut.includes('--disable-api-nodes')) args.push('--disable-api-nodes');
  return args;
}

/**
 * WO-41: map a ComfyUI /prompt failure to plain words. NEVER returns raw JSON:
 * the renderer shows only `plain`; the full body goes to the app log via the
 * caller's rawError handling (see queuePrompt + main.js comfyGenerate).
 * A ckpt_name "Value not in list" error maps to MODEL_NOT_VISIBLE_MSG.
 */
function mapComfyError(status, body) {
  const raw = String(body || '');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* not JSON — generic message below */ }
  const nodeErrors = parsed && parsed.node_errors;
  if (nodeErrors && typeof nodeErrors === 'object') {
    const entries = Object.entries(nodeErrors);
    for (const [, ne] of entries) {
      const errs = (ne && ne.errors) || [];
      for (const er of errs) {
        const text = String(((er && er.message) || '') + ' ' + ((er && er.details) || ''));
        if (/ckpt_name/i.test(text)) {
          return { plain: MODEL_NOT_VISIBLE_MSG, modelNotVisible: true };
        }
        // M2: a video loader naming a file ComfyUI cannot see (merged
        // diffusion file, VAE, or text encoder) is the video equivalent
        // of the WO-41 checkpoint bug — plain words, never raw JSON.
        if (/unet_name|clip_name|vae_name/i.test(text)) {
          return { plain: VIDEO_NOT_VISIBLE_MSG, modelNotVisible: true };
        }
      }
    }
    for (const [id, ne] of entries) {
      const errs = (ne && ne.errors) || [];
      if (errs.length) {
        const m = String(errs[0].message || errs[0].details || 'failed').replace(/\s+/g, ' ').trim();
        return { plain: `ComfyUI couldn't run this prompt (node ${id}: ${m}).`, modelNotVisible: false };
      }
    }
  }
  if (parsed && parsed.error && parsed.error.message) {
    return { plain: `ComfyUI couldn't run this prompt: ${String(parsed.error.message).replace(/\s+/g, ' ').trim()}`, modelNotVisible: false };
  }
  return { plain: `ComfyUI returned an error (HTTP ${status || 'unknown'}). Try again — if it repeats, check the engine log in Diagnostics.`, modelNotVisible: false };
}

/**
 * WO-41: the ONE way the app and e2e-image.js start ComfyUI. Resolves the
 * engine venv python + ComfyUI dir (legacy shipped-python fallback when the
 * venv python is missing — the WO-23 fallback getComfy used), and always
 * enables the extra_model_paths write so start() passes the config flag.
 * Callers still call mgr.start() themselves (port picking + ready polling).
 */
function createEngineComfy({ root, cpu, onEvent }) {
  const engine = require('./engine.js');
  let pythonExe, comfyDir;
  try {
    pythonExe = engine.venvPython(root);
    comfyDir = engine.comfyDir(root);
    if (!fs.existsSync(pythonExe)) throw new Error('venv python missing');
  } catch {
    const { pythonExe: legacyPythonExe } = require('./deps.js');
    pythonExe = legacyPythonExe(root);
    comfyDir = path.join(root, 'ComfyUI');
  }
  return new ComfyManager({ root, pythonExe, comfyDir, cpu: !!cpu, modelPaths: true, onEvent });
}

/**
 * M2.5: split a byte stream into COMPLETE log lines. ComfyUI's stderr
 * arrives as arbitrary data chunks (block-buffered when piped — a chunk
 * can hold many lines or half of one), and the old handler forwarded
 * each chunk trimmed + sliced to 200 chars as if it were a line: any
 * log line past char 200 of its chunk was silently LOST from both the
 * event stream and the diagnostics file (this is what ate the
 * text_encoders extra-path line on CI, twice). Buffering restores whole
 * lines; the caller keeps the trailing partial for the next chunk.
 * Pure — unit-tested in test/m2.test.js.
 */
function splitLogLines(buffer, chunk) {
  const text = buffer + String(chunk);
  const parts = text.split('\n');
  const rest = parts.pop();
  const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines, rest };
}

class ComfyManager {
  constructor({ root, pythonExe, comfyDir, onEvent, cpu, modelPaths }) {
    this.root = root;
    this.pythonExe = pythonExe;
    this.comfyDir = comfyDir;
    this.onEvent = onEvent || (() => {});
    this.cpu = !!cpu; // e2e CI has no NVIDIA GPU — ComfyUI must boot with --cpu
    this.modelPaths = !!modelPaths; // WO-41: write extra_model_paths.yaml + pass --extra-model-paths-config
    this.modelPathsConfig = null;
    this.proc = null;
    this.port = COMFY_PORT;
    this.ready = false;
  }

  /** WO-41: (re)write extra_model_paths.yaml idempotently, every start. Returns the config path or null. */
  async _ensureModelPaths() {
    if (!this.modelPaths) return null;
    try {
      const engine = require('./engine.js');
      await fsp.mkdir(engine.engineRoot(this.root), { recursive: true });
      await engine.writeModelPaths(this.root);
      const cfg = engine.modelPathsFile(this.root);
      await fsp.access(cfg);
      return cfg;
    } catch (e) {
      this.onEvent('log', { line: 'extra_model_paths.yaml not written: ' + String(e && e.message || e) });
      return null;
    }
  }

  /** Start ComfyUI. Resolves when /system_stats responds. */
  async start() {
    if (this.proc && this.ready) return { ok: true, already: true };

    const mainPy = path.join(this.comfyDir, 'main.py');
    if (!fs.existsSync(mainPy)) {
      return { ok: false, error: 'ComfyUI not found. Install it from the Models page first.' };
    }
    if (!fs.existsSync(this.pythonExe)) {
      return { ok: false, error: 'Python is not ready yet.' };
    }

    return new Promise((resolve) => {
      const done0 = (r) => resolve(r);
      this._pickPort().then(async (port) => {
        this.port = port;
        // WO-41: yaml first (idempotent), then argv — the config flag is
        // what makes ComfyUI print "Adding extra search path checkpoints
        // <root>\Models\image" at boot. Without it, generation fails.
        this.modelPathsConfig = await this._ensureModelPaths();
        this._comfyArgs(mainPy).then((args) => {
          const argvLine = 'ComfyUI argv: ' + [this.pythonExe, ...args].join(' ');
          logToApp(argvLine);
          this.onEvent('log', { line: argvLine });
          try { require('./diagnostics.js').appendComfyLog(this.root, argvLine); } catch {}
          this.proc = spawn(this.pythonExe, args, {
            cwd: this.comfyDir,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          this._wireProc(done0);
        }).catch((e) => done0({ ok: false, error: `Could not start ComfyUI: ${e.message}` }));
      }).catch((e) => done0({ ok: false, error: `Could not find a free port for ComfyUI: ${e.message}` }));
    });
  }

  /** Amendment 8: pick a free port (8188 first, then scan up). */
  async _pickPort() {
    const net = require('net');
    for (let p = COMFY_PORT; p < COMFY_PORT + 20; p++) {
      const free = await new Promise((res) => {
        const s = net.createServer();
        s.once('error', () => res(false));
        s.once('listening', () => s.close(() => res(true)));
        s.listen(p, '127.0.0.1');
      });
      if (free) return p;
    }
    throw new Error('no free port in 8188-8207');
  }

  /**
   * Amendment 8: build the ComfyUI argv via buildComfyArgs (pure, tested).
   * --disable-api-nodes is only added when main.py --help actually lists it
   * (ComfyUI versions differ); the --help output is appended to the ComfyUI
   * log so the choice is auditable. NOTE (WO-42, P2, not this WO):
   * --disable-api-nodes is deprecated upstream in favour of --offline /
   * --disable-partner-nodes — that switch is parked for WO-42.
   */
  async _comfyArgs(mainPy) {
    let helpOut = '';
    try {
      helpOut = await new Promise((resolve) => {
        const p = spawn(this.pythonExe, [mainPy, '--help'], { cwd: this.comfyDir, windowsHide: true });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('error', () => resolve(''));
        p.on('close', () => resolve(out));
        setTimeout(() => { try { p.kill(); } catch {} resolve(out); }, 30000);
      });
    } catch { /* fall through without the flag */ }
    if (helpOut) this.onEvent('log', { line: 'main.py --help captured (' + helpOut.length + ' chars)' });
    return buildComfyArgs({
      mainPy, port: this.port, cpu: this.cpu,
      modelPathsConfig: this.modelPathsConfig, helpOut,
    });
  }

  /** Shared ready-signal path (stdout or stderr): poll /system_stats, then settle. */
  _onReadySignal(done) {
    this._waitForReady().then((ok) => {
      if (ok) { this.ready = true; this.onEvent('ready', {}); done({ ok: true }); }
      else done({ ok: false, error: 'ComfyUI started but API is not responding.' });
    });
  }

  _wireProc(resolve) {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };

      this.proc.stdout.on('data', (d) => {
        const s = String(d);
        // WO-32: persist child output for the diagnostics report.
        try { require('./diagnostics.js').appendComfyLog(this.root, '[out] ' + s.trim()); } catch {}
        // ComfyUI prints "To see the GUI go to: http://127.0.0.1:8188" when ready
        // (usually on stderr — see below; stdout kept as a fallback).
        if (s.includes('To see the GUI') || s.includes('Starting server')) this._onReadySignal(done);
      });

      this.proc.stderr.on('data', (d) => {
        // Log but don't fail — ComfyUI is noisy on stderr.
        // NOTE: ComfyUI prints its startup banner ("To see the GUI…") on STDERR,
        // not stdout — so the ready signal is checked here too.
        // M2.5: buffer into COMPLETE lines first (see splitLogLines) —
        // forwarding raw chunks sliced to 200 chars silently dropped
        // every log line past char 200 of its chunk.
        const { lines, rest } = splitLogLines(this._errBuf || '', d);
        this._errBuf = rest;
        for (const line of lines) {
          if (!line) continue;
          // WO-32: persist child output for the diagnostics report.
          try { require('./diagnostics.js').appendComfyLog(this.root, '[err] ' + line.slice(0, 2000)); } catch {}
          this.onEvent('log', { line: line.slice(0, 2000) });
          if (line.includes('To see the GUI') || line.includes('Starting server')) this._onReadySignal(done);
        }
      });

      this.proc.on('error', (e) => {
        done({ ok: false, error: `Could not start ComfyUI: ${e.message}` });
      });

      this.proc.on('close', (code) => {
        this.ready = false;
        this.proc = null;
        // M2.5: flush a trailing partial stderr line (no trailing \n).
        if (this._errBuf) {
          try { require('./diagnostics.js').appendComfyLog(this.root, '[err] ' + this._errBuf.slice(0, 2000)); } catch {}
          this.onEvent('log', { line: this._errBuf.slice(0, 2000) });
          this._errBuf = '';
        }
        if (!settled) done({ ok: false, error: `ComfyUI exited (code ${code}).` });
        else this.onEvent('stopped', { code });
      });

      // Timeout: if ComfyUI doesn't signal ready in 2 min, fail
      setTimeout(() => {
        if (!settled) {
          try { this.proc.kill(); } catch {}
          done({ ok: false, error: 'ComfyUI took too long to start. Check the logs.' });
        }
      }, START_TIMEOUT_MS);
  }

  /** Poll /system_stats until it responds (max 30s). */
  async _waitForReady() {
    for (let i = 0; i < 30; i++) {
      try {
        await this._get('/system_stats');
        return true;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  _get(p) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${this.port}${p}`, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(JSON.parse(data));
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  _post(p, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port: this.port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(out)); }
            catch (e) { reject(e); }
          } else {
            // WO-41: carry status + full body so the caller can map it to
            // plain words. The raw body NEVER reaches the renderer — main.js
            // logs it to the app log and strips it before replying.
            const e = new Error(`HTTP ${res.statusCode}`);
            e.status = res.statusCode; e.body = out;
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data);
      req.end();
    });
  }

  /** WO-41: what CheckpointLoaderSimple can actually see (preflight). */
  async getCheckpointList() {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    try {
      const info = await this._get('/object_info/CheckpointLoaderSimple');
      const list = info && info.CheckpointLoaderSimple && info.CheckpointLoaderSimple.input
        && info.CheckpointLoaderSimple.input.required && info.CheckpointLoaderSimple.input.required.ckpt_name
        && info.CheckpointLoaderSimple.input.required.ckpt_name[0];
      return { ok: true, checkpoints: Array.isArray(list) ? list : [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Queue a workflow. Returns { prompt_id } on success, or plain-words { error } — never raw JSON. */
  async queuePrompt(workflow) {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    try {
      const r = await this._post('/prompt', { prompt: workflow });
      return { ok: true, promptId: r.prompt_id, port: this.port };
    } catch (e) {
      const m = mapComfyError(e && e.status, e && e.body);
      return {
        ok: false, error: m.plain, modelNotVisible: m.modelNotVisible,
        rawError: e && e.body ? String(e.body).slice(0, 8000) : String((e && e.message) || e),
      };
    }
  }

  /** WO-27: interrupt the current generation (user pressed Cancel). */
  async interrupt() {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    try {
      await this._post('/interrupt', {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Could not cancel: ${e.message}` };
    }
  }

  /** Get history for a prompt_id. Returns outputs when done. */
  async getHistory(promptId) {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    try {
      const h = await this._get(`/history/${promptId}`);
      return { ok: true, history: h[promptId] || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** M2: full /object_info node map (node names + input schemas). */
  async getObjectInfo() {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    try {
      const info = await this._get('/object_info');
      return { ok: true, info: info || {} };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * M2: fetch a finished VIDEO generation and save it to a Library
   * project (videos/ + sidecar in videos/.sidecars/), mirroring
   * fetchAndSaveOutput for images. SaveVideo writes the mp4 to
   * ComfyUI/output/video/ (prefix video/TakeOne), so main picks the
   * newest mp4 written after queue time — it never guesses from
   * history's output shape, which differs per node version. The mp4
   * bytes come back as a dataUrl for the renderer's <video> preview
   * (same pattern as images; a short clip is a few MB).
   *
   * Returns:
   *   { ok:true, path, fileName, bytes, dataUrl, projectId } on success.
   *   { ok:false, notFinished:true } while the prompt is still running.
   *   { ok:false, error } in plain words otherwise. When the video
   *   EXISTS in history but cannot be found/saved, the error starts
   *   "The video was made but couldn't be saved." — the generation
   *   itself is not the failure.
   */
  async fetchAndSaveVideoOutput(root, promptId, projectId, meta = {}) {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    const h = await this.getHistory(promptId);
    if (!h.ok) return { ok: false, error: h.error };
    const hist = h.history;
    if (!hist) return { ok: false, notFinished: true };
    const status = hist.status || {};
    if (!status.completed) return { ok: false, notFinished: true };
    if (status.status_str === 'error') {
      const msgs = Array.isArray(status.messages) ? status.messages : [];
      const execErr = msgs.find((m) => Array.isArray(m) && m[0] === 'execution_error');
      const detail = execErr && execErr[1] && (execErr[1].message || execErr[1].details)
        ? String(execErr[1].message || execErr[1].details).replace(/\s+/g, ' ').trim().slice(0, 300)
        : 'the engine reported an error';
      logToApp(`Video generation failed: ${detail}`);
      return { ok: false, error: `The video couldn't be made: ${detail}` };
    }
    const outDir = path.join(this.comfyDir, 'output', 'video');
    let candidates = [];
    try {
      const names = fs.readdirSync(outDir).filter((n) => /\.mp4$/i.test(n));
      for (const n of names) {
        try {
          const st = fs.statSync(path.join(outDir, n));
          candidates.push({ n, mtime: st.mtimeMs, size: st.size });
        } catch { /* unreadable — skip */ }
      }
    } catch (e) {
      logToApp(`Video output dir unreadable: ${outDir} (${e.message})`);
      return { ok: false, error: "The video was made but couldn't be saved. TakeOne could not read ComfyUI's output folder." };
    }
    const queuedAt = typeof meta.queuedAt === 'number' ? meta.queuedAt : 0;
    candidates.sort((a, b) => b.mtime - a.mtime);
    const pick = candidates.find((c) => c.mtime >= queuedAt - 2000);
    if (!pick) {
      logToApp(`Video output not found: ${candidates.length} mp4(s) in ${outDir}, none newer than queue time`);
      return { ok: false, error: "The video was made but couldn't be saved. No new video file appeared in ComfyUI's output folder." };
    }
    const srcPath = path.join(outDir, pick.n);
    const projDir = path.join(root, 'Projects', projectId, 'videos');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
      + '-' + Math.random().toString(36).slice(2, 6);
    const fileName = `${stamp}.mp4`;
    const dstPath = path.join(projDir, fileName);
    let bytes;
    try {
      await fsp.mkdir(projDir, { recursive: true });
      bytes = await fsp.readFile(srcPath);
      await fsp.writeFile(dstPath, bytes);
      const sidecar = {
        prompt: meta.prompt || '', model: meta.model || '', seed: meta.seed ?? null,
        width: meta.width || null, height: meta.height || null,
        resolution: meta.resolution || null, duration: meta.duration ?? null,
        length: meta.length ?? null, promptId,
        comfyFile: pick.n, bytes: bytes.length,
        savedAt: new Date().toISOString(), source: 'video',
      };
      const sidecarDir = path.join(projDir, '.sidecars');
      await fsp.mkdir(sidecarDir, { recursive: true });
      await fsp.writeFile(path.join(sidecarDir, `${stamp}.json`), JSON.stringify(sidecar, null, 2), 'utf8');
    } catch (e) {
      logToApp(`Video save failed: ${e.message}`);
      return { ok: false, error: "The video was made but couldn't be saved. TakeOne could not write it to the Library." };
    }
    logToApp(`Video saved: ${dstPath} (${bytes.length} bytes)`);
    return {
      ok: true, path: dstPath, fileName, bytes: bytes.length,
      projectId, dataUrl: 'data:video/mp4;base64,' + bytes.toString('base64'),
    };
  }

  /** Binary GET (for /view): returns { status, contentType, buffer }. */
  _getBinary(p) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${this.port}${p}`, (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); });
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          buffer: Buffer.concat(chunks),
        }));
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  /**
   * WO-43: fetch a finished generation's image THROUGH THE MAIN PROCESS
   * (Node http — no browser, no origin, no <img> to a local URL) and save
   * it to the Library, with a sidecar JSON. This replaces the renderer's
   * old `<img src="http://127.0.0.1:<port>/view?...">`, which rendered as a
   * broken image on Ali's PC (v2.2.17).
   *
   * Returns:
   *   { ok:true, path, fileName, bytes, dataUrl, comfyFile } on success.
   *   { ok:false, notFinished:true } while the prompt has no outputs yet.
   *   { ok:false, error } in plain words otherwise. When the image EXISTS
   *   in history but fetch/save fails, the error starts "The image was made
   *   but couldn't be saved." — the generation itself is not the failure.
   *   The raw status + Content-Type go to the app log, never to the UI.
   */
  async fetchAndSaveOutput(root, promptId, meta = {}) {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    const h = await this.getHistory(promptId);
    if (!h.ok) return { ok: false, error: h.error };
    const outs = h.history && h.history.outputs;
    if (!outs) return { ok: false, notFinished: true };
    const imgNode = Object.values(outs).find((o) => o.images && o.images.length);
    if (!imgNode) return { ok: false, notFinished: true };
    const img = imgNode.images[0];
    const viewPath = `/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
    let bin;
    try {
      bin = await this._getBinary(viewPath);
    } catch (e) {
      logToApp(`Quick Generate /view fetch failed: ${e.message}`);
      return { ok: false, error: "The image was made but couldn't be saved. ComfyUI could not be reached to fetch it." };
    }
    if (bin.status !== 200) {
      logToApp(`Quick Generate /view failed: status ${bin.status}, content-type ${bin.contentType}`);
      return { ok: false, error: `The image was made but couldn't be saved. ComfyUI returned status ${bin.status} when fetching it.` };
    }
    if (!isPng(bin.buffer)) {
      logToApp(`Quick Generate /view returned non-PNG bytes: content-type ${bin.contentType}, ${bin.buffer.length} bytes`);
      return { ok: false, error: "The image was made but couldn't be saved. What ComfyUI returned was not a PNG image." };
    }
    // M1 / WO-44: a REAL Library project, not a loose folder. The image
    // lands in Projects/<id>/images/ so the Library shows it with a
    // thumbnail, Show in folder, and Delete-to-Trash like any asset.
    // Sidecars live in images/.sidecars/ (a dot-dir): listAssets only
    // lists files, so sidecars never appear as broken thumbnails.
    let project;
    try {
      project = await require('./library.js').ensureQuickGenerateProject(root);
    } catch (e) {
      logToApp(`Quick Generate project failed: ${e.message}`);
      return { ok: false, error: "The image was made but couldn't be saved. TakeOne could not open the Quick Generate project." };
    }
    const dir = path.join(project.dir, 'images');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
      + '-' + Math.random().toString(36).slice(2, 6);
    const fileName = `${stamp}.png`;
    const pngPath = path.join(dir, fileName);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(pngPath, bin.buffer);
      const sidecar = {
        prompt: meta.prompt || '', model: meta.model || '', seed: meta.seed ?? null,
        width: meta.width || null, height: meta.height || null,
        preset: meta.preset || null, aspect: meta.aspect || null,
        variation: meta.variation ?? null, promptId,
        comfyFile: { filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' },
        bytes: bin.buffer.length, savedAt: new Date().toISOString(), source: 'quick-generate',
      };
      const sidecarDir = path.join(dir, '.sidecars');
      await fsp.mkdir(sidecarDir, { recursive: true });
      await fsp.writeFile(path.join(sidecarDir, `${stamp}.json`), JSON.stringify(sidecar, null, 2), 'utf8');
    } catch (e) {
      logToApp(`Quick Generate save failed: ${e.message}`);
      return { ok: false, error: "The image was made but couldn't be saved. TakeOne could not write it to the Library." };
    }
    logToApp(`Quick Generate saved: ${pngPath} (${bin.buffer.length} bytes)`);
    return {
      ok: true, path: pngPath, fileName, bytes: bin.buffer.length,
      projectId: project.id, projectName: 'Quick Generate',
      dataUrl: 'data:image/png;base64,' + bin.buffer.toString('base64'),
      comfyFile: { filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' },
    };
  }

  /** Stop ComfyUI gracefully. */
  async stop() {
    if (!this.proc) { this.ready = false; return { ok: true }; }
    return new Promise((resolve) => {
      const p = this.proc;
      this.proc = null;
      this.ready = false;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve({ ok: true }); } };
      p.on('close', finish);
      try { p.kill('SIGTERM'); } catch { finish(); }
      setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(); }, 5000);
    });
  }

  isRunning() { return this.ready && !!this.proc; }
}

module.exports = { ComfyManager, COMFY_PORT, buildComfyArgs, mapComfyError, createEngineComfy, MODEL_NOT_VISIBLE_MSG, VIDEO_NOT_VISIBLE_MSG, splitLogLines };
