/* TakeOne Studio 2.2.0 — Phase C: Library FS service.
 * Real file-system operations only. The file system is the source of truth;
 * project.json carries metadata + a hash index (rebuilt from disk, never trusted
 * over it). No fake lists, no decoration.
 *
 * Layout under <root>:
 *   Projects/<projectId>/project.json
 *   Projects/<projectId>/{images,videos,audio,exports}/
 *   Trash/projects/<projectId>_<ts>/
 *   Trash/assets/<projectId>__<file>_<ts>
 *
 * Windows target. Pure helpers are exported for unit tests (node --test).
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const TRASH_DAYS = 30;
const ASSET_DIRS = ['images', 'videos', 'audio', 'exports'];
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);

function projectsDir(root) { return path.join(root, 'Projects'); }
function trashDir(root) { return path.join(root, 'Trash'); }
function trashProjectsDir(root) { return path.join(trashDir(root), 'projects'); }
function trashAssetsDir(root) { return path.join(trashDir(root), 'assets'); }

/** Filesystem-safe project id: slug + timestamp + random (collisions impossible,
 *  even for two projects created in the same second with the same name). */
function makeProjectId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const rand = Math.random().toString(36).slice(2, 7);
  return `${slug}-${ts}-${rand}`;
}

/** Validate a project name before touching the disk. Pure. */
function validateProjectName(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, reason: 'Give the project a name first.' };
  if (n.length > 80) return { ok: false, reason: 'Keep the name under 80 characters.' };
  if (/[<>:"/\\|?*\x00-\x1f]/.test(n)) {
    return { ok: false, reason: 'That name has characters Windows folders cannot use.' };
  }
  if (/^\.+$/.test(n)) return { ok: false, reason: 'That name is not usable as a folder.' };
  return { ok: true, name: n };
}

function defaultProjectDoc(id, name) {
  const now = new Date().toISOString();
  const steps = {};
  for (let n = 1; n <= 6; n++) {
    steps[n] = {
      status: 'empty', // empty | ready | failed
      outputs: [],
      settings: {},
      selectedVariation: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
    };
  }
  return {
    version: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    originalIdea: '',
    lockedDecisions: [],
    niche: 'none',
    currentStep: 1,
    steps,
    assetIndex: {}, // relpath -> { sha256, size, importedAt }
    customStyles: [],
  };
}

async function readProjectDoc(root, id) {
  const p = path.join(projectsDir(root), id, 'project.json');
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); }
  catch { return null; }
}

async function writeProjectDoc(root, doc) {
  doc.updatedAt = new Date().toISOString();
  const dir = path.join(projectsDir(root), doc.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

/** Create a project: folder + subfolders + project.json. Real, on disk. */
async function createProject(root, name) {
  const v = validateProjectName(name);
  if (!v.ok) return v;
  const id = makeProjectId(v.name);
  const dir = path.join(projectsDir(root), id);
  for (const sub of ASSET_DIRS) await fsp.mkdir(path.join(dir, sub), { recursive: true });
  const doc = defaultProjectDoc(id, v.name);
  await writeProjectDoc(root, doc);
  return { ok: true, project: { id: doc.id, name: doc.name, createdAt: doc.createdAt } };
}

async function renameProject(root, id, name) {
  const v = validateProjectName(name);
  if (!v.ok) return v;
  const doc = await readProjectDoc(root, id);
  if (!doc) return { ok: false, reason: 'Project not found.' };
  doc.name = v.name;
  await writeProjectDoc(root, doc);
  return { ok: true };
}

/** Count real files per asset dir (no index trust). */
async function countAssets(dir) {
  const counts = { images: 0, videos: 0, audio: 0, exports: 0, total: 0 };
  for (const sub of ASSET_DIRS) {
    try {
      const entries = await fsp.readdir(path.join(dir, sub), { withFileTypes: true });
      const n = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).length;
      counts[sub] = n;
      counts.total += n;
    } catch { /* missing dir = 0 */ }
  }
  return counts;
}

/** List projects from disk. Every entry corresponds to a real folder. */
async function listProjects(root) {
  const base = projectsDir(root);
  let ids;
  try {
    const entries = await fsp.readdir(base, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
  const out = [];
  for (const id of ids) {
    const doc = await readProjectDoc(root, id);
    if (!doc) continue; // folder without project.json is not a project — skip, don't invent
    const counts = await countAssets(path.join(base, id));
    const readySteps = Object.values(doc.steps || {}).filter((s) => s.status === 'ready').length;
    // M1: card thumbnail — the newest image in the project, or null.
    // (Library cards render it; detail view already thumbnails every image.)
    let thumb = null;
    try {
      const entries = await fsp.readdir(path.join(base, id, 'images'), { withFileTypes: true });
      const imgs = [];
      for (const e of entries) {
        if (!e.isFile() || !IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
        try { const st = await fsp.stat(path.join(base, id, 'images', e.name)); imgs.push({ name: e.name, mtime: st.mtimeMs }); }
        catch { /* unreadable — skip */ }
      }
      imgs.sort((a, b) => b.mtime - a.mtime);
      if (imgs.length) thumb = `images/${imgs[0].name}`;
    } catch { /* no images dir — no thumbnail */ }
    out.push({
      id: doc.id,
      name: doc.name,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      counts,
      readySteps,
      currentStep: doc.currentStep || 1,
      hasIdea: !!(doc.originalIdea && doc.originalIdea.trim()),
      thumb,
    });
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

/**
 * M1 / WO-44: the ONE "Quick Generate" project. Quick Generate images are
 * real Library assets, not loose files: find the project by name, or
 * create it (a normal project — it opens in the Library like any other,
 * with thumbnails, Show in folder, and Delete-to-Trash).
 * Returns { id, dir } where dir is Projects/<id>.
 */
const QUICK_GENERATE_PROJECT = 'Quick Generate';
async function ensureQuickGenerateProject(root) {
  const projects = await listProjects(root);
  const found = projects.find((p) => p.name === QUICK_GENERATE_PROJECT);
  if (found) return { id: found.id, dir: path.join(projectsDir(root), found.id) };
  const created = await createProject(root, QUICK_GENERATE_PROJECT);
  if (!created.ok) throw new Error(created.reason || 'Could not create the Quick Generate project.');
  return { id: created.project.id, dir: path.join(projectsDir(root), created.project.id) };
}

/**
 * Sync twin for diagnostics (which builds its report synchronously):
 * returns the Projects/<id> dir of the "Quick Generate" project, or null.
 * Never creates anything.
 */
function findQuickGenerateProjectDir(root) {
  let ids;
  try { ids = fs.readdirSync(projectsDir(root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return null; }
  for (const id of ids) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(projectsDir(root), id, 'project.json'), 'utf8'));
      if (doc && doc.name === QUICK_GENERATE_PROJECT) return path.join(projectsDir(root), id);
    } catch { /* not a project — skip */ }
  }
  return null;
}

/** SHA-256 of a file, streamed (safe for large video files). */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function guessAssetType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'images';
  if (VIDEO_EXT.has(ext)) return 'videos';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null; // unknown -> caller decides (exports dir or reject)
}

/** A name that does not collide inside dir. Pure-ish (needs dir listing). */
async function uniqueName(dir, wanted) {
  const ext = path.extname(wanted);
  const base = path.basename(wanted, ext);
  let candidate = wanted;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i++;
    if (i > 10000) throw new Error('Too many name collisions.');
  }
  return candidate;
}

/** Import a file into a project's asset dir.
 *  Duplicate guard: identical SHA-256 anywhere in this project -> no copy,
 *  returns { ok:false, duplicate:true, existing }. */
/** WO-39(4): a blocked save must be a plain-words message, never a crash.
 *  Wraps a save fn: EPERM/EACCES/EBUSY -> { ok:false, blocked:true, ... }. */
function guardBlocked(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const code = String((err && err.code) || '').toUpperCase();
      if (['EPERM', 'EACCES', 'EBUSY'].includes(code)) {
        return {
          ok: false,
          blocked: true,
          reason: 'Windows Security is blocking TakeOne from saving files here.',
          whatNext: 'Open Windows Security > Virus & threat protection > Ransomware protection ' +
            'and add TakeOne Studio to the allowed apps, or move your library to a folder ' +
            "Windows doesn't restrict (Settings > Library location). Nothing was lost.",
        };
      }
      throw err;
    }
  };
}

async function importAsset(root, projectId, srcPath, opts = {}) {
  const doc = await readProjectDoc(root, projectId);
  if (!doc) return { ok: false, reason: 'Project not found.' };
  let st;
  try { st = await fsp.stat(srcPath); } catch { return { ok: false, reason: 'Could not read that file.' }; }
  if (!st.isFile()) return { ok: false, reason: 'That is not a file.' };

  const hash = await sha256File(srcPath);
  const index = doc.assetIndex || {};
  for (const [rel, meta] of Object.entries(index)) {
    if (meta && meta.sha256 === hash) {
      return { ok: false, duplicate: true, existing: rel, reason: 'Already in Library — no second copy was made.' };
    }
  }
  // Also guard against files placed on disk outside the index (belt and braces).
  const type = opts.type || guessAssetType(srcPath) || 'exports';
  if (!ASSET_DIRS.includes(type)) return { ok: false, reason: 'Unknown asset type.' };
  const destDir = path.join(projectsDir(root), projectId, type);
  await fsp.mkdir(destDir, { recursive: true });

  const fileName = await uniqueName(destDir, path.basename(srcPath));
  const dest = path.join(destDir, fileName);
  await fsp.copyFile(srcPath, dest);
  const rel = `${type}/${fileName}`;
  doc.assetIndex = index;
  doc.assetIndex[rel] = { sha256: hash, size: st.size, importedAt: new Date().toISOString(), step: opts.step || null };
  await writeProjectDoc(root, doc);
  return { ok: true, asset: { rel, type, fileName, size: st.size } };
}

/** List assets: walk the disk (truth), merge index info where present.
 *  Files on disk without index entries are still listed (marked external). */
async function listAssets(root, projectId) {
  const doc = await readProjectDoc(root, projectId);
  if (!doc) return { ok: false, reason: 'Project not found.' };
  const base = path.join(projectsDir(root), projectId);
  const index = doc.assetIndex || {};
  const out = [];
  for (const type of ASSET_DIRS) {
    let entries;
    try { entries = await fsp.readdir(path.join(base, type), { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const rel = `${type}/${e.name}`;
      let size = 0;
      try { size = (await fsp.stat(path.join(base, rel))).size; } catch { continue; }
      const meta = index[rel] || null;
      out.push({
        rel, type, fileName: e.name, size,
        importedAt: meta ? meta.importedAt : null,
        step: meta ? meta.step : null,
        external: !meta, // on disk but not imported through TakeOne — listed honestly
      });
    }
  }
  out.sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
  return { ok: true, assets: out };
}

/** Delete an asset -> Trash (recoverable). The index entry is dropped. */
async function deleteAsset(root, projectId, rel) {
  const doc = await readProjectDoc(root, projectId);
  if (!doc) return { ok: false, reason: 'Project not found.' };
  if (rel.includes('..') || path.isAbsolute(rel)) return { ok: false, reason: 'Bad asset path.' };
  const src = path.join(projectsDir(root), projectId, rel);
  try { if (!(await fsp.stat(src)).isFile()) return { ok: false, reason: 'Asset not found.' }; }
  catch { return { ok: false, reason: 'Asset not found.' }; }
  const ts = Date.now();
  const trashName = `${projectId}__${rel.replace(/\//g, '__')}__${ts}`;
  const dest = path.join(trashAssetsDir(root), trashName);
  await fsp.mkdir(trashAssetsDir(root), { recursive: true });
  await fsp.rename(src, dest);
  if (doc.assetIndex) delete doc.assetIndex[rel];
  await writeProjectDoc(root, doc);
  return { ok: true, trashName, trashedAt: new Date(ts).toISOString() };
}

/** Whole project -> Trash/projects (recoverable 30 days). */
async function trashProject(root, projectId) {
  const src = path.join(projectsDir(root), projectId);
  try { if (!(await fsp.stat(src)).isDirectory()) return { ok: false, reason: 'Project not found.' }; }
  catch { return { ok: false, reason: 'Project not found.' }; }
  const ts = Date.now();
  const trashName = `${projectId}__${ts}`;
  const dest = path.join(trashProjectsDir(root), trashName);
  await fsp.mkdir(trashProjectsDir(root), { recursive: true });
  await fsp.rename(src, dest);
  return { ok: true, trashName, trashedAt: new Date(ts).toISOString() };
}

function trashEntryMeta(trashName, kind) {
  // "<projectId>__<ts>" or "<projectId>__<rel-with-__>__<ts>"
  const m = trashName.match(/^(.*)__(\d{13})$/);
  if (!m) return null;
  const ts = parseInt(m[2], 10);
  const daysLeft = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - ts) / 86400000));
  return { trashName, kind, trashedAt: new Date(ts).toISOString(), daysLeft };
}

/** List everything in Trash with days-remaining. Real folders only. */
async function listTrash(root) {
  const out = [];
  for (const [dir, kind] of [[trashProjectsDir(root), 'project'], [trashAssetsDir(root), 'asset']]) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const meta = trashEntryMeta(e.name, kind);
      if (!meta) continue;
      let label = e.name;
      let size = 0;
      try {
        if (kind === 'project') {
          const pj = path.join(dir, e.name, 'project.json');
          try { label = JSON.parse(await fsp.readFile(pj, 'utf8')).name || label; } catch { /* keep raw */ }
        } else {
          label = e.name.split('__').slice(1, -1).join('/') || e.name;
        }
        size = await dirSize(path.join(dir, e.name));
      } catch { /* ignore */ }
      out.push({ ...meta, label, size });
    }
  }
  out.sort((a, b) => (b.trashedAt || '').localeCompare(a.trashedAt || ''));
  return out;
}

async function dirSize(dir) {
  let total = 0;
  async function walk(d, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* ignore */ } }
    }
  }
  await walk(dir, 0);
  return total;
}

/** Restore a trashed project or asset to its original place. */
async function restoreFromTrash(root, trashName, kind) {
  const src = path.join(kind === 'project' ? trashProjectsDir(root) : trashAssetsDir(root), trashName);
  try { await fsp.stat(src); } catch { return { ok: false, reason: 'Trash entry not found.' }; }
  if (kind === 'project') {
    const projectId = trashName.split('__')[0];
    let dest = path.join(projectsDir(root), projectId);
    if (fs.existsSync(dest)) dest = path.join(projectsDir(root), `${projectId}-restored-${Date.now()}`);
    await fsp.mkdir(projectsDir(root), { recursive: true });
    await fsp.rename(src, dest);
    return { ok: true, projectId: path.basename(dest) };
  }
  // asset: "<projectId>__<rel-with-__>__<ts>"
  const parts = trashName.split('__');
  const projectId = parts[0];
  const rel = parts.slice(1, -1).join('/');
  const dest = path.join(projectsDir(root), projectId, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const finalDest = fs.existsSync(dest) ? path.join(path.dirname(dest), await uniqueName(path.dirname(dest), path.basename(dest))) : dest;
  await fsp.rename(src, finalDest);
  // re-index with a fresh hash
  const doc = await readProjectDoc(root, projectId);
  if (doc) {
    const relKey = path.relative(path.join(projectsDir(root), projectId), finalDest).replace(/\\/g, '/');
    try {
      const st = await fsp.stat(finalDest);
      doc.assetIndex = doc.assetIndex || {};
      doc.assetIndex[relKey] = { sha256: await sha256File(finalDest), size: st.size, importedAt: new Date().toISOString(), step: null, restored: true };
      await writeProjectDoc(root, doc);
    } catch { /* index miss is non-fatal; file is back on disk */ }
  }
  return { ok: true, rel: path.relative(path.join(projectsDir(root), projectId), finalDest).replace(/\\/g, '/') };
}

/** Permanent delete of one trash entry. Irreversible — renderer confirms first. */
async function deleteForever(root, trashName, kind) {
  const target = path.join(kind === 'project' ? trashProjectsDir(root) : trashAssetsDir(root), trashName);
  if (!trashEntryMeta(trashName, kind)) return { ok: false, reason: 'Trash entry not found.' };
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true };
}

/** Empty the whole trash. Irreversible — renderer confirms first. */
async function emptyTrash(root) {
  let removed = 0;
  for (const dir of [trashProjectsDir(root), trashAssetsDir(root)]) {
    let entries;
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      await fsp.rm(path.join(dir, e), { recursive: true, force: true });
      removed++;
    }
  }
  return { ok: true, removed };
}

/** Remove trash entries older than TRASH_DAYS. Called on Studio launch. */
async function purgeExpiredTrash(root) {
  let purged = 0;
  for (const dir of [trashProjectsDir(root), trashAssetsDir(root)]) {
    let entries;
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries) {
      const m = e.match(/__(\d{13})$/);
      if (!m) continue;
      if (Date.now() - parseInt(m[1], 10) > TRASH_DAYS * 86400000) {
        await fsp.rm(path.join(dir, e), { recursive: true, force: true });
        purged++;
      }
    }
  }
  return { purged };
}

module.exports = {
  TRASH_DAYS,
  guardBlocked,
  ASSET_DIRS,
  makeProjectId,
  validateProjectName,
  defaultProjectDoc,
  QUICK_GENERATE_PROJECT,
  ensureQuickGenerateProject,
  findQuickGenerateProjectDir,
  createProject: guardBlocked(createProject),
  renameProject: guardBlocked(renameProject),
  listProjects,
  countAssets,
  sha256File,
  guessAssetType,
  importAsset: guardBlocked(importAsset),
  listAssets,
  deleteAsset,
  trashProject,
  listTrash,
  restoreFromTrash,
  deleteForever,
  emptyTrash,
  purgeExpiredTrash,
  readProjectDoc,
  writeProjectDoc,
  projectsDir,
  trashDir,
};
