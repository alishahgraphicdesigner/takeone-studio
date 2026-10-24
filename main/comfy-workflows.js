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
function sdxlLightningTxt2Img({ checkpoint, positive, negative = '', width = 1024, height = 1024, seed }) {
  return sdxlTxt2Img({
    checkpoint, positive, negative, width, height, seed,
    steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'sgm_uniform',
  });
}

module.exports = { sdxlTxt2Img, sdxlLightningTxt2Img };
