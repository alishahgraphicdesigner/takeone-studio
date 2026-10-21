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
 * Requires: SDXL checkpoint in ComfyUI/models/checkpoints/
 * @param {string} checkpoint - e.g. "sd_xl_base_1.0.safetensors"
 * @param {string} positive - the prompt
 * @param {string} negative - negative prompt
 * @param {number} width, height
 * @param {number} steps - default 20 (use 4-8 for Lightning)
 * @param {number} cfg - default 7
 * @param {number} seed - random if not provided
 */
function sdxlTxt2Img({ checkpoint, positive, negative = '', width = 1024, height = 1024, steps = 20, cfg = 7, seed }) {
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
        seed: s, steps, cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'takeone' } },
  };
}

module.exports = { sdxlTxt2Img };
