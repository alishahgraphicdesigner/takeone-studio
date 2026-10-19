/* TakeOne Studio 2.2.0 — Phase A integration tests (plain node, no Electron).
 * Exercises the REAL measurement code paths: checkPC, model scan, folder sizes. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkPC, scanExistingModels, folderSizeBytes, uninstallData, isTakeOneRoot } = require('../main.js');

describe('checkPC (real measurements)', () => {
  it('returns a complete, honest result object', async () => {
    const pc = await checkPC(os.tmpdir());
    assert.ok(pc && typeof pc === 'object');
    assert.ok(typeof pc.ramGB === 'number' && pc.ramGB > 0, 'ramGB must be a positive number');
    // This VM has no NVIDIA GPU: the honest answer is null, not a guessed card.
    assert.equal(pc.gpuName, null);
    assert.equal(pc.vramMB, null);
    assert.ok(typeof pc.measuredAt === 'string');
    console.log('    measured:', JSON.stringify({ ramGB: pc.ramGB, diskFreeGB: pc.diskFreeGB, speedMbps: pc.speedMbps }));
  });
  it('diskFreeGB is a real positive number on this machine', async () => {
    const pc = await checkPC(os.homedir()); // /tmp is a tiny tmpfs here; home is the real disk
    assert.ok(typeof pc.diskFreeGB === 'number' && pc.diskFreeGB > 1, 'diskFreeGB must be real');
  });
});

describe('scanExistingModels', () => {
  it('finds known weight files and ignores unknown ones', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1scan-'));
    const md = path.join(root, 'Models', 'image');
    fs.mkdirSync(md, { recursive: true });
    fs.writeFileSync(path.join(md, 'sdxl_lightning_4step.safetensors'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(md, 'random-notes.txt'), 'hello');
    fs.writeFileSync(path.join(md, 'mystery.safetensors'), Buffer.alloc(512));
    const found = await scanExistingModels(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].tool, 'Image Studio (SDXL-Lightning)');
    assert.equal(found[0].file, 'sdxl_lightning_4step.safetensors');
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('returns [] when the Models folder does not exist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1scan-'));
    assert.deepEqual(await scanExistingModels(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('folderSizeBytes + uninstallData', () => {
  it('measures and removes only inside a verified TakeOne root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1rm-'));
    fs.writeFileSync(path.join(root, 'config.json'), '{}');
    const md = path.join(root, 'Models');
    fs.mkdirSync(md, { recursive: true });
    fs.writeFileSync(path.join(md, 'w.bin'), Buffer.alloc(2048));
    assert.ok(isTakeOneRoot(root));
    const before = await folderSizeBytes(md);
    assert.equal(before, 2048);
    const r = await uninstallData(root, { models: true, projects: false, trash: false, temp: false });
    assert.deepEqual(r.removed, [md]);
    assert.ok(!fs.existsSync(md), 'Models must be gone');
    assert.ok(fs.existsSync(path.join(root, 'config.json')), 'config.json must survive');
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('REFUSES a folder without config.json', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1rm-'));
    await assert.rejects(() => uninstallData(root, { models: true }), /not a TakeOne library root/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
