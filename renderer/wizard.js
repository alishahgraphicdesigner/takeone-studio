/* TakeOne Studio 2.2.0 — Phase A wizard logic (5 steps). */
(function () {
  'use strict';

  // Tool catalog (Phase A: informational — downloads land in Phase B).
  // Sizes/VRAM from the v2.2 build spec catalog; shown honestly, never downloaded here.
  // Tool list: the signed catalog (main process) is the source of truth.
  // This fallback only renders if the catalog IPC is unreachable.
  let TOOLS = [
    ['brain', 'Brain', 'Qwen3 8B', '~5 GB', '~6 GB VRAM'],
    ['image-studio', 'Image Studio', 'SDXL-Lightning 9-step', '~7 GB', '~8 GB VRAM'],
    ['image-lite', 'Image Lite', 'SD 1.5 + Turbo', '~7 GB', '~6 GB VRAM'],
    ['video-studio', 'Video Studio', 'Wan 2.1 1.3B', '~3 GB', '8.2 GB VRAM'],
    ['video-quality', 'Video Quality', 'Allegro 2.8B', '~6 GB', '9.3 GB VRAM'],
    ['video-pro', 'Video Pro', 'Wan 2.2 TI2V-5B', '~11 GB', '24 GB VRAM'],
    ['voice-studio', 'Voice Studio', 'Chatterbox TTS', '~2 GB', '~4 GB VRAM'],
    ['voice-lite', 'Voice Lite', 'Piper (optional)', '~150 MB', 'CPU'],
    ['transcribe', 'Transcribe', 'faster-whisper large-v3', '~3 GB', '~4 GB VRAM'],
    ['music-studio', 'Music Studio', 'ACE-Step v1.5', '~4 GB', '~8 GB VRAM'],
    ['upscaler', 'Upscaler', 'SwinIR x4', '~65 MB', '~2 GB VRAM'],
    ['face-restore', 'Face Restore', 'GFPGAN v1.4', '~333 MB', '~2 GB VRAM'],
    ['vision', 'Vision', 'Florence-2 large', '~1.5 GB', '~3 GB VRAM'],
    ['smart-select', 'Smart Select', 'SAM 2 tiny', '~150 MB', '~2 GB VRAM'],
    ['erase', 'Erase', 'LaMa', '~200 MB', '~2 GB VRAM'],
    ['depth-fx', 'Depth FX', 'Depth-Anything V2', '~100 MB', '~1 GB VRAM'],
    ['pose-lock', 'Pose Lock', 'DWPose', '~500 MB', '~2 GB VRAM'],
    ['bg-remove', 'BG Remove', 'BiRefNet', '~800 MB', '~3 GB VRAM'],
    ['voice-cleanup', 'Voice Cleanup', 'DeepFilterNet + Silero', '~50 MB', 'CPU'],
    ['slow-motion', 'Slow Motion', 'RIFE', '~50 MB', '~2 GB VRAM'],
    ['stem-split', 'Stem Split', 'Demucs', '~500 MB', '~4 GB VRAM'],
  ];
  const fmtSize = (mb) => mb >= 1024 ? '~' + (mb / 1024).toFixed(1) + ' GB' : '~' + Math.round(mb) + ' MB';
  const fmtVram = (mb) => mb === 0 ? 'CPU' : '~' + (mb / 1024).toFixed(1) + ' GB VRAM';
  async function loadToolCatalog() {
    try {
      const r = await window.takeone.catalog();
      if (r && r.ok && Array.isArray(r.catalog) && r.catalog.length === 21) {
        TOOLS = r.catalog.map((t) => [t.id, t.friendlyName, t.technical, fmtSize(t.sizeMB), fmtVram(t.vramMB)]);
        TIER_TOOLS.pro = TOOLS.map((t) => t[0]);
        TIER_TOOLS.standard = TOOLS.map((t) => t[0]).filter((id) => id !== 'video-pro');
      }
    } catch { /* fallback list above stays */ }
  }
  const TIER_TOOLS = {
    pro: TOOLS.map(t => t[0]),
    standard: TOOLS.map(t => t[0]).filter(id => id !== 'video-pro'),
    lite: ['brain', 'voice-lite', 'upscaler', 'voice-cleanup', 'slow-motion', 'bg-remove', 'erase'],
  };
  const TIER_LABEL = { pro: 'Pro', standard: 'Standard', lite: 'Lite' };
  const NICHES = ['Short Films', 'History Documentaries', 'Wedding Films', 'Real Estate', 'Product Ads', 'Vlogs', 'Horror Shorts'];
  const STEP_NAMES = ['Welcome', 'Check My PC', 'Storage', 'Tools', 'Ready'];

  const state = {
    step: 1,
    pcCheck: null,
    recommendation: null,
    storageRoot: null,
    packChoice: 'recommended',
    customTools: new Set(TIER_TOOLS.standard),
    existingModels: [],
    acknowledgedLater: false,
    niche: 'none',
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ---- step rail -----------------------------------------------------------
  function renderSteps() {
    $('#steps').innerHTML = STEP_NAMES.map((n, i) => {
      const k = i + 1;
      const cls = k === state.step ? 'active' : (k < state.step ? 'done' : '');
      const mark = k < state.step ? '✓' : k;
      return `<div class="stepdot ${cls}"><span class="dot">${mark}</span>${n}</div>`;
    }).join('');
  }
  function goStep(n) {
    state.step = n;
    $$('.step').forEach(s => s.classList.toggle('on', +s.dataset.step === n));
    renderSteps();
    if (n === 2) runPcCheck();
    if (n === 3) refreshDiskHint();
    if (n === 4) renderReco();
    if (n === 5) renderSummary();
    persistDraft();
  }

  // ---- persistence (survives reboot mid-wizard) -----------------------------
  let persistTimer = null;
  function persistDraft() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      window.takeone.saveWizard({
        storageRoot: state.storageRoot, pcCheck: state.pcCheck,
        packChoice: state.packChoice, customTools: Array.from(state.customTools),
        existingModels: state.existingModels, acknowledgedLater: state.acknowledgedLater,
        niche: state.niche, wizardStep: state.step,
      }).catch(() => {});
    }, 400);
  }

  // ---- step 2: real PC check ------------------------------------------------
  let checking = false;
  async function runPcCheck() {
    if (checking) return;
    checking = true;
    $('#pcNext').disabled = true;
    const rows = { gpu: $('#ck-gpu'), ram: $('#ck-ram'), disk: $('#ck-disk'), speed: $('#ck-speed') };
    Object.values(rows).forEach(r => { r.querySelector('.spin, .tick, .cross').className = 'spin'; r.querySelector('.val').textContent = 'Measuring…'; r.querySelector('.val').className = 'val'; });
    try {
      const pc = await window.takeone.checkPC(state.storageRoot);
      state.pcCheck = pc;
      state.recommendation = await window.takeone.recommendPack(pc);
      state.customTools = new Set(TIER_TOOLS[state.recommendation.tier] || TIER_TOOLS.standard);
      setRow(rows.gpu, pc.gpuName ? 'ok' : 'warn',
        pc.gpuName ? `${pc.gpuName} — ${(pc.vramMB / 1024).toFixed(1)} GB VRAM` : 'No NVIDIA GPU detected — CPU-only tools will be recommended.');
      setRow(rows.ram, 'ok', `${pc.ramGB} GB installed`);
      setRow(rows.disk, pc.diskFreeGB !== null && pc.diskFreeGB > 20 ? 'ok' : 'warn',
        pc.diskFreeGB !== null ? `${pc.diskFreeGB} GB free on this drive` : 'Could not read free disk space.');
      setRow(rows.speed, pc.speedMbps !== null ? 'ok' : 'warn',
        pc.speedMbps !== null ? `${pc.speedMbps} Mbps (measured just now)` : 'Speed test unavailable — download times will be estimated later, not now.');
      $('#recoPackDesc').textContent = `${TIER_LABEL[state.recommendation.tier]} pack — ${state.recommendation.reason}`;
    } catch (err) {
      Object.values(rows).forEach(r => setRow(r, 'warn', 'Check failed: ' + String(err.message || err)));
    }
    checking = false;
    $('#pcNext').disabled = false;
  }
  function setRow(row, cls, text) {
    const icon = row.querySelector('.spin, .tick, .cross');
    icon.className = cls === 'ok' ? 'tick' : 'cross';
    icon.textContent = cls === 'ok' ? '✓' : '!';
    const v = row.querySelector('.val');
    v.textContent = text;
    v.className = 'val ' + cls;
  }

  // ---- step 3: storage -------------------------------------------------------
  async function refreshDiskHint() {
    if (!state.storageRoot) state.storageRoot = await window.takeone.defaultRoot();
    // Display the path masked (no OS username on screen); the real path is
    // used for all file operations and via "Show in folder".
    $('#storagePath').textContent = await window.takeone.displayPath(state.storageRoot);
    $('#storagePath').title = 'Your full path stays private — click "Change" to pick another folder.';
    const free = await window.takeone.diskFree(state.storageRoot);
    $('#diskHint').textContent = free !== null
      ? `${free} GB free on this drive. TakeOne needs room for tools (up to ~40 GB for the full pack) plus your projects.`
      : 'Could not read free space on this drive.';
  }

  // ---- step 4: pack ----------------------------------------------------------
  function renderReco() {
    if (state.recommendation) {
      $('#recoTitle').textContent = `Recommended for your PC: ${TIER_LABEL[state.recommendation.tier]} pack`;
      $('#recoReason').textContent = state.recommendation.reason;
    }
    renderTools();
    renderNiches();
    updateGate();
  }
  function renderTools() {
    const box = $('#toolList');
    const custom = state.packChoice === 'custom';
    box.hidden = !custom;
    if (!custom) return;
    box.innerHTML = TOOLS.map(([id, name, tech, size, vram]) =>
      `<label class="tool"><input type="checkbox" data-tool="${id}" ${state.customTools.has(id) ? 'checked' : ''}>
       <div><b>${name}</b><div class="meta">${tech} · ${size} · ${vram}</div></div></label>`).join('');
    $$('#toolList input').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) state.customTools.add(cb.dataset.tool); else state.customTools.delete(cb.dataset.tool);
      updateGate(); persistDraft();
    }));
  }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function renderNiches() {
    const box = $('#nicheChips');
    if (!box) return; // niche moved out of the wizard — asked in Studio at first project
    const all = ['none', ...NICHES];
    box.innerHTML = all.map(n =>
      `<button class="chip ${state.niche === n ? 'sel' : ''}" data-niche="${n}">${n === 'none' ? 'Skip' : n}</button>`).join('');
    $$('#nicheChips .chip').forEach(c => c.addEventListener('click', () => {
      state.niche = c.dataset.niche; renderNiches(); persistDraft();
    }));
  }
  function toolsSelected() {
    return state.packChoice === 'recommended' ||
      (state.packChoice === 'custom' && state.customTools.size > 0);
  }
  // Gate 2 mirror (main process enforces it for real).
  function updateGate() {
    const needAck = !toolsSelected() && state.existingModels.length === 0;
    $('#gateWarn').hidden = !needAck;
    const ok = toolsSelected() || state.existingModels.length > 0 || (needAck && $('#ackLater').checked);
    $('#packNext').disabled = !ok;
    state.acknowledgedLater = needAck && $('#ackLater').checked;
  }

  // ---- step 5: summary -------------------------------------------------------
  async function renderSummary() {
    const pc = state.pcCheck || {};
    const packTxt = state.packChoice === 'recommended'
      ? `Recommended pack (${TIER_LABEL[(state.recommendation || {}).tier || 'standard']})`
      : state.packChoice === 'custom' ? `Custom — ${state.customTools.size} tools` : 'Skipped — I will add tools later';
    const shownRoot = await window.takeone.displayPath(state.storageRoot);
    $('#summaryBox').innerHTML = `
      <div class="srow"><span class="k">PC</span><span class="v">${pc.gpuName ? pc.gpuName + ' · ' + (pc.vramMB / 1024).toFixed(1) + ' GB VRAM' : 'No NVIDIA GPU'} · ${pc.ramGB || '?'} GB RAM</span></div>
      <div class="srow"><span class="k">TakeOne folder</span><span class="v">${shownRoot}</span></div>
      <div class="srow"><span class="k">Tools</span><span class="v">${packTxt}</span></div>
      <div class="srow"><span class="k">Existing models found</span><span class="v">${state.existingModels.length}</span></div>
      <div class="srow"><span class="k">Niche</span><span class="v">${state.niche === 'none' ? 'Not set' : state.niche}</span></div>`;
  }

  // ---- wiring ----------------------------------------------------------------
  function wire() {
    $$('[data-next]').forEach(b => b.addEventListener('click', () => goStep(Math.min(5, state.step + 1))));
    $$('[data-back]').forEach(b => b.addEventListener('click', () => goStep(Math.max(1, state.step - 1))));
    $('#recheck').addEventListener('click', () => { checking = false; runPcCheck(); });
    $('#changePath').addEventListener('click', async () => {
      const p = await window.takeone.pickFolder();
      if (!p) return;
      try {
        const v = await window.takeone.validateRoot(p);
        if (!v.ok) {
          const again = confirm(
            'This folder already contains: ' + (v.conflicts || []).join(', ') + '\n\n' +
            'TakeOne uses these folder names for its own data. Using this folder could put YOUR existing files at risk.\n\n' +
            'Press OK to choose a different folder (recommended), or Cancel to use it anyway.');
          if (again) return;
        }
      } catch {}
      state.storageRoot = p; refreshDiskHint(); persistDraft();
    });
    $$('input[name="pack"]').forEach(r => r.addEventListener('change', () => {
      state.packChoice = r.value; state.acknowledgedLater = false; $('#ackLater').checked = false;
      renderTools(); updateGate(); persistDraft();
    }));
    $('#ackLater').addEventListener('change', updateGate);
    $('#scanOtherBtn').addEventListener('click', async () => {
      const dir = await window.takeone.pickFolder();
      if (!dir) return;
      const box = $('#adoptBox');
      box.hidden = false;
      box.innerHTML = '<b>Scanning...</b>';
      $('#scanHint').textContent = 'Looking for TakeOne model files in the chosen folder.';
      let r;
      try { r = await window.takeone.scanFolderModels(dir); }
      catch (err) { box.innerHTML = '<b>Scan failed:</b> ' + esc(String(err.message || err)); return; }
      if (!r.ok) { box.innerHTML = '<b>Scan failed:</b> ' + esc(r.reason); return; }
      if (!r.found.length) {
        box.innerHTML = '<b>No TakeOne model files found</b> in that folder. Only files from the TakeOne catalog can be adopted.';
        $('#scanHint').textContent = 'Nothing matching the TakeOne catalog was found there.';
        return;
      }
      const totalGB = (r.found.reduce((a, f) => a + f.sizeMB, 0) / 1024).toFixed(1);
      state.pendingAdopt = r.found;
      box.innerHTML = '<b>Found ' + r.found.length + ' model file(s) (' + totalGB + ' GB)</b><ul>' +
        r.found.map(f => '<li>' + esc(f.toolName) + ' - ' + esc(f.file) + ' (' + f.sizeMB + ' MB)</li>').join('') +
        '</ul><button class="primary" id="adoptBtn">Adopt these files (copy into TakeOne folder)</button> ' +
        '<span class="hint">Copied, not moved - your other apps keep working.</span>';
      $('#adoptBtn').addEventListener('click', async () => {
        const btn = $('#adoptBtn');
        btn.disabled = true;
        btn.textContent = 'Copying...';
        let ar;
        try { ar = await window.takeone.adoptModels(state.pendingAdopt, state.storageRoot); }
        catch (err) { box.innerHTML = '<b>Adopt failed:</b> ' + esc(String(err.message || err)); return; }
        if (!ar.ok) { box.innerHTML = '<b>Adopt failed:</b> ' + esc(ar.reason); return; }
        const okc = ar.results.filter(x => x.ok && !x.skipped).length;
        const skc = ar.results.filter(x => x.ok && x.skipped).length;
        const bad = ar.results.filter(x => !x.ok);
        state.existingModels = (state.existingModels || []).concat(
          ar.results.filter(x => x.ok).map(x => ({ tool: x.toolId, adopted: true })));
        persistDraft();
        box.innerHTML = '<b>Adopted ' + okc + ' file(s)' + (skc ? ', ' + skc + ' already present' : '') + '.</b>' +
          (bad.length ? '<br><span class="hint">' + bad.length + ' failed: ' + esc(bad[0].reason || '') + '</span>' : '') +
          '<br><span class="hint">These tools will show as Installed - no download needed.</span>';
        $('#scanHint').textContent = 'Adopted files are now part of your TakeOne library.';
      });
    });
    $('#scanBtn').addEventListener('click', async () => {
      $('#scanBtn').disabled = true; $('#scanHint').textContent = 'Scanning…';
      try {
        const found = await window.takeone.scanModels(state.storageRoot);
        state.existingModels = found;
        if (found.length) {
          $('#foundBox').hidden = false;
          $('#foundList').innerHTML = found.map(f => `<li>${f.tool} — ${f.file} (${f.sizeMB} MB)</li>`).join('');
          $('#scanHint').textContent = `${found.length} model file(s) found — these will be reused, not downloaded again.`;
        } else {
          $('#scanHint').textContent = 'No known model files found in the TakeOne folder.';
        }
      } catch (err) { $('#scanHint').textContent = 'Scan failed: ' + String(err.message || err); }
      $('#scanBtn').disabled = false;
      updateGate(); persistDraft();
    });
    $('#openStudio').addEventListener('click', async () => {
      $('#openStudio').disabled = true;
      const r = await window.takeone.finishWizard({
        storageRoot: state.storageRoot, pcCheck: state.pcCheck,
        packChoice: state.packChoice, customTools: Array.from(state.customTools),
        existingModels: state.existingModels, acknowledgedLater: state.acknowledgedLater,
        niche: state.niche,
      });
      if (!r.ok) { notice(r.reason); $('#openStudio').disabled = false; }
      // on success the main process swaps to the Studio window
    });
  }

  // ---- init ------------------------------------------------------------------
  async function init() {
    renderSteps(); wire();
    await loadToolCatalog(); // signed catalog is the source of truth; fallback above if unreachable
    const smokeMode = new URLSearchParams(location.search).get('smoke') === '1';
    try {
      const cfg = await window.takeone.getConfig();
      if (cfg && !cfg.wizardCompleted) {
        if (cfg.storageRoot) state.storageRoot = cfg.storageRoot;
        if (cfg.pcCheck) { state.pcCheck = cfg.pcCheck; }
        if (cfg.packChoice) {
          state.packChoice = cfg.packChoice;
          const radio = document.querySelector(`input[name="pack"][value="${cfg.packChoice}"]`);
          if (radio) radio.checked = true;
        }
        if (Array.isArray(cfg.customTools) && cfg.customTools.length) state.customTools = new Set(cfg.customTools);
        if (Array.isArray(cfg.existingModels)) state.existingModels = cfg.existingModels;
        if (cfg.niche) state.niche = cfg.niche;
        if (cfg.wizardStep && cfg.wizardStep > 1) {
          try { state.recommendation = await window.takeone.recommendPack(state.pcCheck); } catch { /* ignore */ }
        }
        if (state.pcCheck && !state.recommendation) {
          try { state.recommendation = await window.takeone.recommendPack(state.pcCheck); } catch { /* ignore */ }
        }
        goStep(cfg.wizardStep && cfg.wizardStep >= 1 && cfg.wizardStep <= 5 ? cfg.wizardStep : 1);
        return;
      }
    } catch { /* fresh start */ }
    goStep(1);
    if (smokeMode) {
      // Dev smoke only (?smoke=1, never in production): walk into step 2 so the
      // real checkPC IPC path executes end-to-end.
      setTimeout(() => {
        const b = document.querySelector('.step[data-step="1"] [data-next]');
        if (b) b.click();
      }, 1500);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
