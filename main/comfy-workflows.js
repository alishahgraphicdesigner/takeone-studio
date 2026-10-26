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

/**
 * M2: Wan 2.2 TI2V-5B video workflow on the PINNED ComfyUI commit's NATIVE
 * nodes (no custom node pack). Proven from the pinned source (commit
 * b1a247c, comfy_extras/nodes_wan.py): Wan22ImageToVideoLatent is the
 * Wan 2.2 latent node (48 channels, Wan22 format); plain CLIPTextEncode
 * conditionings feed KSampler; the start image is baked into the latent
 * by that node (VAE-encoded first frames + noise mask), so I2V needs no
 * separate conditioning node. Frames decode through VAEDecode, then
 * CreateVideo (16 fps) and SaveVideo (mp4) — both native video nodes.
 *
 * Model loading, and why the diffusion file is a MERGED single file:
 * the pinned ComfyUI's UNETLoader loads ONE .safetensors file
 * (comfy/utils.py load_torch_file — no sharded-index support anywhere
 * in the pinned tree), but Wan-AI/Wan2.2-TI2V-5B ships 3 shards + an
 * index. The app therefore merges the shards once at install time
 * (main/merge-shards.py, sha256-verified shards in, one file out) and
 * this workflow loads that merged file. The VAE and text encoder are
 * single files already; ComfyUI finds them through extra_model_paths
 * (vae + text_encoders both map at Models/video — see engine.js).
 *
 * File NAMES, not paths: ComfyUI resolves them through extra_model_paths
 * (recursive search, so snapshot subdirs like video-studio/... work).
 *
 * Defaults are community starting points for Wan 2.2 (steps 20, cfg 5,
 * euler, sgm_uniform, 16 fps), NOT a tuned recipe — the first GPU
 * render (M2.6) is what tunes them. Lengths satisfy (frames-1)%4==0,
 * which the Wan22 latent math requires; resolutions are multiples of
 * 32, which the latent node requires. "720p" is 1280x704 — the node's
 * own default and the Wan 2.2 native frame (720 is not a multiple of 32).
 */
const VIDEO_RESOLUTIONS = {
  '480p': [832, 480],
  '720p': [1280, 704],
};
function videoDims(resolution) {
  return VIDEO_RESOLUTIONS[resolution] || VIDEO_RESOLUTIONS['480p'];
}
/** Duration seconds -> frames at 16 fps ((frames-1) % 4 == 0). */
const VIDEO_LENGTHS = { 2: 33, 4: 65 };
function videoFrames(seconds) {
  return VIDEO_LENGTHS[seconds] || VIDEO_LENGTHS[2];
}
const VIDEO_DEFAULTS = { steps: 20, cfg: 5, sampler_name: 'euler', scheduler: 'sgm_uniform', fps: 16 };
const DEFAULT_VIDEO_NEGATIVE = 'blurry, low quality, distorted, deformed, bad anatomy, watermark, text, logo';
function wanVideo({
  unet, clip, vae, positive, negative = '',
  width = 832, height = 480, length = 33, seed,
  steps = VIDEO_DEFAULTS.steps, cfg = VIDEO_DEFAULTS.cfg,
  sampler_name = VIDEO_DEFAULTS.sampler_name, scheduler = VIDEO_DEFAULTS.scheduler,
  fps = VIDEO_DEFAULTS.fps, startImage = null,
}) {
  const s = seed ?? Math.floor(Math.random() * 1000000000);
  const latent = {
    class_type: 'Wan22ImageToVideoLatent',
    inputs: { vae: ['3', 0], width, height, length, batch_size: 1 },
  };
  const nodes = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'wan' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    '6': latent,
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed: s, steps, cfg, sampler_name, scheduler, denoise: 1.0,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps } },
    '11': { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'video/TakeOne', format: 'mp4' } },
  };
  if (startImage) {
    // I2V: the Library image is copied into ComfyUI/input/ by main
    // BEFORE queueing (LoadImage only reads that dir); the latent node
    // then bakes its VAE-encoded frames + mask into the latent.
    nodes['7'] = { class_type: 'LoadImage', inputs: { image: startImage } };
    nodes['6'].inputs.start_image = ['7', 0];
  }
  return nodes;
}

/**
 * M2.6: the video Ali pack — 2 prompts x 2 settings, short clips, ONE
 * seed, so Ali can compare settings on identical luck AND compare
 * prompt 1 side-by-side with the first render ever done on his PC
 * (WO-45 Recipe 2, same sunset-ocean prompt, 2026-10-13). Prompt 2 is
 * the checklist's planned fox prompt from the same file (its render
 * status was unconfirmed there — this pack is its first real attempt).
 * The renderer assembles a 2x2 contact sheet from first frames.
 */
const VIDEO_ALI_PACK_PROMPTS = [
  'Slow aerial drone shot gliding over ocean waves at golden sunset, cinematic lighting, photorealistic',
  'A red fox kit walking through autumn leaves, cinematic lighting',
];
const VIDEO_ALI_PACK_SETTINGS = [
  { resolution: '480p', duration: 2 },
  { resolution: '720p', duration: 2 },
];
function buildVideoAliPackJobs(seed) {
  const jobs = [];
  for (const prompt of VIDEO_ALI_PACK_PROMPTS) {
    for (const s of VIDEO_ALI_PACK_SETTINGS) {
      const [width, height] = videoDims(s.resolution);
      jobs.push({
        prompt, negative: DEFAULT_VIDEO_NEGATIVE,
        resolution: s.resolution, duration: s.duration,
        width, height, length: videoFrames(s.duration), seed,
      });
    }
  }
  return jobs;
}

module.exports = {
  sdxlTxt2Img, sdxlLightningTxt2Img,
  ASPECT_DIMS, aspectDims, DEFAULT_NEGATIVE, PRESETS, presetParams,
  ALI_PACK_PROMPTS, ALI_PACK_SETTINGS, buildAliPackJobs,
  VIDEO_RESOLUTIONS, videoDims, VIDEO_LENGTHS, videoFrames, VIDEO_DEFAULTS,
  DEFAULT_VIDEO_NEGATIVE, wanVideo,
  VIDEO_ALI_PACK_PROMPTS, VIDEO_ALI_PACK_SETTINGS, buildVideoAliPackJobs,
};
