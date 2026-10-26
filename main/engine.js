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

/** WO-36: the engine root can be overridden (venv fallback to %LOCALAPPDATA%).
 *  The override is stored in the state file at the DEFAULT location, so
 *  engineRoot() finds it on every run. All engine paths derive from here. */
function defaultEngineRoot(root) { return path.join(root, ENGINE_DIRNAME); }
function localAppDataEngineRoot() {
  const lad = process.env.LOCALAPPDATA;
  if (!lad) return null;
  return path.join(lad, 'TakeOne', 'engine');
}
function engineRoot(root) {
  // WO-38: sync fast-path via the in-memory override cache (populated by
  // resolveEngineRoot on install/boot). Falls back to one tiny sync read.
  const cached = _engineRootCache.get(path.resolve(root));
  if (cached) return cached;
  const def = defaultEngineRoot(root);
  try {
    const st = JSON.parse(fs.readFileSync(path.join(def, STATE_FILENAME), 'utf8'));
    if (st && typeof st.engineRootOverride === 'string' && st.engineRootOverride) {
      _engineRootCache.set(path.resolve(root), st.engineRootOverride);
      return st.engineRootOverride;
    }
  } catch { /* no state yet — default location */ }
  return def;
}
/** WO-38: async override resolution — warms the engineRoot() cache so the
 *  install path never does a sync read. */
const _engineRootCache = new Map();
async function resolveEngineRoot(root) {
  const def = defaultEngineRoot(root);
  try {
    const raw = await fsp.readFile(path.join(def, STATE_FILENAME), 'utf8');
    const st = JSON.parse(raw);
    if (st && typeof st.engineRootOverride === 'string' && st.engineRootOverride) {
      _engineRootCache.set(path.resolve(root), st.engineRootOverride);
      return st.engineRootOverride;
    }
  } catch { /* no state yet */ }
  _engineRootCache.set(path.resolve(root), def);
  return def;
}
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
 *  can never leave a half-written state file behind.
 *  WO-38: async — state writes happen on the hot install path. */
async function writeEngineState(root, state) {
  const dir = engineRoot(root);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, STATE_FILENAME + '.tmp-' + process.pid);
  await fsp.writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  await fsp.rename(tmp, engineStatePath(root));
}

/** WO-38: async — read on the install path. */
async function readEngineState(root) {
  try { return JSON.parse(await fsp.readFile(engineStatePath(root), 'utf8')); }
  catch { return null; }
}

function freshState() {
  return { ready: false, wheels: {}, inProgress: [], python: null, phases: {} };
}

/* ---------------------------------------------------------------- manifest */

/** WO-38: async — the manifest read happens on the install path. */
async function loadLock(lockFile) {
  const lock = JSON.parse(await fsp.readFile(lockFile || lockPath(), 'utf8'));
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

/** Full download manifest: 86 wheels + ComfyUI zip. Pure — unit-testable.
 *  WO-38: async (loadLock reads the manifest file). */
async function planEngineInstall(root, opts = {}) {
  const lock = await loadLock(opts.lockFile);
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

/** WO-38: async — no sync fs on the install path. */
async function checkDiskSpace(root) {
  // statfs needs an EXISTING path — walk up to the nearest existing ancestor
  // (the engine dir itself usually doesn't exist yet on a fresh install).
  const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
  let dir = path.resolve(engineRoot(root));
  while (!(await exists(dir))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let freeBytes = 0;
  try { const s = await fsp.statfs(dir); freeBytes = Number(s.bfree) * Number(s.bsize); }
  catch { freeBytes = 0; }
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
const fmtGB1 = (b) => ((b || 0) / 1073741824).toFixed(1);
/** WO-29: cancel result — in-progress partial deleted, verified wheels kept. */
function cancelledResult(freedBytes) {
  return {
    ok: false, cancelled: true, freedBytes: freedBytes || 0,
    why: `Cancelled. ${fmtGB1(freedBytes)} GB freed.`,
    whatNext: 'Already-downloaded files are kept, so installing again resumes where it stopped.',
  };
}

/* ------------------------------------------------------- WO-36: failure evidence */

/** Last N lines of a child process's output (for state.lastError.tail). */
function tailLines(text, n = 30) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  // Drop the trailing empty line a final newline produces.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/** Append to the app log (takeone-startup.log) — engine events land here.
 *  WO-38: fire-and-forget async append; logging never blocks the event loop. */
function engineLog(msg) {
  try {
    if (global.__takeoneLog) { global.__takeoneLog('ENGINE: ' + msg); return; }
    const lp = path.join(os.tmpdir(), 'takeone-startup.log');
    fsp.appendFile(lp, new Date().toISOString() + ' ENGINE: ' + msg + '\n').catch(() => {});
  } catch { /* logging never breaks the install */ }
}

/**
 * WO-36: record a failing child step. state.lastError = {step, code, tail, at}.
 * The UI message stays in plain words; the detail lives here + the app log,
 * and surfaces only in the diagnostics report.
 */
async function recordLastError(root, state, step, result) {
  const tail = tailLines(
    [result && result.err, result && result.out].filter(Boolean).join('\n'), 30);
  state.lastError = {
    step,
    code: result && result.code !== undefined ? result.code : null,
    tail: tail.slice(0, 4000), // cap: the state file must stay small
    at: new Date().toISOString(),
  };
  engineLog('FAIL step=' + step + ' code=' + state.lastError.code + '\n' + tail);
  await writeEngineState(root, state);
  return state.lastError;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  try { await fsp.access(exe); } catch { return null; }
  const r = await (runExec || runPython)(exe, ['-c', 'import sys; print(sys.version.split()[0])']);
  const v = String((r && (r.out || r.stdout)) || '').trim().split('\n')[0];
  return /^\d+\.\d+/.test(v) ? v : null;
}

/** Amendment 4: explicit model-type -> Models/<category> mapping.
 *  WO-38: async — no sync writes on the install path.
 *  M2: the Wan 2.2 files live in Models/video/<tool-id>/ (the HF snapshot
 *  dir), so ComfyUI must also see that dir as a VAE path and as a text
 *  encoder path — otherwise VAELoader and CLIPLoader (type wan) cannot
 *  find Wan2.2_VAE.pth and models_t5_umt5-xxl-enc-bf16.pth. The yaml
 *  parser splits a value on newlines, so the vae value uses a literal
 *  block scalar (|) to carry both paths; diffusion_models already
 *  pointed at Models/video (recursive search finds the snapshot dir). */
async function writeModelPaths(root) {
  const er = engineRoot(root);
  const M = (c) => path.join(root, 'Models', c);
  const yml =
`# TakeOne Studio — generated by the engine installer. Do not edit by hand.
comfyui:
  base_path: ${er}
  checkpoints: ${M('image')}
  diffusion_models: ${M('video')}
  loras: ${path.join(M('image'), 'loras')}
  vae: |
    ${path.join(M('image'), 'vae')}
    ${M('video')}
  text_encoders: ${M('video')}
  embeddings: ${path.join(M('image'), 'embeddings')}
  controlnet: ${path.join(M('image'), 'controlnet')}
  upscale_models: ${M('fix')}
  clip: ${M('text')}
  clip_vision: ${M('analyze')}
`;
  await fsp.writeFile(modelPathsFile(root), yml);
}

async function deleteWheelhouse(root) {
  const wh = wheelhouseDir(root);
  try { await fsp.rm(wh, { recursive: true, force: true }); } catch { /* best effort */ }
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
  // WO-38: warm the engineRoot() override cache async — the rest of the
  // install path never does a sync read.
  await resolveEngineRoot(root);
  const state = (await readEngineState(root)) || freshState();
  const manifest = await planEngineInstall(root, { lockFile: opts.lockFile });

  const deps = opts.deps || {};
  const gpuCheck = deps.gpu || (() => checkGpu());
  const diskCheck = deps.disk || (() => checkDiskSpace(root));
  const runPip = deps.runPip || ((args) => runPython(venvPython(root), ['-m', 'pip', ...args]));
  const runPy = deps.runPython || runPython;

  const E = (type, data) => emit(onEvent, type, data);
  const wasCancelled = () => cancelled(token);

  // ---- preflight: disk
  E('phase', { phase: 'preflight' });
  const disk = await diskCheck();
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
  // WO-29: the skip is honoured ONLY when CI=true (GitHub sets it); a local
  // TAKEONE_SKIP_GPU_CHECK=1 is ignored so dev runs always do the real check.
  const skipGpu = !!opts.skipGpuCheck && process.env.CI === 'true';
  if (skipGpu) {
    E('gpu', { skipped: true, reason: 'TAKEONE_SKIP_GPU_CHECK=1 (CI has no NVIDIA GPU)' });
  } else {
    const gpu = await gpuCheck();
    if (!gpu.ok) return failResult(gpu.error.why, gpu.error.whatNext);
    E('gpu', { gpu: gpu.gpu });
  }
  if (wasCancelled()) return cancelledResult(0);

  // ---- venv: create from the shipped python, rebuild if it changed (amendment 3)
  // WO-36: on failure (a) remove dir, wait 2 s, retry once at the same location;
  // (b) then switch the whole engine root to %LOCALAPPDATA%\TakeOne\engine and
  // retry there. Downloads happen AFTER the venv, so nothing needs migrating.
  const shipVer = await shippedPythonVersion(root, deps.runPython && ((exe, args) => deps.runPython(exe, args)));
  if (!shipVer) {
    return failResult(
      'The app\'s built-in Python is missing. The engine installer needs it to set up.',
      'Reinstall TakeOne Studio, then try again.'
    );
  }
  const shipExe = shippedPythonExe(root);
  const venvExe = venvPython(root);
  const venvPresent = await (async () => { try { await fsp.access(venvExe); return true; } catch { return false; } })();
  const venvNeedsRebuild = !venvPresent
    || !state.python || state.python.version !== shipVer || state.python.exe !== shipExe;
  if (venvNeedsRebuild) {
    E('phase', { phase: 'venv' });
    // WO-38: async delete + UI shows "Cleaning up old files..." — the old
    // venv (~5.6 GB) delete MUST NOT block the event loop.
    E('cleanupNote', { note: 'Cleaning up old files...' });
    try { await fsp.rm(venvDir(root), { recursive: true, force: true }); } catch { /* ignore */ }
    let r = await runPy(shipExe, ['-m', 'venv', venvDir(root)]);
    if (!r.ok) {
      // WO-36(a): one retry after clearing the dir and waiting 2 s
      // (antivirus/file locks often clear on their own).
      await recordLastError(root, state, 'venv', r);
      engineLog(`venv attempt 1 failed at ${venvDir(root)} — clearing dir, waiting 2 s, retrying once`);
      E('cleanupNote', { note: 'Cleaning up old files...' });
      try { await fsp.rm(venvDir(root), { recursive: true, force: true }); } catch { /* ignore */ }
      await sleep(2000);
      r = await runPy(shipExe, ['-m', 'venv', venvDir(root)]);
    }
    if (!r.ok) {
      // WO-36(b): fall back to %LOCALAPPDATA%\TakeOne\engine for the whole
      // engine root (venv, wheelhouse, ComfyUI). The override is written to the
      // state file at the DEFAULT location, so engineRoot() resolves it on
      // every future run; all engine paths derive from engineRoot().
      await recordLastError(root, state, 'venv', r);
      const ladEr = localAppDataEngineRoot();
      if (ladEr && ladEr !== engineRoot(root)) {
        engineLog(`venv failed twice at default root — falling back to ${ladEr}`);
        E('phase', { phase: 'venv-fallback', engineRoot: ladEr });
        const defEr = defaultEngineRoot(root);
        await fsp.mkdir(defEr, { recursive: true });
        state.engineRootOverride = ladEr;
        // Pointer at the default location so engineRoot() finds it next run.
        await fsp.writeFile(path.join(defEr, STATE_FILENAME),
          JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
        // WO-38: the override changed mid-install — refresh the cache NOW so
        // every path below resolves to the fallback root, not the stale default.
        _engineRootCache.set(path.resolve(root), ladEr);
        r = await runPy(shipExe, ['-m', 'venv', venvDir(root)]);
        if (!r.ok) await recordLastError(root, state, 'venv-fallback', r);
        else { state.lastError = null; engineLog(`venv fallback OK at ${ladEr}`); }
      }
    }
    if (!r.ok) {
      await recordLastError(root, state, 'venv', r);
      return failResult(
        'We could not set up the engine\'s Python workspace.',
        'Restart the install. If it keeps failing, reinstall TakeOne Studio.'
      );
    }
    state.python = { version: shipVer, exe: shipExe, venv: venvDir(root) };
    state.wheels = {}; state.inProgress = []; state.ready = false;
    await writeEngineState(root, state);
  }
  if (wasCancelled()) return cancelledResult(0);

  // ---- downloading (bytes-weighted, via the download manager's manifest job)
  E('phase', { phase: 'downloading' });
  const downloadFiles = deps.downloadFiles || ((files, o) => defaultDownloadFiles(root, files, o));
  const dl = await downloadFiles(manifest.files, {
    onEvent: (e) => E('download', e),
    cancelToken: token,
  });
  if (!dl.ok) {
    // WO-29: cancel deletes the in-progress partial (the dep reports freedBytes);
    // verified files stay for resume.
    if (dl.cancelled || wasCancelled()) return cancelledResult(dl.freedBytes);
    await recordLastError(root, state, 'download', { code: null, err: dl.why || '', out: '' });
    return failResult(dl.why || 'Some engine files could not be downloaded.', dl.whatNext || 'Check your internet connection and try again. Downloaded files are kept.');
  }
  if (wasCancelled()) return cancelledResult(0);

  // ---- verifying is folded into the manifest job (size+sha256 per file, WO-19 pattern)
  E('phase', { phase: 'verifying' });
  if (wasCancelled()) return cancelledResult(0);

  // ---- installing: per-wheel pip, bytes-weighted progress + i/N (amendment 1)
  E('phase', { phase: 'installing' });
  const wh = wheelhouseDir(root);
  const wheels = manifest.files.filter((f) => f.file.endsWith('.whl'));
  const installedBytes = Object.values(state.wheels).reduce((s, w) => s + (w.bytes || 0), 0);
  let doneBytes = installedBytes;
  const totalInstallBytes = wheels.reduce((s, w) => s + w.bytes, 0);

  const forceReinstall = new Set(state.inProgress || []); // amendment 2: resume reinstalls in-progress wheels
  state.inProgress = wheels.map((w) => w.file);
  await writeEngineState(root, state);

  for (let i = 0; i < wheels.length; i++) {
    if (wasCancelled()) {
      state.inProgress = wheels.slice(i).map((w) => w.file);
      await writeEngineState(root, state);
      // WO-29: nothing on disk to free mid-install (the wheel file is verified
      // and kept for resume); the interrupted wheel is force-reinstalled next time.
      return cancelledResult(0);
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
      await recordLastError(root, state, `pip-install:${w.file}`, r);
      return failResult(
        `The engine setup stopped on part ${i + 1} of ${wheels.length}. Nothing is broken — the parts already installed are kept.`,
        'Try the install again; it resumes from where it stopped. If it keeps stopping on the same part, reinstall TakeOne Studio.'
      );
    }
    state.wheels[w.file] = { bytes: w.bytes, installedAt: new Date().toISOString() };
    state.inProgress = wheels.slice(i + 1).map((x) => x.file);
    doneBytes += w.bytes;
    await writeEngineState(root, state);
    E('wheel', { index: i + 1, count: wheels.length, file: w.file, doneBytes, totalBytes: totalInstallBytes, done: true });
  }

  // ---- final checks: pip check + torch CUDA assert (amendment 2)
  E('phase', { phase: 'finalizing' });
  const chk = await runPip(['check']);
  if (!chk.ok) {
    await recordLastError(root, state, 'pip-check', chk);
    return failResult(
      'The engine\'s final self-check found a problem with its installed parts.',
      'Try the install again. If it keeps failing, reinstall TakeOne Studio.'
    );
  }
  const tc = await runPy(venvPython(root), ['-c', `import torch; assert torch.version.cuda == '${REQUIRED_TORCH_CUDA}', torch.version.cuda`]);
  if (!tc.ok) {
    await recordLastError(root, state, 'torch-cuda-check', tc);
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
      const extractedOk = await (async () => { try { await fsp.access(extracted); return true; } catch { return false; } })();
      const comfyOk = await (async () => { try { await fsp.access(comfyDir(root)); return true; } catch { return false; } })();
      if (extractedOk && !comfyOk) {
        await fsp.rename(extracted, comfyDir(root));
      }
    }
  } catch { /* non-fatal: comfy boot will report a clear error */ }
  await writeModelPaths(root);

  // ---- ready: state + delete the wheelhouse to reclaim ~3.5 GB (amendment 5)
  // WO-38: async delete + UI shows "Cleaning up old files..." — never blocks.
  state.ready = true;
  state.inProgress = [];
  state.phases.readyAt = new Date().toISOString();
  await writeEngineState(root, state);
  E('cleanupNote', { note: 'Cleaning up old files...' });
  await deleteWheelhouse(root);

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
      return { ok: false, cancelled: true, freedBytes: 0, why: 'Install cancelled.', whatNext: 'You can start the install again any time.' };
    }
    if (st !== 'done') return { ok: false, why: 'Some engine files could not be downloaded.', whatNext: 'Check your internet connection and try again. Downloaded files are kept.' };
    return { ok: true };
  } finally {
    try { await mgr.stop(); } catch { /* ignore */ }
  }
}

/* ---------------------------------------------------------------- readiness */
/** WO-38: async — no sync existsSync on the hot path. */
async function venvExists(root) {
  try { await fsp.access(venvPython(root)); return true; } catch { return false; }
}

/** WO-38: async. */
async function engineReady(root) {
  const st = await readEngineState(root);
  if (!(st && st.ready)) return false;
  if (!(await venvExists(root))) return false;
  try { await fsp.access(comfyDir(root)); return true; } catch { return false; }
}

/**
 * WO-41: one readiness fact for every surface (diagnostics header, Engine
 * section, Studio step readiness). engineReady() is the boolean; this is
 * the same check plus the parts, so no surface can invent its own answer.
 * Note the old diagnostics header read state.installed — a field that never
 * existed (state carries `ready`, wheels is an OBJECT) — so it always said
 * "not installed" even with a running engine. That bug dies here.
 */
async function engineReadiness(root) {
  const st = await readEngineState(root).catch(() => null);
  const venvPresent = await venvExists(root);
  let comfyPresent = false;
  try { await fsp.access(comfyDir(root)); comfyPresent = true; } catch { /* missing */ }
  const stateReady = !!(st && st.ready);
  return {
    ready: stateReady && venvPresent && comfyPresent,
    stateReady, venvPresent, comfyPresent,
    wheelsCount: st && st.wheels ? Object.keys(st.wheels).length : 0,
    pythonVersion: st && st.python && st.python.version ? st.python.version : null,
  };
}

/** Throw a plain-words error when the engine is not ready (comfy.js uses this).
 *  WO-38: async. */
async function assertEngineReady(root) {
  if (await engineReady(root)) return;
  throw new Error('The AI engine is not installed yet. Install it from the Models page first — it is a one-time setup.');
}

async function ensureEngine(root, opts = {}) {
  if (await engineReady(root)) return { ok: true, already: true };
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

  if (!(await engineReady(root))) {
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
  if (cancelled(token)) return cancelledResult(0);

  E('toolStep', { step: 2, of: 2, label: 'Downloading the model' });
  const dlTool = opts.downloadTool || (async () => ({ ok: true }));
  const m = await dlTool(toolId, { onEvent: (e) => E('model', e), cancelToken: token });
  if (!m.ok) return m;
  return { ok: true };
}

/* ---------------------------------------------------------------- exports */

module.exports = {
  // paths
  engineRoot, defaultEngineRoot, localAppDataEngineRoot, resolveEngineRoot,
  engineStatePath, venvDir, wheelhouseDir, comfyDir, modelPathsFile,
  shippedPythonExe, venvPython, lockPath, guardedDest,
  // state
  readEngineState, writeEngineState, freshState,
  // WO-36: failure evidence
  recordLastError, tailLines, engineLog,
  // manifest
  planEngineInstall, loadLock,
  // checks
  checkDiskSpace, checkGpu, shippedPythonVersion,
  // install
  installEngine, ensureEngine, installTool, engineReady, venvExists,
  assertEngineReady, writeModelPaths, engineReadiness,
  // cancel
  newCancelToken, cancelEngineInstall,
  // constants (tests + CI)
  PIP_INSTALL_FLAGS, REQUIRED_TORCH_CUDA, MIN_NVIDIA_DRIVER, NVIDIA_DRIVER_DOCS,
  ESTIMATED_ENGINE_BYTES, HEADROOM_FACTOR, COMFYUI_COMMIT,
};
