/* TakeOne Studio 2.2.9 — WO-27 Studio generate flow tests.
 * The REAL main/comfy.js HTTP client against a mock ComfyUI HTTP server
 * (plain node:http): /system_stats, /prompt, /history/{id}, /interrupt, /view.
 * Scenarios: success (PNG bytes retrievable), engine not ready (plain message),
 * cancel mid-generate (/interrupt received), ComfyUI crash (errors surface).
 * No GPU, no real ComfyUI, no network beyond localhost. */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ComfyManager } = require('../main/comfy.js');
const engine = require('../main/engine.js');

// A minimal valid 1x1 PNG (hand-built, fixed bytes).
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
  '0000000c4944415478da6360000000020001e221bc330000000049454e44ae426082', 'hex');

let server, port, interrupted = 0, historyCalls = 0, crashMode = false;

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

before(async () => {
  server = http.createServer((req, res) => {
    if (crashMode) { req.socket.destroy(); return; }
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/system_stats') return json(res, { system: { comfyui_version: 'mock' } });
    if (u.pathname === '/prompt' && req.method === 'POST') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => json(res, { prompt_id: 'mock-prompt-1' }));
      return;
    }
    if (u.pathname === '/interrupt' && req.method === 'POST') { interrupted++; return json(res, {}); }
    if (u.pathname.startsWith('/history/')) {
      historyCalls++;
      // First two polls: still working. Then: done with one PNG output.
      if (historyCalls < 3) return json(res, { 'mock-prompt-1': { status: { status_str: 'running' } } });
      return json(res, {
        'mock-prompt-1': {
          status: { status_str: 'success', completed: true },
          outputs: { '9': { images: [{ filename: 'mock_00001_.png', subfolder: '', type: 'output' }] } },
        },
      });
    }
    if (u.pathname === '/view') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG_1X1); return; }
    json(res, { error: 'unknown' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => { await new Promise((r) => server.close(r)); });

/** A manager "attached" to the mock server (no real ComfyUI process spawned). */
function attachedManager() {
  const mgr = new ComfyManager({ root: '/tmp', pythonExe: '/tmp/fake-python', comfyDir: '/tmp/fake-comfy' });
  mgr.ready = true;
  mgr.port = port;
  mgr.proc = { fake: true }; // isRunning() needs a proc handle
  return mgr;
}

describe('WO-27: Studio generate flow vs mock ComfyUI', () => {
  it('success: queue -> history -> PNG bytes are a real PNG', async () => {
    historyCalls = 0;
    const mgr = attachedManager();
    const q = await mgr.queuePrompt({ fake: 'workflow' });
    assert.equal(q.ok, true);
    assert.equal(q.promptId, 'mock-prompt-1');
    assert.equal(q.port, port, 'port is returned so the renderer never hardcodes 8188');

    let outs = null;
    for (let i = 0; i < 5 && !outs; i++) {
      const h = await mgr.getHistory(q.promptId);
      assert.equal(h.ok, true);
      const images = h.history && h.history.outputs && Object.values(h.history.outputs)
        .flatMap((o) => o.images || []);
      if (images && images.length) outs = images;
    }
    assert.ok(outs && outs.length, 'history eventually carries the PNG output');

    // The renderer hotlinks /view — prove the bytes behind it are a real PNG.
    const png = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/view?filename=${outs[0].filename}&type=output`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    assert.deepEqual(png.subarray(0, 8), PNG_1X1.subarray(0, 8), 'PNG magic bytes');
    assert.ok(png.length > 50, 'non-trivial PNG body');
  });

  it('engine not ready: assertEngineReady throws a plain-words message', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takeone-noengine-'));
    try {
      await assert.rejects(() => engine.assertEngineReady(root), (err) => {
        assert.match(err.message, /Models page/);
        assert.ok(!/venv|torch|traceback|\.py\b/i.test(err.message), 'no dev jargon: ' + err.message);
        return true;
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancel mid-generate: /interrupt reaches the server', async () => {
    interrupted = 0;
    const mgr = attachedManager();
    const r = await mgr.interrupt();
    assert.equal(r.ok, true);
    assert.equal(interrupted, 1, 'mock server saw POST /interrupt');
  });

  it('ComfyUI crash: errors surface as {ok:false}, never throw', async () => {
    crashMode = true;
    try {
      const mgr = attachedManager();
      const q = await mgr.queuePrompt({ fake: 'workflow' });
      assert.equal(q.ok, false, 'queue fails when the server is gone');
      assert.match(q.error, /Could not queue/);
      const h = await mgr.getHistory('mock-prompt-1');
      assert.equal(h.ok, false, 'history fails when the server is gone');
    } finally {
      crashMode = false;
    }
  });
});
