/* WO-41: Quick Generate on Ali's PC failed because ComfyUI never saw the
 * model — the app never passed --extra-model-paths-config, and Quick
 * Generate queued a hard-coded checkpoint name. These tests pin the fix:
 * shared start argv, Lightning workflow, plain (never raw-JSON) errors,
 * truthful diagnostics, and one Studio step-readiness source. */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { buildComfyArgs, mapComfyError, createEngineComfy, ComfyManager, MODEL_NOT_VISIBLE_MSG } = require('../main/comfy.js');
const { sdxlTxt2Img, sdxlLightningTxt2Img } = require('../main/comfy-workflows.js');
const engine = require('../main/engine.js');
const diag = require('../main/diagnostics.js');

/** Ali's exact ComfyUI 400 body (checkpoint name from v2.2.16 Quick Generate). */
const ALI_400 = JSON.stringify({
  error: { message: 'Invalid prompt', details: '' },
  node_errors: {
    1: {
      class_type: 'CheckpointLoaderSimple',
      errors: [{ message: "Value not in list: ckpt_name: 'sd_xl_base_1.0.safetensors' not in []", details: "ckpt_name: 'sd_xl_base_1.0.safetensors' not in []" }],
    },
  },
});

describe('Lightning workflow (WO-41.2)', () => {
  it('uses 4 steps, cfg 1, euler + sgm_uniform', () => {
    const wf = sdxlLightningTxt2Img({ checkpoint: 'sdxl_lightning_4step.safetensors', positive: 'a cat' });
    assert.equal(wf['1'].inputs.ckpt_name, 'sdxl_lightning_4step.safetensors');
    assert.equal(wf['5'].inputs.steps, 4);
    assert.equal(wf['5'].inputs.cfg, 1);
    assert.equal(wf['5'].inputs.sampler_name, 'euler');
    assert.equal(wf['5'].inputs.scheduler, 'sgm_uniform');
  });
  it('base workflow defaults are unchanged (euler/normal)', () => {
    const wf = sdxlTxt2Img({ checkpoint: 'x.safetensors', positive: 'a cat' });
    assert.equal(wf['5'].inputs.steps, 20);
    assert.equal(wf['5'].inputs.scheduler, 'normal');
  });
});

describe('shared ComfyUI argv (WO-41.1, WO-41.4, WO-41.7)', () => {
  it('passes --extra-model-paths-config, --cpu, and binds 127.0.0.1', () => {
    const args = buildComfyArgs({
      mainPy: '/root/.engine/ComfyUI/main.py', port: 8188, cpu: true,
      modelPathsConfig: '/root/.engine/extra_model_paths.yaml', helpOut: '',
    });
    assert.ok(args.includes('--extra-model-paths-config'));
    assert.equal(args[args.indexOf('--extra-model-paths-config') + 1], '/root/.engine/extra_model_paths.yaml');
    assert.ok(args.includes('--cpu'));
    assert.equal(args[args.indexOf('--listen') + 1], '127.0.0.1');
    assert.ok(!args.includes('--disable-api-nodes'), 'no flag without --help evidence');
  });
  it('adds --disable-api-nodes only when --help lists it', () => {
    const withFlag = buildComfyArgs({ mainPy: 'm.py', port: 8188, helpOut: '... --disable-api-nodes ...' });
    assert.ok(withFlag.includes('--disable-api-nodes'));
  });
  it('createEngineComfy enables the model-paths write (the shared path)', () => {
    const mgr = createEngineComfy({ root: path.join(os.tmpdir(), 'wo41-root'), cpu: true, onEvent: () => {} });
    assert.equal(mgr.modelPaths, true);
    assert.equal(mgr.cpu, true);
    assert.ok(mgr.comfyDir.endsWith('ComfyUI'));
  });
  it('writeModelPaths maps checkpoints at <root>/Models/image', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo41-yaml-'));
    await fs.promises.mkdir(engine.engineRoot(root), { recursive: true });
    await engine.writeModelPaths(root);
    const yml = fs.readFileSync(engine.modelPathsFile(root), 'utf8');
    assert.ok(yml.includes(`checkpoints: ${path.join(root, 'Models', 'image')}`), yml);
  });
});

describe('plain ComfyUI errors, never raw JSON (WO-41.3, WO-41.7)', () => {
  it("Ali's 400 maps to the plain model-not-visible message", () => {
    const m = mapComfyError(400, ALI_400);
    assert.equal(m.modelNotVisible, true);
    assert.equal(m.plain, MODEL_NOT_VISIBLE_MSG);
    assert.ok(!m.plain.includes('{') && !m.plain.includes('node_errors') && !m.plain.includes('sd_xl_base'));
  });
  it('a generic node error becomes one plain line, no JSON', () => {
    const body = JSON.stringify({ node_errors: { 5: { errors: [{ message: 'OOM: out of memory' }] } } });
    const m = mapComfyError(400, body);
    assert.equal(m.modelNotVisible, false);
    assert.ok(!m.plain.includes('{') && !m.plain.includes('node_errors'));
    assert.match(m.plain, /OOM/);
  });
  it('fake ComfyUI 400 via queuePrompt: plain error + raw kept aside', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/prompt' && req.method === 'POST') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(ALI_400);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const mgr = new ComfyManager({ root: '/tmp', pythonExe: '/tmp/py', comfyDir: '/tmp', onEvent: () => {} });
    mgr.ready = true; mgr.proc = { fake: true }; mgr.port = server.address().port;
    const q = await mgr.queuePrompt({ '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } });
    assert.equal(q.ok, false);
    assert.equal(q.modelNotVisible, true);
    assert.equal(q.error, MODEL_NOT_VISIBLE_MSG);
    assert.ok(q.rawError.includes('node_errors'), 'raw body is kept for the app log, not the UI');
    server.close();
  });
  it('getCheckpointList reads /object_info/CheckpointLoaderSimple', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/object_info/CheckpointLoaderSimple') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl_lightning_4step.safetensors', 'other.safetensors']] } } } }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const mgr = new ComfyManager({ root: '/tmp', pythonExe: '/tmp/py', comfyDir: '/tmp', onEvent: () => {} });
    mgr.ready = true; mgr.proc = { fake: true }; mgr.port = server.address().port;
    const pre = await mgr.getCheckpointList();
    assert.equal(pre.ok, true);
    assert.ok(pre.checkpoints.includes('sdxl_lightning_4step.safetensors'));
    server.close();
  });
});

describe('diagnostics truth (WO-41.6)', () => {
  it('strips ANSI codes from the ComfyUI log', () => {
    assert.equal(diag.stripAnsi('\x1b[32mgreen\x1b[0m and \x1b[1mbold\x1b[0m'), 'green and bold');
  });
  it('header says ready when engineReadiness is ready (the old "not installed" bug)', async () => {
    const r = await diag.buildDiagnosticsReport('C:\\TakeOne', {
      version: '2.2.17', windows: 'Windows 11 Pro (win32)', gpu: 'RTX 5070 Ti',
      engineReadiness: { ready: true, stateReady: true, venvPresent: true, comfyPresent: true, wheelsCount: 86, pythonVersion: '3.11.17' },
      disk: '412.3 GB free', appLog: '', comfyLog: '', engineSection: 'Root: x', storageSection: 'Root: x', prevSession: '',
    });
    assert.match(r, /Engine: ready \(86 wheels, python 3\.11\.17\)/);
    assert.ok(!r.includes('Engine: not installed'), r.split('\n').find((l) => l.startsWith('Engine:')));
  });
  it('header says not installed with parts when readiness is false', async () => {
    const r = await diag.buildDiagnosticsReport('C:\\TakeOne', {
      version: '2.2.17', windows: 'Windows 11 Pro (win32)', gpu: 'x',
      engineReadiness: { ready: false, stateReady: false, venvPresent: true, comfyPresent: false, wheelsCount: 0, pythonVersion: null },
      disk: 'x', appLog: '', comfyLog: '', engineSection: 'Root: x', storageSection: 'Root: x', prevSession: '',
    });
    assert.match(r, /Engine: not installed \(state ready=false, venv present, ComfyUI missing\)/);
  });
  it('engine section lists checkpoints + Models/image files, strips ANSI in the report', async () => {
    const sec = await diag.engineSection('C:\\TakeOne', {
      engineState: null, security: { controlledFolderAccess: 'off', defenderRealTime: 'on' },
      shippedPythonVer: null, engineReadiness: { ready: false, stateReady: false, venvPresent: false, comfyPresent: false, wheelsCount: 0 },
      comfyCheckpoints: ['sdxl_lightning_4step.safetensors'],
      modelFiles: ['sdxl_lightning_4step.safetensors (6.6 GB)'],
    });
    assert.ok(sec.includes('ComfyUI checkpoints (via /object_info): sdxl_lightning_4step.safetensors'), sec);
    assert.ok(sec.includes('sdxl_lightning_4step.safetensors (6.6 GB)'), sec);
    const r = await diag.buildDiagnosticsReport('C:\\TakeOne', {
      version: '2.2.17', windows: 'w', gpu: 'x',
      engineReadiness: { ready: false, stateReady: false, venvPresent: false, comfyPresent: false, wheelsCount: 0 },
      disk: 'x', appLog: '', comfyLog: '\x1b[31mred error\x1b[0m', engineSection: 'Root: x', storageSection: 'Root: x', prevSession: '',
    });
    assert.ok(r.includes('red error') && !r.includes('\x1b['), 'ANSI must not survive into the report');
  });
  it('Defender 1123 query joins ALL properties (Process Name + Path), not [0] only', async () => {
    let captured = '';
    const blocks = await diag.queryDefenderBlocks(async (file, args) => {
      captured = args.join(' ');
      return { err: null, stdout: '2026-10-24T12:46:00|TakeOne Studio.exe | C:\\Program Files\\TakeOne Studio\\TakeOne Studio.exe\n' };
    });
    assert.ok(captured.includes('Properties') && captured.includes('-join'), captured);
    assert.ok(!captured.includes('Properties[0]'), 'must not read only the first property: ' + captured);
    assert.ok(blocks[0].includes('TakeOne Studio.exe') && blocks[0].includes('C:\\Program Files'), blocks[0]);
  });
  it('queryComfyCheckpoints returns null when ComfyUI is unreachable', async () => {
    const ck = await diag.queryComfyCheckpoints(59999);
    assert.equal(ck, null);
  });
});

describe('Studio step readiness, one source (WO-41.5)', () => {
  it('model file present + engine absent => modelInstalled true, ready false', async () => {
    const main = require('../main.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo41-step-'));
    const dir = path.join(root, 'Models', 'image');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sdxl_lightning_4step.safetensors'), 'x');
    const r = await main.imageStepReady(root);
    assert.equal(r.modelInstalled, true);
    assert.equal(r.engineReady, false);
    assert.equal(r.ready, false);
  });
  it('neither engine nor model => both false', async () => {
    const main = require('../main.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo41-step2-'));
    const r = await main.imageStepReady(root);
    assert.equal(r.modelInstalled, false);
    assert.equal(r.engineReady, false);
    assert.equal(r.ready, false);
  });
});
