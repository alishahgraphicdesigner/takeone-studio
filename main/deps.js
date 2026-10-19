/* TakeOne Studio 2.2.0 — Phase B: in-app dependency installer.
 * EVERY pip / manual-download flow becomes a one-click in-app operation with
 * progress, or a silent auto-install with consent at pack selection.
 * No terminal windows, no commands for the user to type — ever.
 *
 * Uses the bundled Python from Phase A (<root>/.python/python.exe).
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function pythonExe(root) {
  const p = process.platform === 'win32'
    ? path.join(root, '.python', 'python.exe')
    : path.join(root, '.python', 'bin', 'python3');
  return p;
}

/** Run the bundled python with args, streaming progress lines to onProgress.
 *  Resolves { ok, code }. Never opens a window. */
function runPython(root, args, onProgress, timeoutMs = 30 * 60 * 1000, onCancel) {
  return new Promise((resolve) => {
    const exe = pythonExe(root);
    if (!fs.existsSync(exe)) return resolve({ ok: false, code: -1, error: 'Python is not ready yet.' });
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let finished = false;
    const done = (r) => { if (!finished) { finished = true; resolve(r); } };
    let maxFrac = 0; // H5: monotonic progress — never go backwards
    const prog = (f) => {
      if (typeof f === 'number') { maxFrac = Math.max(maxFrac, Math.min(1, f)); f = maxFrac; }
      if (onProgress) onProgress(f);
    };
    const killTree = () => {
      try {
        if (process.platform === 'win32') {
          // Kill entire process tree — child.kill() orphans grandchildren.
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch { try { child.kill(); } catch { /* already gone */ } }
    };
    if (onCancel) onCancel(() => { killTree(); done({ ok: false, code: -4, error: 'Cancelled.' }); });
    const timer = setTimeout(() => { killTree(); done({ ok: false, code: -2, error: 'Timed out.' }); }, timeoutMs);
    child.stdout.on('data', (d) => { prog(parsePipProgress(String(d))); });
    child.stderr.on('data', (d) => { prog(parsePipProgress(String(d))); });
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, code: -3, error: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, code }); });
  });
}

/** Turn pip's chatter into a 0..1 fraction (best effort; null when unknown). Pure. */
function parsePipProgress(chunk) {
  const m = chunk.match(/(\d+)%/);
  if (m) return Math.min(1, parseInt(m[1], 10) / 100);
  if (/Successfully installed/i.test(chunk)) return 1;
  return null;
}

async function pipWorks(root) {
  const r = await runPython(root, ['-m', 'pip', '--version'], null, 30000);
  return r.ok;
}

async function ensurePip(root, onProgress) {
  if (await pipWorks(root)) return { ok: true, already: true };
  if (onProgress) onProgress({ phase: 'preparing' });
  const r = await runPython(root, ['-m', 'ensurepip', '--upgrade'], (f) => {
    if (onProgress) onProgress({ phase: 'preparing', fraction: f });
  }, 120000, onCancel);
  return r;
}

/** One-click pip install of a package. Progress → onProgress. */
async function pipInstall(root, pkg, onProgress, onCancel) {
  const prep = await ensurePip(root, onProgress);
  if (!prep.ok) return { ok: false, error: 'Could not prepare the installer.' };
  if (onProgress) onProgress({ phase: 'installing', fraction: 0 });
  const r = await runPython(root,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', pkg],
    (f) => { if (onProgress) onProgress({ phase: 'installing', fraction: f }); },
    30 * 60 * 1000, onCancel);
  if (!r.ok) return { ok: false, error: 'Installation did not finish. Check your connection and try again.' };
  if (onProgress) onProgress({ phase: 'done', fraction: 1 });
  return { ok: true };
}

/** Fetch a Hugging Face repo into Models/<category>/<repoDir> via huggingface_hub.
 *  Auto-installs huggingface_hub first (shown honestly as a dependency). */
async function hfSnapshot(root, repo, destDir, onProgress, onCancel) {
  const prep = await ensurePip(root, onProgress, onCancel);
  if (!prep.ok) return { ok: false, error: 'Could not prepare the installer.' };
  // Is huggingface_hub already there?
  const hasHub = await runPython(root, ['-c', 'import huggingface_hub'], null, 30000, onCancel);
  if (!hasHub.ok) {
    if (onProgress) onProgress({ phase: 'dependency', fraction: 0, note: 'helper' });
    const inst = await runPython(root,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'huggingface_hub'],
      (f) => { if (onProgress) onProgress({ phase: 'dependency', fraction: f, note: 'helper' }); },
      30 * 60 * 1000, onCancel);
    if (!inst.ok) return { ok: false, error: 'Could not fetch the helper needed for this download.' };
  }
  await fsp.mkdir(destDir, { recursive: true });
  if (onProgress) onProgress({ phase: 'downloading', fraction: 0 });
  const code = `
import sys
from huggingface_hub import snapshot_download
d = snapshot_download(repo_id=${JSON.stringify(repo)}, local_dir=${JSON.stringify(destDir)})
print("SNAPSHOT_OK " + d)
`;
  const r = await runPython(root, ['-c', code], (f) => {
    if (onProgress) onProgress({ phase: 'downloading', fraction: f });
  }, 6 * 60 * 60 * 1000, onCancel);
  if (!r.ok) return { ok: false, error: 'Download did not finish. Check your connection and try again.' };
  if (onProgress) onProgress({ phase: 'done', fraction: 1 });
  return { ok: true, path: destDir };
}

/** What the UI shows for a tool's install path — honest, no jargon. Pure. */
function installPlan(tool) {
  const deps = [];
  if (tool.installType === 'hf') deps.push({ name: 'huggingface_hub', kind: 'helper', note: 'Fetches model files. Installed once, with your OK.' });
  const steps = {
    file: ['Download the file', 'Check it is complete and untampered', 'Move it into your Library'],
    hf: ['Get the fetch helper (first time only)', 'Download the model files', 'Move them into your Library'],
    pip: ['Set up the package privately inside TakeOne', 'Verify it works'],
    external: ['Open the official download page', 'Install it there — it runs alongside TakeOne'],
    adopt: ['Open the author\u2019s folder', 'You pick the folder — TakeOne copies and checks the files itself'],
  };
  return { steps: steps[tool.installType] || [], dependencies: deps };
}

module.exports = { pythonExe, runPython, parsePipProgress, ensurePip, pipInstall, hfSnapshot, installPlan };
