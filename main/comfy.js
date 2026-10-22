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
const http = require('http');

const COMFY_PORT = 8188;
const START_TIMEOUT_MS = 300000; // 5 min: CPU boot on a slow CI runner (torch import alone can take minutes)

class ComfyManager {
  constructor({ root, pythonExe, comfyDir, onEvent, cpu }) {
    this.root = root;
    this.pythonExe = pythonExe;
    this.comfyDir = comfyDir;
    this.onEvent = onEvent || (() => {});
    this.cpu = !!cpu; // e2e CI has no NVIDIA GPU — ComfyUI must boot with --cpu
    this.proc = null;
    this.port = COMFY_PORT;
    this.ready = false;
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
      this._pickPort().then((port) => {
        this.port = port;
        this._comfyArgs(mainPy).then((args) => {
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
   * Amendment 8: build the ComfyUI argv. --disable-api-nodes is only added when
   * main.py --help actually lists it (ComfyUI versions differ); the --help
   * output is appended to the ComfyUI log so the choice is auditable.
   * Always binds to 127.0.0.1 (never 0.0.0.0).
   */
  async _comfyArgs(mainPy) {
    const args = [mainPy, '--port', String(this.port), '--listen', '127.0.0.1', '--disable-auto-launch'];
    if (this.cpu) args.push('--cpu');
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
    if (helpOut && helpOut.includes('--disable-api-nodes')) args.push('--disable-api-nodes');
    return args;
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
        const s = String(d).trim();
        // WO-32: persist child output for the diagnostics report.
        try { if (s) require('./diagnostics.js').appendComfyLog(this.root, '[err] ' + s.slice(0, 500)); } catch {}
        if (s) this.onEvent('log', { line: s.slice(0, 200) });
        if (s.includes('To see the GUI') || s.includes('Starting server')) this._onReadySignal(done);
      });

      this.proc.on('error', (e) => {
        done({ ok: false, error: `Could not start ComfyUI: ${e.message}` });
      });

      this.proc.on('close', (code) => {
        this.ready = false;
        this.proc = null;
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
          if (res.statusCode === 200) resolve(JSON.parse(out));
          else reject(new Error(`HTTP ${res.statusCode}: ${out.slice(0, 200)}`));
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data);
      req.end();
    });
  }

  /** Queue a workflow. Returns { prompt_id }. */
  async queuePrompt(workflow) {
    if (!this.ready) return { ok: false, error: 'ComfyUI is not running.' };
    try {
      const r = await this._post('/prompt', { prompt: workflow });
      return { ok: true, promptId: r.prompt_id, port: this.port };
    } catch (e) {
      return { ok: false, error: `Could not queue: ${e.message}` };
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

module.exports = { ComfyManager, COMFY_PORT };
