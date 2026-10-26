#!/usr/bin/env node
/* WO-22 driver: end-to-end "Studio se asli output file" on CI (Windows, CPU).
 *
 * Uses the SAME code the app will run:
 *   - main/engine.js  -> installEngine()
 *   - main/comfy-workflows.js -> sdxlLightningTxt2Img() (shared Lightning workflow)
 *   - main/comfy.js   -> createEngineComfy() (shared ComfyUI start path)
 *
 * Steps: install engine -> fetch SDXL-Lightning checkpoint (sha256-verified)
 * into <root>/Models/image ONLY -> ComfyUI --cpu (via the shared path, so
 * extra_model_paths must work or the test fails) -> assert the extra search
 * path log line + loader preflight -> queue 1 prompt (512x512) -> wait via
 * the APP's fetchAndSaveOutput (Node /view fetch -> Library/Quick Generate
 * + sidecar, WO-43) -> assert on the SAVED file: exists, PNG magic,
 * dimensions 512x512, pixel variance > threshold (a black or solid-colour
 * image fails) -> /view probe with file-origin headers (info only).
 *
 * PNG decode is dependency-free (node:zlib + a minimal unfilter implementation).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = process.env.TAKEONE_E2E_ROOT || path.join(process.cwd(), '.e2e-root');
const PROMPT = process.env.TAKEONE_E2E_PROMPT || 'a small lighthouse on a rocky coast at dusk, cinematic';
const CKPT_URL = 'https://huggingface.co/ByteDance/SDXL-Lightning/resolve/main/sdxl_lightning_4step.safetensors';
const CKPT_SHA256 = 'e0d996ee0013e79d9d3561f50fcafb9a17e3ff07b780358e3b66d67932c4d490'; // from main/catalog.js (image-studio)
const VARIANCE_THRESHOLD = 50; // mean squared deviation of grayscale; solid/black images score ~0
const CORRELATION_THRESHOLD = 0.3; // adjacent-pixel correlation; noise ~0, real output 0.8+

function log(...a) { console.log('[e2e]', ...a); }

function sha256File(p) {
  // Streaming: fs.readFileSync throws ERR_FS_FILE_TOO_LARGE past 2 GiB
  // (the SDXL checkpoint is ~6.6 GB).
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function fetchFile(url, dest) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let done = 0;
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { get(res.headers.location); return; }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      res.on('data', (c) => {
        done += c.length;
        if (total && done % (256 * 1024 * 1024) < c.length) log(`checkpoint: ${(done / 1073741824).toFixed(2)} / ${(total / 1073741824).toFixed(2)} GB`);
      });
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
    }).on('error', reject);
    get(url);
  });
}

/** Minimal PNG reader: returns { width, height, gray: Buffer } (8-bit grayscale). */
function readPngGrayscale(p) {
  const b = fs.readFileSync(p);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width, height, bitDepth, colorType, idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 0 && colorType !== 2 && colorType !== 6))
        throw new Error(`unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const stride = width * ch;
  const gray = Buffer.alloc(width * height);
  let pIn = 0;
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pIn++];
    const line = Buffer.alloc(stride);
    raw.copy(line, 0, pIn, pIn + stride); pIn += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const bb = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + bb) & 255;
      else if (filter === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + bb - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
        v = (v + pr) & 255;
      }
      line[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = x * ch;
      gray[y * width + x] = ch === 1 ? line[o] : Math.round((line[o] + line[o + 1] + line[o + 2]) / 3);
    }
    line.copy(prev);
  }
  return { width, height, gray };
}

function pixelVariance(gray) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let sq = 0;
  for (let i = 0; i < gray.length; i++) { const d = gray[i] - mean; sq += d * d; }
  return sq / gray.length;
}

/** Pearson correlation between horizontally adjacent grayscale pixels. */
function spatialCorrelation(gray, width, height) {
  const n = (width - 1) * height;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width - 1; x++) {
      const a = gray[row + x], b = gray[row + x + 1];
      sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
    }
  }
  const denom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (!denom) return 0;
  return (n * sxy - sx * sy) / denom;
}

async function main() {
  log('root:', ROOT);
  // 1. Engine install — the same function the app will call (WO-21).
  const engine = require('../main/engine.js');
  log('installing engine (same code the app runs)...');
  const inst = await engine.installEngine(ROOT, {
    // GitHub runners have no NVIDIA GPU; the GPU failure kinds are unit-tested
    // and the real GPU path is proven on the user's own PC.
    skipGpuCheck: process.env.TAKEONE_SKIP_GPU_CHECK === '1',
    onEvent: (e) => log('engine:', e.phase, e.detail || ''),
  });
  if (!inst.ok) throw new Error(`engine install failed: ${inst.why} — ${inst.whatNext}`);

  // 2. Checkpoint — manifest data (URL + sha256 from main/catalog.js), verified download.
  // WO-41.4: the checkpoint lives ONLY where the app puts it: <root>/Models/image
  // (the catalog destination for image-studio). It must NOT be copied into
  // ComfyUI/models/checkpoints — that bypass is exactly what hid the
  // extra_model_paths bug from this test until now. ComfyUI sees the model
  // only through --extra-model-paths-config (see step 3).
  const https = require('https');
  const crypto = require('crypto');
  const ckptDir = path.join(ROOT, 'Models', 'image');
  fs.mkdirSync(ckptDir, { recursive: true });
  const ckptDest = path.join(ckptDir, 'sdxl_lightning_4step.safetensors');
  const needDl = !fs.existsSync(ckptDest) || sha256File(ckptDest) !== CKPT_SHA256;
  if (needDl) {
    log('downloading checkpoint (~6.6 GB)...');
    await fetchFile(CKPT_URL, ckptDest);
    const h = sha256File(ckptDest);
    if (h !== CKPT_SHA256) throw new Error(`checkpoint sha256 mismatch: ${h}`);
    log('checkpoint verified');
  } else log('checkpoint already verified on disk');

  // 3. Boot ComfyUI through the SAME shared path the app uses
  // (WO-41: createEngineComfy — yaml + --extra-model-paths-config + port).
  const { createEngineComfy } = require('../main/comfy.js');
  const { sdxlLightningTxt2Img } = require('../main/comfy-workflows.js');
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
  // WO-41.4: this test must now CATCH the bug that slipped through before.
  // (a) ComfyUI's own log must show the extra search path into Models/image.
  // (b) The checkpoint must NOT exist under ComfyUI/models/checkpoints.
  const comfyLogFile = path.join(engine.engineRoot(ROOT), 'comfyui.log');
  let comfyLogText = '';
  try { comfyLogText = fs.readFileSync(comfyLogFile, 'utf8'); } catch {}
  const extraPathLine = [...comfyLog, ...comfyLogText.split(/\r?\n/)].find((l) => /Adding extra search path checkpoints/i.test(l));
  if (!extraPathLine) throw new Error('ComfyUI log has no "Adding extra search path checkpoints" line — extra_model_paths is not wired (WO-41 bug)');
  if (!/Models/.test(extraPathLine) || !/image/.test(extraPathLine)) throw new Error(`extra search path line does not point at Models/image: ${extraPathLine}`);
  log('extra search path:', extraPathLine.trim());
  const bypassCkpt = path.join(engine.engineRoot(ROOT), 'ComfyUI', 'models', 'checkpoints', 'sdxl_lightning_4step.safetensors');
  if (fs.existsSync(bypassCkpt)) throw new Error('checkpoint found under ComfyUI/models/checkpoints — the test must not bypass extra_model_paths');
  // (c) The loader itself must list the model (the preflight the app runs).
  const pre = await mgr.getCheckpointList();
  if (!pre.ok || !pre.checkpoints.includes('sdxl_lightning_4step.safetensors')) {
    throw new Error(`CheckpointLoaderSimple does not list the model (preflight: ${JSON.stringify(pre)})`);
  }
  log('preflight: model visible to CheckpointLoaderSimple');

  // 4. Queue the REAL workflow: the shared Lightning workflow, 512x512.
  const wf = sdxlLightningTxt2Img({
    checkpoint: 'sdxl_lightning_4step.safetensors',
    positive: PROMPT, negative: '',
    width: 512, height: 512,
  });
  const q = await mgr.queuePrompt(wf);
  if (!q.ok) throw new Error('queuePrompt failed: ' + (q.error || 'unknown'));
  log('queued prompt', q.promptId || q.id);

  // 5. Wait for the PNG through the APP's own path (WO-43): poll
  // fetchAndSaveOutput (timeout 20 min on CPU). It fetches /view via Node,
  // validates PNG magic, and saves to Library/Quick Generate + sidecar.
  // The old path (read the PNG out of ComfyUI's output dir directly) is
  // gone — the app never touches that dir anymore.
  const deadline = Date.now() + 20 * 60 * 1000;
  let saved = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const r = await mgr.fetchAndSaveOutput(ROOT, q.promptId || q.id, { prompt: PROMPT, model: 'sdxl_lightning_4step.safetensors' });
    if (r.ok) { saved = r; break; }
    if (!r.notFinished) throw new Error('fetchAndSaveOutput failed: ' + r.error);
    log('waiting for output...');
  }
  if (!saved) throw new Error('timed out waiting for the generated PNG (20 min on CPU)');
  const full = saved.path;
  log('output (Library):', full);
  log('dataUrl bytes:', saved.dataUrl.length, '| comfy file:', JSON.stringify(saved.comfyFile));
  // Sidecar must exist (M1: in images/.sidecars/, not next to the PNG,
  // so the Library never shows it as a broken thumbnail) and carry prompt + model.
  const sidecarPath = path.join(path.dirname(full), '.sidecars', path.basename(full).replace(/\.png$/i, '.json'));
  // M1: the save must land in the real "Quick Generate" project.
  if (!saved.projectId || !full.includes(`${path.sep}Projects${path.sep}`) || !full.includes(`${path.sep}images${path.sep}`)) {
    throw new Error('saved path is not in the Quick Generate project images dir: ' + full);
  }
  if (!fs.existsSync(sidecarPath)) throw new Error('sidecar JSON missing: ' + sidecarPath);
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  if (sidecar.prompt !== PROMPT || sidecar.model !== 'sdxl_lightning_4step.safetensors') {
    throw new Error('sidecar mismatch: ' + JSON.stringify(sidecar));
  }
  log('sidecar OK:', sidecarPath);
  // WO-43.4 (INFO ONLY — never fails the run): probe /view the way the OLD
  // renderer path loaded it, to learn why it broke on Ali's PC. ComfyUI's
  // /view is hit (a) with browser-like file-origin headers and (b) plain,
  // and both statuses + content-types are logged.
  {
    const viewQs = `filename=${encodeURIComponent(saved.comfyFile.filename)}&subfolder=${encodeURIComponent(saved.comfyFile.subfolder || '')}&type=${encodeURIComponent(saved.comfyFile.type || 'output')}`;
    const probe = (headers) => new Promise((resolve) => {
      const http = require('http');
      const req = http.get({ hostname: '127.0.0.1', port: mgr.port, path: '/view?' + viewQs, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '' }));
      });
      req.on('error', (e) => resolve({ status: 'error', contentType: e.message }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ status: 'timeout', contentType: '' }); });
    });
    const withHeaders = await probe({ Origin: 'file://', 'Sec-Fetch-Site': 'cross-site' });
    const plain = await probe({});
    log(`[/view probe] file-origin headers -> status ${withHeaders.status}, content-type ${withHeaders.contentType}`);
    log(`[/view probe] plain Node request -> status ${plain.status}, content-type ${plain.contentType}`);
  }

  // 6. Assertions: exists, 512x512, variance > threshold.
  if (!fs.existsSync(full)) throw new Error('PNG file does not exist: ' + full);
  const { width, height, gray } = readPngGrayscale(full);
  log(`dimensions: ${width}x${height}`);
  if (width !== 512 || height !== 512) throw new Error(`expected 512x512, got ${width}x${height}`);
  const v = pixelVariance(gray);
  log(`pixel variance: ${v.toFixed(1)} (threshold ${VARIANCE_THRESHOLD})`);
  if (v <= VARIANCE_THRESHOLD) throw new Error('image looks black or solid-colour — variance too low');
  // Spatial correlation: real generations have structure (neighbouring pixels
  // correlate); pure noise does not. Threshold 0.3 (typical SDXL output: 0.8+).
  const c = spatialCorrelation(gray, width, height);
  log(`spatial correlation: ${c.toFixed(3)} (threshold ${CORRELATION_THRESHOLD})`);
  if (c <= CORRELATION_THRESHOLD) throw new Error('image looks like noise — spatial correlation too low');

  const outArtifact = path.join(process.cwd(), 'e2e-output.png');
  fs.copyFileSync(full, outArtifact);
  log('PASS — artifact:', outArtifact);
  await mgr.stop();
}

main().catch((e) => { console.error('[e2e] FAILED:', e.message); process.exit(1); });
