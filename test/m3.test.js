/* M3 — Image quality bake-off: workflow builders, catalog entries,
 * switch gating, model-paths yaml, and the image-models Ali pack.
 * Pure node tests (no Electron, no GPU, no downloads). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  zImage, fluxKlein, IMAGE_MODEL_FILES,
  IMAGE_MODELS_PACK_MODELS, buildImageModelsPackJobs, ALI_PACK_PROMPTS,
} = require('../main/comfy-workflows.js');
const { CATALOG, effectiveAvailability, vramAllowed } = require('../main/catalog.js');
const engine = require('../main/engine.js');

function classes(wf) {
  return Object.fromEntries(Object.entries(wf).map(([id, n]) => [id, n.class_type]));
}
function links(wf) {
  const out = {};
  for (const [id, n] of Object.entries(wf)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v)) out[`${id}.${k}`] = v.join(':');
    }
  }
  return out;
}

describe('zImage builder (official Z-Image Turbo template nodes)', () => {
  const wf = zImage({
    unet: 'z_image_turbo_bf16.safetensors', clip: 'qwen_3_4b.safetensors',
    vae: 'ae.safetensors', positive: 'a portrait', seed: 7,
  });
  it('loads bf16 + Qwen3 (lumina2) + ae, with the template sampler chain', () => {
    const c = classes(wf);
    assert.equal(c['1'], 'UNETLoader');
    assert.equal(c['2'], 'CLIPLoader');
    assert.equal(c['3'], 'VAELoader');
    assert.equal(c['4'], 'CLIPTextEncode');
    assert.equal(c['5'], 'ConditioningZeroOut');
    assert.equal(c['6'], 'EmptySD3LatentImage');
    assert.equal(c['7'], 'ModelSamplingAuraFlow');
    assert.equal(c['8'], 'KSampler');
    assert.equal(c['9'], 'VAEDecode');
    assert.equal(c['10'], 'SaveImage');
    assert.equal(wf['1'].inputs.unet_name, 'z_image_turbo_bf16.safetensors');
    assert.equal(wf['2'].inputs.clip_name, 'qwen_3_4b.safetensors');
    assert.equal(wf['2'].inputs.type, 'lumina2');
    assert.equal(wf['3'].inputs.vae_name, 'ae.safetensors');
    assert.equal(wf['7'].inputs.shift, 3);
    assert.equal(wf['8'].inputs.steps, 8);
    assert.equal(wf['8'].inputs.cfg, 1);
    assert.equal(wf['8'].inputs.sampler_name, 'res_multistep');
    assert.equal(wf['8'].inputs.scheduler, 'simple');
    assert.equal(wf['8'].inputs.seed, 7);
    const l = links(wf);
    assert.equal(l['8.model'], '7:0');
    assert.equal(l['8.negative'], '5:0');
    assert.equal(l['5.conditioning'], '4:0');
    assert.equal(l['9.vae'], '3:0');
  });
});

describe('fluxKlein builder (official distilled-Klein template nodes)', () => {
  const wf = fluxKlein({
    unet: 'flux-2-klein-4b.safetensors', clip: 'qwen_3_4b.safetensors',
    vae: 'flux2-vae.safetensors', positive: 'a landscape', seed: 7,
  });
  it('loads distilled 4b + Qwen3 (flux2) + flux2-vae, with the template sampler chain', () => {
    const c = classes(wf);
    assert.equal(c['1'], 'UNETLoader');
    assert.equal(c['2'], 'CLIPLoader');
    assert.equal(c['3'], 'VAELoader');
    assert.equal(c['4'], 'CLIPTextEncode');
    assert.equal(c['5'], 'ConditioningZeroOut');
    assert.equal(c['6'], 'EmptyFlux2LatentImage');
    assert.equal(c['7'], 'RandomNoise');
    assert.equal(c['8'], 'CFGGuider');
    assert.equal(c['9'], 'KSamplerSelect');
    assert.equal(c['10'], 'Flux2Scheduler');
    assert.equal(c['11'], 'SamplerCustomAdvanced');
    assert.equal(c['12'], 'VAEDecode');
    assert.equal(c['13'], 'SaveImage');
    assert.equal(wf['1'].inputs.unet_name, 'flux-2-klein-4b.safetensors');
    assert.doesNotMatch(wf['1'].inputs.unet_name, /base/, 'distilled file, never the base file');
    assert.equal(wf['2'].inputs.clip_name, 'qwen_3_4b.safetensors');
    assert.equal(wf['2'].inputs.type, 'flux2');
    assert.equal(wf['3'].inputs.vae_name, 'flux2-vae.safetensors');
    assert.equal(wf['8'].inputs.cfg, 1);
    assert.equal(wf['9'].inputs.sampler_name, 'euler');
    assert.equal(wf['10'].inputs.steps, 4);
    assert.equal(wf['10'].inputs.width, 1024);
    assert.equal(wf['7'].inputs.noise_seed, 7);
    const l = links(wf);
    assert.equal(l['11.noise'], '7:0');
    assert.equal(l['11.guider'], '8:0');
    assert.equal(l['11.sampler'], '9:0');
    assert.equal(l['11.sigmas'], '10:0');
    assert.equal(l['11.latent_image'], '6:0');
    assert.equal(l['8.negative'], '5:0');
  });
});

describe('catalog M3 entries (pinned, complete, experimental)', () => {
  const zi = CATALOG.find((t) => t.id === 'z-image-turbo');
  const fl = CATALOG.find((t) => t.id === 'flux2-klein-4b');
  it('Z-Image Turbo: Comfy-Org repack, pinned commit, 3 files, sizes add up', () => {
    assert.equal(zi.repo, 'Comfy-Org/Z-Image-Turbo');
    assert.match(zi.commit, /^[0-9a-f]{40}$/);
    assert.equal(zi.files.length, 3);
    for (const f of zi.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
      assert.ok(f.bytes > 0, f.path);
    }
    const total = zi.files.reduce((s, f) => s + f.bytes, 0);
    assert.equal(zi.sizeBytes, total);
    assert.equal(zi.sizeMB, Math.floor(total / 1048576));
    assert.equal(zi.license, 'Apache-2.0');
    assert.match(zi.licenseNote, /apache-2\.0/i);
    assert.equal(zi.category, 'image');
    assert.equal(zi.experimentalSwitch, 'imageModels');
    assert.ok(typeof zi.experimental === 'string' && zi.experimental.length > 0);
    assert.equal(zi.unavailable, undefined);
  });
  it('FLUX.2 Klein 4B: distilled only, pinned commit, 3 files, sizes add up', () => {
    assert.equal(fl.repo, 'Comfy-Org/Flux-2-Klein-4B');
    assert.match(fl.commit, /^[0-9a-f]{40}$/);
    assert.equal(fl.files.length, 3);
    const paths = fl.files.map((f) => f.path);
    assert.ok(paths.includes('split_files/diffusion_models/flux-2-klein-4b.safetensors'));
    assert.ok(!paths.some((p) => /9b|base-4b|non-commercial/i.test(p)), 'no 9B/base/non-commercial files');
    for (const f of fl.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
      assert.ok(f.bytes > 0, f.path);
    }
    const total = fl.files.reduce((s, f) => s + f.bytes, 0);
    assert.equal(fl.sizeBytes, total);
    assert.equal(fl.sizeMB, Math.floor(total / 1048576));
    assert.equal(fl.license, 'Apache-2.0');
    assert.match(fl.licenseNote, /Apache-2\.0/);
    assert.equal(fl.experimentalSwitch, 'imageModels');
  });
  it('the shared Qwen3 encoder is byte-identical across both tools', () => {
    const a = zi.files.find((f) => f.path.endsWith('qwen_3_4b.safetensors'));
    const b = fl.files.find((f) => f.path.endsWith('qwen_3_4b.safetensors'));
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.bytes, b.bytes);
  });
  it('both pass the 0.8 VRAM gate on Ali\'s 16 GB card', () => {
    assert.equal(vramAllowed(zi, 16303).ok, true);
    assert.equal(vramAllowed(fl, 16303).ok, true);
  });
  it('loader names match the catalog file basenames', () => {
    for (const [id, names] of Object.entries(IMAGE_MODEL_FILES)) {
      const tool = CATALOG.find((t) => t.id === id);
      const base = tool.files.map((f) => f.path.split('/').pop());
      assert.ok(base.includes(names.unet), `${id} unet`);
      assert.ok(base.includes(names.clip), `${id} clip`);
      assert.ok(base.includes(names.vae), `${id} vae`);
    }
  });
});

describe('effectiveAvailability with two switches (M3)', () => {
  const vs = CATALOG.find((t) => t.id === 'video-studio');
  const zi = CATALOG.find((t) => t.id === 'z-image-turbo');
  it('boolean legacy form still gates the video tool only', () => {
    assert.equal(effectiveAvailability(vs, true), null);
    assert.ok(effectiveAvailability(vs, false));
    assert.ok(effectiveAvailability(zi, true), 'video ON must NOT offer image models');
    assert.ok(effectiveAvailability(zi, false));
  });
  it('object form keys each tool to its own switch', () => {
    assert.equal(effectiveAvailability(vs, { video: true, imageModels: false }), null);
    assert.ok(effectiveAvailability(vs, { video: false, imageModels: true }));
    assert.equal(effectiveAvailability(zi, { video: false, imageModels: true }), null);
    assert.ok(effectiveAvailability(zi, { video: true, imageModels: false }));
    assert.ok(effectiveAvailability(zi, {}), 'unknown key reads as OFF, never ON');
  });
});

describe('image-models Ali pack jobs (M3)', () => {
  it('3 prompts x 3 models, one seed, 1024x1024, prompt-major order', () => {
    const jobs = buildImageModelsPackJobs(4242);
    assert.equal(jobs.length, 9);
    assert.ok(jobs.every((j) => j.seed === 4242));
    assert.ok(jobs.every((j) => j.width === 1024 && j.height === 1024));
    assert.deepEqual(IMAGE_MODELS_PACK_MODELS, ['image-studio', 'z-image-turbo', 'flux2-klein-4b']);
    assert.deepEqual(jobs.map((j) => j.prompt), [
      ALI_PACK_PROMPTS[0], ALI_PACK_PROMPTS[0], ALI_PACK_PROMPTS[0],
      ALI_PACK_PROMPTS[1], ALI_PACK_PROMPTS[1], ALI_PACK_PROMPTS[1],
      ALI_PACK_PROMPTS[2], ALI_PACK_PROMPTS[2], ALI_PACK_PROMPTS[2],
    ]);
    assert.deepEqual(jobs.map((j) => j.model), [
      'image-studio', 'z-image-turbo', 'flux2-klein-4b',
      'image-studio', 'z-image-turbo', 'flux2-klein-4b',
      'image-studio', 'z-image-turbo', 'flux2-klein-4b',
    ]);
  });
});

describe('extra_model_paths yaml reaches Models/image for M3 loaders', () => {
  it('diffusion_models, text_encoders and vae all list Models/image (video lines kept)', async () => {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'takeone-m3-'));
    fs.mkdirSync(path.dirname(engine.modelPathsFile(ROOT)), { recursive: true });
    await engine.writeModelPaths(ROOT);
    const yml = fs.readFileSync(engine.modelPathsFile(ROOT), 'utf8');
    const img = path.join(ROOT, 'Models', 'image');
    const vid = path.join(ROOT, 'Models', 'video');
    for (const key of ['diffusion_models', 'text_encoders', 'vae']) {
      assert.ok(yml.includes(key), key);
    }
    assert.ok(yml.includes(img), 'Models/image present');
    assert.ok(yml.includes(vid), 'Models/video kept for M2');
    fs.rmSync(ROOT, { recursive: true, force: true });
  });
});
