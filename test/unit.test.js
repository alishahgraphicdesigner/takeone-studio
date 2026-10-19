/* TakeOne Studio 2.2.0 — Phase A unit tests. Run: node --test test/unit.test.js */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseNvidiaSmi, recommendPack, validateWizardCompletion, isTakeOneRoot } = require('../main.js');

describe('parseNvidiaSmi', () => {
  it('parses a typical RTX line', () => {
    const r = parseNvidiaSmi('NVIDIA GeForce RTX 5070 Ti, 16303\n');
    assert.deepEqual(r, { name: 'NVIDIA GeForce RTX 5070 Ti', vramMB: 16303 });
  });
  it('takes the first GPU when several exist', () => {
    const r = parseNvidiaSmi('NVIDIA GeForce RTX 5070 Ti, 16303\nNVIDIA GeForce RTX 3060, 12288\n');
    assert.equal(r.name, 'NVIDIA GeForce RTX 5070 Ti');
  });
  it('returns null on empty output', () => {
    assert.equal(parseNvidiaSmi(''), null);
    assert.equal(parseNvidiaSmi(null), null);
  });
  it('returns null on malformed output', () => {
    assert.equal(parseNvidiaSmi('garbage without comma number'), null);
  });
});

describe('recommendPack', () => {
  it('recommends pro at 16GB VRAM', () => {
    const r = recommendPack({ gpuName: 'NVIDIA GeForce RTX 5070 Ti', vramMB: 16303 });
    assert.equal(r.tier, 'pro');
    assert.match(r.reason, /15\.9 GB/); // 16303 MB is honestly 15.9 GB, not "16"
  });
  it('recommends standard at 8GB and names the exclusion honestly', () => {
    const r = recommendPack({ gpuName: 'NVIDIA GeForce RTX 4060', vramMB: 8188 });
    assert.equal(r.tier, 'standard');
    assert.match(r.reason, /24 GB-tier/);
  });
  it('recommends lite below 8GB', () => {
    const r = recommendPack({ gpuName: 'NVIDIA GeForce GTX 1660', vramMB: 6144 });
    assert.equal(r.tier, 'lite');
  });
  it('recommends lite with no NVIDIA GPU', () => {
    const r = recommendPack({ gpuName: null, vramMB: null });
    assert.equal(r.tier, 'lite');
    assert.match(r.reason, /No NVIDIA GPU/);
  });
});

describe('validateWizardCompletion (Gate 2 poka-yoke)', () => {
  const base = { packChoice: 'skip', customTools: [], existingModels: [], acknowledgedLater: false };
  it('recommended pack completes', () => {
    assert.equal(validateWizardCompletion({ ...base, packChoice: 'recommended' }).ok, true);
  });
  it('custom pack with tools completes', () => {
    assert.equal(validateWizardCompletion({ ...base, packChoice: 'custom', customTools: ['brain'] }).ok, true);
  });
  it('custom pack with ZERO tools does NOT complete', () => {
    const r = validateWizardCompletion({ ...base, packChoice: 'custom', customTools: [] });
    assert.equal(r.ok, false);
    assert.ok(r.reason);
  });
  it('skip with existing models completes', () => {
    assert.equal(validateWizardCompletion({ ...base, existingModels: [{ file: 'x' }] }).ok, true);
  });
  it('skip with nothing selected and no acknowledgment is BLOCKED', () => {
    const r = validateWizardCompletion({ ...base });
    assert.equal(r.ok, false);
  });
  it('skip with nothing selected but explicit acknowledgment completes', () => {
    assert.equal(validateWizardCompletion({ ...base, acknowledgedLater: true }).ok, true);
  });
});

describe('isTakeOneRoot', () => {
  it('accepts a folder containing config.json', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 't1-'));
    fs.writeFileSync(path.join(d, 'config.json'), '{}');
    assert.equal(isTakeOneRoot(d), true);
    fs.rmSync(d, { recursive: true, force: true });
  });
  it('rejects anything else', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 't1-'));
    assert.equal(isTakeOneRoot(d), false);
    assert.equal(isTakeOneRoot(path.join(d, 'nope')), false);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
