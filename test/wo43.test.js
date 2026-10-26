/* WO-43: Quick Generate's image rendered as a broken <img> on Ali's PC
 * (v2.2.17) because the renderer loaded it straight from ComfyUI's /view
 * URL, and nothing was saved to the Library. The fix fetches through main
 * and saves first. These tests pin it with a fake ComfyUI HTTP server. */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ComfyManager } = require('../main/comfy.js');
const diag = require('../main/diagnostics.js');
const engine = require('../main/engine.js');

/* 1x1 transparent PNG (real bytes, not a fixture string). */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

/** Fake ComfyUI: /history/<id> with one image, /view serving `viewMode`. */
function fakeComfy(viewMode) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/history/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pid1: { outputs: { 7: { images: [{ filename: 'takeone_00001_.png', subfolder: '', type: 'output' }] } } },
      }));
    } else if (req.url.startsWith('/view')) {
      if (viewMode === 'png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(TINY_PNG);
      } else if (viewMode === '404') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html>not found</html>');
      } else if (viewMode === '403') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden');
      } else if (viewMode === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>not an image</html>');
      }
    } else { res.writeHead(404); res.end(); }
  });
  return server;
}

async function attachedManager(viewMode) {
  const server = fakeComfy(viewMode);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mgr = new ComfyManager({ root: '/tmp', pythonExe: '/tmp/py', comfyDir: '/tmp', onEvent: () => {} });
  mgr.ready = true; mgr.proc = { fake: true }; mgr.port = server.address().port;
  return { server, mgr };
}

describe('fetchAndSaveOutput (WO-43.1, WO-43.2)', () => {
  it('saves a real PNG to Library/Quick Generate + sidecar + dataUrl', async () => {
    const { server, mgr } = await attachedManager('png');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo43-save-'));
    try {
      const r = await mgr.fetchAndSaveOutput(root, 'pid1', { prompt: 'a cat', model: 'sdxl_lightning_4step.safetensors', seed: 42, width: 512, height: 512 });
      assert.equal(r.ok, true, JSON.stringify(r));
      // M1: a real Library project, not the old loose folder.
      assert.ok(r.path.includes(path.join('Projects', r.projectId, 'images')), r.path);
      assert.equal(r.projectName, 'Quick Generate');
      assert.ok(fs.existsSync(r.path), 'PNG must exist on disk');
      const bytes = fs.readFileSync(r.path);
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic bytes');
      assert.ok(r.dataUrl.startsWith('data:image/png;base64,'), 'renderer gets a dataUrl, never a local URL');
      const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(r.path), '.sidecars', path.basename(r.path).replace(/\.png$/i, '.json')), 'utf8'));
      assert.equal(sidecar.prompt, 'a cat');
      assert.equal(sidecar.model, 'sdxl_lightning_4step.safetensors');
      assert.equal(sidecar.seed, 42);
      assert.equal(sidecar.comfyFile.filename, 'takeone_00001_.png');
    } finally { server.close(); }
  });
  it('ComfyUI 404 on /view -> plain "made but couldn\'t be saved", no HTML', async () => {
    const { server, mgr } = await attachedManager('404');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo43-404-'));
    try {
      const r = await mgr.fetchAndSaveOutput(root, 'pid1', {});
      assert.equal(r.ok, false);
      assert.match(r.error, /made but couldn't be saved/);
      assert.match(r.error, /404/);
      assert.ok(!r.error.includes('<html>') && !r.error.includes('not found'), 'no raw body in the message: ' + r.error);
    } finally { server.close(); }
  });
  it('ComfyUI 403 on /view -> plain message with the status', async () => {
    const { server, mgr } = await attachedManager('403');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo43-403-'));
    try {
      const r = await mgr.fetchAndSaveOutput(root, 'pid1', {});
      assert.equal(r.ok, false);
      assert.match(r.error, /made but couldn't be saved/);
      assert.match(r.error, /403/);
    } finally { server.close(); }
  });
  it('200 but non-PNG bytes -> plain message, nothing saved', async () => {
    const { server, mgr } = await attachedManager('html');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo43-html-'));
    try {
      const r = await mgr.fetchAndSaveOutput(root, 'pid1', {});
      assert.equal(r.ok, false);
      assert.match(r.error, /not a PNG/);
      const projects = path.join(root, 'Projects');
      assert.ok(!fs.existsSync(projects) || fs.readdirSync(projects).length === 0, 'an error page must never be saved as an image');
    } finally { server.close(); }
  });
  it('unwritable Library root -> plain message, never a throw', async () => {
    const { server, mgr } = await attachedManager('png');
    const rootFile = path.join(os.tmpdir(), 'wo43-notadir-' + Date.now());
    fs.writeFileSync(rootFile, 'x');
    try {
      const r = await mgr.fetchAndSaveOutput(rootFile, 'pid1', {});
      assert.equal(r.ok, false);
      assert.match(r.error, /couldn't be saved/);
    } finally { server.close(); fs.unlinkSync(rootFile); }
  });
  it('prompt with no outputs yet -> notFinished (renderer keeps polling)', async () => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/history/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pid1: { outputs: null } }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const mgr = new ComfyManager({ root: '/tmp', pythonExe: '/tmp/py', comfyDir: '/tmp', onEvent: () => {} });
    mgr.ready = true; mgr.proc = { fake: true }; mgr.port = server.address().port;
    try {
      const r = await mgr.fetchAndSaveOutput('/tmp', 'pid1', {});
      assert.equal(r.ok, false);
      assert.equal(r.notFinished, true);
    } finally { server.close(); }
  });
});

describe('diagnostics: last generation + Quick Generate outputs (WO-43.5)', () => {
  it('lastGenerationLine finds the last "Prompt executed" line, ANSI-free', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo43-diag-'));
    const dir = engine.engineRoot(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'comfyui.log'),
      '[err] Starting server\n[err] \x1b[32m[INFO]\x1b[0m Prompt executed in 12.34 seconds\n[err] Prompt executed in 9.01 seconds\n');
    assert.equal(diag.lastGenerationLine(root), 'Prompt executed in 9.01 seconds');
  });
  it('lastGenerationLine is null when no generation completed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo43-diag2-'));
    assert.equal(diag.lastGenerationLine(root), null);
  });
  it('listQuickOutputs returns the newest 5 PNGs, name + size', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wo43-diag3-'));
    // M1: outputs live in the real Quick Generate project's images dir.
    const projDir = path.join(root, 'Projects', 'quick-generate-1');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'project.json'), JSON.stringify({ id: 'quick-generate-1', name: 'Quick Generate' }));
    const dir = path.join(projDir, 'images');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const p = path.join(dir, `2026-10-24-12000${i}.png`);
      fs.writeFileSync(p, Buffer.alloc(100 + i));
      fs.utimesSync(p, new Date(2026, 9, 24, 12, 0, i), new Date(2026, 9, 24, 12, 0, i));
    }
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}'); // sidecars are not outputs
    const outs = diag.listQuickOutputs(root);
    assert.equal(outs.length, 5);
    assert.ok(outs[0].startsWith('2026-10-24-120006.png'), outs[0]);
    assert.ok(outs.every((o) => o.includes('(') && o.includes(')')));
  });
  it('report carries the Last generation + Quick Generate sections', async () => {
    const r = await diag.buildDiagnosticsReport('C:\\TakeOne', {
      version: '2.2.18', windows: 'w', gpu: 'x',
      engineReadiness: { ready: false, stateReady: false, venvPresent: false, comfyPresent: false, wheelsCount: 0 },
      disk: 'x', appLog: '', comfyLog: '', engineSection: 'Root: x', storageSection: 'Root: x', prevSession: '',
      lastGeneration: 'Prompt executed in 12.34 seconds',
      quickOutputs: ['2026-10-24-120006.png (1 MB)'],
    });
    assert.ok(r.includes('--- Last generation ---'), r);
    assert.ok(r.includes('Prompt executed in 12.34 seconds'), r);
    assert.ok(r.includes('2026-10-24-120006.png (1 MB)'), r);
  });
});
