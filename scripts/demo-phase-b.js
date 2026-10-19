/* TakeOne Studio 2.2.0 — Phase B demo script.
 * Run: node scripts/demo-phase-b.js
 * Demonstrates (Quality-gate evidence):
 *  1. Real download of SwinIR (~65 MB) with PAUSE → RESUME → checksum green.
 *  2. A failed download (bad URL) → one auto-retry → honest failed state → manual retry.
 * Uses the REAL DownloadManager + REAL aria2c. Output goes to a temp dir. */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { DownloadManager, sha256File } = require('../main/downloads.js');

const SWINIR = {
  id: 'upscale', installType: 'file', category: 'fix', fileName: 'SwinIR_classical_x4.pth',
  url: 'https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/001_classicalSR_DF2K_s64w8_SwinIR-M_x4.pth',
  sha256: '4e78e33f22c1aa8a773db0cf4a7381bae97c2362c717f155439ebc690cbd9215',
  sizeMB: 65, sizeBytes: 67869037,
};

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'takeone-demo-b-'));
  console.log('demo root:', root);
  const mgr = new DownloadManager({
    root,
    aria2cPath: process.env.TAKEONE_ARIA2 || 'aria2c',
    diskFreeGB: async () => 100,
    onEvent: (type, d) => {
      if (type === 'progress') return;
      console.log(`[event] ${type}`, d.toolId || '', d.state || '', d.error || '');
    },
  });
  await mgr.start();

  console.log('\n=== 1. Real download: SwinIR (~65 MB) ===');
  console.log((await mgr.addDownload(SWINIR)).ok ? 'started' : 'START FAILED');
  // let it run ~8s, then pause mid-download
  await new Promise((r) => setTimeout(r, 8000));
  let st = mgr.getState('upscale');
  console.log('mid-download state:', st.status, Math.round((st.progress || 0) * 100) + '%');
  await mgr.pause('upscale');
  st = mgr.getState('upscale');
  console.log('after pause:', st.status, Math.round((st.progress || 0) * 100) + '%');
  const pausedAt = st.progress;
  if (pausedAt >= 1) console.log('(already finished before pause — fine, it was fast)');
  await new Promise((r) => setTimeout(r, 1500));
  console.log('resuming…');
  await mgr.resume('upscale');
  // wait for done
  const t0 = Date.now();
  for (;;) {
    st = mgr.getState('upscale');
    if (st.status === 'done' || st.status === 'failed') break;
    if (Date.now() - t0 > 300000) throw new Error('demo download timed out');
    if (st.status === 'downloading' && (st.progress || 0) > 0) {
      process.stdout.write(`\rprogress: ${Math.round(st.progress * 100)}%   `);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\nfinal state:', st.status);
  if (st.status === 'done') {
    const hash = await sha256File(st.installedPath);
    console.log('checksum:', hash === SWINIR.sha256 ? 'GREEN ✓' : 'MISMATCH ✗');
    const stat = await fsp.stat(st.installedPath);
    console.log('file:', st.installedPath, stat.size, 'bytes');
  } else {
    console.log('error:', st.error);
  }

  console.log('\n=== 2. Failure demo: bad URL ===');
  const bad = { id: 'bad-demo', installType: 'file', category: 'fix', fileName: 'nope.bin',
    url: 'https://127.0.0.1:9/nope.bin', sizeMB: 1 };
  console.log((await mgr.addDownload(bad)).ok ? 'started' : 'START FAILED');
  const t1 = Date.now();
  let bst;
  for (;;) {
    bst = mgr.getState('bad-demo');
    if (bst.status === 'failed') break;
    if (Date.now() - t1 > 120000) throw new Error('failure demo timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('state:', bst.status);
  console.log('error shown to user:', bst.error);
  console.log('retrying with a real URL (SwinIR again, new name)…');
  const again = { ...SWINIR, id: 'bad-demo', fileName: 'nope.bin' };
  console.log((await mgr.retry('bad-demo', again)).ok ? 'retry accepted' : 'RETRY FAILED');
  const t2 = Date.now();
  for (;;) {
    bst = mgr.getState('bad-demo');
    if (bst.status === 'done' || bst.status === 'failed') break;
    if (Date.now() - t2 > 300000) throw new Error('retry timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('after retry:', bst.status);

  await mgr.stop();
  console.log('\ndemo complete. Root left at:', root);
}

main().catch((e) => { console.error('DEMO FAILED:', e.message); process.exit(1); });
