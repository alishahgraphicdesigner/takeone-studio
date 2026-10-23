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
 * WO-39(5): last apps blocked by Controlled Folder Access, from the Windows
 * Defender event log (event ID 1123). Best-effort: returns [] on any failure.
 * runExec is injected for tests; production uses promisified execFile.
 */
async function queryDefenderBlocks(runExec) {
  const exec = runExec || ((file, args) => new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve({ err, stdout: String(stdout || '') });
    });
  }));
  try {
    const ps = `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1123} -MaxEvents 5 -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { $_.TimeCreated.ToString('o') + '|' + ($_.Properties[0].Value) }`;
    const r = await Promise.race([
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
    ]);
    if (!r || r.timeout || r.err) return [];
    return String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * WO-39(5): storage section — real root (masked later), protected yes/no,
 * Controlled Folder Access status, recent Defender blocks.
 */
async function storageSection(root, over = {}) {
  const lines = [];
  lines.push(`Root: ${root}`);
  let prot = over.protected;
  if (prot === undefined) {
    try {
      const sr = require('./storage-root.js');
      prot = sr.isProtectedFolder(root, null) ? 'yes' : 'no';
    } catch { prot = 'unknown'; }
  }
  lines.push(`Protected folder: ${prot}`);
  // WO-39: run both PowerShell queries in parallel — each has its own 5 s
  // timeout, so the section never takes more than ~5 s total.
  const [sec, blocks] = await Promise.all([
    over.security ? over.security : querySecurity(over.runExec),
    over.defenderBlocks !== undefined ? over.defenderBlocks : queryDefenderBlocks(over.runExec),
  ]);
  lines.push(`Controlled Folder Access: ${sec.controlledFolderAccess}`);
  lines.push(`Defender real-time protection: ${sec.defenderRealTime}`);
  if (blocks && blocks.length) {
    lines.push('Recently blocked by Controlled Folder Access:');
    for (const b of blocks) lines.push('  ' + b);
  } else {
    lines.push('Recently blocked by Controlled Folder Access: none recorded');
  }
  return lines.join('\n');
}

/**
 * WO-36: Windows Security posture via PowerShell (async, 5 s timeout).
 * Returns { controlledFolderAccess, defenderRealTime } — each is
 * 'on' / 'off' / 'audit' / 'unknown' ('unknown' is an acceptable answer).
 * `runExec` is injectable for tests.
 */
async function querySecurity(runExec) {
  const run = runExec || promisify(execFile);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('security query timed out')), GPU_QUERY_TIMEOUT_MS));
  const ps = async (code) => {
    const { stdout } = await Promise.race([
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code],
        { timeout: GPU_QUERY_TIMEOUT_MS, windowsHide: true }),
      timeout,
    ]);
    return String(stdout || '').trim();
  };
  const out = { controlledFolderAccess: 'unknown', defenderRealTime: 'unknown' };
  try {
    // 0 = off, 1 = on, 2 = audit mode
    const cfa = await ps('(Get-MpPreference).EnableControlledFolderAccess');
    out.controlledFolderAccess = cfa === '1' ? 'on' : cfa === '2' ? 'audit' : cfa === '0' ? 'off' : 'unknown';
  } catch { /* unknown stays */ }
  try {
    const rt = await ps('(Get-MpComputerStatus).RealTimeProtectionEnabled');
    out.defenderRealTime = /^true$/i.test(rt) ? 'on' : /^false$/i.test(rt) ? 'off' : 'unknown';
  } catch { /* unknown stays */ }
  return out;
}

/** WO-36: is this path inside a OneDrive-synced folder? (heuristic) */
function isOneDrivePath(p) {
  return /onedrive/i.test(String(p || ''));
}

/**
 * WO-36: session-scoped app log tail — only lines AFTER the last TOP-OF-FILE
 * marker (the current session). Never shows older sessions.
 */
function sessionLogTail(logPath, n = LOG_TAIL_LINES) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return '(no app log yet)'; }
  const marker = 'TOP-OF-FILE';
  const idx = text.lastIndexOf(marker);
  const session = idx >= 0 ? text.slice(idx) : text;
  const lines = session.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n') || '(empty session log)';
}

/**
 * WO-38: previous-session crash detection. Splits the log on TOP-OF-FILE
 * markers. If the session BEFORE the current one has no "SHUTDOWN clean"
 * marker, it ended unexpectedly (crash / kill / "Not Responding") — show its
 * last 100 lines under "Previous session (ended unexpectedly)".
 * Returns '' when there is nothing to show.
 */
function previousSessionSection(logPath) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return ''; }
  const marker = 'TOP-OF-FILE';
  const parts = text.split(marker);
  // parts[0] = before the first marker (ignore); the current session is the
  // last part; the previous session is the one before it.
  if (parts.length < 3) return ''; // need at least: old + previous + current
  const previous = parts[parts.length - 2];
  if (!previous.trim()) return '';
  if (previous.includes('SHUTDOWN clean')) return ''; // ended fine
  const lines = previous.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const tail = lines.slice(-LOG_TAIL_LINES).join('\n') || '(empty)';
  return [
    `--- Previous session (ended unexpectedly, last ${LOG_TAIL_LINES} lines) ---`,
    tail,
  ].join('\n');
}

/**
 * WO-36: the Engine section of the diagnostics report.
 * `over` injects: engineState, security, shippedPythonVer.
 */
async function engineSection(root, over = {}) {
  const engine = require('./engine.js');
  const st = over.engineState !== undefined ? over.engineState
    : await (async () => { try { return await engine.readEngineState(root); } catch { return null; } })();
  const er = engine.engineRoot(root);
  const lines = [];
  lines.push(`Root: ${er}${st && st.engineRootOverride ? ' (override active)' : ''}`);
  lines.push(`OneDrive folder: ${isOneDrivePath(er) || isOneDrivePath(root) ? 'YES — may cause file locks' : 'no'}`);
  const shipVer = over.shippedPythonVer !== undefined ? over.shippedPythonVer
    : await engine.shippedPythonVersion(root).catch(() => null);
  const shipExe = engine.shippedPythonExe(root);
  lines.push(`Shipped python: ${shipExe} ${shipVer ? `(version ${shipVer})` : '(missing)'}`);
  const venvPy = engine.venvPython(root);
  const venvPresent = fs.existsSync(venvPy);
  lines.push(`Engine venv: ${venvPresent ? 'present' : 'MISSING'} (${venvPy})`);
  if (st && st.lastError) {
    const le = st.lastError;
    lines.push(`Last error: step=${le.step} code=${le.code} at=${le.at}`);
    const tail = String(le.tail || '').split('\n').slice(-10).join('\n');
    if (tail) lines.push(`Last error tail:\n${tail}`);
  } else {
    lines.push('Last error: none recorded');
  }
  const sec = over.security !== undefined ? over.security : await querySecurity(over.securityExec);
  lines.push(`Controlled Folder Access: ${sec.controlledFolderAccess}`);
  lines.push(`Defender real-time protection: ${sec.defenderRealTime}`);
  return lines.join('\n');
}

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
  const engineSummary = over.engineSummary !== undefined ? over.engineSummary : await (async () => {
    let st = null;
    try { st = await engine.readEngineState(root); } catch {}
    if (!st || !st.installed) return 'not installed';
    const wheels = Array.isArray(st.wheels) ? st.wheels.length : 0;
    const py = st.python && st.python.version ? `, python ${st.python.version}` : '';
    return `installed (${wheels} wheels${py})`;
  })();
  const disk = over.disk !== undefined ? over.disk : await (async () => {
    try {
      const c = await engine.checkDiskSpace(root);
      return `${fmtGB(c.freeBytes)} free`;
    } catch {
      return 'unknown';
    }
  })();
  const appLog = d('appLog', () => sessionLogTail(path.join(os.tmpdir(), 'takeone-startup.log'), LOG_TAIL_LINES));
  const comfyLog = d('comfyLog', () => tailFile(comfyLogPath(root), LOG_TAIL_LINES));
  // WO-36: Engine section — lastError, root (masked later), OneDrive, shipped
  // python, venv presence, Controlled Folder Access + Defender status.
  const engSection = over.engineSection !== undefined ? over.engineSection
    : await engineSection(root, over);
  // WO-38: previous session crash evidence ('' when clean / absent).
  const prevSession = over.prevSession !== undefined ? over.prevSession
    : previousSessionSection(path.join(os.tmpdir(), 'takeone-startup.log'));
  // WO-39(5): storage section — root, protected yes/no, CFA, Defender blocks.
  const storSection = over.storageSection !== undefined ? over.storageSection
    : await storageSection(root, over);

  const report = [
    'TakeOne Studio diagnostics',
    '===========================',
    `App version: ${version}`,
    `Windows: ${windows}`,
    `GPU: ${gpu}`,
    `Engine: ${engineSummary}`,
    `Free disk: ${disk}`,
    '',
    '--- Engine ---',
    engSection,
    '',
    '--- Storage ---',
    storSection,
    '',
    `--- App log (current session only, last ${LOG_TAIL_LINES} lines) ---`,
    appLog,
    '',
    `--- ComfyUI log (last ${LOG_TAIL_LINES} lines) ---`,
    comfyLog,
    '',
    prevSession ? prevSession + '\n' : '',
    '(user names in paths are masked; no passwords or keys are included)',
  ].join('\n');

  return maskReport(report);
}

module.exports = {
  buildDiagnosticsReport, maskReport, maskUserName, scrubSecrets,
  tailFile, sessionLogTail, previousSessionSection, comfyLogPath, appendComfyLog, queryGpu,
  querySecurity, queryDefenderBlocks, isOneDrivePath, engineSection, storageSection,
  LOG_TAIL_LINES, GPU_QUERY_TIMEOUT_MS,
};
