/* M1 "Image Studio feels finished": presets, aspects, Ali pack jobs,
 * the real Quick Generate project (+ card thumbnail), and sidecar facts.
 * Pure + filesystem tests; the renderer canvas sheet is covered by the
 * UI audit (screens) and the CI e2e (real generation + save path). */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wf = require('../main/comfy-workflows.js');
const lib = require('../main/library.js');

describe('M1 presets, aspects, negative (M1.d, M1.e)', () => {
  it('aspectDims: all four + unknown falls back to 1:1', () => {
    assert.deepEqual(wf.aspectDims('1:1'), [1024, 1024]);
    assert.deepEqual(wf.aspectDims('3:2'), [1152, 768]);
    assert.deepEqual(wf.aspectDims('16:9'), [1344, 768]);
    assert.deepEqual(wf.aspectDims('9:16'), [768, 1344]);
    assert.deepEqual(wf.aspectDims('bogus'), [1024, 1024]);
    for (const [w, h] of Object.values(wf.ASPECT_DIMS)) {
      assert.equal(w % 64, 0, 'width multiple of 64');
      assert.equal(h % 64, 0, 'height multiple of 64');
    }
  });
  it('presetParams: fast 4/1, quality 8/2, unknown -> fast', () => {
    assert.deepEqual(wf.presetParams('fast'), { label: 'Fast', steps: 4, cfg: 1 });
    assert.deepEqual(wf.presetParams('quality'), { label: 'Quality', steps: 8, cfg: 2 });
    assert.equal(wf.presetParams('nope').label, 'Fast');
  });
  it('DEFAULT_NEGATIVE is a photoreal guard, not a style steer', () => {
    assert.ok(wf.DEFAULT_NEGATIVE.includes('watermark'));
    assert.ok(wf.DEFAULT_NEGATIVE.includes('bad anatomy'));
    assert.ok(!/cinematic|photoreal/i.test(wf.DEFAULT_NEGATIVE), 'must not force a look');
  });
  it('Lightning workflow honours steps/cfg overrides (quality preset)', () => {
    const fast = wf.sdxlLightningTxt2Img({ checkpoint: 'm.safetensors', positive: 'x' });
    assert.equal(fast['5'].inputs.steps, 4);
    assert.equal(fast['5'].inputs.cfg, 1);
    const quality = wf.sdxlLightningTxt2Img({ checkpoint: 'm.safetensors', positive: 'x', steps: 8, cfg: 2 });
    assert.equal(quality['5'].inputs.steps, 8);
    assert.equal(quality['5'].inputs.cfg, 2);
    assert.equal(quality['5'].inputs.sampler_name, 'euler');
    assert.equal(quality['5'].inputs.scheduler, 'sgm_uniform');
  });
  it('buildAliPackJobs: 3 prompts x 3 settings, ONE seed', () => {
    const jobs = wf.buildAliPackJobs(777);
    assert.equal(jobs.length, 9);
    assert.ok(jobs.every((j) => j.seed === 777), 'same seed across the pack');
    assert.equal(new Set(jobs.map((j) => j.prompt)).size, 3);
    const settings = new Set(jobs.map((j) => `${j.preset}/${j.aspect}`));
    assert.deepEqual([...settings].sort(), ['fast/16:9', 'fast/1:1', 'quality/1:1']);
    for (const j of jobs) {
      assert.deepEqual([j.width, j.height], wf.aspectDims(j.aspect));
      assert.equal(j.negative, wf.DEFAULT_NEGATIVE);
    }
  });
});

describe('M1 real Quick Generate project (M1.b, WO-44)', () => {
  it('ensureQuickGenerateProject creates once, then finds the same id', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-qg-'));
    const first = await lib.ensureQuickGenerateProject(root);
    assert.ok(fs.existsSync(path.join(first.dir, 'project.json')));
    const doc = JSON.parse(fs.readFileSync(path.join(first.dir, 'project.json'), 'utf8'));
    assert.equal(doc.name, 'Quick Generate');
    const second = await lib.ensureQuickGenerateProject(root);
    assert.equal(second.id, first.id, 'no duplicate project on second call');
    const projects = await lib.listProjects(root);
    assert.equal(projects.filter((p) => p.name === 'Quick Generate').length, 1);
  });
  it('listProjects thumb: newest image, or null when empty', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-thumb-'));
    const proj = await lib.ensureQuickGenerateProject(root);
    let projects = await lib.listProjects(root);
    assert.equal(projects[0].thumb, null);
    const imgDir = path.join(proj.dir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const a = path.join(imgDir, 'old.png');
    const b = path.join(imgDir, 'new.png');
    fs.writeFileSync(a, Buffer.alloc(10));
    fs.writeFileSync(b, Buffer.alloc(10));
    fs.utimesSync(a, new Date(2026, 9, 24, 12, 0, 0), new Date(2026, 9, 24, 12, 0, 0));
    fs.utimesSync(b, new Date(2026, 9, 24, 12, 0, 5), new Date(2026, 9, 24, 12, 0, 5));
    projects = await lib.listProjects(root);
    assert.equal(projects[0].thumb, 'images/new.png');
  });
  it('findQuickGenerateProjectDir is sync and never creates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-find-'));
    assert.equal(lib.findQuickGenerateProjectDir(root), null);
    assert.ok(!fs.existsSync(path.join(root, 'Projects')), 'find must not create');
  });
});
