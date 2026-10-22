// TAKEONE STARTUP LOG — absolute first, before any require
try {
  const _lp = require('path').join(require('os').tmpdir(), 'takeone-startup.log');
  const _lm = (m) => { try { require('fs').appendFileSync(_lp, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
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
try { global.__takeoneLog && global.__takeoneLog('REQ catalog OK'); } catch {}
const dlMod = require('./main/downloads.js');
const depsMod = require('./main/deps.js');
const { hfInstalledStatus } = require('./main/hf-install-check.js');
// Phase C modules.
const libMod = require('./main/library.js');
const pipeMod = require('./main/pipeline.js');
const { CATALOG, IMPLICIT_DEPS, validateCatalog, vramAllowed, estimateBytes, catalogSignature, verifyCatalog } = catalogMod;
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
function defaultRoot() { return path.join(app.getPath('documents'), 'TakeOne'); }
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
    settings: { language: 'en' },
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
  try { vramMB = (await readConfig(root) || {}).pcCheck?.vramMB ?? null; } catch { /* ignore */ }
  for (const t of CATALOG) {
    const gate = vramAllowed(t, vramMB);
    const installed = await toolInstalled(root, t);
    const dl = dlStates[t.id];
    const ts = tstat[t.id];
    let state = 'not-installed';
    let progress = 0, error = null, detail = null;
    if (installed) { state = 'installed'; }
    else if (dl && dl.status === 'done') {
      state = 'not-installed'; // finished on record but the file is gone — allow a fresh download
    }
    else if (dl) {
      state = dl.status; progress = dl.progress || 0; error = dl.error || null;
      if (dl.status === 'retrying') detail = 'Retrying automatically…';
    } else if (ts && ts.status === 'installing') { state = 'installing'; progress = ts.fraction || 0; detail = ts.note; }
    else if (ts && ts.status === 'cancelling') { state = 'cancelling'; detail = ts.detail || 'Stopping…'; }
    else if (ts && ts.status === 'queued') { state = 'queued'; detail = ts.detail || 'Queued — starts automatically.'; }
    else if (ts && ts.status === 'failed') { state = 'failed'; error = ts.error; }
    out[t.id] = {
      state, progress, error, detail,
      // WO-12: catalog honesty reaches the UI — a tool marked unavailable in
      // main/catalog.js surfaces here so the renderer can show "Not Available"
      // and suppress its Install button.
      unavailable: typeof t.unavailable === 'string' && t.unavailable ? t.unavailable : null,
      // WO-16: plain-language user text (the only text the UI shows).
      unavailableUser: typeof t.unavailableUser === 'string' && t.unavailableUser ? t.unavailableUser : null,
      gateOk: gate.ok, gateReason: gate.reason || null, gateWhy: gate.whyLink || null,
      deps: IMPLICIT_DEPS[t.installType] || [],
      verifiedAt: (ts && ts.verifiedAt) || null,
      speedBps: (dl && dl.speedBps) || 0,
    };
  }
  return out;
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
  const forceWizard = process.env.TAKEONE_FORCE_WIZARD === '1';
  const receipt = await readReceipt();
  let root = (receipt && receipt.storageRoot) || defaultRoot();
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
    if (!root) {
      const receipt = await readReceipt();
      root = (receipt && receipt.storageRoot) || defaultRoot();
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
  const { ComfyManager } = require('./main/comfy.js');
  const { sdxlTxt2Img } = require('./main/comfy-workflows.js');
  const engine = require('./main/engine.js');
  let comfyMgr = null;
  function getComfy(root) {
    if (!comfyMgr) {
      // WO-23: when the engine is installed, ComfyUI runs on the engine venv's
      // python with the engine's extra_model_paths; otherwise fall back to the
      // legacy shipped-python path.
      let pythonExe, comfyDir;
      try {
        engine.assertEngineReady(root);
        pythonExe = engine.venvPython(root);
        comfyDir = engine.comfyDir(root);
      } catch {
        const { pythonExe: legacyPythonExe } = require('./deps.js');
        pythonExe = legacyPythonExe(root);
        comfyDir = path.join(root, 'ComfyUI');
      }
      comfyMgr = new ComfyManager({
        root,
        pythonExe,
        comfyDir,
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
      onEvent: (ev) => {
        if (studioWin && !studioWin.isDestroyed()) studioWin.webContents.send('engine-event', ev);
      },
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
    return { ok: true, ready: engine.engineReady(r), state: engine.readEngineState(r) };
  });
  // WO-32: one-click diagnostics report (plain text, clipboard; user names masked, no secrets).
  // WO-35: the builder is async — nvidia-smi never blocks the UI thread.
  ipcMain.handle('takeone:diagnostics', async (e, root) => {
    try {
      const r = root || defaultRoot();
      const report = await require('./main/diagnostics.js').buildDiagnosticsReport(r);
      return { ok: true, report };
    } catch (err) {
      return { ok: false, reason: 'Could not build the diagnostics report.' };
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
    try {
      engine.assertEngineReady(r);
    } catch (err) {
      return { ok: false, engineMissing: true, error: err.message };
    }
    const mgr = getComfy(r);
    if (!mgr.isRunning()) {
      const st = await mgr.start();
      if (!st.ok) return st;
    }
    // For now: SDXL text-to-image. More workflows as models land.
    const workflow = sdxlTxt2Img({
      checkpoint: params.checkpoint || 'sd_xl_base_1.0.safetensors',
      positive: params.prompt || '',
      negative: params.negative || '',
      width: params.width || 1024,
      height: params.height || 1024,
      steps: params.steps || 20,
    });
    return mgr.queuePrompt(workflow);
  });
  ipcMain.handle('takeone:comfyHistory', async (e, promptId) => {
    if (!comfyMgr) return { ok: false, error: 'Not running.' };
    return comfyMgr.getHistory(promptId);
  });
  ipcMain.handle('takeone:comfyInterrupt', async () => {
    if (!comfyMgr) return { ok: false, error: 'Not running.' };
    return comfyMgr.interrupt();
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
    try { return await libMod.createProject(needRoot(root), name); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:renameProject', async (e, root, id, name) => {
    try { return await libMod.renameProject(needRoot(root), id, name); }
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
      return { ok: true, results };
    } catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:deleteAsset', async (e, root, id, rel) => {
    try { return await libMod.deleteAsset(needRoot(root), id, rel); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:trashProject', async (e, root, id) => {
    try { return await libMod.trashProject(needRoot(root), id); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:listTrash', async (e, root) => {
    try { return { ok: true, trash: await libMod.listTrash(needRoot(root)) }; }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:restoreFromTrash', async (e, root, trashName, kind) => {
    try { return await libMod.restoreFromTrash(needRoot(root), trashName, kind); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:deleteForever', async (e, root, trashName, kind) => {
    try { return await libMod.deleteForever(needRoot(root), trashName, kind); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
  });
  ipcMain.handle('takeone:emptyTrash', async (e, root) => {
    try { return await libMod.emptyTrash(needRoot(root)); }
    catch (err) { return { ok: false, reason: String(err.message || err) }; }
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
    const log = (m) => { try { require('fs').appendFileSync(logPath, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
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
      if (dlm) {
        quitting = true;
        e.preventDefault(); // wait for clean shutdown
        try { await dlm.stop(); } catch { /* ignore */ }
        app.quit();
      }
    });
  }
}
