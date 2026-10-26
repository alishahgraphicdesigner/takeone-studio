/**
 * ComfyUI workflow templates for TakeOne Studio.
 *
 * Each template is a function that takes params and returns a ComfyUI
 * API-format workflow JSON (node ID -> node object).
 *
 * These are minimal, tested-against-docs workflows. The user will validate
 * on their RTX 5070 Ti with real models.
 */

/**
 * SDXL Text-to-Image (basic).
 * Requires: SDXL checkpoint visible to ComfyUI (via --extra-model-paths-config,
 * which maps checkpoints to <root>/Models/image — see main/comfy.js).
 * @param {string} checkpoint - e.g. "sdxl_lightning_4step.safetensors"
 * @param {string} positive - the prompt
 * @param {string} negative - negative prompt
 * @param {number} width, height
 * @param {number} steps - default 20 (use 4-8 for Lightning)
 * @param {number} cfg - default 7
 * @param {number} seed - random if not provided
 */
function sdxlTxt2Img({ checkpoint, positive, negative = '', width = 1024, height = 1024, steps = 20, cfg = 7, seed, sampler_name = 'euler', scheduler = 'normal' }) {
  const s = seed ?? Math.floor(Math.random() * 1000000000);
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed: s, steps, cfg, sampler_name, scheduler, denoise: 1.0,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'takeone' } },
  };
}

/**
 * WO-41: SDXL-Lightning Text-to-Image — the ONE workflow the app's Quick
 * Generate and tools/e2e-image.js both use. SDXL-Lightning's official
 * parameters: 4 steps, cfg 1, euler sampler, sgm_uniform scheduler.
 * The checkpoint here is a file NAME, not a path: ComfyUI resolves it
 * through extra_model_paths (checkpoints -> <root>/Models/image).
 */
function sdxlLightningTxt2Img({ checkpoint, positive, negative = '', width = 1024, height = 1024, seed, steps = 4, cfg = 1 }) {
  return sdxlTxt2Img({
    checkpoint, positive, negative, width, height, seed,
    steps, cfg, sampler_name: 'euler', scheduler: 'sgm_uniform',
  });
}

/**
 * M1: aspect ratios -> SDXL-friendly dimensions (multiples of 64, long
 * side ~1024-1344). Pure: unit-tested, shared by the app and the audit.
 */
const ASPECT_DIMS = {
  '1:1': [1024, 1024],
  '3:2': [1152, 768],
  '16:9': [1344, 768],
  '9:16': [768, 1344],
};
function aspectDims(aspect) {
  return ASPECT_DIMS[aspect] || ASPECT_DIMS['1:1'];
}

/**
 * M1: the default negative prompt, used when the user leaves the negative
 * box empty. Photoreal-focused: it suppresses the artifacts SDXL produces
 * most (blur, anatomy errors, text, watermarks) without steering style.
 */
const DEFAULT_NEGATIVE = 'blurry, low quality, distorted, deformed, bad anatomy, extra limbs, watermark, text, logo, oversaturated, cartoon, illustration';

/**
 * M1: Fast / Quality presets. Honest note: the installed model is
 * SDXL-Lightning, distilled for 4 steps — Quality (8 steps, cfg 2) buys a
 * little more detail at ~2x the time, not a different league of quality.
 * Both presets are Lightning parameters; neither pretends to be a base-model
 * 20-step run.
 */
const PRESETS = {
  fast: { label: 'Fast', steps: 4, cfg: 1 },
  quality: { label: 'Quality', steps: 8, cfg: 2 },
};
function presetParams(preset) {
  return PRESETS[preset] || PRESETS.fast;
}

/**
 * M1: the Ali pack — 3 prompts x 3 settings, ONE seed for all 9, so Ali
 * can compare settings on identical luck. Pure builder: the app queues
 * these jobs; the renderer assembles the contact sheet from the results.
 */
const ALI_PACK_PROMPTS = [
  'A weathered fisherman mending nets at dawn on a wooden boat, documentary photograph, soft golden light',
  'A misty mountain valley with an old stone bridge, golden hour, cinematic landscape photograph',
  'A ceramic teapot on a worn wooden table by a window, soft daylight, product photograph',
];
const ALI_PACK_SETTINGS = [
  { preset: 'fast', aspect: '1:1' },
  { preset: 'quality', aspect: '1:1' },
  { preset: 'fast', aspect: '16:9' },
];
function buildAliPackJobs(seed) {
  const jobs = [];
  for (const prompt of ALI_PACK_PROMPTS) {
    for (const s of ALI_PACK_SETTINGS) {
      const [width, height] = aspectDims(s.aspect);
      jobs.push({ prompt, negative: DEFAULT_NEGATIVE, preset: s.preset, aspect: s.aspect, width, height, seed });
    }
  }
  return jobs;
}

module.exports = {
  sdxlTxt2Img, sdxlLightningTxt2Img,
  ASPECT_DIMS, aspectDims, DEFAULT_NEGATIVE, PRESETS, presetParams,
  ALI_PACK_PROMPTS, ALI_PACK_SETTINGS, buildAliPackJobs,
};
