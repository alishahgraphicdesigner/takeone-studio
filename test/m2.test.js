/* M2 — Video v1 on Wan 2.2 TI2V-5B: workflow builder, catalog entry,
 * VRAM check, loader names, video error mapping, model-paths yaml,
 * diagnostics video list, and the shard-merge script (tiny-shard
 * end-to-end when a Python with safetensors is available, skipped
 * otherwise — the CI unit-test runners carry no torch). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  wanVideo, videoDims, videoFrames, VIDEO_DEFAULTS, DEFAULT_VIDEO_NEGATIVE,
  buildVideoAliPackJobs, VIDEO_ALI_PACK_PROMPTS,
} = require('../main/comfy-workflows.js');
const { CATALOG } = require('../main/catalog.js');
const { videoLoaderNames, videoVramCheck } = require('../main/video-model.js');
const { mapComfyError, MODEL_NOT_VISIBLE_MSG, VIDEO_NOT_VISIBLE_MSG } = require('../main/comfy.js');
const engine = require('../main/engine.js');
const { listQuickVideos } = require('../main/diagnostics.js');

function classes(wf) {
  return Object.fromEntries(Object.entries(wf).map(([id, n]) => [id, n.class_type]));
}

describe('wanVideo builder (native Wan 2.2 nodes, pinned commit)', () => {
  it('T2V graph: loaders + Wan22 latent + sampler + decode + video save, no LoadImage', () => {
    const wf = wanVideo({
      unet: 'video-studio/diffusion_pytorch_model.safetensors',
      clip: 'video-studio/models_t5_umt5-xxl-enc-bf16.pth',
      vae: 'video-studio/Wan2.2_VAE.pth',
      positive: 'a fox', negative: '', width: 832, height: 480, length: 33, seed: 7,
    });
    const c = classes(wf);
    assert.equal(c['1'], 'UNETLoader');
    assert.equal(c['2'], 'CLIPLoader');
    assert.equal(c['3'], 'VAELoader');
    assert.equal(c['4'], 'CLIPTextEncode');
    assert.equal(c['5'], 'CLIPTextEncode');
    assert.equal(c['6'], 'Wan22ImageToVideoLatent');
    assert.equal(c['8'], 'KSampler');
    assert.equal(c['9'], 'VAEDecode');
    assert.equal(c['10'], 'CreateVideo');
    assert.equal(c['11'], 'SaveVideo');
    assert.ok(!('7' in wf), 'T2V has no LoadImage node');
    assert.equal(wf['2'].inputs.type, 'wan');
    assert.equal(wf['11'].inputs.format, 'mp4');
    assert.equal(wf['11'].inputs.filename_prefix, 'video/TakeOne');
    assert.equal(wf['10'].inputs.fps, 16);
    // Links: sampler <- loaders/latent, decode <- sampler, video <- decode.
    assert.deepEqual(wf['8'].inputs.model, ['1', 0]);
    assert.deepEqual(wf['8'].inputs.positive, ['4', 0]);
    assert.deepEqual(wf['8'].inputs.negative, ['5', 0]);
    assert.deepEqual(wf['8'].inputs.latent_image, ['6', 0]);
    assert.deepEqual(wf['9'].inputs.samples, ['8', 0]);
    assert.deepEqual(wf['9'].inputs.vae, ['3', 0]);
    assert.deepEqual(wf['10'].inputs.images, ['9', 0]);
    assert.deepEqual(wf['11'].inputs.video, ['10', 0]);
    assert.equal(wf['8'].inputs.steps, 20);
    assert.equal(wf['8'].inputs.cfg, 5);
    assert.equal(wf['8'].inputs.sampler_name, 'euler');
    assert.equal(wf['8'].inputs.scheduler, 'sgm_uniform');
  });
  it('I2V graph: LoadImage feeds the latent node start_image', () => {
    const wf = wanVideo({
      unet: 'u', clip: 'c', vae: 'v', positive: 'fox walks',
      width: 832, height: 480, length: 33, seed: 1, startImage: 'fox.png',
    });
    assert.equal(wf['7'].class_type, 'LoadImage');
    assert.equal(wf['7'].inputs.image, 'fox.png');
    assert.deepEqual(wf['6'].inputs.start_image, ['7', 0]);
  });
  it('resolutions are multiples of 32; lengths satisfy (frames-1)%4==0', () => {
    for (const r of ['480p', '720p']) {
      const [w, h] = videoDims(r);
      assert.equal(w % 32, 0, r); assert.equal(h % 32, 0, r);
    }
    assert.deepEqual(videoDims('480p'), [832, 480]);
    assert.deepEqual(videoDims('720p'), [1280, 704]);
    assert.equal(videoFrames(2), 33);
    assert.equal(videoFrames(4), 65);
    assert.equal((videoFrames(2) - 1) % 4, 0);
    assert.equal((videoFrames(4) - 1) % 4, 0);
  });
  it('defaults are the Wan 2.2 community starting point, labelled as such', () => {
    assert.deepEqual({ ...VIDEO_DEFAULTS }, { steps: 20, cfg: 5, sampler_name: 'euler', scheduler: 'sgm_uniform', fps: 16 });
    assert.ok(DEFAULT_VIDEO_NEGATIVE.includes('blurry'));
  });
});

describe('video Ali pack (M2.6)', () => {
  it('is 2 prompts x 2 settings, one seed, Recipe 2 prompt first', () => {
    const jobs = buildVideoAliPackJobs(4242);
    assert.equal(jobs.length, 4);
    assert.equal(VIDEO_ALI_PACK_PROMPTS.length, 2);
    assert.equal(jobs[0].prompt, 'Slow aerial drone shot gliding over ocean waves at golden sunset, cinematic lighting, photorealistic');
    assert.equal(jobs[1].prompt, jobs[0].prompt);
    assert.notEqual(jobs[2].prompt, jobs[0].prompt);
    assert.ok(jobs.every((j) => j.seed === 4242));
    assert.deepEqual(jobs.map((j) => `${j.resolution} ${j.duration}s`), ['480p 2s', '720p 2s', '480p 2s', '720p 2s']);
  });
});

describe('catalog video-studio (M2.1)', () => {
  const vs = CATALOG.find((t) => t.id === 'video-studio');
  it('is Wan 2.2 TI2V-5B with a pinned commit + full file manifest', () => {
    assert.equal(vs.technical, 'Wan 2.2 TI2V-5B');
    assert.equal(vs.repo, 'Wan-AI/Wan2.2-TI2V-5B');
    assert.match(vs.commit, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(vs.files) && vs.files.length >= 10);
    for (const f of vs.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
      assert.ok(f.bytes > 0, f.path);
    }
    const paths = vs.files.map((f) => f.path);
    assert.ok(paths.includes('Wan2.2_VAE.pth'));
    assert.ok(paths.includes('models_t5_umt5-xxl-enc-bf16.pth'));
    assert.ok(paths.includes('diffusion_pytorch_model.safetensors.index.json'));
    assert.equal(paths.filter((p) => /^diffusion_pytorch_model-0000\d-of-00003\.safetensors$/.test(p)).length, 3);
  });
  it('license note is plain words; unavailable STAYS until M2.5+M2.6 green', () => {
    assert.equal(vs.license, 'Apache-2.0');
    assert.match(vs.licenseNote, /Free for commercial use/);
    assert.match(vs.licenseNote, /no payment/);
    assert.ok(typeof vs.unavailable === 'string' && vs.unavailable.length > 0);
    assert.match(vs.unavailable, /M2\.6/);
  });
  it('is a 16 GB target, NOT the 24 GB tier (video-pro keeps tier24 alone)', () => {
    assert.equal(vs.vramMB, 16384);
    assert.ok(!vs.tier24);
    assert.deepEqual(CATALOG.filter((t) => t.tier24).map((t) => t.id), ['video-pro']);
  });
});

describe('video loader names + VRAM check (M2.4)', () => {
  it('loads the MERGED file, never a shard', () => {
    const n = videoLoaderNames();
    assert.equal(n.unet, 'video-studio/diffusion_pytorch_model.safetensors');
    assert.ok(!/0000\d-of-00003/.test(n.unet));
    assert.equal(n.clip, 'video-studio/models_t5_umt5-xxl-enc-bf16.pth');
    assert.equal(n.vae, 'video-studio/Wan2.2_VAE.pth');
  });
  it('VRAM check reports in plain words, never blocks', () => {
    assert.equal(videoVramCheck(null).level, 'unknown');
    assert.match(videoVramCheck(null).text, /not measured/);
    assert.equal(videoVramCheck(16384).level, 'ok');
    assert.match(videoVramCheck(16384).text, /16\.0 GB/);
    assert.match(videoVramCheck(16384).text, /24 GB/);
    assert.equal(videoVramCheck(8192).level, 'warn');
  });
});

describe('video ComfyUI errors map to plain words (M2)', () => {
  it('unet/vae loader 400 -> video not-visible message; ckpt 400 unchanged', () => {
    const body400 = JSON.stringify({ node_errors: { 1: { errors: [{ message: 'Value not in list: unet_name: X not in []' }] } } });
    const m = mapComfyError(400, body400);
    assert.equal(m.modelNotVisible, true);
    assert.equal(m.plain, VIDEO_NOT_VISIBLE_MSG);
    assert.ok(!m.plain.includes('Value not in list'));
    const ali400 = JSON.stringify({ node_errors: { 1: { errors: [{ message: "Value not in list: ckpt_name: 'x' not in []" }] } } });
    const m2 = mapComfyError(400, ali400);
    assert.equal(m2.plain, MODEL_NOT_VISIBLE_MSG);
  });
});

describe('model-paths yaml gains video VAE + text encoders (M2)', () => {
  it('writes vae (both dirs) and text_encoders -> Models/video', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-yaml-'));
    await fs.promises.mkdir(engine.engineRoot(root), { recursive: true });
    await engine.writeModelPaths(root);
    const yml = fs.readFileSync(engine.modelPathsFile(root), 'utf8');
    assert.ok(yml.includes(`checkpoints: ${path.join(root, 'Models', 'image')}`), yml);
    assert.ok(yml.includes('text_encoders:'), yml);
    assert.ok(yml.includes(path.join(root, 'Models', 'video')), yml);
    // The vae block scalar must carry BOTH dirs (image vae + video).
    const vaeBlock = yml.split('vae:')[1].split('text_encoders:')[0];
    assert.ok(vaeBlock.includes(path.join(root, 'Models', 'image', 'vae')), vaeBlock);
    assert.ok(vaeBlock.includes(path.join(root, 'Models', 'video')), vaeBlock);
  });
});

describe('diagnostics video list (M2)', () => {
  it('lists newest mp4s + thumbs from the Quick Generate project videos/', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-diag-'));
    const proj = path.join(root, 'Projects', 'qg1');
    fs.mkdirSync(path.join(proj, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ id: 'qg1', name: 'Quick Generate' }));
    const a = path.join(proj, 'videos', 'a.mp4');
    const b = path.join(proj, 'videos', 'b_thumb.png');
    fs.writeFileSync(a, Buffer.alloc(100));
    fs.writeFileSync(b, Buffer.alloc(50));
    const now = Date.now();
    fs.utimesSync(a, new Date(now - 1000), new Date(now - 1000));
    fs.utimesSync(b, new Date(now), new Date(now));
    const rows = listQuickVideos(root);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].startsWith('b_thumb.png'), rows[0]);
    assert.ok(rows[1].startsWith('a.mp4'), rows[1]);
  });
});

describe('e2e-video driver uses real module exports (M2.5 regression)', () => {
  // The first CI run of e2e-video died on catalog.TOOLS — an export that
  // does not exist (it is CATALOG). The driver only runs on CI, so a
  // local test must catch a wrong export name before it ships.
  it('references CATALOG, never TOOLS, and every module it requires exports what it uses', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'e2e-video.js'), 'utf8');
    assert.ok(!src.includes('TOOLS'), 'driver still references the nonexistent TOOLS export');
    assert.ok(src.includes('CATALOG.find'), 'driver must look video-studio up in CATALOG');
    const catalogMod = require('../main/catalog.js');
    assert.ok(Array.isArray(catalogMod.CATALOG), 'catalog.js must export the CATALOG array');
    assert.ok(catalogMod.CATALOG.some((t) => t.id === 'video-studio'));
  });
});

describe('merge-shards.py (M2 load path)', () => {
  it('rejects bad usage', (t) => {
    const py = findPython();
    if (!py) { t.skip('no python3/python on PATH'); return; }
    const r = spawnSync(py, [path.join(__dirname, '..', 'main', 'merge-shards.py')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/);
  });
  it('merges tiny shards end-to-end (pure stdlib: no torch, no safetensors lib)', (t) => {
    const py = findPython();
    if (!py) { t.skip('no python3/python on PATH'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-merge-'));
    const script = path.join(__dirname, '..', 'main', 'merge-shards.py');
    // Pure-node safetensors writer (no torch/numpy needed): 8-byte LE
    // header length + JSON header + raw F32 bytes.
    function writeShard(file, entries) {
      let offset = 0;
      const header = { __metadata__: { format: 'pt' } };
      const chunks = [];
      for (const [key, floats] of entries) {
        const data = Buffer.alloc(floats.length * 4);
        floats.forEach((v, i) => data.writeFloatLE(v, i * 4));
        header[key] = { dtype: 'F32', shape: [floats.length], data_offsets: [offset, offset + data.length] };
        offset += data.length;
        chunks.push(data);
      }
      const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64LE(BigInt(headerBuf.length));
      fs.writeFileSync(file, Buffer.concat([lenBuf, headerBuf, ...chunks]));
    }
    writeShard(path.join(dir, 'diffusion_pytorch_model-00001-of-00003.safetensors'), [['a', [1, 2]]]);
    writeShard(path.join(dir, 'diffusion_pytorch_model-00002-of-00003.safetensors'), [['b', [3, 4, 5]]]);
    fs.writeFileSync(path.join(dir, 'diffusion_pytorch_model.safetensors.index.json'), JSON.stringify({
      metadata: { total_size: 20 },
      weight_map: { a: 'diffusion_pytorch_model-00001-of-00003.safetensors', b: 'diffusion_pytorch_model-00002-of-00003.safetensors' },
    }));
    const r = spawnSync(py, [script, dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const mergedPath = path.join(dir, 'diffusion_pytorch_model.safetensors');
    assert.ok(fs.existsSync(mergedPath));
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'merged.json'), 'utf8'));
    assert.equal(sidecar.tensors, 2);
    // Verify the merged file by parsing its header in node: keys a + b,
    // F32, shapes preserved, and the tensor bytes round-trip exactly.
    const buf = fs.readFileSync(mergedPath);
    const headerLen = Number(buf.readBigUInt64LE(0));
    const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'));
    assert.deepEqual(Object.keys(header).filter((k) => k !== '__metadata__').sort(), ['a', 'b']);
    assert.equal(header.a.dtype, 'F32');
    assert.deepEqual(header.a.shape, [2]);
    assert.deepEqual(header.b.shape, [3]);
    const dataStart = 8 + headerLen;
    const floats = (spec) => {
      const out = [];
      for (let o = spec.data_offsets[0]; o < spec.data_offsets[1]; o += 4) out.push(buf.readFloatLE(dataStart + o));
      return out;
    };
    assert.deepEqual(floats(header.a), [1, 2]);
    assert.deepEqual(floats(header.b), [3, 4, 5]);
    // Second run is idempotent (no rewrite).
    const r2 = spawnSync(py, [script, dir], { encoding: 'utf8' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /already merged/);
  });
});

function findPython() {
  for (const c of ['python3', 'python']) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return null;
}
