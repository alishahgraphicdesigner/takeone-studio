/* TakeOne Studio 2.2.0 — Phase C unit tests: Library FS service.
 * Every op hits a real temp directory. The torture test imports 100 files and
 * asserts zero orphans and zero duplicates. */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TRASH_DAYS,
  validateProjectName,
  makeProjectId,
  createProject,
  renameProject,
  listProjects,
  sha256File,
  guessAssetType,
  importAsset,
  listAssets,
  deleteAsset,
  trashProject,
  listTrash,
  restoreFromTrash,
  deleteForever,
  emptyTrash,
  purgeExpiredTrash,
  readProjectDoc,
} = require('../main/library.js');

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 't1lib-'));
});

function makeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('validateProjectName', () => {
  it('rejects empty names', () => assert.equal(validateProjectName('  ').ok, false));
  it('rejects path separators', () => assert.equal(validateProjectName('a/b').ok, false));
  it('rejects Windows-forbidden chars', () => assert.equal(validateProjectName('a:b').ok, false));
  it('rejects >80 chars', () => assert.equal(validateProjectName('x'.repeat(81)).ok, false));
  it('accepts a normal name', () => {
    const v = validateProjectName('Echoes — Pompeii Ep1');
    assert.equal(v.ok, true);
    assert.equal(v.name, 'Echoes — Pompeii Ep1');
  });
  it('makeProjectId is unique across calls', () => {
    assert.notEqual(makeProjectId('Test'), makeProjectId('Test'));
  });
});

describe('projects: create/list/rename', () => {
  it('creates a project with folders + project.json on disk', async () => {
    const r = await createProject(root, 'Alpha Film');
    assert.equal(r.ok, true);
    const dir = path.join(root, 'Projects', r.project.id);
    for (const sub of ['images', 'videos', 'audio', 'exports']) {
      assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), sub + ' exists');
    }
    assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  });
  it('lists the project with zero counts', async () => {
    const list = await listProjects(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Alpha Film');
    assert.equal(list[0].counts.total, 0);
  });
  it('renames on disk (project.json, not the folder id)', async () => {
    const [p] = await listProjects(root);
    const r = await renameProject(root, p.id, 'Alpha Film v2');
    assert.equal(r.ok, true);
    const doc = await readProjectDoc(root, p.id);
    assert.equal(doc.name, 'Alpha Film v2');
  });
  it('refuses to create with a bad name and touches nothing', async () => {
    const beforeList = await listProjects(root);
    const r = await createProject(root, 'bad/name');
    assert.equal(r.ok, false);
    assert.deepEqual((await listProjects(root)).map((p) => p.id), beforeList.map((p) => p.id));
  });
});

describe('assets: import/list/duplicate-guard/delete', () => {
  let pid;
  before(async () => {
    const r = await createProject(root, 'Asset Test');
    pid = r.project.id;
  });
  it('imports a file into the right type folder', async () => {
    const src = makeFile(root, 'shot1.png', 'fake-png-bytes-1');
    const r = await importAsset(root, pid, src);
    assert.equal(r.ok, true);
    assert.equal(r.asset.type, 'images');
    assert.ok(fs.existsSync(path.join(root, 'Projects', pid, 'images', 'shot1.png')));
  });
  it('blocks an identical file as a duplicate (no second copy)', async () => {
    const src = makeFile(root, 'shot1-copy.png', 'fake-png-bytes-1'); // same bytes, diff name
    const r = await importAsset(root, pid, src);
    assert.equal(r.ok, false);
    assert.equal(r.duplicate, true);
    assert.match(r.reason, /Already in Library/);
    const { assets } = await listAssets(root, pid);
    assert.equal(assets.filter((a) => a.fileName.startsWith('shot1')).length, 1);
  });
  it('renames on name collision with different content', async () => {
    const src = makeFile(root, 'shot1.png', 'different-bytes-entirely');
    const r = await importAsset(root, pid, src);
    assert.equal(r.ok, true);
    assert.match(r.asset.fileName, /shot1 \(2\)\.png/);
  });
  it('lists every file on disk (no orphans either way)', async () => {
    // Drop a file directly on disk, bypassing import: it must still be listed.
    fs.writeFileSync(path.join(root, 'Projects', pid, 'audio', 'stray.wav'), 'stray');
    const { assets } = await listAssets(root, pid);
    const stray = assets.find((a) => a.fileName === 'stray.wav');
    assert.ok(stray, 'stray file is listed');
    assert.equal(stray.external, true);
    // And every listed asset exists on disk.
    for (const a of assets) {
      assert.ok(fs.existsSync(path.join(root, 'Projects', pid, a.rel)), a.rel + ' exists');
    }
  });
  it('delete moves the asset to Trash (recoverable)', async () => {
    const { assets } = await listAssets(root, pid);
    const target = assets.find((a) => a.fileName === 'shot1.png');
    const r = await deleteAsset(root, pid, target.rel);
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.join(root, 'Projects', pid, target.rel)));
    const trash = await listTrash(root);
    assert.ok(trash.some((t) => t.kind === 'asset'), 'asset is in trash');
  });
  it('restore brings the asset back', async () => {
    const trash = await listTrash(root);
    const entry = trash.find((t) => t.kind === 'asset');
    const r = await restoreFromTrash(root, entry.trashName, 'asset');
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(path.join(root, 'Projects', pid, r.rel)));
  });
});

describe('projects: trash/restore/delete-forever', () => {
  let pid;
  before(async () => {
    const r = await createProject(root, 'Doomed Project');
    pid = r.project.id;
  });
  it('trashProject moves the whole folder to Trash', async () => {
    const r = await trashProject(root, pid);
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.join(root, 'Projects', pid)));
    assert.deepEqual((await listProjects(root)).map((p) => p.id).includes(pid), false);
    const trash = await listTrash(root);
    const entry = trash.find((t) => t.kind === 'project');
    assert.ok(entry);
    assert.equal(entry.label, 'Doomed Project');
    assert.ok(entry.daysLeft <= TRASH_DAYS && entry.daysLeft > TRASH_DAYS - 2);
  });
  it('restore brings the project back with its data', async () => {
    const trash = await listTrash(root);
    const entry = trash.find((t) => t.kind === 'project');
    const r = await restoreFromTrash(root, entry.trashName, 'project');
    assert.equal(r.ok, true);
    const doc = await readProjectDoc(root, r.projectId);
    assert.equal(doc.name, 'Doomed Project');
  });
  it('deleteForever removes a trashed project permanently', async () => {
    await trashProject(root, pid);
    const trash = await listTrash(root);
    const entry = trash.find((t) => t.kind === 'project');
    const r = await deleteForever(root, entry.trashName, 'project');
    assert.equal(r.ok, true);
    assert.deepEqual((await listTrash(root)).filter((t) => t.kind === 'project'), []);
  });
});

describe('trash expiry', () => {
  it('purgeExpiredTrash removes only entries older than 30 days', async () => {
    const oldName = `oldproj__${Date.now() - 31 * 86400000}`;
    const newName = `newproj__${Date.now()}`;
    const td = path.join(root, 'Trash', 'projects');
    fs.mkdirSync(td, { recursive: true });
    fs.mkdirSync(path.join(td, oldName));
    fs.mkdirSync(path.join(td, newName));
    const r = await purgeExpiredTrash(root);
    assert.equal(r.purged, 1);
    assert.ok(!fs.existsSync(path.join(td, oldName)));
    assert.ok(fs.existsSync(path.join(td, newName)));
    await emptyTrash(root);
    assert.deepEqual(await listTrash(root), []);
  });
});

describe('100-file torture test: zero orphans, zero dupes', () => {
  it('imports 100 unique files; every file listed; every listing on disk', async () => {
    const r = await createProject(root, 'Torture');
    const pid = r.project.id;
    const srcDir = path.join(root, 'src100');
    fs.mkdirSync(srcDir, { recursive: true });
    const exts = ['png', 'mp4', 'wav'];
    for (let i = 0; i < 100; i++) {
      const f = makeFile(srcDir, `file-${i}.${exts[i % 3]}`, `content-${i}-${'x'.repeat(i % 17)}`);
      const ir = await importAsset(root, pid, f);
      assert.equal(ir.ok, true, `import ${i} ok`);
    }
    // Re-import all 100: every single one must be caught as duplicate.
    let dupes = 0;
    for (let i = 0; i < 100; i++) {
      const f = path.join(srcDir, `file-${i}.${exts[i % 3]}`);
      const ir = await importAsset(root, pid, f);
      if (ir.duplicate) dupes++;
    }
    assert.equal(dupes, 100, 'all 100 re-imports caught as duplicates');
    const { assets } = await listAssets(root, pid);
    assert.equal(assets.length, 100, 'exactly 100 assets listed');
    for (const a of assets) {
      assert.ok(fs.existsSync(path.join(root, 'Projects', pid, a.rel)), 'on disk: ' + a.rel);
    }
    // Count files on disk directly: must equal 100 (plus project.json).
    let onDisk = 0;
    for (const sub of ['images', 'videos', 'audio', 'exports']) {
      const d = path.join(root, 'Projects', pid, sub);
      if (fs.existsSync(d)) onDisk += fs.readdirSync(d).filter((f) => !f.startsWith('.')).length;
    }
    assert.equal(onDisk, 100, 'exactly 100 files on disk — zero orphans');
  }, { timeout: 60000 });
});

describe('guessAssetType', () => {
  it('classifies by extension', () => {
    assert.equal(guessAssetType('a.png'), 'images');
    assert.equal(guessAssetType('a.JPG'), 'images');
    assert.equal(guessAssetType('a.mp4'), 'videos');
    assert.equal(guessAssetType('a.wav'), 'audio');
    assert.equal(guessAssetType('a.xyz'), null);
  });
  it('sha256File is stable', async () => {
    const f = makeFile(root, 'hash.txt', 'hello');
    assert.equal(await sha256File(f), await sha256File(f));
  });
});
