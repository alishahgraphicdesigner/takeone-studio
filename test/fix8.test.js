'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { decideToolState } = require('../main/tool-states.js');

test('FIX-8: installed beats every other signal', () => {
  const d = decideToolState({ installed: true, dl: { status: 'done' }, ts: null });
  assert.strictEqual(d.state, 'installed');
  assert.strictEqual(d.needsAutoRetry, false);
});

test('FIX-8: download done but manifest check fails is FAILED with the bad file named, never "not installed"', () => {
  const d = decideToolState({
    installed: false, dl: { status: 'done' }, ts: null,
    bad: 'models_t5_umt5-xxl-enc-bf16.pth: size 11361920384 != expected 11361920418',
  });
  assert.strictEqual(d.state, 'failed', 'must not read as not-installed');
  assert.match(d.error, /models_t5_umt5-xxl-enc-bf16\.pth/);
  assert.match(d.error, /re-checking/);
  assert.strictEqual(d.needsAutoRetry, true);
});

test('FIX-8: download done but check fails without detail still fails honestly', () => {
  const d = decideToolState({ installed: false, dl: { status: 'done' }, ts: null, bad: null });
  assert.strictEqual(d.state, 'failed');
  assert.strictEqual(d.needsAutoRetry, true);
});

test('FIX-8: in-flight download states pass through unchanged', () => {
  assert.strictEqual(decideToolState({ installed: false, dl: { status: 'downloading', progress: 0.42 }, ts: null }).state, 'downloading');
  assert.strictEqual(decideToolState({ installed: false, dl: { status: 'downloading', progress: 0.42 }, ts: null }).progress, 0.42);
  const r = decideToolState({ installed: false, dl: { status: 'retrying' }, ts: null });
  assert.strictEqual(r.state, 'retrying');
  assert.strictEqual(r.detail, 'Retrying automatically…');
});

test('FIX-8: legacy tool-status records pass through; nothing at all is not-installed', () => {
  assert.strictEqual(decideToolState({ installed: false, dl: null, ts: { status: 'installing', fraction: 0.7 } }).state, 'installing');
  assert.strictEqual(decideToolState({ installed: false, dl: null, ts: { status: 'failed', error: 'boom' } }).error, 'boom');
  assert.strictEqual(decideToolState({ installed: false, dl: null, ts: null }).state, 'not-installed');
  assert.strictEqual(decideToolState({ installed: false, dl: null, ts: null }).needsAutoRetry, false);
});

test('FIX-8 diagnostics: video-studio section names every file, the first mismatch and the raw record', async () => {
  const diag = require('../main/diagnostics.js');
  const vs = {
    dir: 'C:\\Users\\RealName\\TakeOne\\Models\\video\\video-studio',
    files: [
      { path: 'diffusion_pytorch_model-00001-of-00003.safetensors', size: 100, expected: 100 },
      { path: 'models_t5_umt5-xxl-enc-bf16.pth', size: null, expected: 200 },
    ],
    firstMismatch: 'models_t5_umt5-xxl-enc-bf16.pth: missing',
    dlState: { toolId: 'video-studio', status: 'done', progress: 1 },
    toolState: 'failed',
    toolError: 'Download finished but models_t5_umt5-xxl-enc-bf16.pth: missing — re-checking the download automatically.',
  };
  const r = await diag.buildDiagnosticsReport('C:\\Users\\RealName\\TakeOne', {
    version: '2.2.23', windows: 'w', gpu: 'g', engineSummary: 'e', disk: 'd',
    appLog: '', comfyLog: '', engineSection: 'x', storageSection: 'x', prevSession: '',
    videoStudio: vs,
  });
  assert.ok(r.includes('--- Video Studio files ---'), 'section header present');
  assert.ok(r.includes('models_t5_umt5-xxl-enc-bf16.pth — missing (expected 200)'), 'missing file named with expected size');
  assert.ok(r.includes('First mismatch: models_t5_umt5-xxl-enc-bf16.pth: missing'), 'first mismatch named');
  assert.ok(r.includes('"status":"done"'), 'raw download record present');
  assert.ok(r.includes('Tool state: failed'), 'derived tool state present');
  assert.ok(!r.includes('RealName'), 'user name still masked');
});
