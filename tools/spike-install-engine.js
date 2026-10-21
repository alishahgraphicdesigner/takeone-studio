/* WO-23: shipped-python-spike CI driver — runs the REAL main/engine.js installEngine()
 * with no UI. TAKEONE_SKIP_GPU_CHECK=1 is set by the workflow because GitHub
 * runners have no NVIDIA GPU (the three GPU failure kinds are unit-tested;
 * the real GPU path is proven on the user's own PC).
 *
 * Env: TAKEONE_SPIKE_ROOT (the <root> to install into), TAKEONE_ARIA2 (aria2c binary).
 */
'use strict';
const path = require('path');
const engine = require('../main/engine.js');

const ROOT = path.resolve(process.env.TAKEONE_SPIKE_ROOT || process.cwd());

(async () => {
  console.log('[spike] root:', ROOT);
  console.log('[spike] TAKEONE_SKIP_GPU_CHECK =', process.env.TAKEONE_SKIP_GPU_CHECK);
  const t0 = Date.now();
  const r = await engine.installEngine(ROOT, {
    skipGpuCheck: process.env.TAKEONE_SKIP_GPU_CHECK === '1',
    onEvent: (e) => {
      if (e.type === 'phase') console.log(`[spike] phase: ${e.phase}`);
      else if (e.type === 'wheel' && e.done) console.log(`[spike] wheel ${e.index}/${e.count} installed`);
      else if (e.type === 'download') console.log(`[spike] download: ${Math.round((e.progress || 0) * 100)}% ${e.fileName || ''}`);
    },
  });
  console.log(`[spike] done in ${Math.round((Date.now() - t0) / 1000)}s — ok:`, r.ok);
  if (!r.ok) {
    console.error('[spike] WHY:', r.why);
    console.error('[spike] WHAT NEXT:', r.whatNext);
    process.exit(1);
  }
  // Prove the state file + engine layout the app will rely on.
  const st = engine.readEngineState(ROOT);
  console.log('[spike] engine ready:', engine.engineReady(ROOT),
    '| wheels in state:', Object.keys((st && st.wheels) || {}).length,
    '| python:', st && st.python && st.python.version);
})().catch((e) => { console.error('[spike] CRASH:', e && e.stack || e); process.exit(1); });
