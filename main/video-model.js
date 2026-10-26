/**
 * M2: Video Studio model readiness — the merged Wan 2.2 file + the VRAM
 * check in plain words. Pure where possible; only ensureMergedVideoModel
 * touches disk/processes (it shells out to a plain stdlib Python —
 * merge-shards.py needs no torch, numpy, or safetensors library — to
 * merge the verified shards).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

const VIDEO_TOOL_ID = 'video-studio';
const MERGED_FILE = 'diffusion_pytorch_model.safetensors';

/** Where the HF snapshot for video-studio lives: Models/video/video-studio. */
function videoToolDir(root) {
  return path.join(root, 'Models', 'video', VIDEO_TOOL_ID);
}

/**
 * The three file NAMES ComfyUI's loaders take (relative, as its
 * recursive extra-path search lists them — forward slashes work on
 * Windows). The diffusion entry is the MERGED file, not a shard:
 * UNETLoader cannot load sharded weights (see merge-shards.py).
 */
function videoLoaderNames() {
  return {
    unet: `${VIDEO_TOOL_ID}/${MERGED_FILE}`,
    clip: `${VIDEO_TOOL_ID}/models_t5_umt5-xxl-enc-bf16.pth`,
    vae: `${VIDEO_TOOL_ID}/Wan2.2_VAE.pth`,
  };
}

/** Is the merged file present and recorded? (Light: existence + sidecar.) */
async function mergedReady(root) {
  try {
    const dir = videoToolDir(root);
    const st = await fsp.stat(path.join(dir, MERGED_FILE));
    if (!st.isFile() || st.size <= 0) return false;
    const sidecar = JSON.parse(await fsp.readFile(path.join(dir, 'merged.json'), 'utf8'));
    return typeof sidecar.tensors === 'number' && sidecar.tensors > 0;
  } catch {
    return false;
  }
}

/**
 * Ensure the merged file exists, merging the verified shards if needed.
 * Returns { ok:true, already } or { ok:false, error } in plain words.
 * pythonExe is any stdlib Python (merge-shards.py needs no libraries).
 */
function ensureMergedVideoModel(root, pythonExe) {
  return new Promise((resolve) => {
    const dir = videoToolDir(root);
    const script = path.join(__dirname, 'merge-shards.py');
    let out = '', err = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(pythonExe, [script, dir], { windowsHide: true });
    } catch (e) {
      done({ ok: false, error: 'Could not prepare the video model: ' + e.message });
      return;
    }
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', () => done({ ok: false, error: 'Could not prepare the video model (the engine Python did not start).' }));
    child.on('close', (code) => {
      if (code === 0) {
        done({ ok: true, already: /already merged/.test(out) });
      } else {
        const reason = (err.trim().split('\n').pop() || 'merge failed').replace(/^merge-shards: /, '');
        done({ ok: false, error: `Could not prepare the video model: ${reason}` });
      }
    });
    setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, error: 'Preparing the video model took too long (over 60 minutes) — disk or memory may be full.' });
    }, 60 * 60 * 1000).unref();
  });
}

/**
 * VRAM check in plain words — a REPORT, never a block (Ali decides).
 * video-studio targets ~16 GB (catalog vramMB); video-pro lists 24 GB
 * for full quality. The honest conflict is stated, not smoothed over:
 * 16 GB runs with offloading and short clips, unproven until M2.6.
 */
function videoVramCheck(vramMB) {
  const gb = (m) => (m / 1024).toFixed(1);
  if (vramMB === null || vramMB === undefined) {
    return {
      level: 'unknown',
      text: 'Video memory not measured yet — try a short 480p clip first and watch whether it finishes.',
    };
  }
  const note = ' Note: Video Pro lists 24 GB for full quality; 16 GB runs with offloading — unproven until the first GPU render.';
  if (vramMB >= 16384) {
    return {
      level: 'ok',
      text: `Your PC reports ${gb(vramMB)} GB — Video Studio targets about 16 GB. Short 480p clips are the safe first try; 720p may be slow.${note}`,
    };
  }
  if (vramMB >= 13107) {
    return {
      level: 'warn',
      text: `Your PC reports ${gb(vramMB)} GB — close to the ~16 GB target. Short 480p clips first; 720p may be slow or run out of memory.${note}`,
    };
  }
  return {
    level: 'warn',
    text: `Your PC reports ${gb(vramMB)} GB — below Video Studio's ~16 GB target. A clip may run out of memory or crawl; try a short 480p clip only.${note}`,
  };
}

module.exports = {
  VIDEO_TOOL_ID, MERGED_FILE, videoToolDir, videoLoaderNames,
  mergedReady, ensureMergedVideoModel, videoVramCheck,
};
