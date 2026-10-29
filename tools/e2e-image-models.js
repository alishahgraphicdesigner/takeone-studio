#!/usr/bin/env node
/* M3 driver: end-to-end IMAGE-MODELS validation on CI (Windows, CPU, no GPU).
 *
 * Uses the SAME code the app will run:
 *   - main/engine.js          -> installEngine() + writeModelPaths()
 *   - main/catalog.js         -> z-image-turbo + flux2-klein-4b manifests
 *   - main/comfy-workflows.js -> zImage() + fluxKlein() (shared builders)
 *
 * What it proves (and what it honestly does NOT):
 *   PROVES: (1) both catalog manifests are complete + well-formed
 *   (every file has a 64-hex sha256, the HF commit is pinned, sizes
 *   add up, only the 4B distilled klein file is listed); (2) the
 *   pinned ComfyUI commit really serves the Z-Image + Flux.2 nodes
 *   (EmptySD3LatentImage, ModelSamplingAuraFlow, EmptyFlux2LatentImage,
 *   CFGGuider, Flux2Scheduler, SamplerCustomAdvanced et al. in
 *   /object_info) AND both CLIPLoader types (lumina2, flux2) in the
 *   type list; (3) the extra search paths reach Models/image
 *   (diffusion_models, vae, text_encoders); (4) both shared builders'
 *   workflows VALIDATE at queue time (a prompt_id, not a 400 — the
 *   exact failure class that broke Quick Generate in WO-41);
 *   (5) interrupt works.
 *   DOES NOT prove a real render: no 20 GB + 16 GB downloads run here
 *   (the loader files are 1-byte VALIDATION STAND-INS, clearly
 *   labeled in the log, so the combo lists contain the loader names
 *   — ComfyUI's queue validator checks combo membership, so without
 *   them the queue would 400 exactly like WO-41). Execution after
 *   queueing is interrupted immediately; the first real images are
 *   the bake-off on Ali's GPU and stay Not Tested until he runs it.
 *
 * Steps: engine install -> manifest checks -> placeholder loader files
 * -> boot --cpu -> extra-path log lines -> /object_info node +
 * loader-list + CLIP-type asserts -> queue Z-Image -> interrupt ->
 * queue FLUX.2 Klein -> interrupt -> PASS.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = process.env.TAKEONE_E2E_ROOT || path.join(process.cwd(), '.e2e-root');
const IMAGE_NODES = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut',
  'EmptySD3LatentImage', 'ModelSamplingAuraFlow', 'KSampler', 'VAEDecode', 'SaveImage',
  'EmptyFlux2LatentImage', 'RandomNoise', 'CFGGuider', 'KSamplerSelect', 'Flux2Scheduler', 'SamplerCustomAdvanced'];

function log(...a) { console.log('[e2e-image-models]', ...a); }

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

  // 2. Manifest checks — the catalog entries themselves, no download.
  const { CATALOG } = require('../main/catalog.js');
  const { zImage, fluxKlein, IMAGE_MODEL_FILES } = require('../main/comfy-workflows.js');
  const checks = [
    { id: 'z-image-turbo', repo: 'Comfy-Org/Z-Image-Turbo', unet: 'z_image_turbo_bf16.safetensors' },
    { id: 'flux2-klein-4b', repo: 'Comfy-Org/Flux-2-Klein-4B', unet: 'flux-2-klein-4b.safetensors' },
  ];
  for (const c of checks) {
    const entry = CATALOG.find((t) => t.id === c.id);
    if (!entry) throw new Error(`${c.id} missing from catalog`);
    if (entry.repo !== c.repo) throw new Error(`wrong repo for ${c.id}: ${entry.repo}`);
    if (!/^[0-9a-f]{40}$/.test(entry.commit || '')) throw new Error(`commit not pinned for ${c.id}: ${entry.commit}`);
    if (entry.license !== 'Apache-2.0') throw new Error(`wrong license for ${c.id}: ${entry.license}`);
    if (entry.experimentalSwitch !== 'imageModels') throw new Error(`${c.id} is not on the imageModels switch`);
    if (!Array.isArray(entry.files) || entry.files.length !== 3) throw new Error(`files[] manifest wrong for ${c.id}`);
    let total = 0;
    for (const f of entry.files) {
      if (!f.path || !/^[0-9a-f]{64}$/.test(f.sha256 || '') || !(f.bytes > 0)) {
        throw new Error(`bad manifest entry for ${c.id}: ${JSON.stringify(f)}`);
      }
      total += f.bytes;
    }
    log(`manifest OK: ${c.id}: ${entry.files.length} files, ${total} bytes, commit ${entry.commit}`);
    if (entry.sizeBytes && entry.sizeBytes !== total) {
      throw new Error(`sizeBytes mismatch for ${c.id}: catalog says ${entry.sizeBytes}, files sum to ${total}`);
    }
    const base = entry.files.map((f) => f.path.split('/').pop());
    const names = IMAGE_MODEL_FILES[c.id];
    for (const k of ['unet', 'clip', 'vae']) {
      if (!base.includes(names[k])) throw new Error(`${c.id} manifest lacks loader file ${names[k]}`);
    }
  }
  const klein = CATALOG.find((t) => t.id === 'flux2-klein-4b');
  if (klein.files.some((f) => /9b|base-4b/i.test(f.path))) {
    throw new Error('flux2-klein-4b manifest lists a 9B/base file — only 4B distilled is allowed');
  }

  // 3. Validation stand-ins: 1-byte files with the EXACT loader names,
  // so ComfyUI's combo lists contain them (see header). Bare names at
  // Models/image top level — the extra paths point there (recursive).
  const names = new Set();
  for (const c of checks) {
    const n = IMAGE_MODEL_FILES[c.id];
    names.add(n.unet); names.add(n.clip); names.add(n.vae);
  }
  for (const name of names) {
    const p = path.join(ROOT, 'Models', 'image', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'); // VALIDATION STAND-IN ONLY — not a model
    log(`stand-in: ${name}`);
  }

  // 4. Boot ComfyUI through the SAME shared path the app uses.
  const { createEngineComfy } = require('../main/comfy.js');
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
  // WHY stream matching, not line matching: see e2e-video.js — comfy.js
  // forwards stderr as data chunks, and a chunk boundary can split an
  // extra-path line mid-path. Concatenating restores the stream.
  const eventStream = comfyLog.join('');
  const fileStream = comfyLogText.split(/\r?\n/).map((l) => l.replace(/^\[err\] /, '')).join('');
  const streamHas = (key) => {
    const re = new RegExp(`Adding extra search path ${key}[^\\n]*Models[\\\\/]image`);
    return re.test(eventStream) || re.test(fileStream);
  };
  // Extra search paths must reach Models/image for all three keys.
  for (const key of ['diffusion_models', 'vae', 'text_encoders']) {
    if (!streamHas(key)) {
      throw new Error(`no "Adding extra search path ${key}" entry reaches Models/image (joined-stream check)`);
    }
    const line = [...comfyLog, ...comfyLogText.split(/\r?\n/)].find((l) => /Adding extra search path/i.test(l) && l.includes(key));
    log(`extra path ${key}:`, line ? line.trim() : '(matched on the joined stream; split across log chunks)');
  }

  // 5. /object_info: M3 nodes present, loader lists contain the names,
  // and the CLIPLoader type list contains lumina2 + flux2.
  const info = await mgr.getObjectInfo();
  if (!info.ok) throw new Error('getObjectInfo failed: ' + info.error);
  const nodeNames = Object.keys(info.info || {});
  log(`object_info: ${nodeNames.length} nodes`);
  for (const n of IMAGE_NODES) {
    if (!nodeNames.includes(n)) throw new Error(`node missing from /object_info: ${n}`);
  }
  const norm = (s) => String(s).replace(/\\/g, '/');
  const listOf = (node, input) => {
    try {
      const spec = info.info[node] && info.info[node].input && info.info[node].input.required
        && info.info[node].input.required[input];
      return Array.isArray(spec && spec[0]) ? spec[0].map(norm) : [];
    } catch { return []; }
  };
  const unetList = listOf('UNETLoader', 'unet_name');
  const clipList = listOf('CLIPLoader', 'clip_name');
  const vaeList = listOf('VAELoader', 'vae_name');
  const clipTypes = listOf('CLIPLoader', 'type');
  for (const [label, list, want] of [
    ['UNETLoader', unetList, 'z_image_turbo_bf16.safetensors'],
    ['UNETLoader', unetList, 'flux-2-klein-4b.safetensors'],
    ['CLIPLoader', clipList, 'qwen_3_4b.safetensors'],
    ['VAELoader', vaeList, 'ae.safetensors'],
    ['VAELoader', vaeList, 'flux2-vae.safetensors'],
    ['CLIPLoader type', clipTypes, 'lumina2'],
    ['CLIPLoader type', clipTypes, 'flux2'],
  ]) {
    if (!list.includes(norm(want))) {
      throw new Error(`${label} list does not contain ${want} (got: ${JSON.stringify(list)})`);
    }
    log(`${label} lists ${want}`);
  }

  // 6. Queue Z-Image via the shared builder -> prompt_id (NOT 400) -> interrupt.
  const zi = IMAGE_MODEL_FILES['z-image-turbo'];
  const zwf = zImage({
    unet: zi.unet, clip: zi.clip, vae: zi.vae,
    positive: 'A weathered fisherman mending nets at dawn on a wooden boat, documentary photograph, soft golden light',
    seed: 42,
  });
  const q1 = await mgr.queuePrompt(zwf);
  if (!q1.ok) {
    log('Z-Image queue raw error:', q1.rawError || '(no raw body)');
    throw new Error('Z-Image queue VALIDATION failed (this is the WO-41 class): ' + (q1.error || JSON.stringify(q1)));
  }
  log('Z-Image queued, prompt_id:', q1.promptId || q1.id);
  await mgr.interrupt();
  log('Z-Image interrupted');

  // 7. Queue FLUX.2 Klein the same way.
  const fl = IMAGE_MODEL_FILES['flux2-klein-4b'];
  const fwf = fluxKlein({
    unet: fl.unet, clip: fl.clip, vae: fl.vae,
    positive: 'A weathered fisherman mending nets at dawn on a wooden boat, documentary photograph, soft golden light',
    seed: 42,
  });
  const q2 = await mgr.queuePrompt(fwf);
  if (!q2.ok) {
    log('FLUX.2 Klein queue raw error:', q2.rawError || '(no raw body)');
    throw new Error('FLUX.2 Klein queue VALIDATION failed (this is the WO-41 class): ' + (q2.error || JSON.stringify(q2)));
  }
  log('FLUX.2 Klein queued, prompt_id:', q2.promptId || q2.id);
  await mgr.interrupt();
  log('FLUX.2 Klein interrupted');

  log('PASS — Z-Image + FLUX.2 Klein validated (prompt_ids above); real images stay Not Tested until Ali\'s GPU bake-off (M3)');
  await mgr.stop();
}

main().catch((e) => { console.error('[e2e-image-models] FAILED:', e.message); process.exit(1); });
