/**
 * TakeOne Studio 2.2.9 — Engine installer (WO-23).
 *
 * Installs the AI engine into <root>/.engine/:
 *   engine-state.json      # install state (atomic writes)
 *   wheelhouse/            # 86 wheels from engine-lock.json (sha256-verified)
 *   comfyui.zip            # ComfyUI pinned b1a247c9 (sha256-verified)
 *   ComfyUI/               # extracted
 *   venv/                  # created FROM the shipped python (<root>/.python)
 *   extra_model_paths.yaml # explicit model-type -> <root>/Models/<category> map
 *
 * Phases: preflight -> downloading -> verifying -> installing -> ready.
 * Cancel works in every phase (one cancel token covers engine+model via installTool).
 * Failures return { ok:false, why, whatNext } in plain words — never dev jargon.
 *
 * Dependency injection for unit tests: pass deps { runExec, downloadFiles, gpu, disk, clock }
 * to installEngine. Production code passes the real ones (see makeRealDeps).
 */
'use strict';

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

/* ---------------------------------------------------------------- constants */

const ENGINE_DIRNAME = '.engine';
const STATE_FILENAME = 'engine-state.json';
const WHEELHOUSE_DIRNAME = 'wheelhouse';
const VENV_DIRNAME = 'venv';
const MODEL_PATHS_FILENAME = 'extra_model_paths.yaml';

/** ~9.7 GB worst case: 3.54 GB wheelhouse + ~5.6 GiB venv + ComfyUI + headroom for temp. */
const ESTIMATED_ENGINE_BYTES = 9.7e9;
const HEADROOM_FACTOR = 1.25; // amendment 5: preflight needs ESTIMATED * HEADROOM free

const REQUIRED_TORCH_CUDA = '12.8';
/**
 * Amendment 7: minimum NVIDIA driver for CUDA 12.8, from NVIDIA's own docs
 * (CUDA Toolkit Release Notes, Table 3: CUDA 12.8 GA -> >=570.26 Linux / >=570.65 Windows).
 * https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/
 */
const MIN_NVIDIA_DRIVER = { win32: '570.65', linux: '570.26', darwin: null };
const NVIDIA_DRIVER_DOCS = 'https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/';

/** Amendment 1: per-wheel pip flags. --no-deps because the lockfile IS the full closure. */
const PIP_INSTALL_FLAGS = [
  '--no-deps', '--no-index', '--no-input',
  '--disable-pip-version-check', '--no-warn-script-location',
];

const COMFYUI_COMMIT = 'b1a247c9cf9dbfda4b2c0a0c1d50950667eeaa0c';
const COMFYUI_ZIP_URL = `https://github.com/comfyanonymous/ComfyUI/archive/${COMFYUI_COMMIT}.zip`;
const COMFYUI_ZIP_SHA256 = '14d2ffe3775d656ebe3d9a6f684b5f1874ac89992ca296ee3c4646c14ebe4e1e';
const COMFYUI_ZIP_BYTES = 13509383;

/* ---------------------------------------------------------------- paths */

function engineRoot(root) { return path.join(root, ENGINE_DIRNAME); }
function engineStatePath(root) { return path.join(engineRoot(root), STATE_FILENAME); }
function venvDir(root) { return path.join(engineRoot(root), VENV_DIRNAME); }
function wheelhouseDir(root) { return path.join(engineRoot(root), WHEELHOUSE_DIRNAME); }
function comfyDir(root) { return path.join(engineRoot(root), 'ComfyUI'); }
function modelPathsFile(root) { return path.join(engineRoot(root), MODEL_PATHS_FILENAME); }

function shippedPythonExe(root) {
  return process.platform === 'win32'
    ? path.join(root, '.python', 'python.exe')
    : path.join(root, '.python', 'bin', 'python3');
}
function venvPython(root) {
  return process.platform === 'win32'
    ? path.join(venvDir(root), 'Scripts', 'python.exe')
    : path.join(venvDir(root), 'bin', 'python');
}

/** engine-lock.json ships inside the app (build.files). At runtime it sits next to main/. */
function lockPath() {
  const p = path.resolve(__dirname, '..', 'engine-lock.json');
  if (fs.existsSync(p)) return p;
  const alt = path.resolve(__dirname, 'engine-lock.json');
  if (fs.existsSync(alt)) return alt;
  throw new Error('engine-lock.json is missing from the app bundle.');
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/* ---------------------------------------------------------------- state (atomic) */

/** Amendment 9: state file is always written atomically (tmp + rename) so a crash
 *  can never leave a half-written state file behind. */
function writeEngineState(root, state) {
  const dir = engineRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, STATE_FILENAME + '.tmp-' + process.pid);
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, engineStatePath(root));
}

function readEngineState(root) {
  try { return JSON.parse(fs.readFileSync(engineStatePath(root), 'utf8')); }
  catch { return null; }
}

function freshState() {
  return { ready: false, wheels: {}, inProgress: [], python: null, phases: {} };
}

/* ---------------------------------------------------------------- manifest */

function loadLock(lockFile) {
  const lock = JSON.parse(fs.readFileSync(lockFile || lockPath(), 'utf8'));
  if (!Array.isArray(lock.wheels) || !lock.wheels.length) {
    throw new Error('engine-lock.json has no wheels.');
  }
  return lock;
}

/**
 * Amendment 9: every dest is guarded — it must resolve inside the engine root.
 * A lock entry can never write outside it.
 */
function guardedDest(root, rel) {
  const er = path.resolve(engineRoot(root));
  const dest = path.resolve(er, rel);
  if (dest !== er && !dest.startsWith(er + path.sep)) {
    throw new Error(`Blocked unsafe install destination: ${rel}`);
  }
  return dest;
}

/** Full download manifest: 86 wheels + ComfyUI zip. Pure — unit-testable. */
function planEngineInstall(root, opts = {}) {
  const lock = loadLock(opts.lockFile);
  const files = lock.wheels.map((w) => ({
    url: w.url,
    file: w.file,
    dest: guardedDest(root, path.join(WHEELHOUSE_DIRNAME, w.file)),
    bytes: w.bytes,
    sha256: w.sha256,
  }));
  files.push({
    url: COMFYUI_ZIP_URL,
    file: 'comfyui.zip',
    dest: guardedDest(root, 'comfyui.zip'),
    bytes: COMFYUI_ZIP_BYTES,
    sha256: COMFYUI_ZIP_SHA256,
  });
  return { files, totalBytes: files.reduce((s, f) => s + f.bytes, 0), wheelCount: lock.wheels.length };
}

/* ---------------------------------------------------------------- checks */

function checkDiskSpace(root) {
  let freeBytes = 0;
  try { freeBytes = fs.statfsSync(engineRoot(root)).bfree * fs.statfsSync(engineRoot(root)).bsize; }
  catch {
    try { freeBytes = fs.statfsSync(root).bfree * fs.statfsSync(root).bsize; }
    catch { freeBytes = 0; }
  }
  const needBytes = Math.ceil(ESTIMATED_ENGINE_BYTES * HEADROOM_FACTOR);
  return { ok: freeBytes >= needBytes, freeBytes, needBytes };
}

/**
 * Amendment 7: GPU preflight with plain-words failures.
 * kind: 'none' (no NVIDIA GPU/driver) | 'old-driver' | 'unknown'
 */
function checkGpu(runExec) {
  const run = runExec || ((cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
  }));
  return run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']).then(({ err, stdout }) => {
    if (err) {
      return {
        ok: false,
        error: {
          kind: 'none',
          why: 'We could not find an NVIDIA graphics card on this PC. The engine needs one to generate images.',
          whatNext: 'Image generation needs an NVIDIA GPU. You can still use the app for everything else.',
        },
      };
    }
    const line = stdout.trim().split('\n')[0] || '';
    const m = line.match(/,\s*([\d.]+)\s*$/);
    const driver = m ? m[1] : null;
    const name = line.split(',')[0].trim() || 'NVIDIA GPU';
    const min = MIN_NVIDIA_DRIVER[process.platform] || MIN_NVIDIA_DRIVER.linux;
    if (driver && min && compareVersions(driver, min) < 0) {
      return {
        ok: false,
        error: {
          kind: 'old-driver',
          why: `Your NVIDIA driver (${driver}) is older than the minimum this engine needs (${min}). Newer drivers are free.`,
          whatNext: `Update your NVIDIA driver to ${min} or newer, then try again. See the official requirements: ${NVIDIA_DRIVER_DOCS}`,
        },
      };
    }
    if (!driver) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          why: 'We found an NVIDIA card but could not read its driver version, so we cannot be sure the engine will work.',
          whatNext: `Updating to the latest NVIDIA driver usually fixes this. Requirements: ${NVIDIA_DRIVER_DOCS}`,
        },
      };
    }
    return { ok: true, gpu: { name, driver } };
  });
}

/* ---------------------------------------------------------------- engine install */

function emit(onEvent, type, data) {
  try { (onEvent || (() => {}))({ type, ...data }); } catch { /* listener errors never break the install */ }
}

function cancelled(token) { return !!(token && token.cancelled); }
function failResult(why, whatNext) { return { ok: false, why, whatNext }; }

async function runPython(exe, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true, ...opts });
    let out = '', err = '';
    p.stdout && p.stdout.on('data', (d) => { out += d; });
    p.stderr && p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, code: -1, error: String(e && e.message || e) }));
    p.on('close', (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

/**
 * Amendment 3: the venv is created FROM the shipped python (<root>/.python).
 * engine-state records the shipped python's version; if it (or its path) changes,
 * the venv is rebuilt from scratch.
 */
async function shippedPythonVersion(root, runExec) {
  const exe = shippedPythonExe(root);
  if (!fs.existsSync(exe)) return null;
  const r = await (runExec || runPython)(exe, ['-c', 'import sys; print(sys.version.split()[0])']);
  const v = String((r && (r.out || r.stdout)) || '').trim().split('\n')[0];
  return /^\d+\.\d+/.test(v) ? v : null;
}

/** Amendment 4: explicit model-type -> Models/<category> mapping. */
function writeModelPaths(root) {
  const er = engineRoot(root);
  const M = (c) => path.join(root, 'Models', c);
  const yml =
`# TakeOne Studio — generated by the engine installer. Do not edit by hand.
comfyui:
  base_path: ${er}
  checkpoints: ${M('image')}
  diffusion_models: ${M('video')}
  loras: ${path.join(M('image'), 'loras')}
  vae: ${path.join(M('image'), 'vae')}
  embeddings: ${path.join(M('image'), 'embeddings')}
  controlnet: ${path.join(M('image'), 'controlnet')}
  upscale_models: ${M('fix')}
  clip: ${M('text')}
  clip_vision: ${M('analyze')}
`;
  fs.writeFileSync(modelPathsFile(root), yml);
}

function deleteWheelhouse(root) {
  const wh = wheelhouseDir(root);
  try { fs.rmSync(wh, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Install (or resume) the engine. Returns { ok:true } or { ok:false, why, whatNext }.
 *
 * deps (all optional; real defaults used when omitted):
 *   downloadFiles(files, { onEvent, cancelToken }) -> Promise<{ok, why?, whatNext?}>
 *   runPip(args, opts)   -> Promise<{ok, code, out, err}>
 *   runPython(exe, args)  -> Promise<{ok, code, out, err}>
 *   gpu()                 -> Promise<checkGpu result>
 *   disk()                -> checkDiskSpace result
 */
async function installEngine(root, opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  const token = opts.cancelToken || {};
  const state = readEngineState(root) || freshState();
  const manifest = planEngineInstall(root, { lockFile: opts.lockFile });

  const deps = opts.deps || {};
  const gpuCheck = deps.gpu || (() => checkGpu());
  const diskCheck = deps.disk || (() => checkDiskSpace(root));
  const runPip = deps.runPip || ((args) => runPython(venvPython(root), ['-m', 'pip', ...args]));
  const runPy = deps.runPython || runPython;

  const E = (type, data) => emit(onEvent, type, data);
  const wasCancelled = () => cancelled(token);

  // ---- preflight: disk
  E('phase', { phase: 'preflight' });
  const disk = diskCheck();
  if (!disk.ok) {
    const gb = (b) => (b / 1073741824).toFixed(1);
    return failResult(
      `Not enough free disk space. The engine needs about ${gb(disk.needBytes)} GB free, but this drive has ${gb(disk.freeBytes)} GB free.`,
      'Free up some disk space and try again. Nothing was installed.'
    );
  }

  // ---- preflight: GPU (fatal here — the engine cannot run without CUDA).
  // CI sets opts.skipGpuCheck (env TAKEONE_SKIP_GPU_CHECK=1) because GitHub
  // runners have no NVIDIA GPU; the three GPU failure kinds are covered by
  // unit tests, and the real GPU path is proven on the user's own PC.
  if (opts.skipGpuCheck) {
    E('gpu', { skipped: true, reason: 'TAKEONE_SKIP_GPU_CHECK=1 (CI has no NVIDIA GPU)' });
  } else {
    const gpu = await gpuCheck();
    if (!gpu.ok) return failResult(gpu.error.why, gpu.error.whatNext);
    E('gpu', { gpu: gpu.gpu });
  }
  if (wasCancelled()) return failResult('Install cancelled.', 'You can start the install again any time.');

  // ---- venv: create from the shipped python, rebuild if it changed (amendment 3)
  const shipVer = await shippedPythonVersion(root, deps.runPython && ((exe, args) => deps.runPython(exe, args)));
  if (!shipVer) {
    return failResult(
      'The app\'s built-in Python is missing. The engine installer needs it to set up.',
      'Reinstall TakeOne Studio, then try again.'
    );
  }
  const shipExe = shippedPythonExe(root);
  const venvNeedsRebuild = !fs.existsSync(venvPython(root))
    || !state.python || state.python.version !== shipVer || state.python.exe !== shipExe;
  if (venvNeedsRebuild) {
    E('phase', { phase: 'venv' });
    try { fs.rmSync(venvDir(root), { recursive: true, force: true }); } catch { /* ignore */ }
    const r = await runPy(shipExe, ['-m', 'venv', venvDir(root)]);
    if (!r.ok) {
      return failResult(
        'We could not set up the engine\'s Python workspace.',
        'Restart the install. If it keeps failing, reinstall TakeOne Studio.'
      );
    }
    state.python = { version: shipVer, exe: shipExe, venv: venvDir(root) };
    state.wheels = {}; state.inProgress = []; state.ready = false;
    writeEngineState(root, state);
  }
  if (wasCancelled()) return failResult('Install cancelled.', 'You can start the install again any time.');

  // ---- downloading (bytes-weighted, via the download manager's manifest job)
  E('phase', { phase: 'downloading' });
  const downloadFiles = deps.downloadFiles || ((files, o) => defaultDownloadFiles(root, files, o));
  const dl = await downloadFiles(manifest.files, {
    onEvent: (e) => E('download', e),
    cancelToken: token,
  });
  if (!dl.ok) {
    if (wasCancelled()) return failResult('Install cancelled.', 'Already-downloaded files are kept, so the next install resumes where this one stopped.');
    return failResult(dl.why || 'Some engine files could not be downloaded.', dl.whatNext || 'Check your internet connection and try again. Downloaded files are kept.');
  }
  if (wasCancelled()) return failResult('Install cancelled.', 'Already-downloaded files are kept, so the next install resumes where this one stopped.');

  // ---- verifying is folded into the manifest job (size+sha256 per file, WO-19 pattern)
  E('phase', { phase: 'verifying' });
  if (wasCancelled()) return failResult('Install cancelled.', 'You can start the install again any time.');

  // ---- installing: per-wheel pip, bytes-weighted progress + i/N (amendment 1)
  E('phase', { phase: 'installing' });
  const wh = wheelhouseDir(root);
  const wheels = manifest.files.filter((f) => f.file.endsWith('.whl'));
  const installedBytes = Object.values(state.wheels).reduce((s, w) => s + (w.bytes || 0), 0);
  let doneBytes = installedBytes;
  const totalInstallBytes = wheels.reduce((s, w) => s + w.bytes, 0);

  const forceReinstall = new Set(state.inProgress || []); // amendment 2: resume reinstalls in-progress wheels
  state.inProgress = wheels.map((w) => w.file);
  writeEngineState(root, state);

  for (let i = 0; i < wheels.length; i++) {
    if (wasCancelled()) {
      state.inProgress = wheels.slice(i).map((w) => w.file);
      writeEngineState(root, state);
      return failResult('Install cancelled.', 'Already-installed parts are kept, so the next install resumes where this one stopped.');
    }
    const w = wheels[i];
    if (state.wheels[w.file] && !forceReinstall.has(w.file)) {
      doneBytes += w.bytes; // resume: skip verified-installed wheels
      continue;
    }
    const wheelPath = path.join(wh, w.file);
    const args = [
      'install', wheelPath,
      '--find-links', wh,
      ...PIP_INSTALL_FLAGS,
      ...(forceReinstall.has(w.file) ? ['--force-reinstall'] : []),
    ];
    E('wheel', { index: i + 1, count: wheels.length, file: w.file, doneBytes, totalBytes: totalInstallBytes });
    const r = await runPip(args);
    if (!r.ok) {
      state.inProgress = wheels.slice(i).map((x) => x.file);
      writeEngineState(root, state);
      return failResult(
        `The engine setup stopped on part ${i + 1} of ${wheels.length}. Nothing is broken — the parts already installed are kept.`,
        'Try the install again; it resumes from where it stopped. If it keeps stopping on the same part, reinstall TakeOne Studio.'
      );
    }
    state.wheels[w.file] = { bytes: w.bytes, installedAt: new Date().toISOString() };
    state.inProgress = wheels.slice(i + 1).map((x) => x.file);
    doneBytes += w.bytes;
    writeEngineState(root, state);
    E('wheel', { index: i + 1, count: wheels.length, file: w.file, doneBytes, totalBytes: totalInstallBytes, done: true });
  }

  // ---- final checks: pip check + torch CUDA assert (amendment 2)
  E('phase', { phase: 'finalizing' });
  const chk = await runPip(['check']);
  if (!chk.ok) {
    return failResult(
      'The engine\'s final self-check found a problem with its installed parts.',
      'Try the install again. If it keeps failing, reinstall TakeOne Studio.'
    );
  }
  const tc = await runPy(venvPython(root), ['-c', `import torch; assert torch.version.cuda == '${REQUIRED_TORCH_CUDA}', torch.version.cuda`]);
  if (!tc.ok) {
    return failResult(
      'The engine installed, but its graphics support did not pass the final check.',
      'Update your NVIDIA driver and try again. If it keeps failing, reinstall TakeOne Studio.'
    );
  }

  // ---- ComfyUI extract + model paths
  try {
    const zipPath = path.join(engineRoot(root), 'comfyui.zip');
    const r = await runPy(venvPython(root), ['-m', 'zipfile', '-e', zipPath, engineRoot(root)]);
    if (r.ok) {
      const extracted = path.join(engineRoot(root), `ComfyUI-${COMFYUI_COMMIT}`);
      if (fs.existsSync(extracted) && !fs.existsSync(comfyDir(root))) {
        fs.renameSync(extracted, comfyDir(root));
      }
    }
  } catch { /* non-fatal: comfy boot will report a clear error */ }
  writeModelPaths(root);

  // ---- ready: state + delete the wheelhouse to reclaim ~3.5 GB (amendment 5)
  state.ready = true;
  state.inProgress = [];
  state.phases.readyAt = new Date().toISOString();
  writeEngineState(root, state);
  deleteWheelhouse(root);

  E('phase', { phase: 'ready' });
  return { ok: true };
}

/**
 * Default downloadFiles: sequential verified fetch through the app's download
 * manager (manifest job). Used in the real app; CI/tests inject their own.
 */
async function defaultDownloadFiles(root, files, { onEvent, cancelToken }) {
  const { DownloadManager } = require('./downloads.js');
  // TAKEONE_ARIA2 lets CI/dev point at a specific aria2c binary; the packaged
  // app resolves its bundled sidecar; otherwise PATH is used.
  const aria2cPath = process.env.TAKEONE_ARIA2
    || (process.resourcesPath ? path.join(process.resourcesPath, 'aria2c.exe') : null);
  const mgr = new DownloadManager({ root, aria2cPath, onEvent });
  await mgr.start();
  const jobId = 'takeone-engine';
  try {
    const r = await mgr.addManifestJob({ id: jobId, files, category: 'engine' });
    if (!r.ok) return { ok: false, why: r.reason || 'Could not start the download.', whatNext: 'Check your internet connection and try again.' };
    await mgr.waitFor(jobId, cancelToken);
    const st = mgr.jobState(jobId);
    if (st === 'cancelled' || (cancelToken && cancelToken.cancelled)) {
      return { ok: false, cancelled: true, why: 'Install cancelled.', whatNext: 'You can start the install again any time.' };
    }
    if (st !== 'done') return { ok: false, why: 'Some engine files could not be downloaded.', whatNext: 'Check your internet connection and try again. Downloaded files are kept.' };
    return { ok: true };
  } finally {
    try { await mgr.stop(); } catch { /* ignore */ }
  }
}

/* ---------------------------------------------------------------- readiness */

function venvExists(root) {
  return fs.existsSync(venvPython(root));
}

function engineReady(root) {
  const st = readEngineState(root);
  return !!(st && st.ready && venvExists(root) && fs.existsSync(comfyDir(root)));
}

/** Throw a plain-words error when the engine is not ready (comfy.js uses this). */
function assertEngineReady(root) {
  if (engineReady(root)) return;
  throw new Error('The AI engine is not installed yet. Install it from the Models page first — it is a one-time setup.');
}

async function ensureEngine(root, opts = {}) {
  if (engineReady(root)) return { ok: true, already: true };
  return installEngine(root, opts);
}

const _engineCancelTokens = new Set();
function newCancelToken() {
  const t = { cancelled: false };
  _engineCancelTokens.add(t);
  return t;
}
/** Cancel every in-flight engine install (main.js IPC calls this). */
function cancelEngineInstall() {
  for (const t of _engineCancelTokens) t.cancelled = true;
  return { ok: true };
}

/**
 * Amendment 6: installing a tool = Step 1 of 2 (engine) then Step 2 of 2 (model).
 * One cancel token covers both steps.
 */
async function installTool(root, toolId, opts = {}) {
  const onEvent = opts.onEvent || (() => {});
  const token = opts.cancelToken || newCancelToken();
  const E = (type, data) => emit(onEvent, type, data);

  if (!engineReady(root)) {
    E('toolStep', { step: 1, of: 2, label: 'Setting up the AI engine (one-time)' });
    const eng = await installEngine(root, {
      onEvent: (e) => E('engine', e),
      cancelToken: token,
      deps: opts.deps,
      lockFile: opts.lockFile,
    });
    if (!eng.ok) return eng;
  } else {
    E('toolStep', { step: 1, of: 2, label: 'AI engine already installed — skipping' });
  }
  if (cancelled(token)) return failResult('Install cancelled.', 'You can start the install again any time.');

  E('toolStep', { step: 2, of: 2, label: 'Downloading the model' });
  const dlTool = opts.downloadTool || (async () => ({ ok: true }));
  const m = await dlTool(toolId, { onEvent: (e) => E('model', e), cancelToken: token });
  if (!m.ok) return m;
  return { ok: true };
}

/* ---------------------------------------------------------------- exports */

module.exports = {
  // paths
  engineRoot, engineStatePath, venvDir, wheelhouseDir, comfyDir, modelPathsFile,
  shippedPythonExe, venvPython, lockPath, guardedDest,
  // state
  readEngineState, writeEngineState, freshState,
  // manifest
  planEngineInstall, loadLock,
  // checks
  checkDiskSpace, checkGpu, shippedPythonVersion,
  // install
  installEngine, ensureEngine, installTool, engineReady, venvExists,
  assertEngineReady, writeModelPaths,
  // cancel
  newCancelToken, cancelEngineInstall,
  // constants (tests + CI)
  PIP_INSTALL_FLAGS, REQUIRED_TORCH_CUDA, MIN_NVIDIA_DRIVER, NVIDIA_DRIVER_DOCS,
  ESTIMATED_ENGINE_BYTES, HEADROOM_FACTOR, COMFYUI_COMMIT,
};
