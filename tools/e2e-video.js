#!/usr/bin/env node
/* M2.5 driver: end-to-end VIDEO validation on CI (Windows, CPU, no GPU).
 *
 * Uses the SAME code the app will run:
 *   - main/engine.js          -> installEngine()
 *   - main/catalog.js         -> video-studio manifest (Wan 2.2 TI2V-5B)
 *   - main/comfy-workflows.js -> wanVideo() (shared T2V + I2V builder)
 *   - main/video-model.js     -> videoLoaderNames() (merged-file names)
 *   - main/comfy.js           -> createEngineComfy() (shared start path)
 *
 * What it proves (and what it honestly does NOT):
 *   PROVES: (1) the catalog manifest is complete + well-formed (every
 *   file has a 64-hex sha256, the HF commit is pinned, sizes add up);
 *   (2) the pinned ComfyUI commit really serves the Wan 2.2 nodes
 *   (Wan22ImageToVideoLatent et al. in /object_info); (3) the extra
 *   search paths reach Models/video (diffusion_models, vae,
 *   text_encoders); (4) the shared builder's T2V AND I2V workflows
 *   VALIDATE at queue time (a prompt_id, not a 400 — the exact failure
 *   class that broke Quick Generate in WO-41); (5) interrupt works.
 *   DOES NOT prove a real render: no 34 GB download runs here (the
 *   loader files are 1-byte VALIDATION STAND-INS, clearly labeled in
 *   the log, so the combo lists contain the loader names — ComfyUI's
 *   queue validator checks combo membership, so without them the
 *   queue would 400 exactly like WO-41). Execution after queueing is
 *   interrupted immediately; the first real render is M2.6 on Ali's
 *   GPU and stays Not Tested until he runs it.
 *
 * Steps: engine install -> manifest check -> placeholder loader files
 * -> tiny PNG into ComfyUI/input -> boot --cpu -> extra-path log
 * lines -> /object_info node + loader-list asserts -> queue T2V ->
 * interrupt -> queue I2V -> interrupt -> PASS.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = process.env.TAKEONE_E2E_ROOT || path.join(process.cwd(), '.e2e-root');
// Same 1x1 transparent PNG the UI audit uses (ui-audit.py TINY_PNG_B64).
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const WAN_NODES = ['Wan22ImageToVideoLatent', 'WanImageToVideo', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'KSampler', 'VAEDecode', 'CreateVideo', 'SaveVideo'];

function log(...a) { console.log('[e2e-video]', ...a); }

async function main() {
  log('root:', ROOT);
  // 1. Engine install — the same function the app will call.
  const engine = require('../main/engine.js');
  log('installing engine (same code the app runs)...');
  const inst = await engine.installEngine(ROOT, {
    skipGpuCheck: process.env.TAKEONE_SKIP_GPU_CHECK === '1',
    onEvent: (e) => log('engine:', e.phase, e.detail || ''),
  });
  if (!inst.ok) throw new Error(`engine install failed: ${inst.why} — ${inst.whatNext}`);

  // 2. Manifest check — the catalog entry itself, no download.
  const catalog = require('../main/catalog.js');
  const entry = catalog.TOOLS.find((t) => t.id === 'video-studio');
  if (!entry) throw new Error('video-studio missing from catalog');
  if (entry.repo !== 'Wan-AI/Wan2.2-TI2V-5B') throw new Error(`wrong repo: ${entry.repo}`);
  if (!/^[0-9a-f]{40}$/.test(entry.commit || '')) throw new Error(`commit not pinned: ${entry.commit}`);
  if (entry.license !== 'Apache-2.0') throw new Error(`wrong license: ${entry.license}`);
  if (!Array.isArray(entry.files) || entry.files.length === 0) throw new Error('files[] manifest empty');
  let total = 0;
  for (const f of entry.files) {
    if (!f.fileName || !/^[0-9a-f]{64}$/.test(f.sha256 || '') || !(f.size > 0)) {
      throw new Error(`bad manifest entry: ${JSON.stringify(f)}`);
    }
    total += f.size;
  }
  log(`manifest OK: ${entry.files.length} files, ${total} bytes, commit ${entry.commit}`);
  if (entry.sizeBytes && entry.sizeBytes !== total) {
    throw new Error(`sizeBytes mismatch: catalog says ${entry.sizeBytes}, files sum to ${total}`);
  }

  // 3. Validation stand-ins: 1-byte files with the EXACT loader names,
  // so ComfyUI's combo lists contain them (see header). The merged
  // file name comes from the same module the app uses — never a shard.
  const videoModel = require('../main/video-model.js');
  const toolDir = videoModel.videoToolDir(ROOT);
  fs.mkdirSync(toolDir, { recursive: true });
  const names = videoModel.videoLoaderNames();
  for (const key of ['unet', 'clip', 'vae']) {
    const p = path.join(ROOT, 'Models', 'video', names[key]);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'); // VALIDATION STAND-IN ONLY — not a model
    log(`stand-in: ${names[key]}`);
  }

  // 4. Boot ComfyUI through the SAME shared path the app uses.
  const { createEngineComfy } = require('../main/comfy.js');
  const { wanVideo, videoDims, videoFrames, DEFAULT_VIDEO_NEGATIVE } = require('../main/comfy-workflows.js');
  const comfyLog = [];
  const mgr = createEngineComfy({
    root: ROOT,
    cpu: true, // CI runners have no NVIDIA GPU
    onEvent: (t, e) => { if (t === 'log' && e && e.line) comfyLog.push(e.line); },
  });
  const st = await mgr.start();
  if (!st.ok) {
    log('ComfyUI child output (tail):');
    for (const l of comfyLog.slice(-15)) log('  | ' + l);
    throw new Error('ComfyUI failed to start: ' + st.error);
  }
  const comfyLogFile = path.join(engine.engineRoot(ROOT), 'comfyui.log');
  let comfyLogText = '';
  try { comfyLogText = fs.readFileSync(comfyLogFile, 'utf8'); } catch {}
  const allLines = [...comfyLog, ...comfyLogText.split(/\r?\n/)];
  // Extra search paths must reach Models/video for all three Wan keys.
  for (const key of ['diffusion_models', 'vae', 'text_encoders']) {
    const line = allLines.find((l) => /Adding extra search path/i.test(l) && l.includes(key));
    if (!line) throw new Error(`ComfyUI log has no "Adding extra search path ${key}" line`);
    if (!/Models/.test(line) || !/video/.test(line)) throw new Error(`extra path ${key} does not point at Models/video: ${line}`);
    log(`extra path ${key}:`, line.trim());
  }
  // Tiny PNG into ComfyUI/input BEFORE /object_info, so LoadImage's
  // combo list contains it at queue time (same membership rule).
  const inputDir = path.join(engine.engineRoot(ROOT), 'ComfyUI', 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, 'e2e-tiny.png'), Buffer.from(TINY_PNG_B64, 'base64'));

  // 5. /object_info: Wan nodes present AND loader lists contain the names.
  const info = await mgr.getObjectInfo();
  if (!info.ok) throw new Error('getObjectInfo failed: ' + info.error);
  const nodeNames = Object.keys(info.info || {});
  log(`object_info: ${nodeNames.length} nodes`);
  for (const n of WAN_NODES) {
    if (!nodeNames.includes(n)) throw new Error(`node missing from /object_info: ${n}`);
  }
  const wanNodes = nodeNames.filter((n) => /wan/i.test(n));
  log('Wan nodes served:', wanNodes.join(', '));
  const unetList = (((info.info.UNETLoader || {}).input || {}).required || {}).unet_name;
  const clipList = (((info.info.CLIPLoader || {}).input || {}).required || {}).clip_name;
  const vaeList = (((info.info.VAELoader || {}).input || {}).required || {}).vae_name;
  const loadImageList = (((info.info.LoadImage || {}).input || {}).required || {}).image;
  for (const [label, list, want] of [
    ['UNETLoader', unetList, names.unet], ['CLIPLoader', clipList, names.clip],
    ['VAELoader', vaeList, names.vae], ['LoadImage', loadImageList, 'e2e-tiny.png'],
  ]) {
    if (!Array.isArray(list) || !list[0] || !list[0].includes(want)) {
      throw new Error(`${label} list does not contain ${want} (got: ${JSON.stringify(list && list[0])})`);
    }
    log(`${label} lists ${want}`);
  }

  // 6. Queue T2V via the shared builder -> prompt_id (NOT 400) -> interrupt.
  const [w, h] = videoDims('480p');
  const t2v = wanVideo({
    unet: names.unet, clip: names.clip, vae: names.vae,
    positive: 'Slow aerial drone shot gliding over ocean waves at golden sunset, cinematic lighting, photorealistic',
    negative: DEFAULT_VIDEO_NEGATIVE, width: w, height: h,
    length: videoFrames(2), seed: 42,
  });
  const q1 = await mgr.queuePrompt(t2v);
  if (!q1.ok) throw new Error('T2V queue VALIDATION failed (this is the WO-41 class): ' + (q1.error || JSON.stringify(q1)));
  log('T2V queued, prompt_id:', q1.promptId || q1.id);
  await mgr.interrupt();
  log('T2V interrupted');

  // 7. Queue I2V the same way (start image from ComfyUI/input).
  const i2v = wanVideo({
    unet: names.unet, clip: names.clip, vae: names.vae,
    positive: 'A red fox kit walking through autumn leaves, cinematic lighting',
    negative: DEFAULT_VIDEO_NEGATIVE, width: w, height: h,
    length: videoFrames(2), seed: 42, startImage: 'e2e-tiny.png',
  });
  const q2 = await mgr.queuePrompt(i2v);
  if (!q2.ok) throw new Error('I2V queue VALIDATION failed (this is the WO-41 class): ' + (q2.error || JSON.stringify(q2)));
  log('I2V queued, prompt_id:', q2.promptId || q2.id);
  await mgr.interrupt();
  log('I2V interrupted');

  log('PASS — T2V + I2V validated (prompt_ids above); real render stays Not Tested until Ali\'s GPU pack (M2.6)');
  await mgr.stop();
}

main().catch((e) => { console.error('[e2e-video] FAILED:', e.message); process.exit(1); });
