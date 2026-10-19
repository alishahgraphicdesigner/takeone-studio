/* Behaviour tests for DownloadManager against a SIMULATED aria2c (tests/mock-aria2c.js).
 * Run:  node --test tests/downloads.behavior.test.js
 *       DOWNLOADS_JS=/path/to/old/downloads.js node --test tests/downloads.behavior.test.js   (to see old behaviour)
 * Label: logic is tested; real aria2c / real network / Windows are NOT covered by this file. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { DownloadManager } = require(process.env.DOWNLOADS_JS || '../main/downloads.js');
const MOCK = path.join(__dirname, 'mock-aria2c.js');

const pattern = (size, seed) => { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (i * 7 + seed) & 255; return b; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (p) => fs.existsSync(p);
async function waitFor(fn, ms = 20000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); }
  throw new Error('timeout waiting for ' + what);
}

function env(world, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const worldPath = path.join(root, 'world.json'); fs.writeFileSync(worldPath, JSON.stringify(world));
  process.env.MOCK_WORLD = worldPath; process.env.MOCK_LOG = path.join(root, 'mock.log');
  process.env.MOCK_RPC_DELAY_MS = String(extra.delay || 0);
  return root;
}
const logLines = (root) => (has(path.join(root, 'mock.log')) ? fs.readFileSync(path.join(root, 'mock.log'), 'utf8').trim().split('\n') : []);
const adds = (root, urlPart) => logLines(root).filter((l) => l.startsWith('ADD ') && l.includes(urlPart)).length;
const live = [];
async function mgr(root) {
  const events = [];
  const m = new DownloadManager({ root, aria2cPath: MOCK, onEvent: (t, d) => events.push([t, d]), pollMs: 50 });
  m.events = events; await m.start(); live.push(m); return m;
}
function crash(m) { clearInterval(m.pollTimer); m.pollTimer = null; try { m.proc.kill('SIGKILL'); } catch (e) { /* gone */ } m.started = false; }
test.after(() => { for (const m of live) { clearInterval(m.pollTimer); try { m.proc.kill('SIGKILL'); } catch (e) { /* gone */ } } });

const U = (n) => `https://example.test/${n}`;
const fileTool = (id, size, seed, over = {}) => ({ id, installType: 'file', url: U(id), fileName: id + '.bin', sizeBytes: size, sha256: sha(pattern(size, seed)), category: 'text', ...over });
const COMMIT = 'a'.repeat(40);
const hfUrl = (p) => `https://huggingface.co/o/r/resolve/${COMMIT}/${p}`;
function hfTool(sizes) {
  return { id: 'vid', installType: 'hf', repo: 'o/r', commit: COMMIT, category: 'video',
    files: sizes.map((s, i) => ({ path: `d${i}/f${i}.bin`, bytes: s, sha256: sha(pattern(s, 10 + i)) })) };
}
const hfWorld = (tool, bps = 300000) => Object.fromEntries(tool.files.map((f, i) => [hfUrl(f.path), { size: f.bytes, seed: 10 + i, bps }]));

test('1. single file: downloads, verifies, lands in Models', async () => {
  const t = fileTool('brain', 2_000_000, 1);
  const root = env({ [t.url]: { size: t.sizeBytes, seed: 1 } });
  const m = await mgr(root); await m.addDownload(t);
  await waitFor(() => m.getState('brain').status === 'done', 20000, 'done');
  assert.strictEqual(sha(fs.readFileSync(path.join(root, 'Models', 'text', 'brain.bin'))), t.sha256);
});

test('2. HF job: all files verified, placed by path, progress reaches 100%', async () => {
  const t = hfTool([1_200_000, 900_000, 700_000]); const root = env(hfWorld(t));
  const m = await mgr(root); await m.addHfDownload(t);
  await waitFor(() => m.getState('vid').status === 'done', 30000, 'hf done');
  t.files.forEach((f, i) => assert.strictEqual(sha(fs.readFileSync(path.join(root, 'Models', 'video', 'vid', f.path))), f.sha256));
  assert.strictEqual(m.getState('vid').progress, 1);
});

test('3. cancel is not undone by a stale RPC answer', async () => {
  const t = fileTool('brain', 6_000_000, 2); const root = env({ [t.url]: { size: t.sizeBytes, seed: 2, bps: 100000 } }, { delay: 150 });
  const m = await mgr(root); await m.addDownload(t);
  await waitFor(() => m.getState('brain').progress > 0.05, 20000, 'progress');
  const n = logLines(root).filter((l) => l === 'TELL').length;
  await waitFor(() => logLines(root).filter((l) => l === 'TELL').length > n, 5000, 'a status request in flight');
  await m.cancel('brain');                       // lands while a (stale) answer is on its way
  await sleep(900);
  assert.strictEqual(m.getState('brain').status, 'cancelled', 'state must stay cancelled');
  assert.ok(!has(path.join(root, '.staging', 'downloads', 'brain.bin')), 'partial file must be gone');
});

test('4. crash mid-download, restart: resumes from the partial file', async () => {
  const t = fileTool('brain', 4_000_000, 3); const root = env({ [t.url]: { size: t.sizeBytes, seed: 3, bps: 150000 } });
  let m = await mgr(root); await m.addDownload(t);
  await waitFor(() => m.getState('brain').progress > 0.3, 20000, 'some progress'); await m.persist(); crash(m);
  await sleep(200);
  m = await mgr(root); assert.strictEqual(m.getState('brain').status, 'interrupted');
  await m.resume('brain');
  await waitFor(() => m.getState('brain').status === 'done', 30000, 'done after restart');
  assert.ok(logLines(root).some((l) => l.startsWith('RESUME ')), 'must continue from partial data, not from 0');
});

test('5. a finished download interrupted before verify/move is NOT deleted on restart', async () => {
  const t = fileTool('brain', 1_500_000, 4); const root = env({ [t.url]: { size: t.sizeBytes, seed: 4 } });
  const stg = path.join(root, '.staging', 'downloads'); fs.mkdirSync(stg, { recursive: true });
  fs.writeFileSync(path.join(stg, 'brain.bin'), pattern(t.sizeBytes, 4)); // complete, no .aria2 (aria2 removes it on completion)
  fs.writeFileSync(path.join(stg, 'downloads.json'), JSON.stringify({ version: 1, entries: { brain: {
    toolId: 'brain', url: t.url, fileName: 'brain.bin', category: 'text', sha256: t.sha256, expectedBytes: t.sizeBytes, status: 'verifying', progress: 1, retries: 0 } } }));
  const m = await mgr(root);
  assert.ok(has(path.join(stg, 'brain.bin')) || has(path.join(root, 'Models', 'text', 'brain.bin')), 'the finished file was deleted at startup');
  await waitFor(() => m.getState('brain').status === 'done', 15000, 'adopted + verified');
  assert.strictEqual(adds(root, 'brain'), 0, 'must not download it again');
});

test('6. HF: restart mid-job, resume reuses verified files', async () => {
  const t = hfTool([1_500_000, 1_500_000, 600_000]); const root = env(hfWorld(t, 120000));
  let m = await mgr(root); await m.addHfDownload(t);
  await waitFor(() => m.getState('vid').currentFileIndex === 1 && m.getState('vid').progress > 0.55, 30000, 'file 1 under way');
  await m.persist(); crash(m); await sleep(200);
  m = await mgr(root);
  await m.resume('vid');
  await waitFor(() => m.getState('vid').status === 'done', 40000, 'hf done after restart');
  assert.strictEqual(adds(root, 'f0.bin'), 1, 'verified file 0 must not be fetched again');
  t.files.forEach((f) => assert.strictEqual(sha(fs.readFileSync(path.join(root, 'Models', 'video', 'vid', f.path))), f.sha256));
});

test('7. HF: cancel then install again reuses verified files', async () => {
  const t = hfTool([1_200_000, 1_800_000]); const root = env(hfWorld(t, 120000));
  const m = await mgr(root); await m.addHfDownload(t);
  await waitFor(() => m.getState('vid').currentFileIndex === 1 && m.getState('vid').progress > 0.5, 30000, 'file 1 under way');
  await m.cancel('vid'); assert.strictEqual(m.getState('vid').status, 'cancelled');
  await m.addHfDownload(t);
  await waitFor(() => m.getState('vid').status === 'done', 40000, 'done after re-add');
  assert.strictEqual(adds(root, 'f0.bin'), 1, 'verified file 0 must not be fetched again');
});

test('8. checksum failure: says so, no silent restart', async () => {
  const t = fileTool('brain', 1_000_000, 5, { sha256: 'f'.repeat(64) }); const root = env({ [t.url]: { size: t.sizeBytes, seed: 5 } });
  const m = await mgr(root); await m.addDownload(t);
  await waitFor(() => m.getState('brain').status === 'failed', 20000, 'failed');
  assert.match(m.getState('brain').error, /checksum|corrupt/i);
  await sleep(500); assert.strictEqual(adds(root, 'brain'), 1, 'no automatic restart after a verify failure');
});

test('9. "Try again" after a network failure continues from the partial file', async () => {
  const t = fileTool('brain', 3_000_000, 6); const root = env({ [t.url]: { size: t.sizeBytes, seed: 6, bps: 250000, failAt: 1_000_000, failTimes: 2 } });
  const m = await mgr(root); await m.addDownload(t);
  await waitFor(() => m.getState('brain').status === 'failed', 30000, 'failed after auto retry');
  await m.retry('brain', t);
  await waitFor(() => m.getState('brain').status === 'done', 30000, 'done after Try again');
  const L = logLines(root); const lastAdd = L.map((l, i) => (l.startsWith('ADD ') ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(L[lastAdd + 1] && L[lastAdd + 1].startsWith('RESUME '), 'Try again must resume, not restart from 0');
});

test('10. exact size known: off-by-one is rejected (no 95% tolerance)', async () => {
  const t = fileTool('brain', 1_000_000, 7, { sizeBytes: 1_000_001, sha256: null }); const root = env({ [t.url]: { size: 1_000_000, seed: 7 } });
  const m = await mgr(root); await m.addDownload(t);
  await waitFor(() => ['failed', 'done'].includes(m.getState('brain').status), 20000, 'finished');
  assert.strictEqual(m.getState('brain').status, 'failed');
});

test('11. cancel reports freedBytes = partial size, and the UI event carries it (Ali verdict 2026-10-17)', async () => {
  const t = fileTool('brain', 6_000_000, 11);
  const root = env({ [t.url]: { size: t.sizeBytes, seed: 11, bps: 100000 } });
  const m = await mgr(root); await m.addDownload(t);
  await waitFor(() => m.getState('brain').progress > 0.05, 20000, 'progress');
  await m.pause('brain'); // freeze the partial file so its size is deterministic
  await waitFor(() => m.getState('brain').status === 'paused', 5000, 'paused');
  const partialPath = path.join(root, '.staging', 'downloads', 'brain.bin');
  const ctlPath = partialPath + '.aria2';
  // freedBytes counts everything cancel deletes: the partial file AND its .aria2 control file.
  const partialSize = fs.statSync(partialPath).size + (has(ctlPath) ? fs.statSync(ctlPath).size : 0);
  assert.ok(partialSize > 0, 'partial file must have grown, got ' + partialSize);
  const r = await m.cancel('brain');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.freedBytes, partialSize, 'freedBytes must equal the partial file size that was deleted');
  assert.ok(!has(partialPath), 'partial file must be gone after cancel');
  const ev = m.events.filter(([type, d]) => type === 'state' && d.toolId === 'brain' && d.state === 'cancelled').pop();
  assert.ok(ev, 'a cancelled state event must reach the UI');
  assert.strictEqual(ev[1].freedBytes, partialSize, 'UI event must carry the same freedBytes value');
});
