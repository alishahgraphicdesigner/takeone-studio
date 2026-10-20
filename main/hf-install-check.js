/* TakeOne Studio — HF install completeness check.
 * Pure fs logic, no Electron: decides whether an HF tool's files[] manifest is
 * fully present. A half-downloaded job (partials, wrong sizes, missing files)
 * MUST NOT read as installed.
 * Cost (WO-4): the DEFAULT check is stat-only (exact bytes) so toolInstalled()
 * stays cheap on every render — it never hashes multi-GB files. Pass
 * { deep: true } to ALSO verify SHA-256 content hashes (explicit Verify).
 * Used by main.js toolInstalled()'s hf branch (default mode).
 * Label: unit-tested here; live-Electron behaviour covered by CI smoke tests.
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function sha256File(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(fp);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Check an HF tool directory against its files[] manifest.
 * @param {string} dir - tool directory (toolDestDir(root, tool)/tool.id)
 * @param {Array<{path:string, bytes?:number, sha256?:string|null}>} files
 * @param {{deep?:boolean}} [opts] - deep:false (default) = stat-only, exact
 *   bytes; deep:true = also verify each file's SHA-256 against the manifest.
 * @returns {Promise<{complete:boolean, checked:number, bad:string|null}>}
 */
async function hfInstalledStatus(dir, files, opts) {
  const deep = !!(opts && opts.deep);
  if (!files || !files.length) return { complete: false, checked: 0, bad: 'no manifest' };
  let checked = 0;
  for (const f of files) {
    const fp = path.join(dir, f.path);
    let st;
    try { st = await fsp.stat(fp); }
    catch { return { complete: false, checked, bad: f.path + ': missing' }; }
    if (!st.isFile()) return { complete: false, checked, bad: f.path + ': not a file' };
    if (f.bytes && st.size !== f.bytes) {
      return { complete: false, checked, bad: `${f.path}: size ${st.size} != expected ${f.bytes}` };
    }
    if (deep && f.sha256) {
      const actual = await sha256File(fp);
      if (actual !== f.sha256) return { complete: false, checked, bad: f.path + ': checksum mismatch' };
    }
    checked++;
  }
  return { complete: true, checked, bad: null };
}

module.exports = { hfInstalledStatus };
