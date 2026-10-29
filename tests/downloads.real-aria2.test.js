/* Server-based download tests: DownloadManager talks to a LOCAL HTTP server (throttled, Range-capable).
 *   Real aria2c (CI on Windows/Linux):  ARIA2C=C:\path\aria2c.exe  node --test tests/downloads.real-aria2.test.js
 *   Harness check with the simulator:   ARIA2C=tests/mock-aria2c.js (default)  — proves the test code, NOT aria2c itself.
 * Assertions are on bytes actually served and on final state, never on aria2's internal request pattern. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { DownloadManager } = require('../main/downloads.js');

const ARIA2C = process.env.ARIA2C || path.join(__dirname, 'mock-aria2c.js');
const IS_REAL = !!process.env.ARIA2C;
const RATE = 4 * 1024 * 1024;           // total bytes/sec the server hands out per file, however many connections
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (p) => fs.existsSync(p);
async function waitFor(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); } throw new Error('timeout waiting for ' + what); }
const patternBuf = (size, seed, start = 0, len = size) => { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = ((start + i) * 7 + seed) & 255; return b; };
function shaOfPattern(size, seed) { const h = crypto.createHash('sha256'); for (let s = 0; s < size; s += 1 << 20) h.update(patternBuf(size, seed, s, Math.min(1 << 20, size - s))); return h.digest('hex'); }

/** Throttled, Range-capable file server. files: { '/path': { size, seed } } */
function startServer(files) {
  const served = {}; let active = 0; const conns = new Map(); // path -> Set(conn)
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const f = files[decodeURIComponent(u.pathname)];
    if (!f) { res.statusCode = 404; return res.end(); }
    let start = 0, end = f.size - 1, status = 200;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) { start = +m[1]; if (m[2]) end = Math.min(+m[2], f.size - 1); status = 206; }
    if (start >= f.size) { res.statusCode = 416; return res.end(); }
    res.statusCode = status; res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', end - start + 1);
    if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${f.size}`);
    if (req.method === 'HEAD') return res.end();
    const c = { pos: start, end, res }; const key = u.pathname;
    if (!conns.has(key)) conns.set(key, new Set()); conns.get(key).add(c); active++;
    const done = () => { if (conns.get(key).delete(c)) active--; };
    res.on('close', done); req.on('error', done);
  });
  // One shared bucket per file: the total rate does not depend on how many connections the client opens.
  const timer = setInterval(() => {
    for (const [key, set] of conns) {
      const live = [...set].filter((c) => !c.res.destroyed && c.pos <= c.end); if (!live.length) continue;
      const share = Math.max(1, Math.floor((RATE * 0.05) / live.length)); const f = files[decodeURIComponent(key)];
      for (const c of live) {
        const n = Math.min(share, c.end - c.pos + 1); c.res.write(patternBuf(f.size, f.seed, c.pos, n)); c.pos += n;
        served[key] = (served[key] || 0) + n;
        if (c.pos > c.end) { c.res.end(); set.delete(c); active--; }
      }
    }
  }, 50);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`, served, active: () => active,
    close: () => { clearInterval(timer); srv.closeAllConnections && srv.closeAllConnections(); srv.close(); },
  })));
}

const live = []; let servers = [];
async function setup(files) { const s = await startServer(files); servers.push(s); return { s, root: fs.mkdtempSync(path.join(os.tmpdir(), 'dlr-')) }; }
async function mgr(root, s) { const m = new DownloadManager({ root, aria2cPath: ARIA2C, pollMs: 100, hfBase: s.base }); await m.start(); live.push(m); return m; }
function crash(m) { clearInterval(m.pollTimer); m.pollTimer = null; try { m.proc.kill('SIGKILL'); } catch (e) { /* gone */ } m.started = false; }
test.after(() => { for (const m of live) { clearInterval(m.pollTimer); try { m.proc.kill('SIGKILL'); } catch (e) { /* gone */ } } servers.forEach((s) => s.close()); });
const MB = 1024 * 1024;
const fileTool = (s, id, size, seed, over = {}) => ({ id, installType: 'file', url: `${s.base}/${id}.bin`, fileName: `${id}.bin`, sizeBytes: size, sha256: shaOfPattern(size, seed), category: 'text', ...over });

test('A. single file: complete, verified, installed', async () => {
  const size = 8 * MB; const { s, root } = await setup({ '/brain.bin': { size, seed: 1 } });
  const m = await mgr(root, s); await m.addDownload(fileTool(s, 'brain', size, 1));
  await waitFor(() => m.getState('brain').status === 'done', 60000, 'done');
  assert.strictEqual(fs.statSync(path.join(root, 'Models', 'text', 'brain.bin')).size, size);
});

test('B. cancel stops the transfer and leaves no partial file', async () => {
  const size = 40 * MB; const { s, root } = await setup({ '/brain.bin': { size, seed: 2 } });
  const m = await mgr(root, s); await m.addDownload(fileTool(s, 'brain', size, 2));
  await waitFor(() => m.getState('brain').progress > 0.1, 60000, 'progress');
  await m.cancel('brain');
  await waitFor(() => s.active() === 0, 8000, 'server connections closed');
  const served = s.served['/brain.bin'] || 0; await sleep(1500);
  assert.ok((s.served['/brain.bin'] || 0) - served < 0.5 * MB, 'data kept flowing after cancel');
  assert.strictEqual(m.getState('brain').status, 'cancelled');
  assert.ok(!has(path.join(root, '.staging', 'downloads', 'brain.bin')), 'partial file must be removed');
});

test('C. engine killed mid-download (≥12 s in), restart: continues, does not start over', async () => {
  const size = 64 * MB; const { s, root } = await setup({ '/brain.bin': { size, seed: 3 } });
  let m = await mgr(root, s); const t = fileTool(s, 'brain', size, 3); await m.addDownload(t); const t0 = Date.now();
  await waitFor(() => Date.now() - t0 > 12000 && m.getState('brain').progress > 0.5, 90000, '>12 s and >50%');
  await m.persist(); crash(m); await sleep(500);
  const before = s.served['/brain.bin'] || 0;
  m = await mgr(root, s); assert.strictEqual(m.getState('brain').status, 'interrupted');
  await m.resume('brain');
  await waitFor(() => m.getState('brain').status === 'done', 90000, 'done after restart');
  const after = (s.served['/brain.bin'] || 0) - before;
  assert.ok(after < 0.85 * size, `re-fetched ${(after / MB).toFixed(1)} MB of ${(size / MB)} MB — looks like a restart from 0`);
  assert.strictEqual(fs.statSync(path.join(root, 'Models', 'text', 'brain.bin')).size, size);
});

test('D. HF job interrupted mid-way: verified files are not fetched again', async () => {
  const sizes = [12 * MB, 12 * MB, 8 * MB]; const COMMIT = 'b'.repeat(40);
  const key0 = `/o/r/resolve/${COMMIT}/d0/f0.bin`;
  const files = {}; sizes.forEach((z, i) => { files[`/o/r/resolve/${COMMIT}/d${i}/f${i}.bin`] = { size: z, seed: 20 + i }; });
  const { s, root } = await setup(files);
  const tool = { id: 'vid', installType: 'hf', repo: 'o/r', commit: COMMIT, category: 'video', files: sizes.map((z, i) => ({ path: `d${i}/f${i}.bin`, bytes: z, sha256: shaOfPattern(z, 20 + i) })) };
  let m = await mgr(root, s); await m.addHfDownload(tool);
  await waitFor(() => m.getState('vid').currentFileIndex === 1 && m.getState('vid').progress > 0.55, 90000, 'file 1 under way');
  await m.persist(); crash(m); await sleep(500);
  // WO-40.3: snapshot file 0 AT THE CRASH — the old total-served check
  // could not tell a re-download from the pre-crash download. Only bytes
  // served AFTER the restart count, and they must be <= 2% of file 0.
  const servedFile0AtCrash = s.served[key0] || 0;
  m = await mgr(root, s); await m.resume('vid');
  await waitFor(() => m.getState('vid').status === 'done', 90000, 'hf done');
  const servedFile0After = s.served[key0] || 0;
  const reServed = servedFile0After - servedFile0AtCrash;
  const pct = (reServed / sizes[0]) * 100;
  assert.ok(reServed <= sizes[0] * 0.02,
    `verified file 0 was downloaded again: re-served ${reServed} bytes (${pct.toFixed(2)}% of file 0's ${sizes[0]} bytes) after restart; ` +
    `served at crash ${servedFile0AtCrash} bytes, served after done ${servedFile0After} bytes, allowed <= ${Math.floor(sizes[0] * 0.02)} bytes (2%)`);
  sizes.forEach((z, i) => assert.strictEqual(fs.statSync(path.join(root, 'Models', 'video', 'vid', `d${i}`, `f${i}.bin`)).size, z));
});

test('E. corrupt data: clear failure, no silent restart', async () => {
  const size = 6 * MB; const { s, root } = await setup({ '/brain.bin': { size, seed: 5 } });
  const m = await mgr(root, s); await m.addDownload(fileTool(s, 'brain', size, 5, { sha256: 'f'.repeat(64) }));
  await waitFor(() => m.getState('brain').status === 'failed', 60000, 'failed');
  assert.match(m.getState('brain').error, /checksum|corrupt/i);
  await sleep(1500); assert.ok((s.served['/brain.bin'] || 0) <= size * 1.02, 'it silently downloaded the file again');
});
test('F. cancel leaves no partial/.aria2 in staging — 30 iterations (WO-10)', { timeout: 900000 }, async () => {
  const size = 12 * MB; const { s, root } = await setup({ '/loop.bin': { size, seed: 42 } });
  const m = await mgr(root, s);
  for (let i = 0; i < 30; i++) {
    const id = 'loop' + i;
    const tool = { id, installType: 'file', url: `${s.base}/loop.bin`, fileName: 'loop.bin', sizeBytes: size, sha256: shaOfPattern(size, 42), category: 'text' };
    await m.addDownload(tool);
    await waitFor(() => m.getState(id).progress > 0.05, 30000, 'progress iter ' + i);
    const r = await m.cancel(id);
    assert.strictEqual(r.ok, true, `iter ${i}: cancel returned not-ok`);
    assert.strictEqual(m.getState(id).status, 'cancelled', `iter ${i}: status must be cancelled`);
    const partial = path.join(root, '.staging', 'downloads', 'loop.bin');
    assert.ok(!has(partial), `iter ${i}: partial file remained in staging after cancel`);
    assert.ok(!has(partial + '.aria2'), `iter ${i}: .aria2 control file remained in staging after cancel`);
  }
});
/* FIX-8: HF multi-file job end-to-end against a local server with a fake
 * small manifest — the download -> installed link for video-studio and
 * for a second HF tool (vision). The shipped app's panel-installed
 * branch is proven separately by the ui-audit sparse-seed check (the
 * shipped catalog's 34 GB manifest cannot be served byte-exact in CI).
 * A missing/wrong-size file after "done" must read as incomplete with
 * the file named — the diagnostics' first-mismatch source. */
const { hfInstalledStatus } = require('../main/hf-install-check.js');
const hfTool = (id, category, files) => ({ id, installType: 'hf', repo: 'test/' + id, commit: 't1', category, files });
test('FIX-8: HF job video-studio -> files on disk -> install check complete', async () => {
  const a = { size: 64 * 1024, seed: 11 }, b = { size: 3 * 1024, seed: 12 };
  const files = [
    { path: 'diffusion_pytorch_model-00001-of-00003.safetensors', bytes: a.size, sha256: shaOfPattern(a.size, a.seed) },
    { path: 'google/umt5-xxl/tokenizer_config.json', bytes: b.size, sha256: shaOfPattern(b.size, b.seed) },
  ];
  const { s, root } = await setup({
    '/test/video-studio/resolve/t1/diffusion_pytorch_model-00001-of-00003.safetensors': a,
    '/test/video-studio/resolve/t1/google/umt5-xxl/tokenizer_config.json': b,
  });
  const m = await mgr(root, s);
  await m.addHfDownload(hfTool('video-studio', 'video', files));
  await waitFor(() => m.getState('video-studio').status === 'done', 60000, 'video-studio done');
  const dir = path.join(root, 'Models', 'video', 'video-studio');
  assert.strictEqual(fs.statSync(path.join(dir, files[0].path)).size, a.size);
  assert.strictEqual(fs.statSync(path.join(dir, files[1].path)).size, b.size);
  const chk = await hfInstalledStatus(dir, files);
  assert.strictEqual(chk.complete, true, 'install check must pass after a verified download, got ' + chk.bad);
});

test('FIX-8: HF job vision (second tool) -> install check complete; missing file named', async () => {
  const a = { size: 32 * 1024, seed: 21 };
  const files = [{ path: 'model.safetensors', bytes: a.size, sha256: shaOfPattern(a.size, a.seed) }];
  const { s, root } = await setup({ '/test/vision/resolve/t1/model.safetensors': a });
  const m = await mgr(root, s);
  await m.addHfDownload(hfTool('vision', 'analyze', files));
  await waitFor(() => m.getState('vision').status === 'done', 60000, 'vision done');
  const dir = path.join(root, 'Models', 'analyze', 'vision');
  assert.strictEqual((await hfInstalledStatus(dir, files)).complete, true);
  fs.unlinkSync(path.join(dir, 'model.safetensors'));
  const chk = await hfInstalledStatus(dir, files);
  assert.strictEqual(chk.complete, false, 'a deleted file must fail the check');
  assert.match(chk.bad, /model\.safetensors: missing/);
});

console.log(IS_REAL ? '[using REAL aria2c: ' + ARIA2C + ']' : '[using the SIMULATOR — harness check only]');
