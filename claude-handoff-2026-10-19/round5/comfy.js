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
const START_TIMEOUT_MS = 120000; // 2 min for ComfyUI to boot (model loading)

class ComfyManager {
  constructor({ root, pythonExe, comfyDir, onEvent }) {
    this.root = root;
    this.pythonExe = pythonExe;
    this.comfyDir = comfyDir;
    this.onEvent = onEvent || (() => {});
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
      const args = [mainPy, '--port', String(this.port), '--disable-auto-launch'];
      this.proc = spawn(this.pythonExe, args, {
        cwd: this.comfyDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };

      this.proc.stdout.on('data', (d) => {
        const s = String(d);
        // ComfyUI prints "To see the GUI go to: http://127.0.0.1:8188" when ready
        if (s.includes('To see the GUI') || s.includes('Starting server')) {
          this._waitForReady().then((ok) => {
            if (ok) { this.ready = true; this.onEvent('ready', {}); done({ ok: true }); }
            else done({ ok: false, error: 'ComfyUI started but API is not responding.' });
          });
        }
      });

      this.proc.stderr.on('data', (d) => {
        // Log but don't fail — ComfyUI is noisy on stderr
        const s = String(d).trim();
        if (s) this.onEvent('log', { line: s.slice(0, 200) });
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
    });
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
      return { ok: true, promptId: r.prompt_id };
    } catch (e) {
      return { ok: false, error: `Could not queue: ${e.message}` };
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
