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

/** WO-41: strip ANSI colour codes (ComfyUI logs colour). CSI + OSC sequences. */
function stripAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

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
    // WO-41: the stored ComfyUI log is colour-free, so the report never shows raw escapes.
    fs.appendFileSync(p, stripAnsi(String(line)).replace(/\r?\n$/, '') + '\n', 'utf8');
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
    // WO-41: event 1123's properties carry Process Name AND Path — the old
    // code read only Properties[0] (one value, often just a provider name).
    // Join ALL property values so both the process and the path survive.
    const ps = `Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; Id=1123} -MaxEvents 5 -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { $_.TimeCreated.ToString('o') + '|' + (($_.Properties | ForEach-Object { $_.Value }) -join ' | ') }`;
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
  // FIX-4 (Msg 1 item 4): what the Library reads vs what is on disk.
  // A gap means folders without project.json (orphans) — never hidden.
  if (over.libraryRead !== undefined || over.libraryOnDisk !== undefined) {
    lines.push(`Library projects read: ${over.libraryRead ?? '?'}`);
    lines.push(`Projects on disk: ${over.libraryOnDisk ?? '?'}`);
  }
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
 * WO-41: ComfyUI's CheckpointLoaderSimple list via /object_info (best-effort,
 * 5 s). Returns an array, or null when ComfyUI is not reachable. `httpGet`
 * is injectable for tests (defaults to a real 127.0.0.1 GET).
 */
async function queryComfyCheckpoints(port, httpGet) {
  const get = httpGet || ((p) => new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  }));
  try {
    const info = await get('/object_info/CheckpointLoaderSimple');
    const list = info && info.CheckpointLoaderSimple && info.CheckpointLoaderSimple.input
      && info.CheckpointLoaderSimple.input.required && info.CheckpointLoaderSimple.input.required.ckpt_name
      && info.CheckpointLoaderSimple.input.required.ckpt_name[0];
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

/**
 * WO-43: the last "Prompt executed in X seconds" line from the ComfyUI log
 * (ComfyUI prints it when a prompt finishes). Returns null when no
 * generation has completed in the stored log. ANSI + [out]/[err] prefixes
 * are stripped for readability.
 */
function lastGenerationLine(root, over) {
  if (over !== undefined) return over;
  let text = '';
  try { text = fs.readFileSync(comfyLogPath(root), 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/).filter((l) => /Prompt executed in .* seconds/i.test(l));
  if (!lines.length) return null;
  return stripAnsi(lines[lines.length - 1]).replace(/^\[(out|err)\]\s*/, '').trim();
}

/** WO-43 (M1: new home): the last 5 Quick Generate PNGs, newest first.
 * M1 saves into the real "Quick Generate" project's images/ dir; the
 * pre-M1 loose folder (Library/Quick Generate) is still read as a
 * fallback so older saves are not hidden. */
function listQuickOutputs(root, over) {
  if (over !== undefined) return over;
  let dir = null;
  try { dir = require('./library.js').findQuickGenerateProjectDir(root); } catch { dir = null; }
  if (dir) dir = path.join(dir, 'images');
  else dir = path.join(root, 'Library', 'Quick Generate');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)); } catch { return []; }
  const fmt = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB';
  const withTime = [];
  for (const n of names) {
    try { const st = fs.statSync(path.join(dir, n)); withTime.push({ n, mtime: st.mtimeMs, size: st.size }); }
    catch { /* unreadable — skip */ }
  }
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime.slice(0, 5).map((x) => `${x.n} (${fmt(x.size)})`);
}

/** M2: the last 5 video outputs (mp4 + first-frame thumbnails), newest
 * first — mirrors listQuickOutputs for the videos/ dir. */
function listQuickVideos(root, over) {
  if (over !== undefined) return over;
  let dir = null;
  try { dir = require('./library.js').findQuickGenerateProjectDir(root); } catch { dir = null; }
  if (dir) dir = path.join(dir, 'videos');
  else dir = path.join(root, 'Library', 'Quick Generate', 'videos');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.(mp4|png)$/i.test(n)); } catch { return []; }
  const fmt = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB';
  const withTime = [];
  for (const n of names) {
    try { const st = fs.statSync(path.join(dir, n)); withTime.push({ n, mtime: st.mtimeMs, size: st.size }); }
    catch { /* unreadable — skip */ }
  }
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime.slice(0, 5).map((x) => `${x.n} (${fmt(x.size)})`);
}
function listModelFiles(root, over) {
  if (over !== undefined) return over;
  const dir = path.join(root, 'Models', 'image');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ['(Models\\image folder not found)']; }
  const fmt = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB';
  const rows = [];
  for (const n of names.sort().slice(0, 20)) {
    try { rows.push(`${n} (${fmt(fs.statSync(path.join(dir, n)).size)})`); }
    catch { rows.push(`${n} (unreadable)`); }
  }
  if (names.length > 20) rows.push(`... and ${names.length - 20} more`);
  return rows.length ? rows : ['(no files)'];
}

/**
 * WO-36: the Engine section of the diagnostics report.
 * `over` injects: engineState, security, shippedPythonVer, engineReadiness,
 * comfyCheckpoints (array, or null when ComfyUI unreachable), comfyPort,
 * modelFiles.
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
  // WO-41: readiness truth (same engineReadiness the header uses) + what
  // ComfyUI can actually see + what is on disk. A model file on disk that
  // ComfyUI cannot see is exactly the WO-41 bug — this section makes the
  // two lists comparable at a glance.
  const readiness = over.engineReadiness !== undefined ? over.engineReadiness
    : await engine.engineReadiness(root).catch(() => null);
  if (readiness) {
    lines.push(`Ready: ${readiness.ready ? 'YES' : 'NO'} (state ready=${readiness.stateReady}, venv=${readiness.venvPresent ? 'present' : 'missing'}, ComfyUI=${readiness.comfyPresent ? 'present' : 'missing'}, wheels=${readiness.wheelsCount})`);
  }
  let ckpts = over.comfyCheckpoints;
  if (ckpts === undefined && over.comfyPort) ckpts = await queryComfyCheckpoints(over.comfyPort, over.comfyHttpGet);
  if (Array.isArray(ckpts)) {
    lines.push(`ComfyUI checkpoints (via /object_info): ${ckpts.length ? ckpts.join(', ') : '(none — the model list is empty)'}`);
  } else {
    lines.push('ComfyUI checkpoints (via /object_info): unavailable — ComfyUI is not running');
  }
  lines.push('Models\\image files:');
  for (const f of listModelFiles(root, over.modelFiles)) lines.push('  ' + f);
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
  // WO-41: the header tells the truth from engineReadiness (state.ready +
  // venv + ComfyUI dir). The old header read state.installed — a field that
  // never existed — so it always said "not installed" on a running engine.
  const readiness = over.engineReadiness !== undefined ? over.engineReadiness
    : await engine.engineReadiness(root).catch(() => null);
  const engineSummary = over.engineSummary !== undefined ? over.engineSummary : !readiness ? 'unknown'
    : readiness.ready
      ? `ready (${readiness.wheelsCount} wheels${readiness.pythonVersion ? `, python ${readiness.pythonVersion}` : ''})`
      : `not installed (state ready=${readiness.stateReady}, venv ${readiness.venvPresent ? 'present' : 'missing'}, ComfyUI ${readiness.comfyPresent ? 'present' : 'missing'})`;
  const disk = over.disk !== undefined ? over.disk : await (async () => {
    try {
      const c = await engine.checkDiskSpace(root);
      return `${fmtGB(c.freeBytes)} free`;
    } catch {
      return 'unknown';
    }
  })();
  const appLog = d('appLog', () => sessionLogTail(path.join(os.tmpdir(), 'takeone-startup.log'), LOG_TAIL_LINES));
  // WO-41: strip ANSI even from older stored logs (appendComfyLog strips new writes too).
  const comfyLog = d('comfyLog', () => stripAnsi(tailFile(comfyLogPath(root), LOG_TAIL_LINES)));
  // WO-36: Engine section — lastError, root (masked later), OneDrive, shipped
  // python, venv presence, Controlled Folder Access + Defender status.
  // WO-41: pass the header's readiness through so both agree by construction.
  const engSection = over.engineSection !== undefined ? over.engineSection
    : await engineSection(root, { ...over, engineReadiness: readiness });
  // WO-38: previous session crash evidence ('' when clean / absent).
  const prevSession = over.prevSession !== undefined ? over.prevSession
    : previousSessionSection(path.join(os.tmpdir(), 'takeone-startup.log'));
  // WO-39(5): storage section — root, protected yes/no, CFA, Defender blocks.
  const storSection = over.storageSection !== undefined ? over.storageSection
    : await storageSection(root, over);

  // WO-43: last generation + last Library outputs (injected via over for tests).
  const lastGen = over.lastGeneration !== undefined ? over.lastGeneration : lastGenerationLine(root);
  const quickOuts = over.quickOutputs !== undefined ? over.quickOutputs : listQuickOutputs(root);
  // M2: last video outputs (Quick Generate project videos/, newest 5).
  const quickVids = over.quickVideos !== undefined ? over.quickVideos : listQuickVideos(root);
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
    '--- Last generation ---',
    lastGen || '(no completed generation in the ComfyUI log yet)',
    '',
    '--- Quick Generate outputs (last 5, Quick Generate project) ---',
    quickOuts.length ? quickOuts.map((o) => '  ' + o).join('\n') : '  (none saved yet)',
    '',
    '--- Video outputs (last 5, Quick Generate project videos/) ---',
    quickVids.length ? quickVids.map((o) => '  ' + o).join('\n') : '  (none saved yet)',
    '',
    prevSession ? prevSession + '\n' : '',
    '(user names in paths are masked; no passwords or keys are included)',
  ].join('\n');

  // WO-41: the report as a whole is ANSI-free by construction — no escape
  // sequence survives, whichever source a line came from.
  return maskReport(stripAnsi(report));
}

module.exports = {
  buildDiagnosticsReport, maskReport, maskUserName, scrubSecrets, stripAnsi,
  tailFile, sessionLogTail, previousSessionSection, comfyLogPath, appendComfyLog, queryGpu,
  querySecurity, queryDefenderBlocks, queryComfyCheckpoints, listModelFiles,
  lastGenerationLine, listQuickOutputs, listQuickVideos,
  isOneDrivePath, engineSection, storageSection,
  LOG_TAIL_LINES, GPU_QUERY_TIMEOUT_MS,
};
