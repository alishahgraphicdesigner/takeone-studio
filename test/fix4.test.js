/* FIX-4 (FINAL): the Library list was stale — a project created while the
 * app ran never appeared until restart. Cause, proven by code + Ali's
 * restart evidence: renderer/library.js rendered ONCE at DOMContentLoaded
 * and view switches only toggled CSS classes. Possibilities (2) "not
 * registered" and (3) "project.json missing" are ruled out: listProjects
 * walks the disk (no index/registry exists) and ensureQuickGenerateProject
 * writes project.json — the restart proved the files were there all along.
 * The two-roots hypothesis is withdrawn (both Settings cards showed the
 * same path); the fix is re-read on every show + an IPC refresh event.
 * These node tests cover the parts a browser cannot: the real Quick
 * Generate save path through a fake ComfyUI, the catalog flag change,
 * the single-root normalization, the contact-sheet geometry, and the
 * diagnostics read-vs-disk counts. The re-read-on-show half is covered
 * by the UI audit's late-project check (Library opened FIRST, project
 * created after, back to Library, card appears — never seeded). */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sr = require('../main/storage-root.js');
const { CATALOG, validateCatalog, effectiveAvailability } = require('../main/catalog.js');
const sheet = require('../renderer/contact-sheet.js');
const libMod = require('../main/library.js');
const diag = require('../main/diagnostics.js');
const { ComfyManager } = require('../main/comfy.js');

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tmpRoots = [];
function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'takeone-fix4-'));
  tmpRoots.push(d);
  return d;
}
afterEach(() => {
  while (tmpRoots.length) {
    try { fs.rmSync(tmpRoots.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('single authoritative root (storage-root helpers)', () => {
  it('receipt root wins over a stale config field', () => {
    const cfg = { storageRoot: 'C:\\Users\\Old\\TakeOne', wizardCompleted: true };
    const out = sr.normalizeConfigStorageRoot(cfg, 'C:\\Users\\New\\TakeOne');
    assert.equal(out.storageRoot, 'C:\\Users\\New\\TakeOne');
    assert.equal(out.wizardCompleted, true, 'other fields survive');
    assert.equal(cfg.storageRoot, 'C:\\Users\\Old\\TakeOne', 'input not mutated');
  });
  it('normalize is a no-op when disk and receipt already agree', () => {
    const cfg = { storageRoot: '/data/TakeOne' };
    assert.equal(sr.normalizeConfigStorageRoot(cfg, '/data/TakeOne'), cfg);
  });
  it('normalize returns null for a missing config', () => {
    assert.equal(sr.normalizeConfigStorageRoot(null, '/data/TakeOne'), null);
  });
  it('resolvePrimaryRoot prefers the receipt, then the fallback', () => {
    assert.equal(sr.resolvePrimaryRoot({ storageRoot: '/receipt' }, '/fallback'), '/receipt');
    assert.equal(sr.resolvePrimaryRoot(null, '/fallback'), '/fallback');
    assert.equal(sr.resolvePrimaryRoot({}, '/fallback'), '/fallback');
  });
});

describe('M2.6-ENABLE catalog flag: unavailable -> experimental', () => {
  const vs = CATALOG.find((t) => t.id === 'video-studio');
  it('video-studio carries experimental, not unavailable', () => {
    assert.ok(vs, 'video-studio must exist');
    assert.equal(typeof vs.experimental, 'string');
    assert.match(vs.experimental, /M2\.6/);
    assert.equal(vs.unavailable, undefined);
    assert.equal(typeof vs.experimentalUser, 'string');
    assert.match(vs.experimentalUser, /^Coming soon/);
  });
  it('effectiveAvailability maps OFF to the old unavailable pair, ON to null', () => {
    const off = effectiveAvailability(vs, false);
    assert.equal(off.unavailable, vs.experimental);
    assert.equal(off.unavailableUser, vs.experimentalUser);
    assert.equal(effectiveAvailability(vs, true), null);
  });
  it('a genuinely unavailable tool still maps the same way (precedence)', () => {
    const t = { id: 'x', unavailable: 'gone', unavailableUser: 'Gone.' };
    assert.deepEqual(effectiveAvailability(t, true), { unavailable: 'gone', unavailableUser: 'Gone.' });
  });
  it('catalog still validates; tier24 is still exactly video-pro', () => {
    assert.doesNotThrow(() => validateCatalog());
    assert.deepEqual(CATALOG.filter((t) => t.tier24).map((t) => t.id), ['video-pro']);
    assert.equal(vs.vramMB, 16384);
  });
});

describe('FIX-5 containFit: full image, never cropped', () => {
  it('wide image letterboxes vertically', () => {
    const r = sheet.containFit(1920, 1080, 448);
    assert.equal(r.dw, 448);
    assert.equal(r.dh, 252);
    assert.equal(r.dx, 0);
    assert.equal(r.dy, 98);
  });
  it('tall image letterboxes horizontally', () => {
    const r = sheet.containFit(1080, 1920, 448);
    assert.equal(r.dw, 252);
    assert.equal(r.dh, 448);
    assert.equal(r.dx, 98);
    assert.equal(r.dy, 0);
  });
  it('square image fills the cell exactly', () => {
    assert.deepEqual(sheet.containFit(512, 512, 448), { dw: 448, dh: 448, dx: 0, dy: 0 });
  });
  it('aspect is preserved exactly (no stretch, no crop)', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1024, 768], [640, 640]]) {
      const r = sheet.containFit(w, h, 448);
      assert.ok(Math.abs((r.dw / r.dh) - (w / h)) < 1e-9, `${w}x${h}`);
      assert.ok(r.dw <= 448 && r.dh <= 448, 'never exceeds the cell');
    }
  });
  it('degenerate input is an empty rect', () => {
    assert.deepEqual(sheet.containFit(0, 100, 448), { dw: 0, dh: 0, dx: 0, dy: 0 });
  });
});

describe('FIX-4 real flow: fake ComfyUI Quick Generate -> Library list API', () => {
  it('saves under the data root and listProjects shows it with a thumbnail', async () => {
    const dataRoot = tmpRoot();
    const pid = 'fix4-test-prompt';
    const png = Buffer.from(TINY_PNG_B64, 'base64');
    const server = http.createServer((req, res) => {
      if (req.url === `/history/${pid}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ [pid]: { outputs: { 9: { images: [{ filename: 'fake.png', subfolder: '', type: 'output' }] } } } }));
      } else if (req.url.startsWith('/view?')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const mgr = new ComfyManager({ root: dataRoot, pythonExe: 'python3', comfyDir: dataRoot });
      mgr.port = server.address().port;
      mgr.ready = true;
      const res = await mgr.fetchAndSaveOutput(dataRoot, pid, { prompt: 'a test image' });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.ok(res.path.startsWith(path.join(dataRoot, 'Projects')), res.path);
      // Possibility (3) ruled out by construction: project.json exists.
      const projDir = path.join(dataRoot, 'Projects', res.projectId);
      assert.ok(fs.existsSync(path.join(projDir, 'project.json')), 'project.json must exist');
      assert.ok(fs.existsSync(res.path), 'PNG must exist on disk');
      // The Library list API (what the page reads) shows it, with a thumbnail.
      const projects = await libMod.listProjects(dataRoot);
      assert.ok(projects.length >= 1, 'Library list must not be empty after a real save');
      const entry = projects.find((p) => p.id === res.projectId);
      assert.ok(entry, 'saved project must be listed');
      assert.ok(entry.thumb, 'listed project must carry a thumbnail');
      assert.ok(entry.thumb.startsWith('images/'), entry.thumb);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('FIX-4 diagnostics: Library reads vs Projects on disk', () => {
  it('storage section carries both counts', async () => {
    const section = await diag.storageSection('/tmp/takeone-test', {
      protected: 'no',
      security: { controlledFolderAccess: 'off', defenderRealTime: 'off' },
      defenderBlocks: [],
      libraryRead: 3,
      libraryOnDisk: 4,
    });
    assert.match(section, /Library projects read: 3/);
    assert.match(section, /Projects on disk: 4/);
  });
  it('counts are absent when the caller supplies neither', async () => {
    const section = await diag.storageSection('/tmp/takeone-test', {
      protected: 'no',
      security: { controlledFolderAccess: 'off', defenderRealTime: 'off' },
      defenderBlocks: [],
    });
    assert.ok(!section.includes('Library projects read:'), section);
  });
});
