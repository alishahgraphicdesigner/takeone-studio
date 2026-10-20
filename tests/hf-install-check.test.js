/* Tests for main/hf-install-check.js — HF install completeness.
 * The critical case: a HALF-downloaded HF job must NOT read as installed.
 * Run: node --test tests/hf-install-check.test.js
 * Label: logic is tested; real network / Windows are NOT covered by this file.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { hfInstalledStatus } = require('../main/hf-install-check.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pattern = (size, seed) => { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (i * 7 + seed) & 255; return b; };

function world(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfcheck-'));
  const manifest = [];
  for (const f of files) {
    const fp = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, f.data);
    manifest.push({ path: f.rel, bytes: f.data.length, sha256: f.sha ? sha(f.data) : null });
  }
  return { dir, manifest };
}

test('complete: all files byte-exact -> complete true (default AND deep)', async () => {
  const { dir, manifest } = world([
    { rel: 'model.safetensors', data: pattern(1024, 1), sha: true },
    { rel: 'sub/config.json', data: pattern(100, 2), sha: true },
  ]);
  const r = await hfInstalledStatus(dir, manifest);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.checked, 2);
  assert.strictEqual(r.bad, null);
  const rd = await hfInstalledStatus(dir, manifest, { deep: true });
  assert.strictEqual(rd.complete, true);
  assert.strictEqual(rd.checked, 2);
  assert.strictEqual(rd.bad, null);
});

test('half-downloaded: one file truncated -> complete FALSE (not installed)', async () => {
  const full = pattern(2048, 3);
  const { dir, manifest } = world([{ rel: 'model.safetensors', data: full.slice(0, 500), sha: false }]);
  // manifest expects the FULL size:
  manifest[0].bytes = full.length;
  const r = await hfInstalledStatus(dir, manifest);
  assert.strictEqual(r.complete, false, 'a half-downloaded HF job must not read as installed');
  assert.match(r.bad, /size/);
});

test('missing file -> complete false', async () => {
  const { dir, manifest } = world([{ rel: 'a.bin', data: pattern(64, 4), sha: true }]);
  manifest.push({ path: 'b.bin', bytes: 64, sha256: null });
  const r = await hfInstalledStatus(dir, manifest);
  assert.strictEqual(r.complete, false);
  assert.match(r.bad, /missing/);
});

test('checksum mismatch -> complete false (deep only; WO-4)', async () => {
  const { dir, manifest } = world([{ rel: 'a.bin', data: pattern(64, 5), sha: true }]);
  manifest[0].sha256 = '0'.repeat(64); // wrong checksum on purpose
  const r = await hfInstalledStatus(dir, manifest, { deep: true });
  assert.strictEqual(r.complete, false);
  assert.match(r.bad, /checksum/);
});

test('WO-4 acceptance: right size + wrong content -> default complete true, deep false', async () => {
  // On disk: 128 bytes of pattern(…,9). Manifest expects the SAME length but
  // the sha256 of DIFFERENT content (pattern(…,7)) — size right, content wrong.
  const { dir, manifest } = world([{ rel: 'model.safetensors', data: pattern(128, 9), sha: false }]);
  manifest[0].sha256 = sha(pattern(128, 7));
  const fast = await hfInstalledStatus(dir, manifest); // default: stat-only
  assert.strictEqual(fast.complete, true, 'default (stat-only) must accept exact size without hashing');
  const deep = await hfInstalledStatus(dir, manifest, { deep: true });
  assert.strictEqual(deep.complete, false, 'deep must reject wrong content via sha256');
  assert.match(deep.bad, /checksum/);
});

test('empty manifest -> complete false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfcheck-'));
  const r = await hfInstalledStatus(dir, []);
  assert.strictEqual(r.complete, false);
});

test('nonexistent directory -> complete false', async () => {
  const dir = path.join(os.tmpdir(), 'hfcheck-nope-' + Date.now());
  const r = await hfInstalledStatus(dir, [{ path: 'a.bin', bytes: 10 }]);
  assert.strictEqual(r.complete, false);
});
