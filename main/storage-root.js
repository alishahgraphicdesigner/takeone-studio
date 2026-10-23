/**
 * WO-39: stay out of Windows protected folders.
 *
 * Controlled Folder Access blocks apps from writing to Documents, Pictures,
 * Videos, Music and Desktop. TakeOne's old default root was Documents\TakeOne
 * (and Ali's PC used Videos\TakeOne Studio) — that is why the venv failed.
 *
 * New rule: the default root is %LOCALAPPDATA%\TakeOne. If an existing root
 * sits inside a protected folder, new data goes to LOCALAPPDATA; the old
 * files are never touched, moved or deleted.
 *
 * Pure functions here are unit-testable (getPath is injected).
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

/** Default root: %LOCALAPPDATA%\TakeOne (never a protected folder).
 *  NOTE: Electron's app.getPath has NO 'localAppData' name — use the
 *  LOCALAPPDATA env var directly (always set on Windows). */
function defaultRoot(getPath) {
  const lad = process.env.LOCALAPPDATA
    || (getPath && (() => { try { return getPath('appData').replace(/Roaming$/i, 'Local'); } catch { return null; } })());
  if (lad) return path.win32.join(lad, 'TakeOne');
  // Non-Windows / no LOCALAPPDATA: fall back to the user's home.
  return path.join(os.homedir(), 'TakeOne');
}

/** The folders Controlled Folder Access protects. */
function protectedFolders(getPath) {
  const names = ['documents', 'pictures', 'videos', 'music', 'desktop'];
  const w32 = path.win32;
  const out = [];
  for (const n of names) {
    try {
      const p = getPath && getPath(n);
      if (p) out.push(w32.resolve(p));
    } catch { /* getPath may throw for unknown names */ }
  }
  return out;
}

/** True when p is inside (or is) one of the protected folders. */
function isProtectedFolder(p, getPath) {
  if (!p) return false;
  const w32 = path.win32;
  const rp = w32.resolve(p);
  return protectedFolders(getPath).some((prot) =>
    rp === prot || rp.toLowerCase().startsWith(prot.toLowerCase() + w32.sep));
}

/**
 * Test-write a small temp file in dir. Returns { ok:true } or
 * { ok:false, code } where code is EPERM/EACCES/EBUSY/ENOENT/...
 */
async function probeWritable(dir, fspImpl) {
  const w = (fspImpl || fsp);
  const probe = path.join(dir, '.takeone-write-test-' + process.pid);
  try {
    await w.mkdir(dir, { recursive: true });
    await w.writeFile(probe, 'ok');
    await w.rm(probe, { force: true });
    return { ok: true };
  } catch (err) {
    try { await w.rm(probe, { force: true }); } catch { /* ignore */ }
    return { ok: false, code: (err && err.code) || 'UNKNOWN' };
  }
}

const BLOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
function isBlockedBySecurity(code) {
  return BLOCKED_CODES.has(String(code || '').toUpperCase());
}

/** Plain-words message when Windows Security blocks a save. */
function blockedMessage(folder) {
  return {
    title: 'Windows Security is blocking TakeOne',
    body: `Windows Security is blocking TakeOne from saving files in ${folder}. ` +
      'What to do: open Windows Security > Virus & threat protection > ' +
      'Ransomware protection > Manage ransomware protection, and either turn off ' +
      '"Controlled folder access" or add TakeOne Studio to the allowed apps. ' +
      "TakeOne keeps its files in a folder Windows doesn't restrict, so this " +
      'should not happen there.',
  };
}

module.exports = {
  defaultRoot, protectedFolders, isProtectedFolder,
  probeWritable, isBlockedBySecurity, blockedMessage,
};
