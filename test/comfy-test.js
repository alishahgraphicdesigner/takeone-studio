/**
 * Tests for ComfyUI integration (main/comfy.js, main/comfy-workflows.js).
 * Uses a mock HTTP server — no GPU needed.
 */
const assert = require('assert');
const http = require('http');
const { ComfyManager } = require('../main/comfy.js');
const { sdxlTxt2Img } = require('../main/comfy-workflows.js');

async function testWorkflow() {
  const wf = sdxlTxt2Img({
    checkpoint: 'test.safetensors',
    positive: 'a cat',
    negative: 'blurry',
    width: 512, height: 512, steps: 4, seed: 42,
  });
  // Valid ComfyUI API format: node IDs -> {class_type, inputs}
  assert(wf['1'].class_type === 'CheckpointLoaderSimple', 'node 1 should be checkpoint loader');
  assert(wf['1'].inputs.ckpt_name === 'test.safetensors', 'checkpoint name');
  assert(wf['2'].inputs.text === 'a cat', 'positive prompt');
  assert(wf['5'].inputs.seed === 42, 'seed');
  assert(wf['5'].inputs.steps === 4, 'steps');
  assert(wf['7'].class_type === 'SaveImage', 'node 7 should save');
  console.log('✓ workflow template valid');
}

async function testApiClient() {
  // Mock ComfyUI server
  const server = http.createServer((req, res) => {
    if (req.url === '/system_stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ system: { comfyui_version: 'test' } }));
    } else if (req.url === '/prompt' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body);
        assert(j.prompt, 'should have prompt');
        assert(j.prompt['1'], 'should have node 1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: 'test-123' }));
      });
    } else if (req.url.startsWith('/history/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        'test-123': { outputs: { '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } },
      }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((r) => server.listen(8188, '127.0.0.1', r));

  const mgr = new ComfyManager({ root: '/tmp', pythonExe: '/tmp/py', comfyDir: '/tmp', onEvent: () => {} });
  mgr.ready = true; // bypass process spawn for API test
  mgr.proc = { fake: true };

  // Test queuePrompt
  const q = await mgr.queuePrompt({ '1': { class_type: 'Test', inputs: {} } });
  assert(q.ok && q.promptId === 'test-123', 'queuePrompt should return prompt_id');

  // Test getHistory
  const h = await mgr.getHistory('test-123');
  assert(h.ok && h.history.outputs['7'].images[0].filename === 'out.png', 'history should have image');

  server.close();
  console.log('✓ API client works with mock server');
}

async function main() {
  await testWorkflow();
  await testApiClient();
  console.log('\nAll ComfyUI tests passed.');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
