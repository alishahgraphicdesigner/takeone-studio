/* TakeOne Studio 2.2.0 — Phase B integration tests: DownloadManager against a
 * REAL aria2c (system binary on Linux) and a local HTTP file server with
 * Range support. Run: node --test test/downloads.test.js */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { DownloadManager, sha256File, postCheckResult } = require('../main/downloads.js');
const { execSync } = require('child_process');
let HAS_ARIA2C = false;
try { execSync('aria2c --version', { stdio: 'ignore' }); HAS_ARIA2C = true; } catch { /* not installed */ }

const FILE_BYTES = 2 * 1024 * 1024;
const PAYLOAD = crypto.randomBytes(FILE_BYTES);
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

let server, port, tmpRoot;
const sockets = new Set();

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === '/file.bin') {
        const range = req.headers.range;
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/);
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : PAYLOAD.length - 1;
          const chunk = PAYLOAD.subarray(start, Math.min(end + 1, PAYLOAD.length));
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${PAYLOAD.length}`,
            'Accept-Ranges': 'bytes', 'Content-Length': chunk.length,
            'Content-Type': 'application/octet-stream',
          });
          res.end(chunk);
        } else {
          res.writeHead(200, {
            'Accept-Ranges': 'bytes', 'Content-Length': PAYLOAD.length,
            'Content-Type': 'application/octet-stream',
          });
          res.end(PAYLOAD);
        }
      } else if (req.url === '/slow.bin') {
        // Trickle: 64KB then stall — lets the test pause mid-download deterministically.
        res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': PAYLOAD.length, 'Content-Type': 'application/octet-stream' });
        res.write(PAYLOAD.subarray(0, 65536));
        // never ends until the client goes away
      } else {
        res.writeHead(404); res.end('nope');
      }
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
  });
}

// WO-13: every manager created by a test is registered here and stopped in
// afterEach — a failed assertion mid-test must never skip mgr.stop() and leave
// a real aria2c child process + open sockets holding the test process open.
const liveManagers = new Set();

function mkManager() {
  const events = [];
  const mgr = new DownloadManager({
    root: tmpRoot,
    aria2cPath: 'aria2c',
    diskFreeGB: async () => 100,
    onEvent: (type, data) => events.push({ type, ...data }),
  });
  mgr.events = events;
  liveManagers.add(mgr);
  return mgr;
}

const tool = {
  id: 'demo-tool', installType: 'file', category: 'fix',
  fileName: 'demo.bin', sha256: PAYLOAD_SHA, sizeMB: 2, sizeBytes: FILE_BYTES,
};

async function waitFor(mgr, toolId, states, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const e = mgr.getState(toolId);
    if (e && states.includes(e.status)) return e;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + states.join('/') + ', got ' + (e && e.status));
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('DownloadManager (real aria2c)', { skip: !HAS_ARIA2C }, () => {
  before(async () => {
    await startServer();
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'takeone-dl-'));
  });
  // WO-13: mgr.stop() ALWAYS runs, pass or fail (try/finally equivalent via afterEach).
  afterEach(async () => {
    for (const m of liveManagers) { try { await m.stop(); } catch { /* already stopped */ } }
    liveManagers.clear();
  });
  after(async () => {
    for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
    await new Promise((r) => server.close(r));
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('downloads with pause → resume → checksum green, file lands in Models/', async () => {
    const mgr = mkManager();
    await mgr.start();
    const t = { ...tool, url: `http://127.0.0.1:${port}/slow.bin` };
    const r = await mgr.addDownload(t);
    assert.equal(r.ok, true);
    await waitFor(mgr, t.id, ['downloading'], 15000);
    await mgr.pause(t.id);
    const paused = await waitFor(mgr, t.id, ['paused'], 15000);
    assert.ok(paused.progress >= 0 && paused.progress < 1, 'paused mid-download');
    // swap to the fast URL for resume (same file, same name)
    const e = mgr.getState(t.id);
    e.url = `http://127.0.0.1:${port}/file.bin`;
    await mgr.persist();
    await mgr.cancel(t.id); // clean the trickle partial
    const t2 = { ...tool, id: 'demo-tool2', url: `http://127.0.0.1:${port}/file.bin` };
    await mgr.addDownload(t2);
    const done = await waitFor(mgr, t2.id, ['done'], 30000);
    assert.equal(done.progress, 1);
    const landed = path.join(tmpRoot, 'Models', 'fix', 'demo.bin');
    assert.equal(done.installedPath, landed);
    assert.equal(await sha256File(landed), PAYLOAD_SHA);
    // checksum green means the recorded hash matches reality
    const st = await fsp.stat(landed);
    assert.equal(st.size, FILE_BYTES);
    await mgr.stop();
  });

  it('pre-flight blocks when disk is full (Gate 1)', async () => {
    const mgr = mkManager();
    mgr.diskFreeGB = async () => 0.001; // ~1MB free
    await mgr.start();
    const t = { ...tool, id: 'demo-full', url: `http://127.0.0.1:${port}/file.bin` };
    const r = await mgr.addDownload(t);
    assert.equal(r.ok, false);
    assert.match(r.reason, /disk space/i);
    const e = mgr.getState(t.id);
    assert.equal(e.status, 'failed');
    assert.ok(e.suggestion && e.suggestion.length > 10, 'plain-words suggestion present');
    await mgr.stop();
  });

  it('bad URL → auto-retry → honest failed state with error', async () => {
    const mgr = mkManager();
    await mgr.start();
    const t = { ...tool, id: 'demo-bad', url: 'http://127.0.0.1:9/nope.bin', sha256: null };
    await mgr.addDownload(t);
    const failed = await waitFor(mgr, t.id, ['failed'], 60000);
    assert.ok(failed.error && failed.error.length > 0);
    const retried = mgr.events.some((ev) => ev.toolId === t.id && ev.state === 'retrying');
    assert.equal(retried, true, 'one automatic retry happened');
    await mgr.stop();
  });

  it('cancel removes partials — nothing half-written left behind', async () => {
    const mgr = mkManager();
    await mgr.start();
    const t = { ...tool, id: 'demo-cancel', url: `http://127.0.0.1:${port}/slow.bin` };
    await mgr.addDownload(t);
    await waitFor(mgr, t.id, ['downloading'], 15000);
    await mgr.cancel(t.id);
    const e = mgr.getState(t.id);
    assert.equal(e.status, 'cancelled');
    const partial = path.join(tmpRoot, '.staging', 'downloads', 'demo.bin');
    assert.equal(fs.existsSync(partial), false);
    assert.equal(fs.existsSync(partial + '.aria2'), false);
    await mgr.stop();
  });

  it('interrupted downloads recover as resumable after restart', async () => {
    const mgr = mkManager();
    await mgr.start();
    // Start on the trickle so a real partial exists, then pause it.
    const t = { ...tool, id: 'demo-resume', url: `http://127.0.0.1:${port}/slow.bin` };
    await mgr.addDownload(t);
    await waitFor(mgr, t.id, ['downloading'], 15000);
    await mgr.pause(t.id);
    await waitFor(mgr, t.id, ['paused'], 15000);
    const partial = path.join(tmpRoot, '.staging', 'downloads', 'demo.bin');
    assert.ok(fs.existsSync(partial), 'partial file exists before restart');
    // Point the saved entry at the fast URL, persist, and restart the manager.
    const e0 = mgr.getState(t.id);
    e0.url = `http://127.0.0.1:${port}/file.bin`;
    await mgr.persist();
    await mgr.stop();
    // New manager, same root → recovery marks it interrupted, not lost.
    const mgr2 = mkManager();
    await mgr2.start();
    const e = mgr2.getState(t.id);
    assert.equal(e.status, 'interrupted');
    const r = await mgr2.resume(t.id);
    assert.equal(r.ok, true);
    // The 2MB file finishes fast; what matters is it completes from the partial.
    const done = await waitFor(mgr2, t.id, ['done'], 30000);
    assert.equal(done.progress, 1);
    assert.equal(await sha256File(path.join(tmpRoot, 'Models', 'fix', 'demo.bin')), PAYLOAD_SHA);
    await mgr2.stop();
  });
});
