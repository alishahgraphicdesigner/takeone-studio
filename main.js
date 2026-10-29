// TAKEONE STARTUP LOG — absolute first, before any require
try {
  const _lp = require('path').join(require('os').tmpdir(), 'takeone-startup.log');
  // WO-36: rotate at 512 KB so the log never grows unbounded; a fresh
  // TOP-OF-FILE marker starts every session (diagnostics shows the current
  // session only).
  const _lrot = () => {
    try {
      const st = require('fs').statSync(_lp);
      if (st.size > 512 * 1024) {
        require('fs').renameSync(_lp, _lp + '.1');
      }
    } catch { /* first write */ }
  };
  const _lm = (m) => { try { _lrot(); require('fs').appendFileSync(_lp, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
  _lm('TOP-OF-FILE');
  process.on('uncaughtException', (e) => { _lm('UNCAUGHT: ' + (e.stack || e.message || e)); });
  process.on('unhandledRejection', (e) => { _lm('UNHANDLED: ' + (e && e.stack || e)); });
  global.__takeoneLog = _lm;
} catch {}
/* TakeOne Studio 2.2.0 — Phase A: installer skeleton + truthful wizard.
 * Windows target. Pure functions are exported for unit tests (node --test);
 * Electron wiring only runs inside Electron. */
// ---------------------------------------------------------------------------
// Imports (Electron-safe: require('electron') under plain node returns a path)
// ---------------------------------------------------------------------------
let _electron = null;
try { _electron = require('electron'); } catch { /* plain node (unit tests) */ }
const isElectron = !!(_electron && _electron.app);
const app = isElectron ? _electron.app : null;
const BrowserWindow = isElectron ? _electron.BrowserWindow : null;
const ipcMain = isElectron ? _electron.ipcMain : null;
// WO-38: event-loop lag monitor (pure module — safe under plain node too).
const loopMonitor = require('./main/loop-monitor.js');
const dialog = isElectron ? _electron.dialog : null;
const shell = isElectron ? _electron.shell : null;
const Menu = isElectron ? _electron.Menu : null;

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const dns = require('dns');

// Phase B modules (pure parts unit-tested; classes need real binaries).
try { global.__takeoneLog && global.__takeoneLog('REQ catalog'); } catch {}
const catalogMod = require('./main/catalog.js');
const { decideToolState } = require('./main/tool-states.js');
try { global.__takeoneLog && global.__takeoneLog('REQ catalog OK'); } catch {}
const dlMod = require('./main/downloads.js');
const depsMod = require('./main/deps.js');
const { hfInstalledStatus } = require('./main/hf-install-check.js');
// Phase C modules.
const libMod = require('./main/library.js');
const pipeMod = require('./main/pipeline.js');
const { CATALOG, IMPLICIT_DEPS, validateCatalog, vramAllowed, estimateBytes, catalogSignature, verifyCatalog, effectiveAvailability } = catalogMod;
const { DownloadManager, sha256File, postCheckResult, mapAriaStatus } = dlMod;
const { parsePipProgress, pipInstall, hfSnapshot, installPlan } = depsMod;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const APP_DIR_NAME = 'TakeOne';            // %APPDATA%/TakeOne (receipt, update cache)
const CONFIG_VERSION = 1;
// Speed probe hosts, tried in order — first success wins. Multiple hosts so one
// blocked CDN (office firewall/proxy) doesn't make speed "unavailable".
const SPEED_PROBE_URLS = [
  'https://speed.cloudflare.com/__down?bytes=10000000',
  'https://cachefly.cachefly.net/10mb.test',
];
const SPEED_PROBE_TIMEOUT_MS = 12000;

// Known weight filenames the existing-model scan recognises (friendly catalog names).
const KNOWN_MODELS = [
  ['sdxl_lightning_4step', 'Image Studio (SDXL-Lightning)'],
  ['sdxl_turbo', 'Image Lite (SDXL-Turbo)'],
  ['wan2.1', 'Video Studio (Wan 2.1 1.3B)'],
  ['allegro', 'Video Quality (Allegro 2.8B)'],
  ['wan2.2', 'Video Pro (Wan 2.2 TI2V-5B)'],
  ['chatterbox', 'Voice Studio (Chatterbox)'],
  ['piper', 'Voice Lite (Piper)'],
  ['faster-whisper', 'Transcribe (faster-whisper)'],
  ['ace-step', 'Music Studio (ACE-Step)'],
  ['swinir', 'Upscaler (SwinIR)'],
  ['gfpgan', 'Face Restore (GFPGAN)'],
  ['florence', 'Vision (Florence-2)'],
  ['sam2', 'Smart Select (SAM 2)'],
  ['big-lama', 'Erase (LaMa)'],
  ['depth_anything', 'Depth FX (Depth-Anything V2)'],
  ['dwpose', 'Pose Lock (DWPose)'],
  ['birefnet', 'BG Remove (BiRefNet)'],
  ['deepfilternet', 'Voice Cleanup (DeepFilterNet)'],
  ['silero', 'Voice Cleanup (Silero VAD)'],
  ['rife', 'Slow Motion (RIFE)'],
  ['demucs', 'Stem Split (Demucs)'],
  ['qwen3', 'Brain (Qwen3 8B)'],
];

// ---------------------------------------------------------------------------
// Pure functions (unit-tested)
// ---------------------------------------------------------------------------
function r1(n) { return Math.round(n * 10) / 10; }

/** Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`.
 *  Returns { name, vramMB } | null. */
function parseNvidiaSmi(stdout) {
  if (!stdout || !stdout.trim()) return null;
  const line = stdout.trim().split('\n')[0];
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 2) return null;
  const vramMB = parseInt(parts[1], 10);
  if (!parts[0] || Number.isNaN(vramMB)) return null;
  return { name: parts[0], vramMB };
}

/** Rule-based pack recommendation from REAL measurements. Pure. */
function recommendPack(pc) {
  const vramMB = pc.vramMB || 0;
  const vramGB = r1(vramMB / 1024);
  if (!pc.gpuName) {
    return {
      tier: 'lite',
      reason: 'No NVIDIA GPU was detected on this PC, so the Lite pack is recommended — it contains the tools that run well on CPU.',
    };
  }
  if (vramMB >= 12000) {
    return {
      tier: 'pro',
      reason: `Your ${pc.gpuName} has ${vramGB} GB of VRAM — the full Pro pack is recommended, including the heaviest video tools.`,
    };
  }
  if (vramMB >= 8000) {
    return {
      tier: 'standard',
      reason: `Your ${pc.gpuName} has ${vramGB} GB of VRAM — the Standard pack is recommended. The 24 GB-tier Video Pro tool is excluded because this card cannot run it.`,
    };
  }
  return {
    tier: 'lite',
    reason: `Your ${pc.gpuName} has ${vramGB} GB of VRAM — the Lite pack is recommended. Heavier tools would be too slow or would fail on this card.`,
  };
}

/** Gate 2 poka-yoke: wizard cannot complete with zero downloads AND zero
 *  existing models unless the user explicitly acknowledged "I'll add tools later".
 *  Pure — enforced in main AND mirrored in the renderer for instant feedback. */
function validateWizardCompletion(w) {
  const toolsSelected =
    w.packChoice === 'recommended' ||
    (w.packChoice === 'custom' && Array.isArray(w.customTools) && w.customTools.length > 0);
  const hasExisting = Array.isArray(w.existingModels) && w.existingModels.length > 0;
  const acknowledged = w.acknowledgedLater === true;
  if (toolsSelected || hasExisting || acknowledged) return { ok: true };
  return {
    ok: false,
    reason: 'No tools selected and no existing models found. Either pick a pack, or confirm "I will add tools later" to continue.',
  };
}

/** Mask the OS-username portion of a path for display.
 *  C:\Users\Ali\Documents\TakeOne -> C:\Users\•••\Documents\TakeOne
 *  Pure. The real path is still used for all file operations. */
function maskPersonalPath(p) {
  if (!p) return p;
  return String(p)
    .replace(/^([A-Za-z]:\\Users\\)[^\\]+/i, '$1•••')
    .replace(/^(\/home\/)[^/]+/i, '$1•••')
    .replace(/^(\/Users\/)[^/]+/i, '$1•••');
}

/** Subdirs TakeOne owns inside a storage root. */
const ROOT_OWNED_DIRS = ['Models', 'Projects', 'Trash', '.staging', '.python'];

/** Guard (added 2026-10-15, data-loss incident): refuse to adopt a folder as a
 *  storage root when it already contains non-TakeOne Models/Projects/Trash/
 *  .staging/.python with files in them. Same bug class as the installer
 *  incident: TakeOne would treat the user's own subfolders as its own and the
 *  data-wipe could delete them. A folder that already has our config.json is
 *  ours (adopt flow) and is always allowed. */
async function validateStorageRoot(dir) {
  const conflicts = [];
  let isOurs = false;
  try { isOurs = !!(await readConfig(dir)); } catch {}
  if (isOurs) return { ok: true, conflicts: [] };
  for (const sub of ROOT_OWNED_DIRS) {
    try {
      const entries = await fsp.readdir(path.join(dir, sub));
      if (entries.length > 0) conflicts.push(sub + ' (' + entries.length + ' items inside)');
    } catch {}
  }
  return { ok: conflicts.length === 0, conflicts };
}

/** Refuse to treat an arbitrary folder as a TakeOne root (safety for deletes). */
function isTakeOneRoot(root) {
  try {
    return fs.existsSync(path.join(root, 'config.json'));
  } catch { return false; }
}

module.exports = {
  parseNvidiaSmi, recommendPack, validateWizardCompletion, isTakeOneRoot, r1, KNOWN_MODELS,
  checkPC, scanExistingModels, scanFolderForModels, adoptModels, changeStorageRoot, validateStorageRoot, folderSizeBytes, uninstallData, ensurePython,
  // Phase B (pure, unit-tested)
  validateCatalog, vramAllowed, estimateBytes, catalogSignature, verifyCatalog,
  postCheckResult, mapAriaStatus, parsePipProgress, installPlan, CATALOG,
  // Phase C: library (pure, unit-tested)
  validateProjectName: libMod.validateProjectName,
  makeProjectId: libMod.makeProjectId,
  guessAssetType: libMod.guessAssetType,
  // Phase C: pipeline (pure, unit-tested)
  STEPS: pipeMod.STEPS,  stepDef: pipeMod.stepDef,
  maskPersonalPath,
  projectThread: pipeMod.projectThread,
  imageStepReady,
  resumeState: pipeMod.resumeState,
  analyzeScript: pipeMod.analyzeScript,
  addTasteRule: pipeMod.addTasteRule,
  removeTasteRule: pipeMod.removeTasteRule,
  updateTasteRule: pipeMod.updateTasteRule,
  suggestNextMoves: pipeMod.suggestNextMoves,
  engineGateText: pipeMod.engineGateText,
  toggleVariation: pipeMod.toggleVariation,
};

// ---------------------------------------------------------------------------
// Paths (Electron only)
// ---------------------------------------------------------------------------
function receiptDir() { return path.join(app.getPath('appData'), APP_DIR_NAME); }
function receiptPath() { return path.join(receiptDir(), 'receipt.json'); }
// WO-39: default root is %LOCALAPPDATA%\TakeOne — never a Windows protected
// folder (Documents/Pictures/Videos/Music/Desktop), so Controlled Folder
// Access can't block the engine install.
// NOTE: lazy require — a top-level require here crashed the packaged app on
// Windows (root cause under investigation); lazy + defensive never blocks boot.
function defaultRoot() {
  try {
    const sr = require('./main/storage-root.js');
    return sr.defaultRoot(app.getPath.bind(app));
  } catch (err) {
    try { global.__takeoneLog && global.__takeoneLog('defaultRoot fallback: ' + String(err && err.message || err)); } catch {}
    // Ultimate fallback: never let a path lookup crash boot.
    try { return path.join(os.homedir(), 'TakeOne'); }
    catch { return path.join(os.tmpdir(), 'TakeOne'); }
  }
}
function configPath(root) { return path.join(root, 'config.json'); }
function pythonDir(root) { return path.join(root, '.python'); }
function bundledPythonTarball() { return path.join(process.resourcesPath, 'python.tar.gz'); }

async function readReceipt() {
  try { return JSON.parse(await fsp.readFile(receiptPath(), 'utf8')); }
  catch { return null; }
}
async function writeReceipt(data) {
  await fsp.mkdir(receiptDir(), { recursive: true });
  await fsp.writeFile(receiptPath(), JSON.stringify(data, null, 2), 'utf8');
}
async function readConfig(root) {
  try { return JSON.parse(await fsp.readFile(configPath(root), 'utf8')); }
  catch { return null; }
}
async function writeConfig(root, cfg) {
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(configPath(root), JSON.stringify(cfg, null, 2), 'utf8');
}
function defaultConfig(storageRoot) {
  return {
    version: CONFIG_VERSION,
    wizardCompleted: false,
    storageRoot,
    pcCheck: null,
    packChoice: null,
    customTools: [],
    existingModels: [],
    acknowledgedLater: false,
    niche: 'none',
    taste: {},
    settings: { language: 'en', experimentalVideo: false, experimentalImageModels: false },
  };
}

// ---------------------------------------------------------------------------
// Check-My-PC (REAL measurements, no assumptions)
// ---------------------------------------------------------------------------
function execFileHidden(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

async function detectGPU() {
  // nvidia-smi ships with the NVIDIA driver; also on PATH when drivers installed.
  const tried = [];
  if (process.platform === 'win32') {
    tried.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'));
  }
  tried.push('nvidia-smi');
  for (const bin of tried) {
    const out = await execFileHidden(bin, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 15000);
    const parsed = parseNvidiaSmi(out || '');
    if (parsed) return parsed;
  }
  return null;
}

async function diskFreeGB(dirPath) {
  // Node's statfs first; PowerShell fallback on Windows.
  try {
    const st = fs.statfsSync(dirPath);
    return (st.bavail * st.bsize) / 2 ** 30;
  } catch { /* fall through */ }
  if (process.platform === 'win32') {
    const drive = path.parse(path.resolve(dirPath)).root.replace(/\\$/, '') || 'C:';
    const out = await execFileHidden('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive '${drive[0]}').Free`], 15000);
    const bytes = parseInt((out || '').trim(), 10);
    if (!Number.isNaN(bytes)) return bytes / 2 ** 30;
  }
  return null;
}

/** Measured download speed (Mbps), or null when every probe fails. Never guessed. */
function measureSpeedMbps() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const tryUrl = (i) => {
      if (i >= SPEED_PROBE_URLS.length) return finish(null);
      const t0 = Date.now();
      let bytes = 0;
      const timer = setTimeout(() => { req.destroy(); tryUrl(i + 1); }, SPEED_PROBE_TIMEOUT_MS);
      const req = https.get(SPEED_PROBE_URLS[i], (res) => {
        if (res.statusCode !== 200) { clearTimeout(timer); res.resume(); return tryUrl(i + 1); }
        res.on('data', (c) => { bytes += c.length; });
        res.on('end', () => {
          clearTimeout(timer);
          const secs = (Date.now() - t0) / 1000;
          // A probe that trickles (<100 KB in the timeout window) says the path to
          // THIS probe host is unusable — try the next host instead of reporting
          // a fake 0. Only when every host fails do we report unmeasurable.
          if (secs <= 0 || bytes < 100 * 1024) return tryUrl(i + 1);
          finish(r1((bytes * 8) / secs / 1e6));
        });
        res.on('error', () => { clearTimeout(timer); tryUrl(i + 1); });
      });
      req.on('error', () => { clearTimeout(timer); tryUrl(i + 1); });
    };
    tryUrl(0);
  });
}

async function checkPC(rootForDisk) {
  const gpu = await detectGPU();
  const [diskFree, speed] = await Promise.all([
    diskFreeGB(rootForDisk),
    measureSpeedMbps(),
  ]);
  return {
    gpuName: gpu ? gpu.name : null,
    vramMB: gpu ? gpu.vramMB : null,
    ramGB: r1(os.totalmem() / 2 ** 30),
    diskFreeGB: diskFree === null ? null : r1(diskFree),
    speedMbps: speed,
    measuredAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Existing-model scan (REAL — walks <root>/Models)
// ---------------------------------------------------------------------------
async function scanExistingModels(root) {
  const modelsDir = path.join(root, 'Models');
  const found = [];
  let filesSeen = 0;
  async function walk(dir, depth) {
    if (depth > 4 || filesSeen > 20000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p, depth + 1); }
      else if (e.isFile()) {
        filesSeen++;
        const lower = e.name.toLowerCase();
        if (!/\.(safetensors|bin|pt|pth|gguf|onnx|ckpt)$/.test(lower)) continue;
        const hit = KNOWN_MODELS.find(([frag]) => lower.includes(frag));
        if (hit) {
          let sizeMB = 0;
          try { sizeMB = r1((await fsp.stat(p)).size / 2 ** 20); } catch { /* ignore */ }
          found.push({ file: e.name, tool: hit[1], sizeMB });
        }
      }
    }
  }
  await walk(modelsDir, 0);
  return found;
}

/** Scan ANY folder (e.g. an existing ComfyUI install) for this catalog's model files.
 *  Matches by exact catalog fileName or by its base fragment. Returns matches with
 *  their source path so the user can adopt (copy) them instead of re-downloading. */
async function scanFolderForModels(dir) {
  const found = [];
  let filesSeen = 0;
  async function walk(d, depth) {
    if (depth > 6 || filesSeen > 50000) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { await walk(fp, depth + 1); }
      else if (e.isFile()) {
        filesSeen++;
        const lower = e.name.toLowerCase();
        if (!/\.(safetensors|bin|pt|pth|gguf|onnx|ckpt)$/.test(lower)) continue;
        const tool = CATALOG.find(t => {
          if (t.installType !== 'file' || !t.fileName) return false;
          const fn = t.fileName.toLowerCase();
          const base = fn.replace(/\.[^.]+$/, '');
          return lower === fn || lower.includes(base);
        });
        if (tool) {
          let sizeMB = 0;
          try { sizeMB = r1((await fsp.stat(fp)).size / 2 ** 20); } catch {}
          found.push({
            toolId: tool.id, toolName: tool.friendlyName,
            file: e.name, sizeMB, fullPath: fp,
            fileName: tool.fileName, category: tool.category || 'misc',
          });
        }
      }
    }
  }
  await walk(dir, 0);
  return found;
}

/** Adopt matched files: COPY (not move) into this library's Models/<category>/<fileName>.
 *  The source app keeps working. Files already present are skipped, never overwritten.
 *  After this, toolInstalled() sees them - no re-download. */
async function adoptModels(matches, root) {
  const results = [];
  for (const m of matches) {
    const destDir = path.join(root, 'Models', m.category);
    const dest = path.join(destDir, m.fileName);
    try {
      let skip = false;
      try { const st = await fsp.stat(dest); if (st.size > 0) skip = true; } catch {}
      if (!skip) {
        await fsp.mkdir(destDir, { recursive: true });
        await fsp.copyFile(m.fullPath, dest);
      }
      results.push({ toolId: m.toolId, ok: true, skipped: skip });
    } catch (err) {
      results.push({ toolId: m.toolId, ok: false, reason: String(err.message || err) });
    }
  }
  return results;
}

/** Change the library root (Settings). Migrates config.json, updates the receipt.
 *  The app must relaunch afterwards - downloads in progress do not survive the move. */
async function changeStorageRoot(newRoot) {
  const cur = await readReceipt();
  const oldRoot = (cur && cur.storageRoot) || defaultRoot();
  if (path.resolve(newRoot) === path.resolve(oldRoot)) return { ok: true, moved: false };
  await fsp.mkdir(newRoot, { recursive: true });
  try {
    const oldCfg = await readConfig(oldRoot);
    const cfg = oldCfg || defaultConfig(newRoot);
    cfg.storageRoot = newRoot;
    await writeConfig(newRoot, cfg);
  } catch (err) { return { ok: false, reason: 'Could not write config: ' + String(err.message || err) }; }
  await writeReceipt({ storageRoot: newRoot, installedAt: (cur && cur.installedAt) || new Date().toISOString() });
  return { ok: true, moved: true };
}

// ---------------------------------------------------------------------------
// Folder size (for the uninstall questionnaire)
// ---------------------------------------------------------------------------
async function folderSizeBytes(dir) {
  let total = 0;
  async function walk(d, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* ignore */ } }
    }
  }
  await walk(dir, 0);
  return total;
}

/** Deterministic, root-scoped data removal for the uninstall flow.
 *  Never touches anything outside a verified TakeOne root. */
async function uninstallData(root, { models, projects, trash, temp }) {
  if (!isTakeOneRoot(root)) throw new Error('Refusing: not a TakeOne library root.');
  // Models / temp: re-downloadable or disposable - permanent delete is fine.
  const targets = [];
  if (models) targets.push(path.join(root, 'Models'));
  if (temp) targets.push(path.join(root, '.staging'));
  for (const t of targets) {
    await fsp.rm(t, { recursive: true, force: true });
  }
  // Projects = user CREATIONS (irreplaceable). The uninstall flow NEVER
  // permanently deletes them - they move into Trash with 30-day recovery.
  // (Added 2026-10-15: creations are not models; uninstall must not nuke them.)
  if (projects) {
    const src = path.join(root, 'Projects');
    try {
      const entries = await fsp.readdir(src);
      if (entries.length > 0) {
        await fsp.mkdir(path.join(root, 'Trash'), { recursive: true });
        const dest = path.join(root, 'Trash', 'projects-uninstalled__' + Date.now());
        await fsp.rename(src, dest);
      } else {
        await fsp.rm(src, { recursive: true, force: true });
      }
    } catch {}
  }
  // Old trash contents: removed only when explicitly ticked. Creations just
  // moved above keep their 30-day recovery window regardless.
  if (trash) {
    const trashDir = path.join(root, 'Trash');
    try {
      const entries = await fsp.readdir(trashDir);
      for (const e of entries) {
        if (/^projects-uninstalled__\d{13}$/.test(e)) continue;
        await fsp.rm(path.join(trashDir, e), { recursive: true, force: true });
      }
    } catch {}
  }
  return { removed: targets };
}

// ---------------------------------------------------------------------------
// Python unpack (first run)
// ---------------------------------------------------------------------------
async function ensurePython(root, onProgress) {
  const dest = pythonDir(root);
  const marker = path.join(dest, 'python.exe');
  if (fs.existsSync(marker)) return { skipped: true };
  const tarball = bundledPythonTarball();
  if (!fs.existsSync(tarball)) throw new Error('Bundled Python archive is missing from the install.');
  const tar = require('tar');
  await fsp.mkdir(dest, { recursive: true });
  // Count entries first so the splash can show real progress.
  let total = 0;
  await tar.t({ file: tarball, onentry: () => { total++; } });
  let done = 0;
  await tar.x({
    file: tarball, cwd: dest, strip: 1, // tarball has a top-level python/ folder
    onentry: () => { done++; if (onProgress) onProgress(done / Math.max(total, 1)); },
  });
  if (!fs.existsSync(marker)) throw new Error('Python unpack finished but python.exe was not found.');
  return { skipped: false };
}

// ---------------------------------------------------------------------------
// Phase B — Download Manager lifecycle + tool status
// ---------------------------------------------------------------------------
let dlm = null;
let dlmRoot = null;
let dlmStarting = null;
// FIX-8: tools whose finished download failed verification get ONE
// automatic resume-aware re-queue per session (good files reused, only
// bad files re-fetched). The guard lives here so a read path
// (toolStates, called on every render) can never loop downloads.
const autoRetryDone = new Set();

function aria2cPath() {
  if (process.env.TAKEONE_ARIA2) return process.env.TAKEONE_ARIA2;
  if (process.platform === 'win32' && isElectron) {
    return path.join(process.resourcesPath, 'aria2c.exe');
  }
  return 'aria2c'; // demo/dev on Linux: system binary
}

function toolStatusPath(root) { return path.join(root, '.staging', 'tool-status.json'); }

async function readToolStatus(root) {
  const cache = toolStatusCache[root];
  if (cache && cache.__loaded) {
    const c = { ...cache };
    delete c.__loaded;
    return c;
  }
  try { return JSON.parse(await fsp.readFile(toolStatusPath(root), 'utf8')); }
  catch { return {}; }
}
async function writeToolStatus(root, st) {
  await fsp.mkdir(path.join(root, '.staging'), { recursive: true });
  await fsp.writeFile(toolStatusPath(root), JSON.stringify(st, null, 2), 'utf8');
}
const toolStatusCache = {};
let toolStatusWriteQ = Promise.resolve();
async function setToolStatus(root, toolId, patch) {
  // In-memory first: concurrent callers never clobber each other.
  const cache = toolStatusCache[root] || (toolStatusCache[root] = {});
  try {
    if (!cache.__loaded) Object.assign(cache, await readToolStatus(root)), cache.__loaded = true;
  } catch { cache.__loaded = true; }
  cache[toolId] = { ...(cache[toolId] || {}), ...patch, at: new Date().toISOString() };
  const snapshot = JSON.parse(JSON.stringify(cache));
  delete snapshot.__loaded;
  // Serialize disk writes so they can't interleave.
  toolStatusWriteQ = toolStatusWriteQ.then(() => writeToolStatus(root, snapshot)).catch(() => {});
  return cache[toolId];
}

/** Lazily start the download engine for a storage root. */
async function getDLM(root) {
  if (dlm && dlmRoot === root) return dlm;
  if (dlmStarting) return dlmStarting;
  dlmStarting = (async () => {
    try {
      if (dlm) { try { await dlm.stop(); } catch { /* ignore */ } dlm = null; }
      const mgr = new DownloadManager({
        root,
        aria2cPath: aria2cPath(),
        diskFreeGB,
        onEvent: (type, data) => {
          if (studioWin && !studioWin.isDestroyed()) studioWin.webContents.send('dl-event', { type, ...data });
        },
      });
      await mgr.start();
      dlm = mgr; dlmRoot = root;
      return mgr;
    } finally {
      // C3: Always clear, even on failure — next call retries fresh
      // instead of returning the same rejection forever.
      dlmStarting = null;
    }
  })();
  return dlmStarting;
}

function toolById(id) { return CATALOG.find((t) => t.id === id) || null; }

/** Where a tool's files live once installed. */
function toolDestDir(root, tool) {
  return path.join(root, 'Models', tool.category || 'misc');
}

async function toolInstalled(root, tool) {
  try {
    if (tool.installType === 'file' && tool.fileName) {
      const st = await fsp.stat(path.join(toolDestDir(root, tool), tool.fileName));
      return st.size > 0;
    }
    if (tool.installType === 'hf') {
      // Byte-exact manifest check: a half-downloaded job must NOT read as installed.
      const d = path.join(toolDestDir(root, tool), tool.id);
      return (await hfInstalledStatus(d, tool.files)).complete;
    }
    const st = await readToolStatus(root);
    return st[tool.id] && st[tool.id].status === 'installed';
  } catch { return false; }
}

/** Merged per-tool state for the renderer. */
async function mergedToolStates(root) {
  const out = {};
  const mgr = dlm && dlmRoot === root ? dlm : null;
  const dlStates = mgr ? mgr.allStates() : {};
  const tstat = await readToolStatus(root);
  let vramMB = null;
  // M3: both experimental switches, as an object — effectiveAvailability
  // keys each experimental tool to its own switch (video vs imageModels).
  const experimentalOn = { video: false, imageModels: false };
  try {
    const cfg = await readConfig(root);
    vramMB = (cfg && cfg.pcCheck && cfg.pcCheck.vramMB) ?? null;
    experimentalOn.video = !!(cfg && cfg.settings && cfg.settings.experimentalVideo);
    experimentalOn.imageModels = !!(cfg && cfg.settings && cfg.settings.experimentalImageModels);
  } catch { /* config optional */ }
  for (const t of CATALOG) {
    const gate = vramAllowed(t, vramMB);
    const installed = await toolInstalled(root, t);
    const dl = dlStates[t.id];
    const ts = tstat[t.id];
    // FIX-8: the manifest detail for the done-but-not-installed case
    // (hfInstalledStatus's `bad`: first mismatching file + reason).
    // Without it the UI could only say "not installed" — the lie.
    let bad = null;
    if (!installed && dl && dl.status === 'done' && t.installType === 'hf') {
      try { bad = (await hfInstalledStatus(path.join(toolDestDir(root, t), t.id), t.files)).bad; } catch { /* keep null */ }
    }
    const dec = decideToolState({ installed, dl, ts, bad });
    const { state, progress, error, detail } = dec;
    // FIX-8 item 4: one automatic resume-aware re-queue per session.
    // The re-queued job reuses verified files (size match skips) and
    // re-fetches only the mismatching ones; a second failure stays
    // 'failed' with its plain error and a manual Try again.
    if (dec.needsAutoRetry && mgr && !autoRetryDone.has(t.id)) {
      autoRetryDone.add(t.id);
      const p = t.installType === 'hf' ? mgr.addHfDownload(t)
        : t.installType === 'file' ? mgr.addDownload(t) : Promise.resolve();
      p.catch(() => { /* the failed state above is what the UI shows */ });
    }
    // M2.6-ENABLE: an experimental tool with the switch OFF surfaces as
    // unavailable (Coming soon, no Install) through the exact WO-12/WO-16
    // fields the UI already honors — no renderer special-casing.
    const eff = effectiveAvailability(t, experimentalOn);
    out[t.id] = {
      state, progress, error, detail,
      // WO-12: catalog honesty reaches the UI — a tool marked unavailable in
      // main/catalog.js surfaces here so the renderer can show "Not Available"
      // and suppress its Install button.
      unavailable: eff ? eff.unavailable : null,
      // WO-16: plain-language user text (the only text the UI shows).
      unavailableUser: eff ? eff.unavailableUser : null,
      gateOk: gate.ok, gateReason: gate.reason || null, gateWhy: gate.whyLink || null,
      deps: IMPLICIT_DEPS[t.installType] || [],
      verifiedAt: (ts && ts.verifiedAt) || null,
      speedBps: (dl && dl.speedBps) || 0,
    };
  }
  return out;
}

/**
 * WO-41.5: the ONE source of truth for "can the Studio Image step generate?".
 * The Models page badge answers "is the file on disk?" (toolInstalled);
 * the Studio step answers "can it run?" — engineReady AND image-studio
 * installed. The old Studio preview reused only the file answer, so a
 * missing engine read as "Needs a tool" next to an "Installed" badge.
 * Callers must use this (not re-derive it) for step readiness.
 */
async function imageStepReady(root) {
  const r = root;
  const engine = require('./main/engine.js');
  const engineReady = await engine.engineReady(r);
  const tool = toolById('image-studio');
  const modelInstalled = tool ? await toolInstalled(r, tool) : false;
  return { engineReady, modelInstalled, ready: engineReady && modelInstalled };
}

/** Plain-words online check (DNS). Never throws. */
function checkOnline() {
  return new Promise((resolve) => {
    dns.lookup('huggingface.co', { family: 4 }, (err) => resolve(!err));
    setTimeout(() => resolve(false), 8000);
  });
}

// ---------------------------------------------------------------------------
// Windows (Electron only)
// ---------------------------------------------------------------------------
let wizardWin = null;
let studioWin = null;
let splashWin = null;

function createSplash() {
  splashWin = new BrowserWindow({
    width: 420, height: 220, resizable: false, frame: false,
    backgroundColor: '#0B0B0F', show: false, center: true,
  });
  splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWin.once('ready-to-show', () => splashWin.show());
}

function createWizard() {
  wizardWin = new BrowserWindow({
    width: 1060, height: 720, minWidth: 940, minHeight: 640,
    backgroundColor: '#0B0B0F', show: false, center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  wizardWin.loadFile(path.join(__dirname, 'renderer', 'wizard.html'),
    process.env.TAKEONE_SMOKE === '1' ? { query: { smoke: '1' } } : {});
  wizardWin.webContents.on('did-finish-load', () => slog('wizard: page loaded'));
  wizardWin.once('ready-to-show', () => wizardWin.show());
  wizardWin.on('closed', () => { wizardWin = null; });
}

function createStudio() {
  studioWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 640,
    backgroundColor: '#0B0B0F', show: false, center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  studioWin.loadFile(path.join(__dirname, 'renderer', 'studio.html'));
  studioWin.once('ready-to-show', () => studioWin.show());
  studioWin.on('closed', () => { studioWin = null; });
  // Phase C: silently purge trash entries older than 30 days on every launch.
  (async () => {
    try {
      const receipt = await readReceipt();
      const root = (receipt && receipt.storageRoot) || defaultRoot();
      await libMod.purgeExpiredTrash(root);
    } catch { /* non-fatal */ }
  })();
}

function openStudioFromWizard() {
  if (wizardWin) { wizardWin.close(); }
  createStudio();
}

const SMOKE_LOG = process.env.TAKEONE_SMOKE_LOG;
function slog(...a) {
  if (process.env.TAKEONE_SMOKE !== '1') return;
  const line = '[smoke] ' + a.map(String).join(' ');
  try { if (SMOKE_LOG) fs.appendFileSync(SMOKE_LOG, line + '\n'); } catch { /* ignore */ }
  console.log(line);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try { global.__takeoneLog && global.__takeoneLog('BOOT start'); } catch {}
  // WO-38: watch the event loop — lag > 500 ms or an IPC handler > 200 ms
  // gets written to the app log with the current operation attached.
  try {
    const tlog = global.__takeoneLog || (() => {});
    loopMonitor.startLoopMonitor(
      (info) => tlog(`LOOP-LAG ${info.lagMs}ms op=${info.op || 'none'} at=${info.at}`));
    const _wrap = (name, fn) => loopMonitor.wrapIpcHandler(name, fn,
      (s) => tlog(`IPC-SLOW ${s.name} took ${s.durationMs}ms`));
    global.__takeoneWrapIpc = _wrap;
  } catch { /* the monitor never breaks boot */ }
  const forceWizard = process.env.TAKEONE_FORCE_WIZARD === '1';
  const receipt = await readReceipt();
  let root = (receipt && receipt.storageRoot) || defaultRoot();
  let rootNotice = null;
  let protectedFrom = null;
  // WO-39: existing root inside a Windows protected folder (Documents,
  // Pictures, Videos, Music, Desktop)? New data goes to LOCALAPPDATA.
  // The old files are NEVER touched, moved or deleted.
  try {
    const getP = app.getPath.bind(app);
    let srMod = null;
    try { srMod = require('./main/storage-root.js'); }
    catch (e) { try { global.__takeoneLog && global.__takeoneLog('storage-root module missing: ' + String(e && e.message || e)); } catch {} }
    if (srMod && srMod.isProtectedFolder(root, getP)) {
      const ladRoot = srMod.defaultRoot(getP);
      if (path.resolve(ladRoot) !== path.resolve(root)) {
        protectedFrom = root;
        rootNotice = {
          kind: 'protected-move',
          from: protectedFrom, to: ladRoot,
          text: "TakeOne now keeps its files in a folder Windows doesn't restrict. " +
            'Your old files are still at ' + protectedFrom + ' — nothing was moved or deleted.',
        };
        try { global.__takeoneLog && global.__takeoneLog('WO-39 protected root moved: ' + protectedFrom + ' -> ' + ladRoot); } catch {}
        root = ladRoot;
        await writeReceipt({
          storageRoot: root,
          previousProtectedRoot: protectedFrom,
          installedAt: (receipt && receipt.installedAt) || new Date().toISOString(),
        });
      }
    }
    // WO-39: startup test-write. If Windows Security blocks the root,
    // say so in plain words and fall back to LOCALAPPDATA automatically.
    const probe = await srMod.probeWritable(root);
    if (!probe.ok && srMod.isBlockedBySecurity(probe.code)) {
      const ladRoot = srMod.defaultRoot(getP);
      const msg = srMod.blockedMessage(root);
      if (path.resolve(ladRoot) !== path.resolve(root)) {
        rootNotice = {
          kind: 'blocked-fallback', from: root, to: ladRoot,
          text: msg.body + " TakeOne switched to a folder Windows doesn't restrict: " + ladRoot,
        };
        try { global.__takeoneLog && global.__takeoneLog('WO-39 root blocked (' + probe.code + '), fallback: ' + root + ' -> ' + ladRoot); } catch {}
        root = ladRoot;
        await writeReceipt({
          storageRoot: root,
          previousProtectedRoot: protectedFrom || (receipt && receipt.storageRoot) || null,
          installedAt: (receipt && receipt.installedAt) || new Date().toISOString(),
        });
      } else {
        rootNotice = { kind: 'blocked', from: root, text: msg.body };
      }
    }
  } catch (err) {
    try { global.__takeoneLog && global.__takeoneLog('WO-39 root resolve failed: ' + String(err && err.message || err)); } catch {}
  }
  // WO-40: the smoke test proves the resolved root from the app log, so the
  // final root is always logged here (normal path, protected move, and
  // blocked fallback alike) — never only on the move/fallback branches.
  try { global.__takeoneLog && global.__takeoneLog('storage root: ' + root); } catch {}
  global.__takeoneRootNotice = rootNotice;
  // Stale install states: no pip process survives a restart, so 'installing',
  // 'queued', or 'cancelling' on boot is a lie. Reset to neutral — the user
  // can retry. Never leave the user stuck with no button to press.
  try {
    const tst = await readToolStatus(root);
    let dirty = false;
    for (const [tid, t] of Object.entries(tst)) {
      if (t && (t.status === 'installing' || t.status === 'queued' || t.status === 'cancelling')) {
        t.status = 'not-installed'; t.detail = null; t.error = null; dirty = true;
      }
    }
    if (dirty) await writeToolStatus(root, tst);
  } catch { /* non-fatal */ }
  let cfg = await readConfig(root);
  // FIX-4: heal a stale config storageRoot field on disk (the receipt
  // root is authoritative). A config that still names an old root used
  // to split creation from reading; after this, disk and receipt agree.
  if (cfg && cfg.storageRoot && cfg.storageRoot !== root) {
    cfg.storageRoot = root;
    try { await writeConfig(root, cfg); } catch { /* heal is best-effort */ }
    try { global.__takeoneLog && global.__takeoneLog('FIX-4 healed stale config storageRoot -> ' + root); } catch {}
  }

  if (cfg && cfg.wizardCompleted && !forceWizard) {
    // Adopt existing library (incl. reinstall-over-existing). No wizard again.
    slog('boot: adopting existing library, opening studio');
    createStudio();
    return;
  }
  if (!cfg) cfg = defaultConfig(root);

  // First run: unpack Python with a splash, then the wizard.
  createSplash();
  try {
    await ensurePython(root, (frac) => {
      if (splashWin && !splashWin.isDestroyed()) {
        splashWin.webContents.send('splash-progress', Math.round(frac * 100));
      }
    });
  } catch (err) {
    slog('boot: splash error: ' + String(err.message || err));
    if (splashWin && !splashWin.isDestroyed()) {
      splashWin.webContents.send('splash-error', String(err.message || err));
      return; // stay on the error screen; user can retry or quit
    }
  }
  if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  slog('boot: splash done, opening wizard');
  createWizard();
}

// ---------------------------------------------------------------------------
// IPC (Electron only)
// ---------------------------------------------------------------------------
// FIX-4 (FINAL): after ANY project/asset mutation, the main process tells
// the Studio window the Library changed. The Library page re-reads from
// disk on the event — so a project created while the app runs appears
// without a restart, whether the tab is open or opened later (the tab
// switch ALSO re-reads; both paths exist on purpose).
function emitLibraryChanged() {
  try {
    if (studioWin && !studioWin.isDestroyed()) studioWin.webContents.send('takeone:library-changed');
  } catch { /* a dead window never breaks a save */ }
}
function wireIPC() {
  try { global.__takeoneLog && global.__takeoneLog('WIREIPC start'); } catch {}
  ipcMain.handle('takeone:checkPC', async (e, rootForDisk) => {
    const r = await checkPC(rootForDisk || defaultRoot());
    slog('ipc: checkPC ok gpu=' + (r.gpuName || 'none') + ' ram=' + r.ramGB + ' disk=' + r.diskFreeGB + ' speed=' + r.speedMbps);
    return r;
  });
  ipcMain.handle('takeone:recommendPack', async (e, pc) => recommendPack(pc));
  ipcMain.handle('takeone:validateWizard', async (e, w) => validateWizardCompletion(w));
  ipcMain.handle('takeone:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('takeone:defaultRoot', async () => defaultRoot());
  // WO-39: the boot-time storage notice (protected move / blocked fallback),
  // shown once as a plain-words banner in the Studio.
  ipcMain.handle('takeone:rootNotice', async () => global.__takeoneRootNotice || null);
  ipcMain.handle('takeone:getVersion', async () => {
    try { return require('./package.json').version; }
    catch { return 'unknown'; }
  });
  ipcMain.handle('takeone:displayPath', async (e, p) => maskPersonalPath(p));
  ipcMain.handle('takeone:diskFree', async (e, dir) => {
    const v = await diskFreeGB(dir);
    return v === null ? null : r1(v);
  });
  ipcMain.handle('takeone:scanModels', async (e, root) => scanExistingModels(root));
  ipcMain.handle('takeone:validateRoot', async (e, dir) => {
    try { return await validateStorageRoot(dir); }
    catch (err) { return { ok: false, reason: String(err.message || err), conflicts: [] }; }
  });
  ipcMain.handle('takeone:scanFolderModels', async (e, dir) => {
    try { return { ok: true, found: await scanFolderForModels(dir) }; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:adoptModels', async (e, matches, root) => {
    try { return { ok: true, results: await adoptModels(matches || [], root || defaultRoot()) }; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:changeRoot', async (e, newRoot) => {
    try { return await changeStorageRoot(newRoot); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:relaunch', async () => { app.relaunch(); app.exit(0); });
  ipcMain.handle('takeone:getConfig', async (e, root) => {
    // FIX-4: with no explicit root, the receipt root is authoritative and
    // the returned config's storageRoot is normalized to it — a stale
    // field inside the config file can no longer send creation to one
    // folder and the Library to another. (An explicit root arg is honored
    // as-is; only the renderer's no-arg calls go through this path.)
    if (!root) {
      const receipt = await readReceipt();
      root = (receipt && receipt.storageRoot) || defaultRoot();
      const cfg = await readConfig(root);
      if (cfg) {
        const srMod = (() => { try { return require('./main/storage-root.js'); } catch { return null; } })();
        return srMod ? srMod.normalizeConfigStorageRoot(cfg, root) : cfg;
      }
      return cfg;
    }
    return readConfig(root);
  });
  ipcMain.handle('takeone:saveWizard', async (e, payload) => {
    const root = payload.storageRoot || defaultRoot();
    const cfg = defaultConfig(root);
    Object.assign(cfg, {
      wizardStep: payload.wizardStep || 1,
      pcCheck: payload.pcCheck || null,
      packChoice: payload.packChoice || null,
      customTools: payload.customTools || [],
      existingModels: payload.existingModels || [],
      acknowledgedLater: !!payload.acknowledgedLater,
      niche: payload.niche || 'none',
    });
    await writeConfig(root, cfg);
    await writeReceipt({ storageRoot: root, installedAt: new Date().toISOString() });
    return { ok: true };
  });
  ipcMain.handle('takeone:finishWizard', async (e, payload) => {
    const root = payload.storageRoot || defaultRoot();
    const v = validateWizardCompletion(payload);
    if (!v.ok) return v; // Gate 2 enforced in main, not just the renderer
    const cfg = (await readConfig(root)) || defaultConfig(root);
    Object.assign(cfg, {
      wizardCompleted: true,
      pcCheck: payload.pcCheck || cfg.pcCheck,
      packChoice: payload.packChoice,
      customTools: payload.customTools || [],
      existingModels: payload.existingModels || [],
      acknowledgedLater: !!payload.acknowledgedLater,
      niche: payload.niche || 'none',
    });
    await writeConfig(root, cfg);
    await writeReceipt({ storageRoot: root, installedAt: new Date().toISOString() });
    openStudioFromWizard();
    return { ok: true };
  });
  ipcMain.handle('takeone:folderSizes', async (e, root) => {
    const sizes = {};
    for (const k of ['Models', 'Projects', 'Trash', '.staging']) {
      sizes[k] = await folderSizeBytes(path.join(root, k));
    }
    return sizes;
  });
  ipcMain.handle('takeone:uninstallData', async (e, root, sel) => uninstallData(root, sel));
  ipcMain.handle('takeone:runUninstaller', async () => {
    // The NSIS uninstaller next to the installed exe; then quit.
    const exeDir = path.dirname(process.execPath);
    const cands = [
      path.join(exeDir, 'Uninstall TakeOne Studio.exe'),
      path.join(exeDir, '..', 'Uninstall TakeOne Studio.exe'),
    ];
    for (const c of cands) {
      if (fs.existsSync(c)) {
        const { spawn } = require('child_process');
        spawn(c, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        app.quit();
        return { ok: true };
      }
    }
    return { ok: false, reason: 'Uninstaller not found. Please uninstall from Windows Settings > Apps.' };
  });
  ipcMain.handle('takeone:showInFolder', async (e, p) => { shell.showItemInFolder(p); return { ok: true }; });
  ipcMain.handle('takeone:quit', async () => { app.quit(); });

  // ---- Phase B: Model Manager -------------------------------------------
  ipcMain.handle('takeone:catalog', async () => {
    const v = validateCatalog(CATALOG);
    if (!v.ok) return { ok: false, errors: v.errors };
    const sig = catalogSignature();
    if (!verifyCatalog(sig)) return { ok: false, errors: ['Catalog signature mismatch.'] };
    return { ok: true, catalog: CATALOG, signature: sig };
  });
  ipcMain.handle('takeone:installPlan', async (e, toolId) => {
    const t = toolById(toolId);
    return t ? { ok: true, plan: installPlan(t) } : { ok: false };
  });
  ipcMain.handle('takeone:toolStates', async (e, root) => {
    try { return { ok: true, states: await mergedToolStates(root || defaultRoot()) }; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:checkOnline', async () => ({ online: await checkOnline() }));

  // ── ComfyUI engine (Phase D: real generation) ──
  // WO-41: the app starts ComfyUI through createEngineComfy — the SAME
  // function tools/e2e-image.js uses. The old getComfy built its own
  // ComfyManager WITHOUT the extra_model_paths config, which is exactly
  // why ComfyUI's checkpoint list was empty on Ali's PC.
  const { createEngineComfy, MODEL_NOT_VISIBLE_MSG, VIDEO_NOT_VISIBLE_MSG } = require('./main/comfy.js');
  const { sdxlLightningTxt2Img, aspectDims, DEFAULT_NEGATIVE, presetParams, buildAliPackJobs,
    wanVideo, videoDims, videoFrames, VIDEO_DEFAULTS, DEFAULT_VIDEO_NEGATIVE, buildVideoAliPackJobs,
    zImage, fluxKlein, IMAGE_MODEL_FILES, buildImageModelsPackJobs } = require('./main/comfy-workflows.js');
  const videoModel = require('./main/video-model.js');
  const engine = require('./main/engine.js');
  let comfyMgr = null;
  // WO-43: per-prompt sidecar facts for the Library save. The renderer knows
  // the prompt text, but only main knows the seed + model it queued — so
  // generate stashes them here keyed by promptId, and fetchOutput reads them.
  const qgMeta = new Map();
  // M2: same stash for video prompts (queuedAt matters: main picks the
  // newest mp4 in ComfyUI/output/video written after queue time).
  const videoMeta = new Map();
  function getComfy(root) {
    if (!comfyMgr) {
      comfyMgr = createEngineComfy({
        root,
        onEvent: (type, data) => {
          if (studioWin && !studioWin.isDestroyed()) {
            studioWin.webContents.send('comfy-event', { type, ...data });
          }
        },
      });
    }
    return comfyMgr;
  }
  // ── Engine install (WO-23) ──
  let engineToken = null;
  ipcMain.handle('takeone:engineInstall', async (e, root) => {
    const r = root || defaultRoot();
    engineToken = engine.newCancelToken();
    // Use the app's single download manager (one aria2c daemon, not two).
    const mgr = await getDLM(r);
    const res = await engine.installEngine(r, {
      cancelToken: engineToken,
      onEvent: loopMonitor.trackEnginePhase((ev) => {
        if (studioWin && !studioWin.isDestroyed()) studioWin.webContents.send('engine-event', ev);
      }),
      deps: {
        downloadFiles: async (files, { onEvent, cancelToken }) => {
          const rr = await mgr.addManifestJob({ id: 'takeone-engine', files, category: 'engine' });
          if (!rr.ok) return { ok: false, why: rr.reason || 'Could not start the download.', whatNext: 'Check your internet connection and try again.' };
          const st = await mgr.waitFor('takeone-engine', cancelToken);
          if (st === 'cancelled' || (cancelToken && cancelToken.cancelled)) {
            // WO-29: delete the in-progress partial, keep verified files; report freed bytes.
            let freedBytes = 0;
            try { const c = await mgr.cancel('takeone-engine'); freedBytes = (c && c.freedBytes) || 0; } catch { /* ignore */ }
            return { ok: false, cancelled: true, freedBytes, why: 'Install cancelled.', whatNext: 'You can start the install again any time.' };
          }
          if (st !== 'done') {
            const je = mgr.entries.get('takeone-engine');
            return { ok: false, why: (je && je.error) || 'Some engine files could not be downloaded.', whatNext: 'Check your internet connection and try again. Downloaded files are kept.' };
          }
          return { ok: true };
        },
      },
    });
    engineToken = null;
    return res;
  });
  ipcMain.handle('takeone:engineCancel', async () => {
    if (engineToken) engineToken.cancelled = true;
    engine.cancelEngineInstall();
    return { ok: true };
  });
  ipcMain.handle('takeone:engineStatus', async (e, root) => {
    const r = root || defaultRoot();
    return { ok: true, ready: await engine.engineReady(r), state: await engine.readEngineState(r) };
  });
  // WO-32: one-click diagnostics report (plain text, clipboard; user names masked, no secrets).
  // WO-35: the builder is async — nvidia-smi never blocks the UI thread.
  ipcMain.handle('takeone:diagnostics', async (e, root) => {
    try {
      const r = root || defaultRoot();
      // WO-41: when ComfyUI is running, the Engine section lists its real
      // checkpoint list from /object_info; otherwise it says unavailable.
      const over = {};
      if (comfyMgr && comfyMgr.isRunning()) over.comfyPort = comfyMgr.port;
      // FIX-4 (Msg 1 item 4): what the Library reads vs what is on disk.
      // A gap here means folders without project.json (orphans) or a stale
      // list — the two things the stale-list fix must never hide.
      try {
        over.libraryRead = (await libMod.listProjects(r)).length;
        const entries = await fs.promises.readdir(path.join(r, 'Projects'), { withFileTypes: true }).catch(() => []);
        over.libraryOnDisk = entries.filter((e) => e.isDirectory()).length;
      } catch { /* diagnostics never breaks on a Library read failure */ }
      // FIX-8 item 1: video-studio files vs manifest, first mismatch,
      // raw download record, derived tool state. Derived via the pure
      // decideToolState (same decision as toolStates) so diagnostics
      // never triggers the automatic re-queue — it only reports.
      try {
        const vs = toolById('video-studio');
        if (vs) {
          const dir = path.join(r, 'Models', vs.category || 'video', vs.id);
          const chk = await hfInstalledStatus(dir, vs.files);
          const files = [];
          for (const f of vs.files) {
            let size = null;
            try { size = (await fs.promises.stat(path.join(dir, f.path))).size; } catch { /* missing */ }
            files.push({ path: f.path, size, expected: f.bytes });
          }
          const mgr = dlm && dlmRoot === r ? dlm : null;
          const dl = mgr ? (mgr.allStates()['video-studio'] || null) : null;
          let ts = null;
          try { ts = (await readToolStatus(r))['video-studio'] || null; } catch { /* ignore */ }
          const dec = decideToolState({ installed: chk.complete, dl, ts, bad: chk.bad });
          over.videoStudio = { dir, files, firstMismatch: chk.bad, dlState: dl, toolState: dec.state, toolError: dec.error };
        }
      } catch { /* diagnostics never breaks on a video-studio check failure */ }
      const report = await require('./main/diagnostics.js').buildDiagnosticsReport(r, over);
      return { ok: true, report };
    } catch (err) {
      return { ok: false, reason: 'Could not build the diagnostics report.' };
    }
  });
  // WO-41.5: single source of truth for Studio Image-step readiness.
  ipcMain.handle('takeone:imageStepReady', async (e, root) => {
    try {
      const r = root || defaultRoot();
      return { ok: true, ...(await imageStepReady(r)) };
    } catch (err) {
      return { ok: false, reason: String(err && err.message || err) };
    }
  });
  ipcMain.handle('takeone:comfyStart', async (e, root) => {
    const r = root || defaultRoot();
    return getComfy(r).start();
  });
  ipcMain.handle('takeone:comfyStop', async () => {
    if (comfyMgr) return comfyMgr.stop();
    return { ok: true };
  });
  ipcMain.handle('takeone:comfyStatus', async () => {
    return { ok: true, running: comfyMgr ? comfyMgr.isRunning() : false };
  });
  ipcMain.handle('takeone:comfyGenerate', async (e, root, params) => {
    const r = root || defaultRoot();
    // WO-27: plain-words engine check BEFORE touching ComfyUI — the renderer
    // turns engineMissing into "Install the engine" guidance.
    // WO-41: assertEngineReady is async — awaiting it (the old code called
    // it without await, so the catch could never fire).
    try {
      await engine.assertEngineReady(r);
    } catch (err) {
      return { ok: false, engineMissing: true, error: err.message };
    }
    const mgr = getComfy(r);
    if (!mgr.isRunning()) {
      const st = await mgr.start();
      if (!st.ok) return st;
    }
    // WO-41.2: NO hard-coded checkpoint. Quick Generate always uses the
    // INSTALLED Image Studio model from the catalog (SDXL-Lightning), with
    // the Lightning workflow from comfy-workflows.js. A caller-supplied
    // checkpoint name is ignored — the UI offers no such choice.
    const tool = toolById('image-studio');
    if (!tool || !(await toolInstalled(r, tool))) {
      return { ok: false, error: "Image Studio isn't installed yet. Open Models and download it.", action: 'models' };
    }
    const checkpoint = tool.fileName;
    // WO-41.3: preflight — is the model visible to ComfyUI's loader? If the
    // list comes back but the model is not in it, fail HERE in plain words
    // instead of queueing a prompt ComfyUI will reject with a 400.
    const pre = await mgr.getCheckpointList();
    if (pre.ok && !pre.checkpoints.includes(checkpoint)) {
      return { ok: false, modelNotVisible: true, error: MODEL_NOT_VISIBLE_MSG, action: 'models' };
    }
    // (Preflight failure itself is not fatal: queueing will surface a plain
    // error if the model really is missing.)
    // M1: variations (1-4), aspect picker, preset, seed lock, default
    // negative. The seed is chosen HERE (not inside the workflow builder)
    // so the Library sidecar records exactly what was generated; variation
    // i uses baseSeed + i, so a locked seed reproduces the whole set.
    const variations = Math.min(4, Math.max(1, parseInt(params.variations, 10) || 1));
    const [width, height] = aspectDims(params.aspect);
    const preset = presetParams(params.preset);
    const negative = (params.negative || '').trim() ? params.negative : DEFAULT_NEGATIVE;
    const baseSeed = Number.isFinite(Number(params.seed)) && params.seed !== '' && params.seed !== null
      ? Math.floor(Number(params.seed)) : Math.floor(Math.random() * 1000000000);
    const promptIds = [];
    for (let i = 0; i < variations; i++) {
      const seed = baseSeed + i;
      const workflow = sdxlLightningTxt2Img({
        checkpoint,
        positive: params.prompt || '',
        negative,
        width, height, seed,
        steps: preset.steps, cfg: preset.cfg,
      });
      const q = await mgr.queuePrompt(workflow);
      if (!q.ok) {
        // WO-41.3: the FULL raw error goes to the app log only. The
        // renderer receives plain words — never raw JSON.
        try { global.__takeoneLog && global.__takeoneLog('comfyGenerate raw error: ' + (q.rawError || q.error)); } catch {}
        const { rawError, ...plain } = q;
        return plain;
      }
      promptIds.push(q.promptId);
      qgMeta.set(q.promptId, {
        prompt: params.prompt || '', model: checkpoint, seed,
        width, height, preset: params.preset || 'fast', aspect: params.aspect || '1:1',
        variation: i,
      });
    }
    return { ok: true, promptIds, promptId: promptIds[0], variations, width, height, seed: baseSeed, preset: params.preset || 'fast', aspect: params.aspect || '1:1' };
  });
  // M1: the Ali pack — 3 prompts x 3 settings, ONE seed (buildAliPackJobs).
  // Queues all 9; the renderer polls each promptId and assembles the
  // contact sheet. Same seed across the pack = settings are comparable.
  ipcMain.handle('takeone:comfyGeneratePack', async (e, root, params) => {
    const r = root || defaultRoot();
    try { await engine.assertEngineReady(r); }
    catch (err) { return { ok: false, engineMissing: true, error: err.message }; }
    const mgr = getComfy(r);
    if (!mgr.isRunning()) {
      const st = await mgr.start();
      if (!st.ok) return st;
    }
    const tool = toolById('image-studio');
    if (!tool || !(await toolInstalled(r, tool))) {
      return { ok: false, error: "Image Studio isn't installed yet. Open Models and download it.", action: 'models' };
    }
    const checkpoint = tool.fileName;
    const pre = await mgr.getCheckpointList();
    if (pre.ok && !pre.checkpoints.includes(checkpoint)) {
      return { ok: false, modelNotVisible: true, error: MODEL_NOT_VISIBLE_MSG, action: 'models' };
    }
    const seed = Number.isFinite(Number(params && params.seed)) && params.seed !== '' && params.seed !== null
      ? Math.floor(Number(params.seed)) : Math.floor(Math.random() * 1000000000);
    const jobs = buildAliPackJobs(seed);
    const queued = [];
    for (const job of jobs) {
      const pp = presetParams(job.preset);
      const workflow = sdxlLightningTxt2Img({
        checkpoint, positive: job.prompt, negative: job.negative,
        width: job.width, height: job.height, seed: job.seed,
        steps: pp.steps, cfg: pp.cfg,
      });
      const q = await mgr.queuePrompt(workflow);
      if (!q.ok) {
        try { global.__takeoneLog && global.__takeoneLog('comfyGeneratePack raw error: ' + (q.rawError || q.error)); } catch {}
        const { rawError, ...plain } = q;
        return plain;
      }
      qgMeta.set(q.promptId, {
        prompt: job.prompt, model: checkpoint, seed: job.seed,
        width: job.width, height: job.height, preset: job.preset, aspect: job.aspect,
      });
      queued.push({ ...job, promptId: q.promptId });
    }
    return { ok: true, seed, jobs: queued };
  });
  // M1: save the Ali pack contact sheet (a dataUrl from the renderer's
  // canvas) into the Quick Generate project, next to the 9 images.
  ipcMain.handle('takeone:saveContactSheet', async (e, root, dataUrl) => {
    try {
      const r = root || defaultRoot();
      const project = await libMod.ensureQuickGenerateProject(r);
      const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, reason: 'Not a PNG data URL.' };
      const target = path.join(project.dir, 'contact_sheet.png');
      await fs.promises.writeFile(target, Buffer.from(m[1], 'base64'));
      emitLibraryChanged();
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, reason: 'Could not save the contact sheet.' };
    }
  });
  // M3: the image-models Ali pack — 3 prompts x 3 models, ONE seed
  // (buildImageModelsPackJobs). Queues all 9; the renderer polls each
  // promptId and assembles ONE 3x3 contact sheet. Refuses while the
  // image-models switch is OFF, and names any model that is not
  // installed yet instead of queueing a prompt ComfyUI will reject.
  ipcMain.handle('takeone:comfyGenerateImageModelsPack', async (e, root, params) => {
    const r = root || defaultRoot();
    try {
      const cfg = await readConfig(r);
      if (!(cfg && cfg.settings && cfg.settings.experimentalImageModels)) {
        return { ok: false, error: 'Image models are experimental and switched off. Turn on “Experimental: image models” in Settings first.', action: 'settings' };
      }
    } catch { return { ok: false, error: 'Could not read your settings.' }; }
    try { await engine.assertEngineReady(r); }
    catch (err) { return { ok: false, engineMissing: true, error: err.message }; }
    const mgr = getComfy(r);
    if (!mgr.isRunning()) {
      const st = await mgr.start();
      if (!st.ok) return st;
    }
    const missing = [];
    for (const id of ['image-studio', 'z-image-turbo', 'flux2-klein-4b']) {
      const tool = toolById(id);
      if (!tool || !(await toolInstalled(r, tool))) missing.push(tool ? tool.friendlyName : id);
    }
    if (missing.length) {
      return { ok: false, error: `Not installed yet: ${missing.join(', ')}. Open Models and download them first.`, action: 'models' };
    }
    // Preflight: are the loader names visible to ComfyUI? A missing
    // name here means the extra_model_paths mapping is wrong — fail in
    // plain words instead of queueing 9 prompts ComfyUI rejects.
    // (Preflight failure itself is not fatal: queueing surfaces a plain
    // error if a model really is missing.)
    try {
      const info = await mgr.getObjectInfo();
      if (info && info.ok && info.info) {
        const listOf = (node, input) => {
          try {
            const spec = info.info[node] && info.info[node].input && info.info[node].input.required
              && info.info[node].input.required[input];
            return Array.isArray(spec && spec[0]) ? spec[0].map((s) => String(s).replace(/\\/g, '/')) : [];
          } catch { return []; }
        };
        const unets = listOf('UNETLoader', 'unet_name');
        const clips = listOf('CLIPLoader', 'clip_name');
        const vaes = listOf('VAELoader', 'vae_name');
        const want = ['z_image_turbo_bf16.safetensors', 'flux-2-klein-4b.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors', 'flux2-vae.safetensors'];
        const absent = want.filter((n) => !(unets.includes(n) || clips.includes(n) || vaes.includes(n)));
        if (absent.length) {
          return { ok: false, modelNotVisible: true, error: `ComfyUI cannot see these model files: ${absent.join(', ')}. They are downloaded but not visible — check Models, then try again.`, action: 'models' };
        }
      }
    } catch { /* preflight optional */ }
    const seed = Number.isFinite(Number(params && params.seed)) && params.seed !== '' && params.seed !== null
      ? Math.floor(Number(params.seed)) : Math.floor(Math.random() * 1000000000);
    const jobs = buildImageModelsPackJobs(seed);
    const queued = [];
    for (const job of jobs) {
      let workflow;
      if (job.model === 'z-image-turbo') {
        const f = IMAGE_MODEL_FILES['z-image-turbo'];
        workflow = zImage({ unet: f.unet, clip: f.clip, vae: f.vae, positive: job.prompt, width: job.width, height: job.height, seed: job.seed });
      } else if (job.model === 'flux2-klein-4b') {
        const f = IMAGE_MODEL_FILES['flux2-klein-4b'];
        workflow = fluxKlein({ unet: f.unet, clip: f.clip, vae: f.vae, positive: job.prompt, width: job.width, height: job.height, seed: job.seed });
      } else {
        const tool = toolById('image-studio');
        workflow = sdxlLightningTxt2Img({
          checkpoint: tool.fileName, positive: job.prompt, negative: DEFAULT_NEGATIVE,
          width: job.width, height: job.height, seed: job.seed, steps: 4, cfg: 1,
        });
      }
      const q = await mgr.queuePrompt(workflow);
      if (!q.ok) {
        try { global.__takeoneLog && global.__takeoneLog('comfyGenerateImageModelsPack raw error: ' + (q.rawError || q.error)); } catch {}
        const { rawError, ...plain } = q;
        return plain;
      }
      qgMeta.set(q.promptId, {
        prompt: job.prompt, model: job.model, seed: job.seed,
        width: job.width, height: job.height,
      });
      queued.push({ ...job, promptId: q.promptId });
    }
    return { ok: true, seed, jobs: queued };
  });
  // M3: save the image-models pack contact sheet (a dataUrl from the
  // renderer's canvas) into the Quick Generate project as its OWN file
  // — never overwriting the M1 pack's contact_sheet.png.
  ipcMain.handle('takeone:saveImageModelsSheet', async (e, root, dataUrl) => {
    try {
      const r = root || defaultRoot();
      const project = await libMod.ensureQuickGenerateProject(r);
      const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, reason: 'Not a PNG data URL.' };
      const target = path.join(project.dir, 'image_models_sheet.png');
      await fs.promises.writeFile(target, Buffer.from(m[1], 'base64'));
      emitLibraryChanged();
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, reason: 'Could not save the contact sheet.' };
    }
  });
  // M1: per-image actions — copy prompt (main clipboard, always works in
  // Electron) and delete to Trash (the Library's 30-day Trash, restorable).
  ipcMain.handle('takeone:copyText', async (e, text) => {
    try {
      const { clipboard } = require('electron');
      clipboard.writeText(String(text || ''));
      return { ok: true };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('takeone:deleteQuickImage', async (e, root, imagePath) => {
    try {
      const r = root || defaultRoot();
      const project = await libMod.ensureQuickGenerateProject(r);
      const rel = path.relative(path.join(project.dir, 'images'), imagePath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'Not a Quick Generate image.' };
      const dr = await libMod.deleteAsset(r, project.id, `images/${rel}`);
      if (!dr.ok) return dr;
      // Sidecar follows the image into Trash (best-effort; the PNG's own
      // Trash entry is what restore uses — a missing sidecar never blocks).
      try {
        const stamp = path.basename(rel, '.png');
        const sidecar = path.join(project.dir, 'images', '.sidecars', `${stamp}.json`);
        await fs.promises.rename(sidecar, path.join(r, 'Trash', 'assets', `${dr.trashName}.json`));
      } catch { /* sidecar optional */ }
      emitLibraryChanged();
      return { ok: true, trashName: dr.trashName };
    } catch (err) {
      return { ok: false, reason: 'Could not delete.' };
    }
  });
  // WO-43: fetch a finished Quick Generate image through main (never a
  // browser <img> to a local URL) and save it to the Library. While the
  // prompt has no outputs yet, { notFinished:true } — the renderer keeps
  // polling. On success the entry is dropped from the stash.
  ipcMain.handle('takeone:comfyFetchOutput', async (e, root, promptId, prompt) => {
    try {
      const r = root || defaultRoot();
      if (!comfyMgr) return { ok: false, error: 'Not running.' };
      const meta = qgMeta.get(promptId) || { prompt: prompt || '' };
      const res = await comfyMgr.fetchAndSaveOutput(r, promptId, meta);
      if (res.ok) { qgMeta.delete(promptId); emitLibraryChanged(); }
      return res;
    } catch (err) {
      return { ok: false, error: "The image was made but couldn't be saved." };
    }
  });
  ipcMain.handle('takeone:comfyHistory', async (e, promptId) => {
    if (!comfyMgr) return { ok: false, error: 'Not running.' };
    return comfyMgr.getHistory(promptId);
  });
  ipcMain.handle('takeone:comfyInterrupt', async () => {
    if (!comfyMgr) return { ok: false, error: 'Not running.' };
    return comfyMgr.interrupt();
  });

  // ── M2: Video Studio (Wan 2.2 TI2V-5B) ──
  // Shared guards for single + pack generation: engine ready, ComfyUI
  // running, video-studio installed, merged diffusion file present,
  // and — WO-41.3-style preflight — the three loader lists in
  // /object_info actually contain the files. A missing file fails HERE
  // in plain words, not after a long queue.
  async function videoGuards(r) {
    // M2.6-ENABLE: airtight gate — even if some path calls video
    // generation directly, an experimental tool with the switch OFF
    // never queues. The panel + Models page already hide it; this is
    // the backstop, with a plain-words pointer to Settings.
    const tool0 = toolById('video-studio');
    if (tool0 && typeof tool0.experimental === 'string' && tool0.experimental) {
      let on = false;
      try { const cfg = await readConfig(r); on = !!(cfg && cfg.settings && cfg.settings.experimentalVideo); } catch { /* config optional */ }
      if (!on) return { ok: false, error: 'Video is experimental and switched off. Turn on “Experimental: early video” in Settings to try it.', action: 'settings' };
    }
    try { await engine.assertEngineReady(r); }
    catch (err) { return { ok: false, engineMissing: true, error: err.message }; }
    const mgr = getComfy(r);
    if (!mgr.isRunning()) {
      const st = await mgr.start();
      if (!st.ok) return st;
    }
    const tool = toolById('video-studio');
    if (!tool || !(await toolInstalled(r, tool))) {
      return { ok: false, error: "Video Studio isn't installed yet. Open the Video panel and download it.", action: 'video-download' };
    }
    if (!(await videoModel.mergedReady(r))) {
      // merge-shards.py is plain stdlib Python: the engine venv works,
      // and the shipped Python is the fallback (no torch needed at all).
      let py = null;
      try { py = engine.venvPython(r); } catch { /* fallback below */ }
      if (!py || !fs.existsSync(py)) {
        try { py = depsMod.pythonExe(r); } catch { py = null; }
      }
      if (!py) return { ok: false, error: 'No Python is ready, so the video model cannot be prepared yet.' };
      const m = await videoModel.ensureMergedVideoModel(r, py);
      if (!m.ok) return m;
    }
    const names = videoModel.videoLoaderNames();
    const oi = await mgr.getObjectInfo();
    if (oi.ok && oi.info) {
      const listOf = (node, field) => {
        try {
          const n = oi.info[node];
          const v = n && n.input && n.input.required && n.input.required[field];
          return Array.isArray(v) && Array.isArray(v[0]) ? v[0] : [];
        } catch { return []; }
      };
      const unets = listOf('UNETLoader', 'unet_name');
      const clips = listOf('CLIPLoader', 'clip_name');
      const vaes = listOf('VAELoader', 'vae_name');
      // Compare separator-normalized: the server lists OS-native paths
      // (backslashes on Windows); names.unet etc. are OS-native too,
      // but a future ComfyUI listing form must not false-negative here.
      const norm = (s) => String(s).replace(/\\/g, '/');
      const has = (list, want) => list.map(norm).includes(norm(want));
      if ((unets.length && !has(unets, names.unet))
        || (clips.length && !has(clips, names.clip))
        || (vaes.length && !has(vaes, names.vae))) {
        return { ok: false, modelNotVisible: true, error: VIDEO_NOT_VISIBLE_MSG, action: 'video' };
      }
    }
    return { ok: true, mgr, names };
  }
  async function queueVideo(r, mgr, job, projectId) {
    const workflow = wanVideo(job);
    const q = await mgr.queuePrompt(workflow);
    if (!q.ok) {
      try { global.__takeoneLog && global.__takeoneLog('comfyGenerateVideo raw error: ' + (q.rawError || q.error)); } catch {}
      const { rawError, ...plain } = q;
      return plain;
    }
    videoMeta.set(q.promptId, {
      prompt: job.positive, model: 'Wan 2.2 TI2V-5B', seed: job.seed,
      width: job.width, height: job.height, resolution: job.resolution || null,
      duration: job.duration ?? null, length: job.length,
      queuedAt: Date.now(), projectId,
    });
    return { ok: true, promptId: q.promptId };
  }
  ipcMain.handle('takeone:comfyGenerateVideo', async (e, root, params) => {
    const r = root || defaultRoot();
    const g = await videoGuards(r);
    if (!g.ok) return g;
    // Resolve the project first: the open Studio project, else the
    // Quick Generate project (videos/ lives there like images/ do).
    let projectId = params.projectId || null;
    if (!projectId) {
      try { projectId = (await libMod.ensureQuickGenerateProject(r)).id; }
      catch { return { ok: false, error: "The video couldn't be queued. TakeOne could not open a project to save it in." }; }
    }
    // I2V: copy the Library image into ComfyUI/input/ (LoadImage only
    // reads that dir). The workflow references just the file name.
    let startImage = null;
    if (params.imageRel && params.imageProjectId) {
      try {
        const src = path.join(r, 'Projects', params.imageProjectId, params.imageRel);
        const base = path.basename(params.imageRel);
        const inputDir = path.join(engine.comfyDir(r), 'input');
        await fs.promises.mkdir(inputDir, { recursive: true });
        await fs.promises.copyFile(src, path.join(inputDir, base));
        startImage = base;
      } catch {
        return { ok: false, error: "The video couldn't be queued. The chosen image could not be handed to the engine." };
      }
    }
    const [width, height] = videoDims(params.resolution);
    const seed = Number.isFinite(Number(params.seed)) && params.seed !== '' && params.seed !== null
      ? Math.floor(Number(params.seed)) : Math.floor(Math.random() * 1000000000);
    const job = {
      unet: g.names.unet, clip: g.names.clip, vae: g.names.vae,
      positive: params.prompt || '',
      negative: (params.negative || '').trim() ? params.negative : DEFAULT_VIDEO_NEGATIVE,
      width, height, length: videoFrames(params.duration), seed,
      steps: VIDEO_DEFAULTS.steps, cfg: VIDEO_DEFAULTS.cfg,
      sampler_name: VIDEO_DEFAULTS.sampler_name, scheduler: VIDEO_DEFAULTS.scheduler,
      fps: VIDEO_DEFAULTS.fps, startImage,
      resolution: params.resolution || '480p', duration: params.duration || 2,
    };
    const res = await queueVideo(r, g.mgr, job, projectId);
    if (!res.ok) return res;
    return { ok: true, promptId: res.promptId, projectId, width, height, seed, resolution: job.resolution, duration: job.duration };
  });
  // M2.6: the video Ali pack — 2 prompts x 2 settings, ONE seed.
  ipcMain.handle('takeone:comfyGenerateVideoPack', async (e, root, params) => {
    const r = root || defaultRoot();
    const g = await videoGuards(r);
    if (!g.ok) return g;
    let projectId = params.projectId || null;
    if (!projectId) {
      try { projectId = (await libMod.ensureQuickGenerateProject(r)).id; }
      catch { return { ok: false, error: "The pack couldn't be queued. TakeOne could not open a project to save it in." }; }
    }
    const seed = Number.isFinite(Number(params && params.seed)) && params.seed !== '' && params.seed !== null
      ? Math.floor(Number(params.seed)) : Math.floor(Math.random() * 1000000000);
    const jobs = buildVideoAliPackJobs(seed);
    const queued = [];
    for (const job of jobs) {
      const full = {
        unet: g.names.unet, clip: g.names.clip, vae: g.names.vae,
        positive: job.prompt, negative: job.negative,
        width: job.width, height: job.height, length: job.length, seed: job.seed,
        steps: VIDEO_DEFAULTS.steps, cfg: VIDEO_DEFAULTS.cfg,
        sampler_name: VIDEO_DEFAULTS.sampler_name, scheduler: VIDEO_DEFAULTS.scheduler,
        fps: VIDEO_DEFAULTS.fps, startImage: null,
        resolution: job.resolution, duration: job.duration,
      };
      const res = await queueVideo(r, g.mgr, full, projectId);
      if (!res.ok) return res;
      queued.push({ ...job, promptId: res.promptId });
    }
    return { ok: true, seed, projectId, jobs: queued };
  });
  ipcMain.handle('takeone:comfyFetchVideoOutput', async (e, root, promptId) => {
    try {
      const r = root || defaultRoot();
      if (!comfyMgr) return { ok: false, error: 'Not running.' };
      const meta = videoMeta.get(promptId);
      if (!meta) return { ok: false, error: "The video couldn't be found. It may have been queued before this session started." };
      const res = await comfyMgr.fetchAndSaveVideoOutput(r, promptId, meta.projectId, meta);
      if (res.ok) { videoMeta.delete(promptId); emitLibraryChanged(); }
      return res;
    } catch (err) {
      return { ok: false, error: "The video was made but couldn't be saved." };
    }
  });
  // M2: first-frame thumbnail (renderer canvas -> PNG) next to the mp4,
  // and the pack's 2x2 contact sheet. Either failing never loses the video.
  ipcMain.handle('takeone:saveVideoThumbnail', async (e, root, projectId, baseName, dataUrl) => {
    try {
      const r = root || defaultRoot();
      const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, reason: 'Not a PNG data URL.' };
      const target = path.join(r, 'Projects', projectId, 'videos', `${baseName}_thumb.png`);
      await fs.promises.writeFile(target, Buffer.from(m[1], 'base64'));
      emitLibraryChanged();
      return { ok: true, path: target };
    } catch { return { ok: false, reason: 'Could not save the thumbnail.' }; }
  });
  ipcMain.handle('takeone:saveVideoContactSheet', async (e, root, projectId, dataUrl) => {
    try {
      const r = root || defaultRoot();
      const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, reason: 'Not a PNG data URL.' };
      const target = path.join(r, 'Projects', projectId, 'contact_sheet_video.png');
      await fs.promises.writeFile(target, Buffer.from(m[1], 'base64'));
      emitLibraryChanged();
      return { ok: true, path: target };
    } catch { return { ok: false, reason: 'Could not save the contact sheet.' }; }
  });
  ipcMain.handle('takeone:videoVramCheck', async (e, root) => {
    try {
      const r = root || defaultRoot();
      const cfg = await readConfig(r);
      const vramMB = (cfg && cfg.pcCheck && cfg.pcCheck.vramMB) ?? null;
      return { ok: true, vramMB, ...videoModel.videoVramCheck(vramMB) };
    } catch {
      return { ok: true, vramMB: null, ...videoModel.videoVramCheck(null) };
    }
  });

  // ── TakeOne Brain (fly-inspired associative learning) ──
  const { TakeOneBrain } = require('./main/brain.js');
  let brain = new TakeOneBrain();
  const BRAIN_PATH = () => path.join((root || defaultRoot()), '.brain.json');
  async function loadBrain(r) {
    try {
      const d = JSON.parse(await fsp.readFile(path.join(r, '.brain.json'), 'utf8'));
      brain.fromJSON(d);
    } catch { /* fresh brain */ }
  }
  async function saveBrain(r) {
    try { await fsp.writeFile(path.join(r, '.brain.json'), JSON.stringify(brain.toJSON())); }
    catch { /* ignore */ }
  }
  ipcMain.handle('takeone:brainLearn', async (e, root, context, action, reward) => {
    const r = root || defaultRoot();
    await loadBrain(r);
    brain.learn(context, action, reward);
    await saveBrain(r);
    return { ok: true };
  });
  ipcMain.handle('takeone:brainSuggest', async (e, root, context, topK) => {
    const r = root || defaultRoot();
    await loadBrain(r);
    return { ok: true, suggestions: brain.suggest(context, topK || 3) };
  });
  /** Real integrity check for an installed tool: file present, size sane,
   *  checksum when the catalog carries one. No theater — reports facts. */
  ipcMain.handle('takeone:verifyTool', async (e, toolId, root) => {
    try {
      const tool = CATALOG.find(t => t.id === toolId);
      if (!tool) return { ok: false, reason: 'Unknown tool.' };
      const r = root || defaultRoot();
      if (tool.installType === 'file' && tool.fileName) {
        const fp = path.join(toolDestDir(r, tool), tool.fileName);
        let st;
        try { st = await fsp.stat(fp); }
        catch { return { ok: true, verified: false, note: 'File not found — install again.' }; }
        const actualMB = st.size / 1048576;
        const sizeOk = !(tool.sizeMB > 0) || Math.abs(actualMB - tool.sizeMB) / tool.sizeMB < 0.08;
        let shaOk = null;
        if (tool.sha256) shaOk = (await sha256File(fp)) === tool.sha256;
        const verified = st.size > 0 && sizeOk && shaOk !== false;
        if (verified) await setToolStatus(r, toolId, { verifiedAt: new Date().toISOString() });
        return { ok: true, verified, sizeMB: Math.round(actualMB * 10) / 10,
          note: !verified ? 'File looks incomplete or changed — re-download is recommended.'
            : tool.sha256 ? 'Checksum matches — the file is intact.'
            : 'File present and size matches — looks good.' };
      }
      if (tool.installType === 'hf' && tool.files && tool.files.length) {
        // Exact byte verification per files[] manifest (not just presence).
        const d = path.join(toolDestDir(r, tool), tool.id);
        let bad = null, checked = 0;
        for (const f of tool.files) {
          const fp = path.join(d, f.path);
          let st;
          try { st = await fsp.stat(fp); }
          catch { bad = f.path + ': missing'; break; }
          if (f.bytes && st.size !== f.bytes) { bad = f.path + ': size ' + st.size + ' != expected ' + f.bytes; break; }
          if (f.sha256 && (await sha256File(fp)) !== f.sha256) { bad = f.path + ': checksum mismatch'; break; }
          checked++;
        }
        const hfVerified = !bad;
        if (hfVerified) await setToolStatus(r, toolId, { verifiedAt: new Date().toISOString() });
        return { ok: true, verified: hfVerified, filesChecked: checked,
          note: hfVerified ? 'All ' + checked + ' files present, byte-exact' + (tool.files.every(x => x.sha256) ? ', checksums match.' : '.')
                           : 'Verification failed — ' + bad };
      }
      const present = await toolInstalled(r, tool);
      if (present) await setToolStatus(r, toolId, { verifiedAt: new Date().toISOString() });
      return { ok: true, verified: present,
        note: present ? 'Installed files found.' : 'Files missing — install again.' };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:dlStart', async (e, toolId, root) => {
    const t = toolById(toolId);
    if (!t || (t.installType !== 'file' && t.installType !== 'hf')) return { ok: false, reason: 'Not a direct download.' };
    try {
      const mgr = await getDLM(root || defaultRoot());
      // HF tools carry commit + files[] on the tool object itself — addHfDownload reads them.
      if (t.installType === 'hf') return await mgr.addHfDownload(t);
      return await mgr.addDownload(t);
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:dlPause', async (e, toolId, root) => {
    try { return await (await getDLM(root || defaultRoot())).pause(toolId); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:dlResume', async (e, toolId, root) => {
    try { return await (await getDLM(root || defaultRoot())).resume(toolId); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:dlCancel', async (e, toolId, root) => {
    try { return await (await getDLM(root || defaultRoot())).cancel(toolId); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:dlRetry', async (e, toolId, root) => {
    const t = toolById(toolId);
    if (!t) return { ok: false };
    try { return await (await getDLM(root || defaultRoot())).retry(toolId, t); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  // One-click dependency setup (pip / hf). Progress arrives as 'dep-event'.
  const depProgress = (root, toolId) => (info) => {
    setToolStatus(root, toolId, {
      status: 'installing',
      fraction: typeof info.fraction === 'number' ? info.fraction : null,
      note: info.phase === 'dependency' ? 'helper' : info.phase,
    }).catch(() => {});
    if (studioWin && !studioWin.isDestroyed()) {
      studioWin.webContents.send('dep-event', { toolId, ...info });
    }
  };
  // Install queue: pip/hf installs run ONE at a time (concurrent pip into the
  // same Python env can corrupt it). Extras wait their turn automatically.
  let installQueue = Promise.resolve();
  let installQueueDepth = 0;
  const installCancels = {}; // toolId -> cancel fn for the RUNNING install
  const installCancelled = new Set(); // toolIds cancelled while queued
  function queueInstall(fn) {
    const run = installQueue.then(fn, fn);
    installQueue = run.catch(() => {});
    return run;
  }

  ipcMain.handle('takeone:depInstall', async (e, toolId, root) => {
    const t = toolById(toolId);
    const r = root || defaultRoot();
    if (!t) return { ok: false, reason: 'Unknown tool.' };
    const cur = await readToolStatus(r);
    if (cur[toolId] && cur[toolId].status === 'cancelling') {
      return { ok: false, reason: 'Still stopping the previous install — try again in a moment.' };
    }
    if (cur[toolId] && ['queued', 'installing'].includes(cur[toolId].status)) {
      return { ok: false, reason: 'Already queued.' };
    }
    // Honest queue state: no frozen position number — the queue advances
    // as installs finish/cancel, so a static number would mislead.
    installQueueDepth++;
    try {
      await setToolStatus(r, toolId, {
        status: 'queued',
        detail: 'Queued — starts automatically when the install ahead finishes.',
      });
    } catch (e) {
      installQueueDepth = Math.max(0, installQueueDepth - 1);
      throw e;
    }
    return queueInstall(async () => {
      if (installCancelled.has(toolId)) {
        installCancelled.delete(toolId);
        installQueueDepth = Math.max(0, installQueueDepth - 1);
        await setToolStatus(r, toolId, { status: 'not-installed', detail: null, error: null });
        return { ok: false, reason: 'cancelled' };
      }
      try {
        await setToolStatus(r, toolId, { status: 'installing', fraction: 0, verifiedAt: null, detail: null });
        let cancelFn = null;
        let cancelRequested = false;
        installCancels[toolId] = () => { cancelRequested = true; if (cancelFn) cancelFn(); };
        const onCancel = (fn) => { cancelFn = fn; if (cancelRequested) fn(); };
        let res;
        if (t.installType === 'pip') res = await pipInstall(r, t.pipPackage, depProgress(r, toolId), onCancel);
        else if (t.installType === 'hf') {
          // Route through download manager for consistent progress/cancel/resume via aria2.
          // Status: Implemented, syntax-checked, behavior Not Tested.
          try {
            const mgr = await getDLM(r);
            const dlRes = await mgr.addHfDownload(t);
            if (!dlRes.ok) {
              res = { ok: false, error: dlRes.reason };
            } else {
              // Download manager owns the lifecycle now; install completes when download finishes.
              // For now, mark as queued — the download manager will emit progress.
              await setToolStatus(r, toolId, { status: 'queued', detail: 'Download queued — see Downloads panel.' });
              return { ok: true, queued: true };
            }
          } catch (err) {
            res = { ok: false, error: String(err.message || err) };
          }
        }
        else return { ok: false, reason: 'Not an installable package.' };
        if (res.ok) {
          await setToolStatus(r, toolId, { status: 'installed', fraction: 1 });
          return { ok: true };
        }
        if (res.code === -4 || res.error === 'Cancelled.') {
          // User chose to stop — stay neutral, not "failed".
          await setToolStatus(r, toolId, { status: 'not-installed', detail: null, error: null });
          return { ok: false, reason: 'cancelled' };
        }
        await setToolStatus(r, toolId, { status: 'failed', error: res.error });
        return { ok: false, reason: res.error };
      } catch (err) {
        await setToolStatus(r, toolId, { status: 'failed', error: String(err.message || err) });
        return { ok: false, reason: String(err.message || err) };
      } finally {
        installQueueDepth = Math.max(0, installQueueDepth - 1);
        delete installCancels[toolId];
      }
    });
  });

  // Cancel a running (or queued) install. User chose to stop — not a failure.
  ipcMain.handle('takeone:depCancel', async (e, toolId, root) => {
    const r = root || defaultRoot();
    const cancel = installCancels[toolId];
    if (cancel) { try { cancel(); } catch { /* already done */ } }
    // If it was queued but never started, mark it so the queued run skips.
    const st = await readToolStatus(r);
    if (st[toolId] && st[toolId].status === 'queued') installCancelled.add(toolId);
    if (st[toolId] && st[toolId].status === 'queued') {
      // Queued but never started: no running fn to stop, so go directly to
      // 'not-installed'. The user should never be stuck with no way forward.
      installCancelled.add(toolId);
      await setToolStatus(r, toolId, { status: 'not-installed', detail: null, error: null });
    } else if (st[toolId] && st[toolId].status === 'installing') {
      // Actually running: 'cancelling' until the fn's cancel path flips it to
      // 'not-installed' when truly stopped. With a safety timeout below.
      await setToolStatus(r, toolId, { status: 'cancelling', detail: 'Stopping…', error: null });
      // Safety: if the fn doesn't flip it within 30s, force it. Never leave
      // the user stuck with no button to press.
      setTimeout(async () => {
        try {
          const cur2 = await readToolStatus(r);
          if (cur2[toolId] && cur2[toolId].status === 'cancelling') {
            await setToolStatus(r, toolId, { status: 'not-installed', detail: null, error: null });
          }
        } catch { /* ignore */ }
      }, 30000).unref();
    }
    return { ok: true };
  });
  ipcMain.handle('takeone:openExternal', async (e, url) => {
    if (!/^https:\/\//.test(url || '')) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle('takeone:adoptPick', async (e, toolId, root) => {
    const t = toolById(toolId);
    const r = root || defaultRoot();
    if (!t || t.installType !== 'adopt') return { ok: false };
    const pick = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (pick.canceled) return { ok: false, reason: 'cancelled' };
    const found = [];
    async function walk(dir, depth) {
      if (depth > 3 || found.length >= (t.adoptFiles || []).length) return;
      let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const en of entries) {
        const p = path.join(dir, en.name);
        if (en.isDirectory()) await walk(p, depth + 1);
        else if ((t.adoptFiles || []).some((f) => en.name.toLowerCase() === f.toLowerCase())) found.push(p);
      }
    }
    await walk(pick.filePaths[0], 0);
    if (!found.length) {
      return { ok: false, reason: `Could not find ${(t.adoptFiles || []).join(', ')} in that folder.` };
    }
    const destDir = toolDestDir(r, t);
    await fsp.mkdir(destDir, { recursive: true });
    for (const src of found) {
      const dest = path.join(destDir, path.basename(src));
      await fsp.copyFile(src, dest);
    }
    await setToolStatus(r, toolId, { status: 'installed', fraction: 1 });
    return { ok: true, files: found.map((f) => path.basename(f)) };
  });
  ipcMain.handle('takeone:splashRetry', async () => {
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
    boot();
  });

  // ---- Phase C: Library + Studio ----------------------------------------
  const needRoot = (root) => root || defaultRoot();
  ipcMain.handle('takeone:listProjects', async (e, root) => {
    try { return { ok: true, projects: await libMod.listProjects(needRoot(root)) }; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:createProject', async (e, root, name) => {
    try { const res = await libMod.createProject(needRoot(root), name); if (res.ok) emitLibraryChanged(); return res; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:renameProject', async (e, root, id, name) => {
    try { const res = await libMod.renameProject(needRoot(root), id, name); if (res.ok) emitLibraryChanged(); return res; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:getProject', async (e, root, id) => {
    try {
      const doc = await libMod.readProjectDoc(needRoot(root), id);
      return doc ? { ok: true, project: doc } : { ok: false, reason: 'Project not found.' };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:updateProject', async (e, root, id, patch) => {
    try {
      const r = needRoot(root);
      const doc = await libMod.readProjectDoc(r, id);
      if (!doc) return { ok: false, reason: 'Project not found.' };
      const p = patch || {};
      if (typeof p.originalIdea === 'string') doc.originalIdea = p.originalIdea.slice(0, 500);
      if (Array.isArray(p.lockedDecisions)) {
        doc.lockedDecisions = p.lockedDecisions.filter((x) => typeof x === 'string').map((x) => x.slice(0, 120)).slice(0, 12);
      }
      if (Number.isInteger(p.currentStep) && p.currentStep >= 1 && p.currentStep <= 6) doc.currentStep = p.currentStep;
      if (typeof p.niche === 'string') doc.niche = p.niche;
      if (Array.isArray(p.customStyles)) {
        doc.customStyles = p.customStyles.filter((s) => s && typeof s.name === 'string' && s.name.trim())
          .map((s) => ({ id: s.id || `style-${Date.now()}`, name: s.name.trim().slice(0, 60), createdAt: s.createdAt || new Date().toISOString() }))
          .slice(0, 50);
      }
      await libMod.writeProjectDoc(r, doc);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:setStepSettings', async (e, root, id, n, settings) => {
    try {
      const r = needRoot(root);
      const doc = await libMod.readProjectDoc(r, id);
      if (!doc) return { ok: false, reason: 'Project not found.' };
      if (!pipeMod.stepDef(n)) return { ok: false, reason: 'Unknown step.' };
      pipeMod.setStepSettings(doc, n, settings);
      await libMod.writeProjectDoc(r, doc);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:failStep', async (e, root, id, n, error) => {
    try {
      const r = needRoot(root);
      const doc = await libMod.readProjectDoc(r, id);
      if (!doc) return { ok: false, reason: 'Project not found.' };
      pipeMod.failStep(doc, n, error);
      await libMod.writeProjectDoc(r, doc);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:retryStep', async (e, root, id, n) => {
    try {
      const r = needRoot(root);
      const doc = await libMod.readProjectDoc(r, id);
      if (!doc) return { ok: false, reason: 'Project not found.' };
      pipeMod.retryStep(doc, n);
      await libMod.writeProjectDoc(r, doc);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:toggleVariation', async (e, root, id, n, variationId) => {
    try {
      const r = needRoot(root);
      const doc = await libMod.readProjectDoc(r, id);
      if (!doc) return { ok: false, reason: 'Project not found.' };
      const selected = pipeMod.toggleVariation(doc, n, String(variationId));
      await libMod.writeProjectDoc(r, doc);
      return { ok: true, selected };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:projectThread', async (e, root, id) => {
    try {
      const doc = await libMod.readProjectDoc(needRoot(root), id);
      return doc ? { ok: true, thread: pipeMod.projectThread(doc) } : { ok: false, reason: 'Project not found.' };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:resumeState', async (e, root) => {
    try {
      const projects = await libMod.listProjects(needRoot(root));
      return { ok: true, resume: pipeMod.resumeState(projects) };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:listAssets', async (e, root, id) => {
    try { return await libMod.listAssets(needRoot(root), id); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:importAsset', async (e, root, id, opts) => {
    try {
      const pick = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'ogg', 'flac', 'm4a'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (pick.canceled || !pick.filePaths.length) return { ok: false, reason: 'cancelled' };
      const results = [];
      for (const fp of pick.filePaths) {
        results.push(await libMod.importAsset(needRoot(root), id, fp, opts || {}));
      }
      emitLibraryChanged();
      return { ok: true, results };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:deleteAsset', async (e, root, id, rel) => {
    try { const res = await libMod.deleteAsset(needRoot(root), id, rel); if (res.ok) emitLibraryChanged(); return res; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  // FIX-7: Trash failures must reach the user in plain words, with the
  // raw error in the app log (never a raw EPERM string in a notice,
  // never silent). The lib functions' own ok:false reasons are already
  // plain; only THROWN errors (e.g. a Windows file lock mid-rename)
  // come through here.
  const trashFail = (err) => {
    const raw = String((err && err.stack) || err);
    try { if (global.__takeoneLog) global.__takeoneLog('TRASH-FAIL: ' + raw); } catch { /* ignore */ }
    try { console.error('[trash]', raw); } catch { /* ignore */ }
    const code = String((err && err.code) || '').toUpperCase();
    if (['EPERM', 'EACCES', 'EBUSY'].includes(code)) {
      return { ok: false, reason: 'Windows is holding one of this project\'s files, so it could not be moved. Close any program showing these files and try again.' };
    }
    return { ok: false, reason: 'Could not finish that Trash action. The full error is in the app log.' };
  };
  ipcMain.handle('takeone:trashProject', async (e, root, id) => {
    try { const res = await libMod.trashProject(needRoot(root), id); if (res.ok) emitLibraryChanged(); return res; }
    catch (err) { return trashFail(err); }
  });
  ipcMain.handle('takeone:listTrash', async (e, root) => {
    try { return { ok: true, trash: await libMod.listTrash(needRoot(root)) }; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:restoreFromTrash', async (e, root, trashName, kind) => {
    try { const res = await libMod.restoreFromTrash(needRoot(root), trashName, kind); if (res.ok) emitLibraryChanged(); return res; }
    catch (err) { return trashFail(err); }
  });
  ipcMain.handle('takeone:deleteForever', async (e, root, trashName, kind) => {
    try { const res = await libMod.deleteForever(needRoot(root), trashName, kind); if (res.ok) emitLibraryChanged(); return res; }
    catch (err) { return trashFail(err); }
  });
  ipcMain.handle('takeone:emptyTrash', async (e, root) => {
    try { const res = await libMod.emptyTrash(needRoot(root)); if (res.ok) emitLibraryChanged(); return res; }
    catch (err) { return trashFail(err); }
  });
  ipcMain.handle('takeone:analyzeScript', async (e, text) => {
    try { return pipeMod.analyzeScript(text); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:suggestMoves', async (e, root, id) => {
    try {
      const r = needRoot(root);
      const doc = await libMod.readProjectDoc(r, id);
      if (!doc) return { ok: false, reason: 'Project not found.' };
      let toolStates = null;
      try { toolStates = await mergedToolStates(r); } catch { /* suggestions work without */ }
      return { ok: true, moves: pipeMod.suggestNextMoves(doc, toolStates) };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:engineGate', async (e, root, stepN) => {
    try {
      const d = pipeMod.stepDef(stepN);
      if (!d || !d.needsTool) return { ok: true, gate: null };
      const t = toolById(d.needsTool);
      const installed = t ? await toolInstalled(needRoot(root), t) : false;
      return { ok: true, gate: pipeMod.engineGateText(stepN, installed) };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  // Taste Lock + niche lens live on the config (global, all projects).
  ipcMain.handle('takeone:setNiche', async (e, root, niche) => {
    try {
      const r = needRoot(root);
      const cfg = (await readConfig(r)) || defaultConfig(r);
      cfg.niche = typeof niche === 'string' ? niche : 'none';
      await writeConfig(r, cfg);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  // M2.6-ENABLE: the "Experimental: early video" switch (Settings).
  // Default OFF (missing field = OFF). The renderer relaunches after
  // toggling so the Models page + Video panel re-read it on boot.
  ipcMain.handle('takeone:setExperimentalVideo', async (e, root, on) => {
    try {
      const r = needRoot(root);
      const cfg = (await readConfig(r)) || defaultConfig(r);
      cfg.settings = cfg.settings || {};
      cfg.settings.experimentalVideo = !!on;
      await writeConfig(r, cfg);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  // M3: the "Experimental: image models" switch (Settings) — the video
  // switch's twin, but a SEPARATE setting: turning on video must never
  // offer the image models, or vice versa. Default OFF. Same relaunch
  // contract as the video switch.
  ipcMain.handle('takeone:setExperimentalImageModels', async (e, root, on) => {
    try {
      const r = needRoot(root);
      const cfg = (await readConfig(r)) || defaultConfig(r);
      cfg.settings = cfg.settings || {};
      cfg.settings.experimentalImageModels = !!on;
      await writeConfig(r, cfg);
      return { ok: true };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:getTaste', async (e, root) => {
    try {
      const cfg = (await readConfig(needRoot(root))) || {};
      const rules = Array.isArray(cfg.taste && cfg.taste.rules) ? cfg.taste.rules : [];
      return { ok: true, rules };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  async function mutateTaste(root, fn) {
    const r = needRoot(root);
    const cfg = (await readConfig(r)) || defaultConfig(r);
    const res = fn(cfg.taste || {});
    if (!res.ok) return res;
    cfg.taste = { rules: res.rules };
    await writeConfig(r, cfg);
    return { ok: true, rules: res.rules };
  }
  ipcMain.handle('takeone:addTaste', async (e, root, type, text) => {
    try { return await mutateTaste(root, (t) => pipeMod.addTasteRule(t, type, text)); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:removeTaste', async (e, root, id) => {
    try { return await mutateTaste(root, (t) => pipeMod.removeTasteRule(t, id)); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:updateTaste', async (e, root, id, text) => {
    try { return await mutateTaste(root, (t) => pipeMod.updateTasteRule(t, id, text)); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
}

if (isElectron) {
  // Startup debug log — write to temp so we can see crash point
  try {
    const logPath = require('path').join(require('os').tmpdir(), 'takeone-startup.log');
    // WO-36: rotate at 512 KB (same as the top-of-file writer).
    const log = (m) => { try {
      const st = require('fs').statSync(logPath);
      if (st.size > 512 * 1024) require('fs').renameSync(logPath, logPath + '.1');
    } catch {} try { require('fs').appendFileSync(logPath, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
    log('START');
    process.on('uncaughtException', (e) => { log('UNCAUGHT: ' + (e.stack || e.message)); });
    process.on('unhandledRejection', (e) => { log('UNHANDLED: ' + (e && e.stack || e)); });
    global.__takeoneLog = log;
  } catch {}
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); }
  else {
    app.on('second-instance', () => {
      const w = studioWin || wizardWin;
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    });
    app.whenReady().then(() => { if (Menu) Menu.setApplicationMenu(null); wireIPC(); return boot(); });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
    let quitting = false;
    app.on('before-quit', async (e) => {
      if (quitting) return;
      // WO-38: mark a clean shutdown so diagnostics can tell "crashed / killed"
      // from "closed normally". This must be the last line the app writes.
      try { global.__takeoneLog && global.__takeoneLog('SHUTDOWN clean'); } catch {}
      if (dlm) {
        quitting = true;
        e.preventDefault(); // wait for clean shutdown
        try { await dlm.stop(); } catch { /* ignore */ }
        app.quit();
      }
    });
  }
}
