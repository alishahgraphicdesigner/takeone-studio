#!/usr/bin/env node
/* WO-22 driver: end-to-end "Studio se asli output file" on CI (Windows, CPU).
 *
 * Uses the SAME code the app will run:
 *   - main/engine.js  -> installEngine()  (WO-21; module does not exist yet —
 *     this driver fails fast with MODULE_NOT_FOUND until the implementation lands)
 *   - main/comfy-workflows.js -> sdxlTxt2Img() (real workflow builder)
 *   - main/comfy.js   -> ComfyManager (real ComfyUI process control)
 *
 * Steps: install engine -> fetch SDXL-Lightning checkpoint (sha256-verified) ->
 * ComfyUI --cpu -> queue 1 prompt (512x512, 4 steps) -> wait for PNG ->
 * assert: file exists, dimensions 512x512, pixel variance > threshold
 * (a black or solid-colour image fails).
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

function log(...a) { console.log('[e2e]', ...a); }

function sha256File(p) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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

async function main() {
  log('root:', ROOT);
  // 1. Engine install — the same function the app will call (WO-21).
  const engine = require('../main/engine.js');
  log('installing engine (same code the app runs)...');
  const inst = await engine.installEngine(ROOT, {
    onEvent: (e) => log('engine:', e.phase, e.detail || ''),
  });
  if (!inst.ok) throw new Error(`engine install failed: ${inst.why} — ${inst.whatNext}`);

  // 2. Checkpoint — manifest data (URL + sha256 from main/catalog.js), verified download.
  // (In the app this goes through downloads.addManifestJob; in CI we use a plain
  // verified fetch — same bytes, same hash gate.)
  const https = require('https');
  const crypto = require('crypto');
  const ckptDir = path.join(engine.engineRoot(ROOT), 'ComfyUI', 'models', 'checkpoints');
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

  // 3. Boot ComfyUI with the engine venv python.
  // (WO-21 comfy.js patch makes start() pass --cpu + --extra-model-paths-config;
  // until then this driver documents the intended call.)
  const { ComfyManager } = require('../main/comfy.js');
  const { sdxlTxt2Img } = require('../main/comfy-workflows.js');
  const mgr = new ComfyManager({
    root: ROOT,
    pythonExe: engine.enginePython(ROOT),
    comfyDir: path.join(engine.engineRoot(ROOT), 'ComfyUI'),
  });
  const st = await mgr.start();
  if (!st.ok) throw new Error('ComfyUI failed to start: ' + st.error);

  // 4. Queue the REAL workflow: 1 prompt, 512x512, 4 steps.
  const wf = sdxlTxt2Img({
    checkpoint: 'sdxl_lightning_4step.safetensors',
    positive: PROMPT, negative: '',
    width: 512, height: 512, steps: 4, cfg: 1,
  });
  const q = await mgr.queuePrompt(wf);
  if (!q.ok) throw new Error('queuePrompt failed: ' + (q.error || 'unknown'));
  log('queued prompt', q.promptId || q.id);

  // 5. Wait for the PNG (poll history, timeout 20 min on CPU).
  const deadline = Date.now() + 20 * 60 * 1000;
  let pngPath = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const h = await mgr.getHistory(q.promptId || q.id);
    const outs = JSON.stringify(h);
    const m = outs.match(/"filename"\s*:\s*"([^"]+\.png)"/);
    if (m) { pngPath = m[1]; break; }
    log('waiting for output...');
  }
  if (!pngPath) throw new Error('timed out waiting for the generated PNG (20 min on CPU)');
  const full = path.isAbsolute(pngPath) ? pngPath : path.join(mgr.comfyDir, 'output', pngPath);
  log('output:', full);

  // 6. Assertions: exists, 512x512, variance > threshold.
  if (!fs.existsSync(full)) throw new Error('PNG file does not exist: ' + full);
  const { width, height, gray } = readPngGrayscale(full);
  log(`dimensions: ${width}x${height}`);
  if (width !== 512 || height !== 512) throw new Error(`expected 512x512, got ${width}x${height}`);
  const v = pixelVariance(gray);
  log(`pixel variance: ${v.toFixed(1)} (threshold ${VARIANCE_THRESHOLD})`);
  if (v <= VARIANCE_THRESHOLD) throw new Error('image looks black or solid-colour — variance too low');

  const outArtifact = path.join(process.cwd(), 'e2e-output.png');
  fs.copyFileSync(full, outArtifact);
  log('PASS — artifact:', outArtifact);
  await mgr.stop();
}

main().catch((e) => { console.error('[e2e] FAILED:', e.message); process.exit(1); });
