/**
 * WO-32: one-click diagnostics report.
 *
 * Ali cannot read logs — Settings gets a "Copy diagnostics" button that puts a
 * plain-text report on the clipboard: app version, Windows version, GPU name +
 * driver (nvidia-smi), engine-state.json summary, free disk, and the last 100
 * lines of the app log + the ComfyUI log.
 *
 * Privacy: user names in paths are masked (C:\Users\<name> -> C:\Users\...),
 * and anything shaped like a secret (api key / token / password assignments)
 * is scrubbed. The report must never carry secrets — see test/diagnostics.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const LOG_TAIL_LINES = 100;
const COMFY_LOG_MAX_BYTES = 512 * 1024; // rotate: keep the last half when exceeded
const GPU_QUERY_TIMEOUT_MS = 5000; // WO-35: never block the UI on nvidia-smi

/** Mask the user name out of paths: C:\Users\<name>\ -> C:\Users\...\ (all platforms). */
function maskUserName(s) {
  return String(s == null ? '' : s)
    .replace(/^([A-Za-z]:\\Users\\)[^\\]+/gim, '$1...')
    .replace(/^(\/home\/)[^/]+/gim, '$1...')
    .replace(/^(\/Users\/)[^/]+/gim, '$1...')
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/g, '$1...')
    .replace(/(\/home\/)[^/]+/g, '$1...')
    .replace(/(\/Users\/)[^/]+/g, '$1...');
}

/** Scrub anything shaped like an assigned secret: api_key=..., token: ..., etc. */
function scrubSecrets(s) {
  return String(s == null ? '' : s).replace(
    /\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd|bearer|token)\b\s*[:=]\s*(\S+)/gi,
    '$1=...'
  );
}

/** Full privacy pass for one report line (or the whole report). */
function maskReport(s) {
  return scrubSecrets(maskUserName(s));
}

/** Last n lines of a text file; "(no log yet)" when missing/unreadable. */
function tailFile(p, n) {
  try {
    const data = fs.readFileSync(p, 'utf8');
    const lines = data.split(/\r?\n/);
    // Drop the trailing empty line from a final newline.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).join('\n') || '(log is empty)';
  } catch {
    return '(no log yet)';
  }
}

/**
 * WO-35: async nvidia-smi (promisified execFile, 5 s timeout) — the UI thread
 * must never block on a missing or hung nvidia-smi. `runExec` is injectable for tests.
 * The timeout is enforced with Promise.race (not just execFile's own timeout option),
 * so it holds even if the exec implementation hangs.
 */
async function queryGpu(runExec) {
  const run = runExec || promisify(execFile);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('nvidia-smi timed out')), GPU_QUERY_TIMEOUT_MS));
  try {
    const { stdout } = await Promise.race([
      run('nvidia-smi',
        ['--query-gpu=name,driver_version', '--format=csv,noheader'],
        { timeout: GPU_QUERY_TIMEOUT_MS }),
      timeout,
    ]);
    const line = String(stdout || '').trim().split('\n')[0] || '';
    const [name, driver] = line.split(',').map((s) => s.trim());
    return name ? `${name}, driver ${driver || 'unknown'}` : 'no NVIDIA GPU detected';
  } catch {
    return 'no NVIDIA GPU detected';
  }
}
function comfyLogPath(root) {
  const engine = require('./engine.js');
  return path.join(engine.engineRoot(root), 'comfyui.log');
}

/** Append one line to the ComfyUI log, rotating when it grows too large. */
function appendComfyLog(root, line) {
  try {
    const p = comfyLogPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      const st = fs.statSync(p);
      if (st.size > COMFY_LOG_MAX_BYTES) {
        const data = fs.readFileSync(p, 'utf8');
        const keep = data.slice(-Math.floor(COMFY_LOG_MAX_BYTES / 2));
        const cut = keep.indexOf('\n');
        fs.writeFileSync(p, cut >= 0 ? keep.slice(cut + 1) : keep, 'utf8');
      }
    } catch { /* first write */ }
    fs.appendFileSync(p, String(line).replace(/\r?\n$/, '') + '\n', 'utf8');
  } catch { /* logging must never break generation */ }
}

const fmtGB = (b) => (b / 1073741824).toFixed(1) + ' GB';

/**
 * Build the full plain-text diagnostics report (async — the GPU query never
 * blocks the calling thread; see WO-35).
 * `over` lets tests inject every data source; defaults read the real machine.
 * `over.gpuExec` injects the exec function used by queryGpu.
 */
async function buildDiagnosticsReport(root, over = {}) {
  const engine = require('./engine.js');
  const d = (k, fn) => (over[k] !== undefined ? over[k] : fn());

  const version = d('version', () => {
    try { return require('../package.json').version; } catch { return 'unknown'; }
  });
  const windows = d('windows', () => {
    // os.version() on Windows: "Windows 10 Pro" / "Windows 11 Pro".
    let v = '';
    try { v = typeof os.version === 'function' ? os.version() : ''; } catch {}
    return [v, `(${os.platform()} ${os.release()})`].filter(Boolean).join(' ');
  });
  // WO-35: async — a missing or hung nvidia-smi resolves within 5 s, UI never blocks.
  const gpu = over.gpu !== undefined ? over.gpu : await queryGpu(over.gpuExec);
  const engineSummary = d('engineSummary', () => {
    let st = null;
    try { st = engine.readEngineState(root); } catch {}
    if (!st || !st.installed) return 'not installed';
    const wheels = Array.isArray(st.wheels) ? st.wheels.length : 0;
    const py = st.python && st.python.version ? `, python ${st.python.version}` : '';
    return `installed (${wheels} wheels${py})`;
  });
  const disk = d('disk', () => {
    try {
      const c = engine.checkDiskSpace(root);
      return `${fmtGB(c.freeBytes)} free`;
    } catch {
      return 'unknown';
    }
  });
  const appLog = d('appLog', () => tailFile(path.join(os.tmpdir(), 'takeone-startup.log'), LOG_TAIL_LINES));
  const comfyLog = d('comfyLog', () => tailFile(comfyLogPath(root), LOG_TAIL_LINES));

  const report = [
    'TakeOne Studio diagnostics',
    '===========================',
    `App version: ${version}`,
    `Windows: ${windows}`,
    `GPU: ${gpu}`,
    `Engine: ${engineSummary}`,
    `Free disk: ${disk}`,
    '',
    `--- App log (last ${LOG_TAIL_LINES} lines) ---`,
    appLog,
    '',
    `--- ComfyUI log (last ${LOG_TAIL_LINES} lines) ---`,
    comfyLog,
    '',
    '(user names in paths are masked; no passwords or keys are included)',
  ].join('\n');

  return maskReport(report);
}

module.exports = {
  buildDiagnosticsReport, maskReport, maskUserName, scrubSecrets,
  tailFile, comfyLogPath, appendComfyLog, queryGpu,
  LOG_TAIL_LINES, GPU_QUERY_TIMEOUT_MS,
};
