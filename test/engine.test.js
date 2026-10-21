/* TakeOne Studio 2.2.9 — WO-23 engine installer unit tests.
 * All heavy deps are faked (fake pip, fake downloads, fake nvidia-smi, fake disk).
 * No network, no GPU, no real python needed. */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../main/engine.js');

let ROOT;
beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'takeone-engine-test-'));
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** A fake shipped python: just needs to exist on disk for the version probe. */
function fakeShippedPython(root) {
  const exe = engine.shippedPythonExe(root);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'fake');
  return exe;
}

/** Make the venv look installed on disk (engineReady needs real files). */
function fakeVenvPresent(root) {
  const py = engine.venvPython(root);
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, 'fake');
  fs.mkdirSync(engine.comfyDir(root), { recursive: true });
}

const okPython = async () => ({ ok: true, code: 0, out: '3.11.17\n', err: '' });
const okGpu = async () => ({ ok: true, gpu: { name: 'NVIDIA GeForce RTX 5070 Ti', driver: '580.65' } });
const okDisk = () => ({ ok: true, freeBytes: 100e9, needBytes: 12.2e9 });
const okDownload = async () => ({ ok: true });

function pipRecorder() {
  const calls = [];
  const runPip = async (args) => { calls.push(args); return { ok: true, code: 0, out: '', err: '' }; };
  return { calls, runPip };
}

function baseDeps(over = {}) {
  const pip = pipRecorder();
  return {
    deps: {
      gpu: okGpu, disk: okDisk, downloadFiles: okDownload,
      runPip: pip.runPip, runPython: okPython, ...over,
    },
    pip,
  };
}

describe('planEngineInstall', () => {
  it('plans 87 files (86 wheels + ComfyUI zip) with sha256 on every file', () => {
    const plan = engine.planEngineInstall(ROOT);
    assert.equal(plan.files.length, 87);
    assert.equal(plan.wheelCount, 86);
    for (const f of plan.files) {
      assert.ok(f.url && f.dest && f.bytes > 0 && /^[0-9a-f]{64}$/.test(f.sha256), f.file);
    }
    assert.ok(plan.totalBytes > 3e9);
  });
  it('keeps every dest inside the engine root (path guard)', () => {
    const plan = engine.planEngineInstall(ROOT);
    const er = path.resolve(engine.engineRoot(ROOT));
    for (const f of plan.files) {
      const d = path.resolve(f.dest);
      assert.ok(d === er || d.startsWith(er + path.sep), f.dest);
    }
  });
  it('guardedDest blocks ../ escapes', () => {
    assert.throws(() => engine.guardedDest(ROOT, '../evil.txt'), /Blocked unsafe/);
    assert.throws(() => engine.guardedDest(ROOT, 'wheelhouse/../../evil.txt'), /Blocked unsafe/);
  });
  it('works with a space in the root path', () => {
    const spaced = path.join(ROOT, 'my dir with spaces');
    fs.mkdirSync(spaced, { recursive: true });
    const plan = engine.planEngineInstall(spaced);
    assert.equal(plan.files.length, 87);
    assert.ok(plan.files[0].dest.includes('my dir with spaces'));
    engine.writeEngineState(spaced, engine.freshState());
    assert.ok(engine.readEngineState(spaced));
  });
});

describe('pip flags (amendment 1)', () => {
  it('uses the exact locked-down flag set', () => {
    assert.deepEqual(engine.PIP_INSTALL_FLAGS, [
      '--no-deps', '--no-index', '--no-input',
      '--disable-pip-version-check', '--no-warn-script-location',
    ]);
  });
  it('per-wheel pip call carries --find-links and the flags', async () => {
    fakeShippedPython(ROOT);
    const { deps, pip } = baseDeps();
    const r = await engine.installEngine(ROOT, { deps });
    assert.equal(r.ok, true);
    assert.equal(pip.calls.length, 86 + 1); // 86 wheels + pip check (torch assert goes through runPython)
    const first = pip.calls[0];
    assert.ok(first.includes('--no-deps') && first.includes('--no-index'));
    assert.ok(first.includes('--find-links'));
    assert.ok(first[0] === 'install');
  });
});

describe('installEngine happy path', () => {
  it('goes preflight -> downloading -> installing -> ready, deletes the wheelhouse', async () => {
    fakeShippedPython(ROOT);
    const phases = [];
    const { deps } = baseDeps();
    const r = await engine.installEngine(ROOT, {
      deps,
      onEvent: (e) => { if (e.type === 'phase') phases.push(e.phase); },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(phases, ['preflight', 'venv', 'downloading', 'verifying', 'installing', 'finalizing', 'ready']);
    const st = engine.readEngineState(ROOT);
    assert.equal(st.ready, true);
    assert.equal(Object.keys(st.wheels).length, 86);
    assert.ok(!fs.existsSync(engine.wheelhouseDir(ROOT)), 'wheelhouse deleted after Ready');
    assert.ok(fs.existsSync(engine.modelPathsFile(ROOT)), 'extra_model_paths.yaml written');
    const yml = fs.readFileSync(engine.modelPathsFile(ROOT), 'utf8');
    assert.ok(yml.includes('checkpoints:') && yml.includes('Models'));
  });
  it('second run is a no-op via ensureEngine', async () => {
    fakeShippedPython(ROOT);
    fakeVenvPresent(ROOT);
    const { deps, pip } = baseDeps();
    await engine.installEngine(ROOT, { deps });
    fakeVenvPresent(ROOT); // the real -m venv would have created these files
    const r2 = await engine.ensureEngine(ROOT, { deps });
    assert.equal(r2.ok, true);
    assert.equal(r2.already, true);
    const callsAfterFirst = pip.calls.length;
    await engine.ensureEngine(ROOT, { deps });
    assert.equal(pip.calls.length, callsAfterFirst, 'no pip calls on second ensure');
  });
});

describe('resume (amendment 2)', () => {
  it('skips installed wheels, --force-reinstalls in-progress ones', async () => {
    fakeShippedPython(ROOT);
    fakeVenvPresent(ROOT);
    const plan = engine.planEngineInstall(ROOT);
    const wheels = plan.files.filter((f) => f.file.endsWith('.whl'));
    const st = engine.freshState();
    st.python = { version: '3.11.17', exe: engine.shippedPythonExe(ROOT), venv: engine.venvDir(ROOT) };
    // pretend first 3 wheels installed, 4th was in progress
    for (let i = 0; i < 3; i++) st.wheels[wheels[i].file] = { bytes: wheels[i].bytes };
    st.inProgress = [wheels[3].file];
    engine.writeEngineState(ROOT, st);

    const { deps, pip } = baseDeps();
    const r = await engine.installEngine(ROOT, { deps });
    assert.equal(r.ok, true);
    const installedArgs = pip.calls.filter((a) => a[0] === 'install');
    const files = installedArgs.map((a) => path.basename(a[1]));
    for (let i = 0; i < 3; i++) assert.ok(!files.includes(wheels[i].file), `skip ${wheels[i].file}`);
    const fourth = installedArgs.find((a) => path.basename(a[1]) === wheels[3].file);
    assert.ok(fourth, 'in-progress wheel reinstalled');
    assert.ok(fourth.includes('--force-reinstall'), 'with --force-reinstall');
  });
});

describe('cancel in every phase', () => {
  it('cancel during downloading stops the install', async () => {
    fakeShippedPython(ROOT);
    const token = engine.newCancelToken();
    const { deps } = baseDeps({
      downloadFiles: async (files, { cancelToken }) => { cancelToken.cancelled = true; return { ok: false, cancelled: true }; },
    });
    const r = await engine.installEngine(ROOT, { deps, cancelToken: token });
    assert.equal(r.ok, false);
    assert.match(r.why, /cancelled/i);
  });
  it('cancel during installing stops after the current wheel', async () => {
    fakeShippedPython(ROOT);
    const token = engine.newCancelToken();
    let n = 0;
    const calls = [];
    const { deps } = baseDeps();
    deps.runPip = async (args) => { calls.push(args); n++; if (n === 3) token.cancelled = true; return { ok: true, code: 0, out: '', err: '' }; };
    const r = await engine.installEngine(ROOT, { deps, cancelToken: token });
    assert.equal(r.ok, false);
    assert.match(r.why, /cancelled/i);
    assert.ok(calls.length < 86, 'stopped early');
    const st = engine.readEngineState(ROOT);
    assert.equal(st.ready, false);
  });
  it('cancelEngineInstall() cancels in-flight installs', () => {
    const t = engine.newCancelToken();
    engine.cancelEngineInstall();
    assert.equal(t.cancelled, true);
  });
});

describe('failure messages are plain words', () => {
  it('no NVIDIA GPU -> plain why + whatNext', async () => {
    fakeShippedPython(ROOT);
    const { deps } = baseDeps({
      gpu: async () => ({ ok: false, error: { kind: 'none', why: 'no gpu here', whatNext: 'get a gpu' } }),
    });
    const r = await engine.installEngine(ROOT, { deps });
    assert.equal(r.ok, false);
    assert.equal(r.why, 'no gpu here');
    assert.equal(r.whatNext, 'get a gpu');
  });
  it('disk preflight failure names GB, not bytes', async () => {
    fakeShippedPython(ROOT);
    const { deps } = baseDeps({ disk: () => ({ ok: false, freeBytes: 1e9, needBytes: 12.2e9 }) });
    const r = await engine.installEngine(ROOT, { deps });
    assert.equal(r.ok, false);
    assert.match(r.why, /GB/);
    assert.ok(!r.why.includes('1000000000'), 'no raw byte counts');
  });
  it('pip failure names the wheel index and says resume works', async () => {
    fakeShippedPython(ROOT);
    const { deps } = baseDeps({
      runPip: async (args) => args[0] === 'install' ? { ok: false, code: 1, out: '', err: 'boom' } : { ok: true, code: 0, out: '', err: '' },
    });
    const r = await engine.installEngine(ROOT, { deps });
    assert.equal(r.ok, false);
    assert.match(r.why, /1 of 86/);
    assert.match(r.whatNext, /resumes/i);
  });
});

describe('checkGpu (amendment 7)', () => {
  const fakeSmi = (out, err) => async () => ({ err, stdout: out });
  it('parses name + driver, passes when new enough', async () => {
    const r = await engine.checkGpu(fakeSmi('NVIDIA GeForce RTX 5070 Ti, 580.65\n', null));
    assert.equal(r.ok, true);
    assert.equal(r.gpu.driver, '580.65');
  });
  it('old driver -> old-driver with NVIDIA docs link', async () => {
    const r2 = await engine.checkGpu(fakeSmi('NVIDIA GeForce GTX 1060, 472.12\n', null));
    assert.equal(r2.ok, false);
    assert.equal(r2.error.kind, 'old-driver');
    assert.ok(r2.error.whatNext.includes('https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/'));
    assert.ok(r2.error.why.includes(engine.MIN_NVIDIA_DRIVER[process.platform] || '570.26'));
  });
  it('nvidia-smi missing -> kind none, plain words', async () => {
    const r = await engine.checkGpu(fakeSmi('', new Error('spawn nvidia-smi ENOENT')));
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'none');
    assert.ok(!/ENOENT|spawn|nvidia-smi/i.test(r.error.why), 'no dev jargon in why');
  });
  it('unreadable driver version -> kind unknown', async () => {
    const r = await engine.checkGpu(fakeSmi('NVIDIA GeForce RTX 5070 Ti, \n', null));
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'unknown');
  });
});

describe('state file', () => {
  it('writes atomically — no .tmp leftovers, always parseable', () => {
    engine.writeEngineState(ROOT, { ...engine.freshState(), ready: true });
    const dir = engine.engineRoot(ROOT);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(engine.readEngineState(ROOT).ready, true);
  });
  it('readEngineState returns null when missing', () => {
    assert.equal(engine.readEngineState(ROOT), null);
  });
});

describe('installTool (amendment 6)', () => {
  it('does Step 1 of 2 (engine) then Step 2 of 2 (model) with one cancel token', async () => {
    fakeShippedPython(ROOT);
    const steps = [];
    const seenTokens = new Set();
    const { deps } = baseDeps();
    const r = await engine.installTool(ROOT, 'image-studio', {
      deps,
      downloadTool: async (toolId, { cancelToken }) => { seenTokens.add(cancelToken); return { ok: true }; },
      onEvent: (e) => { if (e.type === 'toolStep') steps.push([e.step, e.of]); },
      cancelToken: engine.newCancelToken(),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(steps, [[1, 2], [2, 2]]);
    assert.equal(seenTokens.size, 1, 'one token for both steps');
  });
  it('skips Step 1 when the engine is already ready', async () => {
    fakeShippedPython(ROOT);
    fakeVenvPresent(ROOT);
    const { deps } = baseDeps();
    await engine.installEngine(ROOT, { deps });
    fakeVenvPresent(ROOT); // the real -m venv would have created these files
    let engineRan = false;
    const steps = [];
    const r = await engine.installTool(ROOT, 'image-studio', {
      deps: { ...deps, downloadFiles: async () => { engineRan = true; return { ok: true }; } },
      downloadTool: async () => ({ ok: true }),
      onEvent: (e) => { if (e.type === 'toolStep') steps.push(e.label); },
    });
    assert.equal(r.ok, true);
    assert.equal(engineRan, false);
    assert.ok(steps[0].includes('already installed'));
  });
});
