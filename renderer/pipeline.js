/* TakeOne Studio 2.2.0 — Phase C: Studio view (6-step pipeline, real state).
 * Every control is functional or honestly labelled. No theater:
 * generation gates say exactly what is missing; the script analyzer,
 * project thread, resume strip, variations toggle and taste-aware
 * suggestions all run on real project state. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const STEP_NAMES = ['Prompt Brief', 'Image', 'Animate', 'Director', 'Voice', 'Final'];
  const STEP_FROM_TO = [
    ['—', 'Production prompt'], ['Brief', 'Source image'], ['Image', 'Shot set'],
    ['Shot set', 'Sequence'], ['Sequence', 'Voiced film'], ['Voiced film', 'Export'],
  ];
  const BUILT_IN_STYLES = ['Cinematic', 'Documentary', 'Anime', 'Film Noir', 'Vintage Film', 'Neon Nights'];
  const RATIOS = ['16:9', '9:16', '1:1', '21:9'];
  const MOTIONS = ['Slow push-in', 'Slow pull-back', 'Lateral drift', 'Static tripod', 'Handheld sway'];
  const CAMERAS = ['Wide', 'Medium', 'Close-up', 'Aerial'];
  const PACINGS = ['Measured', 'Brisk', 'Slow burn'];
  const PRESETS = ['YouTube 4K', 'YouTube 1080p', 'Instagram Reel', 'Client ProRes'];

  let root = null;
  let projectId = null;
  let project = null;
  let activeStep = 1;
  let saveTimer = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch { return '—'; }
  }
  function fmtDur(ms) {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    return s < 60 ? `ready in ${s}s` : `ready in ${Math.floor(s / 60)}m ${s % 60}s`;
  }
  function fileUrl(abs) {
    return 'file:///' + String(abs).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  }
  function absAsset(rel) { return root + '/Projects/' + projectId + '/' + rel.replace(/\//g, '/'); }

  function queueSave() {
    const el = $('#pipeSaved');
    if (el) { el.textContent = 'Saving…'; el.classList.add('on'); }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (el) { el.textContent = 'Saved'; setTimeout(() => el.classList.remove('on'), 1200); }
    }, 400);
  }
  async function persistSettings(n, patch) {
    if (!projectId) return;
    queueSave();
    const r = await window.takeone.setStepSettings(root, projectId, n, patch);
    if (r && r.ok) {
      const g = await window.takeone.getProject(root, projectId);
      if (g.ok) project = g.project;
    }
  }

  // ------------------------------------------------------------------ boot
  async function init() {
    const cfg = await window.takeone.getConfig();
    if (!cfg) return;
    root = cfg.storageRoot;
    const lp = await window.takeone.listProjects(root);
    const projects = (lp.ok && lp.projects) || [];
    renderResume(projects);
    if (!projects.length) { renderNoProject(); return; }
    await openProject(projects[0].id);
  }

  async function openProject(id) {
    const g = await window.takeone.getProject(root, id);
    if (!g.ok) return;
    projectId = id;
    project = g.project;
    activeStep = project.currentStep || 1;
    renderAll();
  }

  async function refreshProject() {
    const g = await window.takeone.getProject(root, projectId);
    if (g.ok) { project = g.project; renderAll(); }
  }

  function renderAll() {
    renderThread();
    renderSteps();
    renderStepPanel();
    renderMoves();
    renderTools();
    renderQuickGen();
    renderVideoPanel();
  }

  // M1: Quick Generate lives in the Studio view ALWAYS — not only in the
  // no-project empty state. The UI audit caught it: with any project open,
  // renderAll never rendered #quickGen, so the whole feature vanished.
  // renderQuickGen appends the block once (guarded by #quickGen) and wires
  // it; renderNoProject and renderAll both call it. Re-renders never
  // duplicate it, and a wiped studioBody (empty hero) simply re-adds it.
  function renderQuickGen() {
    if (document.getElementById('quickGen')) return;
    const host = $('#studioBody');
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="quickgen" id="quickGen" style="margin-top:32px; padding:20px; border:1px solid var(--line); border-radius:12px; background:var(--panel);">
      <h3 style="margin:0 0 8px;">⚡ Quick Generate <span class="muted small">(engine test)</span></h3>
      <p class="muted small" style="margin:0 0 12px;">Test the local AI engine directly. Needs ComfyUI + an SDXL model in Models.</p>
      <textarea id="qgPrompt" rows="1" placeholder="A cinematic sunset over mountains…" style="width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:#fff; resize:none; overflow:hidden; font:inherit;"></textarea>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:12px 0;">
        <label class="muted small">Preset <select id="qgPreset"><option value="fast">Fast</option><option value="quality">Quality</option></select></label>
        <label class="muted small">Ratio <select id="qgAspect"><option value="1:1">1:1</option><option value="3:2">3:2</option><option value="16:9">16:9</option><option value="9:16">9:16</option></select></label>
        <label class="muted small">Variations <select id="qgVars"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
        <label class="muted small">Seed <input id="qgSeed" placeholder="Random" inputmode="numeric" style="width:90px; padding:6px 8px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:#fff;" /></label>
        <button class="primary" id="qgBtn">Generate</button>
        <button class="ghost" id="qgPackBtn">Run Ali pack (3 prompts × 3 settings, same seed)</button>
      </div>
      <p class="muted small" style="margin:0 0 12px;">Empty negative prompt? TakeOne adds a photoreal default (no blur, no bad anatomy, no text or watermark). Images land in the Library project “Quick Generate”, with thumbnails.</p>
      <div id="qgOut" class="muted small"></div>
    </div>`;
    host.appendChild(wrap.firstElementChild);
      // M1: auto-grow — the whole prompt stays visible, including a long
      // pasted one (grows to its content, capped at 400px, then scrolls).
      const qgPrompt = $('#qgPrompt');
      const qgBtn = $('#qgBtn');
      const qgAutoGrow = () => {
        if (!qgPrompt) return;
        qgPrompt.style.height = 'auto';
        qgPrompt.style.height = Math.min(qgPrompt.scrollHeight, 400) + 'px';
      };
      if (qgPrompt) qgPrompt.addEventListener('input', qgAutoGrow);
      let qgBusy = false;
      if (qgPrompt) qgPrompt.addEventListener('input', async () => {
        if (qgBusy) return;
        const txt = (qgPrompt.value || '').toLowerCase();
        const out = $('#qgOut');
        if (txt.length < 3 || !out || out.querySelector('img')) return;
        try {
          // Simple keyword context
          const ctx = txt.includes('cinematic') ? 'prompt:cinematic'
            : txt.includes('portrait') ? 'prompt:portrait'
            : txt.includes('landscape') ? 'prompt:landscape' : null;
          if (!ctx) return;
          const r = await window.takeone.brainSuggest(root, ctx, 2);
          if (r.ok && r.suggestions.length && !out.querySelector('img')) {
            const s = r.suggestions[0];
            out.innerHTML = `<span class="muted">💡 Brain suggests: ${esc(s.action.replace('suggest:', ''))} (learned from your past)</span>`;
          }
        } catch { /* brain optional */ }
      });
      // M1: one card per generated image — Copy prompt / Open folder /
      // Delete (Trash, 30 days). Cards append; status lives separately so a
      // later generation never wipes earlier results.
      function qgCard(f, promptText, metaLine) {
        const cards = document.getElementById('qgCards');
        if (!cards) return;
        const el = document.createElement('div');
        el.style.cssText = 'margin-top:12px; padding:12px; border:1px solid var(--line); border-radius:12px;';
        el.innerHTML = `<img src="${esc(f.dataUrl)}" style="max-width:100%; border-radius:8px;" />` +
          `<div style="margin-top:8px;"><b>Saved to Library</b> <span class="muted small">${esc(metaLine)} · ${esc(f.path)}</span></div>` +
          `<div class="row" style="margin-top:8px;"><button class="btn small" data-act="copy">Copy prompt</button>` +
          `<button class="btn small" data-act="folder">Open folder</button>` +
          `<button class="btn small" data-act="del">Delete</button></div>`;
        el.querySelector('[data-act="copy"]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          try { await window.takeone.copyText(promptText); btn.textContent = 'Copied!'; }
          catch { btn.textContent = 'Copy failed'; }
          setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2000);
        });
        el.querySelector('[data-act="folder"]').addEventListener('click', () => window.takeone.showInFolder(f.path));
        el.querySelector('[data-act="del"]').addEventListener('click', async () => {
          if (!confirm('Move this image to Trash? You can restore it within 30 days.')) return;
          const dr = await window.takeone.deleteQuickImage(root, f.path);
          if (!dr || !dr.ok) { alert((dr && dr.reason) || 'Could not delete.'); return; }
          el.remove();
        });
        cards.appendChild(el);
      }
      // Poll MAIN for one promptId until saved / failed / cancelled.
      // Returns the saved result, { __error } on a plain failure, or
      // { __timeout: true } on timeout; null ONLY on cancel. statusEl is
      // the TEXT span inside #qgStatus — writing it never wipes the Cancel
      // button, which lives in its own sibling span.
      async function qgPollOne(pid, promptText, cancelState, statusEl, label) {
        for (let i = 0; i < 150; i++) {
          await new Promise((res) => setTimeout(res, 5000));
          if (cancelState.cancelled) return null;
          const f = await window.takeone.comfyFetchOutput(root, pid, promptText);
          if (f && f.ok) return f;
          if (f && !f.notFinished) return { __error: f.error || 'failed' };
          statusEl.textContent = `${label} ${Math.floor((i + 1) * 5 / 60)}m ${((i + 1) * 5) % 60}s`;
        }
        return { __timeout: true };
      }
      function qgStatus(out) {
        out.innerHTML = '<div id="qgStatus"><span id="qgStatusText">Starting the engine…</span> <span id="qgStatusBtn"></span></div><div id="qgCards"></div>';
        return document.getElementById('qgStatusText');
      }
      if (qgBtn) qgBtn.addEventListener('click', async () => {
        const prompt = (qgPrompt || {}).value || '';
        const out = $('#qgOut');
        if (!prompt.trim()) { if (out) out.textContent = 'Pehle prompt likhein.'; return; }
        try {
          const low = prompt.toLowerCase();
          const ctx = low.includes('cinematic') ? 'prompt:cinematic'
            : low.includes('portrait') ? 'prompt:portrait'
            : low.includes('landscape') ? 'prompt:landscape' : 'prompt:general';
          await window.takeone.brainLearn(root, ctx, 'suggest:sdxl', 1);
        } catch { /* brain optional */ }
        qgBtn.disabled = true;
        qgBusy = true;
        const cancelState = { cancelled: false };
        try {
          const statusEl = qgStatus(out);
          statusEl.textContent = 'Starting the engine…';
          document.getElementById('qgStatusBtn').innerHTML = '<button class="btn small ghost2" id="qgCancel">Cancel</button>';
          document.getElementById('qgCancel').addEventListener('click', async () => {
            cancelState.cancelled = true;
            try { await window.takeone.comfyInterrupt(); } catch { /* best effort */ }
          });
          const preset = ($('#qgPreset') || {}).value || 'fast';
          const aspect = ($('#qgAspect') || {}).value || '1:1';
          const variations = parseInt((($('#qgVars') || {}).value || '1'), 10) || 1;
          const seedRaw = ((($('#qgSeed') || {}).value || '').trim());
          const r = await window.takeone.comfyGenerate(root, { prompt: prompt.trim(), preset, aspect, variations, seed: seedRaw });
          if (!r.ok) {
            if (r.engineMissing) {
              out.innerHTML = '<span>The AI engine isn\u2019t installed yet — it\u2019s a one-time setup.</span><br><button class="btn small" id="qgInstallEngine">Install the engine</button>';
              document.getElementById('qgInstallEngine').addEventListener('click', () => switchView('models'));
            } else if (r.modelNotVisible) {
              out.innerHTML = `<span>${esc(r.error)}</span><br><button class="btn small" id="qgModels">Open Models</button>`;
              document.getElementById('qgModels').addEventListener('click', () => switchView('models'));
            } else out.textContent = 'Error: ' + (r.error || r.reason || 'failed');
            return;
          }
          const pids = r.promptIds || [r.promptId];
          let done = 0;
          let firstError = null;
          let timedOut = false;
          for (let vi = 0; vi < pids.length; vi++) {
            if (cancelState.cancelled) { statusEl.textContent = 'Cancelled.'; return; }
            statusEl.textContent = `Generating… variation ${vi + 1}/${pids.length}`;
            const f = await qgPollOne(pids[vi], prompt.trim(), cancelState, statusEl, `Generating… variation ${vi + 1}/${pids.length} —`);
            if (cancelState.cancelled) { statusEl.textContent = 'Cancelled.'; return; }
            if (!f) { statusEl.textContent = 'Cancelled.'; return; }
            if (f.__error) { if (!firstError) firstError = f.__error; continue; }
            if (f.__timeout) { timedOut = true; continue; }
            done++;
            qgCard(f, prompt.trim(), `${preset} · ${aspect} · seed ${r.seed + vi}`);
          }
          statusEl.textContent = done
            ? `Done — ${done} image${done === 1 ? '' : 's'} saved to the Library project “Quick Generate”.`
            : firstError ? 'Error: ' + firstError
            : timedOut ? 'Timed out waiting for the engine.'
            : 'Nothing saved.';
        } catch (e) {
          if (out) out.textContent = 'Error: ' + (e.message || e);
        } finally {
          qgBtn.disabled = false;
          qgBusy = false;
          const bs = document.getElementById('qgStatusBtn');
          if (bs) bs.innerHTML = ''; // FIX-6: no dead Cancel after the run ends
        }
      });
      // M1: the Ali pack — 3 prompts × 3 settings, one seed. After all 9,
      // the renderer draws the 3×3 contact sheet on a canvas and saves it
      // into the Quick Generate project (main writes the file).
      const qgPackBtn = $('#qgPackBtn');
      if (qgPackBtn) qgPackBtn.addEventListener('click', async () => {
        const out = $('#qgOut');
        qgPackBtn.disabled = true;
        qgBusy = true;
        const cancelState = { cancelled: false };
        try {
          const statusEl = qgStatus(out);
          statusEl.textContent = 'Starting the engine for the Ali pack…';
          document.getElementById('qgStatusBtn').innerHTML = '<button class="btn small ghost2" id="qgPackCancel">Cancel</button>';
          document.getElementById('qgPackCancel').addEventListener('click', async () => {
            cancelState.cancelled = true;
            try { await window.takeone.comfyInterrupt(); } catch { /* best effort */ }
          });
          const seedRaw = ((($('#qgSeed') || {}).value || '').trim());
          const r = await window.takeone.comfyGeneratePack(root, { seed: seedRaw });
          if (!r.ok) {
            if (r.engineMissing) out.textContent = 'The AI engine isn\u2019t installed yet — it\u2019s a one-time setup.';
            else if (r.modelNotVisible) out.textContent = r.error;
            else out.textContent = 'Error: ' + (r.error || r.reason || 'failed');
            return;
          }
          statusEl.textContent = `Ali pack queued — 9 images, one seed (${r.seed}). This takes a few minutes.`;
          const results = [];
          for (let ji = 0; ji < r.jobs.length; ji++) {
            const job = r.jobs[ji];
            if (cancelState.cancelled) { statusEl.textContent = 'Cancelled.'; return; }
            const f = await qgPollOne(job.promptId, job.prompt, cancelState, statusEl, `Ali pack ${ji + 1}/9 —`);
            if (cancelState.cancelled) { statusEl.textContent = 'Cancelled.'; return; }
            results.push(f ? { ...job, dataUrl: f.dataUrl, path: f.path } : { ...job, dataUrl: null });
            statusEl.textContent = `Ali pack: ${ji + 1}/9 done.`;
          }
          // FIX-5: the shared drawer — equal cells, contain-fit (no
          // square crop), clean label strips (3 prompts as rows, 3
          // settings as columns).
          const canvas = document.createElement('canvas');
          await window.TakeOneContactSheet.drawSheet(canvas,
            results.map((res) => ({ image: res.dataUrl || null, label: `${res.preset} ${res.aspect}` })), 3);
          const sheetUrl = canvas.toDataURL('image/png');
          const sr = await window.takeone.saveContactSheet(root, sheetUrl);
          const cards = document.getElementById('qgCards');
          if (cards) {
            const el = document.createElement('div');
            el.style.cssText = 'margin-top:12px; padding:12px; border:1px solid var(--line); border-radius:12px;';
            el.innerHTML = `<img src="${esc(sheetUrl)}" style="max-width:100%; border-radius:8px;" />` +
              `<div style="margin-top:8px;"><b>Ali pack contact sheet</b> <span class="muted small">${sr && sr.ok ? esc(sr.path) : 'could not be saved — the sheet above is still yours to screenshot'}</span></div>` +
              (sr && sr.ok ? `<button class="btn small" id="qgSheetFolder">Open folder</button>` : '');
            cards.appendChild(el);
            const sf = document.getElementById('qgSheetFolder');
            if (sf) sf.addEventListener('click', () => window.takeone.showInFolder(sr.path));
          }
          const failed = results.filter((x) => !x.dataUrl).length;
          statusEl.textContent = failed
            ? `Ali pack done — ${9 - failed}/9 saved. ${failed} failed (plain errors were shown while polling).`
            : 'Ali pack done — 9/9 saved to the Library project “Quick Generate”.';
        } catch (e) {
          if (out) out.textContent = 'Error: ' + (e.message || e);
        } finally {
          qgPackBtn.disabled = false;
          qgBusy = false;
          const bs = document.getElementById('qgStatusBtn');
          if (bs) bs.innerHTML = ''; // FIX-6: no dead Cancel after the pack ends
        }
      });
  }


  // M2: Video Studio panel — Wan 2.2 TI2V-5B, text-to-video and
  // image-to-video from a Library image. Lives in the Studio view ALWAYS
  // (same lesson as M1's Quick Generate: renderAll AND renderNoProject
  // both call it, guarded by #videoPanel). The Models page still shows
  // "Coming soon" until the first GPU render goes green (M2.6); this
  // panel is the trial path — it says so plainly and lets the model
  // download here, because without that download the trial can never
  // happen. Results land in the open project's videos/ (or the Quick
  // Generate project), so the Library shows them like any asset.
  function renderVideoPanel() {
    if (document.getElementById('videoPanel')) return;
    const host = $('#studioBody');
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="quickgen" id="videoPanel" style="margin-top:32px; padding:20px; border:1px solid var(--line); border-radius:12px; background:var(--panel);">
      <h3 style="margin:0 0 8px;">🎬 Video Studio <span class="muted small">(Wan 2.2 TI2V-5B)</span></h3>
      <p class="muted small" id="videoStatusNote" style="margin:0 0 12px;">Checking video memory…</p>
      <textarea id="videoPrompt" rows="1" placeholder="A slow aerial shot over ocean waves at sunset…" style="width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:#fff; resize:none; overflow:hidden; font:inherit;"></textarea>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:12px 0;">
        <label class="muted small">Mode <select id="videoMode"><option value="t2v">Text → Video</option><option value="i2v">Image → Video</option></select></label>
        <label class="muted small" id="videoImageWrap" style="display:none;">Image <select id="videoImage"><option value="">Loading Library images…</option></select></label>
        <label class="muted small">Length <select id="videoDur"><option value="2">2s</option><option value="4">4s</option></select></label>
        <label class="muted small">Size <select id="videoRes"><option value="480p">480p</option><option value="720p">720p</option></select></label>
        <label class="muted small">Seed <input id="videoSeed" placeholder="Random" inputmode="numeric" style="width:90px; padding:6px 8px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:#fff;" /></label>
        <button class="primary" id="videoGenBtn" disabled>Generate video</button>
        <button class="ghost" id="videoPackBtn" disabled>Run video Ali pack (2 prompts × 2 settings)</button>
      </div>
      <div id="videoDl" class="muted small"></div>
      <div id="videoOut" class="muted small"></div>
    </div>`;
    host.appendChild(wrap.firstElementChild);
    const vPrompt = $('#videoPrompt');
    const vGenBtn = $('#videoGenBtn');
    const vPackBtn = $('#videoPackBtn');
    const vOut = $('#videoOut');
    const vDl = $('#videoDl');
    const vAutoGrow = () => {
      if (!vPrompt) return;
      vPrompt.style.height = 'auto';
      vPrompt.style.height = Math.min(vPrompt.scrollHeight, 400) + 'px';
    };
    if (vPrompt) vPrompt.addEventListener('input', vAutoGrow);
    let vBusy = false;
    let vInstalled = false;
    let vDlPoll = null;
    let expVideo = false; // M2.6-ENABLE: default OFF until the setting loads
    let videoSpeed = null; // round22: PC-check speed for the download estimate
    let videoSizeMB = null; // round22: cached catalog sizeMB for video-studio
    // The switch lives in Settings; toggling relaunches the app, so one
    // load here is enough (no live re-read needed).
    window.takeone.getConfig().then((c) => {
      expVideo = !!(c && c.settings && c.settings.experimentalVideo);
      videoSpeed = (c && c.pcCheck && c.pcCheck.speedMbps) || null;
      refreshVideoState();
    }).catch(() => {});
    async function refreshVideoState() {
      try {
        const vc = await window.takeone.videoVramCheck(root);
        const note = $('#videoStatusNote');
        if (note) note.textContent = (vc && vc.text) || '';
      } catch { /* VRAM note optional */ }
      try {
        const st = await window.takeone.toolStates(root);
        const vs = st && st['video-studio'];
        if (!expVideo) {
          // M2.6-ENABLE OFF: video stays "Coming soon" — no download
          // offer, no generate, no pack. The old trial path now lives
          // behind the switch.
          vInstalled = false;
          if (vGenBtn) vGenBtn.disabled = true;
          if (vPackBtn) vPackBtn.disabled = true;
          if (vDl) vDl.innerHTML = '<span>Coming soon. Video is experimental and switched off — turn on “Experimental: early video” in Settings to try it before its first real clip is proven.</span>';
          return;
        }
        if (vs && vs.state === 'installed') {
          vInstalled = true;
          if (vGenBtn) vGenBtn.disabled = false;
          if (vPackBtn) vPackBtn.disabled = false;
          if (vDl) vDl.innerHTML = '<span>Video Studio is installed. Trial status: its first real clip on a GPU PC has not run yet — if a generation fails, that failure is useful evidence, not a surprise.</span>';
        } else {
          vInstalled = false;
          if (vGenBtn) vGenBtn.disabled = true;
          if (vPackBtn) vPackBtn.disabled = true;
          const prog = vs && vs.state === 'installing' ? ` — downloading… ${Math.round(vs.progress || 0)}%` : '';
          const err = vs && vs.error ? ` <span>Last attempt: ${esc(vs.error)}</span>` : '';
          // Round22: same plain-words estimate + pause/resume note as the
          // Models card, but ONLY when a fresh download is on offer
          // (not-installed/failed) — never mid-download, where a total
          // time would read as time remaining. Size from the catalog
          // (cached); no measured speed -> time claim omitted, note kept.
          const offer = !vs || vs.state === 'not-installed' || vs.state === 'failed';
          let estTxt = ' You can pause and resume.';
          if (offer) {
            if (videoSizeMB == null && window.takeone.catalog) {
              try {
                const cat = await window.takeone.catalog();
                const t = (cat && cat.catalog || []).find((x) => x.id === 'video-studio');
                if (t) videoSizeMB = t.sizeMB;
              } catch { /* size stays unknown */ }
            }
            const est = (window.TakeOneDownloadEstimate && videoSizeMB)
              ? window.TakeOneDownloadEstimate.formatDownloadEstimate(videoSizeMB, videoSpeed) : null;
            if (est) estTxt = ` ${est.charAt(0).toUpperCase() + est.slice(1)}. You can pause and resume.`;
          }
          if (vDl) vDl.innerHTML = `<span>Video Studio isn't installed yet (~34 GB).${estTxt} Trial status: its first real clip on a GPU PC has not run yet — the download below is how that trial happens; the Models page still shows Coming soon until it goes green.${prog}${err}</span><br><button class="btn small" id="videoDlBtn">Download video model</button>`;
          const dlBtn = document.getElementById('videoDlBtn');
          if (dlBtn) dlBtn.addEventListener('click', async () => {
            dlBtn.disabled = true;
            try { await window.takeone.dlStart('video-studio', root); } catch { /* state poll shows it */ }
            if (vDlPoll) clearInterval(vDlPoll);
            vDlPoll = setInterval(refreshVideoState, 5000);
          });
        }
      } catch { /* state optional */ }
    }
    refreshVideoState();
    const vMode = $('#videoMode');
    const vImgWrap = $('#videoImageWrap');
    const vImgSel = $('#videoImage');
    if (vMode) vMode.addEventListener('change', async () => {
      const isI2V = vMode.value === 'i2v';
      if (vImgWrap) vImgWrap.style.display = isI2V ? '' : 'none';
      if (!isI2V || !vImgSel || vImgSel.dataset.loaded) return;
      try {
        const pr = await window.takeone.listProjects(root);
        const opts = [];
        for (const p of (pr.projects || [])) {
          const la = await window.takeone.listAssets(root, p.id);
          for (const a of ((la && la.assets) || [])) {
            if (a.type === 'images' && opts.length < 100) opts.push({ v: `${p.id}|${a.rel}`, label: `${p.name} / ${a.fileName}` });
          }
        }
        vImgSel.innerHTML = opts.length
          ? opts.map((o) => `<option value="${esc(o.v)}">${esc(o.label)}</option>`).join('')
          : '<option value="">No Library images yet — generate one with Quick Generate first.</option>';
        vImgSel.dataset.loaded = '1';
      } catch {
        if (vImgSel) vImgSel.innerHTML = '<option value="">Could not list Library images.</option>';
      }
    });
    function videoCard(f, promptText, metaLine) {
      const out = $('#videoOut');
      if (!out) return;
      const el = document.createElement('div');
      el.style.cssText = 'margin-top:12px; padding:12px; border:1px solid var(--line); border-radius:12px;';
      el.innerHTML = `<video controls preload="metadata" style="max-width:100%; border-radius:8px; background:#000;"><source src="${esc(f.dataUrl)}" type="video/mp4" /></video>` +
        `<div style="margin-top:8px;"><b>Saved to Library</b> <span class="muted small">${esc(metaLine)} · ${esc(f.path)}</span></div>` +
        `<div class="row" style="margin-top:8px;"><button class="btn small" data-act="copy">Copy prompt</button>` +
        `<button class="btn small" data-act="folder">Open folder</button></div>` +
        `<div class="muted small" data-thumb></div>`;
      el.querySelector('[data-act="copy"]').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        try { await window.takeone.copyText(promptText); btn.textContent = 'Copied!'; }
        catch { btn.textContent = 'Copy failed'; }
        setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2000);
      });
      el.querySelector('[data-act="folder"]').addEventListener('click', () => window.takeone.showInFolder(f.path));
      out.appendChild(el);
      // First-frame thumbnail (canvas from the playing preview) next to
      // the mp4. Failing here never loses the video — it just skips.
      try {
        const vid = el.querySelector('video');
        const grab = async () => {
          try {
            vid.muted = true;
            await vid.play().catch(() => {});
            await new Promise((res) => setTimeout(res, 500));
            vid.pause();
            const canvas = document.createElement('canvas');
            const w = Math.min(vid.videoWidth || 640, 640);
            const h = vid.videoHeight ? Math.round(vid.videoHeight * (w / vid.videoWidth)) : 360;
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(vid, 0, 0, w, h);
            const base = f.fileName.replace(/\.mp4$/i, '');
            const tr = await window.takeone.saveVideoThumbnail(root, f.projectId, base, canvas.toDataURL('image/png'));
            const th = el.querySelector('[data-thumb]');
            if (th) th.textContent = tr && tr.ok ? 'Thumbnail saved next to the video.' : 'Thumbnail unavailable — the video itself is saved.';
          } catch { /* thumbnail optional */ }
        };
        if (vid.readyState >= 2) grab();
        else vid.addEventListener('loadeddata', grab, { once: true });
      } catch { /* thumbnail optional */ }
    }
    async function videoPollOne(pid, cancelState, statusEl, label) {
      for (let i = 0; i < 360; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        if (cancelState.cancelled) return null;
        const f = await window.takeone.comfyFetchVideoOutput(root, pid);
        if (f && f.ok) return f;
        if (f && !f.notFinished) return { __error: f.error || 'failed' };
        statusEl.textContent = `${label} ${Math.floor((i + 1) * 5 / 60)}m ${((i + 1) * 5) % 60}s`;
      }
      return { __timeout: true };
    }
    function videoStatus(out) {
      out.innerHTML = '<div id="videoStatus"><span id="videoStatusText">Starting the engine…</span> <span id="videoStatusBtn"></span></div><div id="videoCards"></div>';
      return document.getElementById('videoStatusText');
    }
    if (vGenBtn) vGenBtn.addEventListener('click', async () => {
      const prompt = (vPrompt || {}).value || '';
      if (!prompt.trim()) { if (vOut) vOut.textContent = 'Pehle prompt likhein.'; return; }
      if (!vInstalled) { if (vOut) vOut.textContent = 'Video Studio is not installed yet — download it above first.'; return; }
      vGenBtn.disabled = true;
      vBusy = true;
      const cancelState = { cancelled: false };
      try {
        const statusEl = videoStatus(vOut);
        statusEl.textContent = 'Starting the engine…';
        document.getElementById('videoStatusBtn').innerHTML = '<button class="btn small ghost2" id="videoCancel">Cancel</button>';
        document.getElementById('videoCancel').addEventListener('click', async () => {
          cancelState.cancelled = true;
          try { await window.takeone.comfyInterrupt(); } catch { /* best effort */ }
        });
        const mode = (vMode || {}).value || 't2v';
        let imageRel = null, imageProjectId = null;
        if (mode === 'i2v') {
          const sel = ((vImgSel || {}).value || '');
          const parts = sel.split('|');
          if (parts.length === 2) [imageProjectId, imageRel] = parts;
          if (!imageRel || !imageProjectId) { statusEl.textContent = 'Image → Video needs a Library image — pick one above.'; return; }
        }
        const dur = parseInt(((($('#videoDur') || {}).value || '2')), 10) || 2;
        const res = ((($('#videoRes') || {}).value || '480p'));
        const seedRaw = ((($('#videoSeed') || {}).value || '').trim());
        const r = await window.takeone.comfyGenerateVideo(root, {
          prompt: prompt.trim(), projectId, imageRel, imageProjectId,
          duration: dur, resolution: res, seed: seedRaw,
        });
        if (!r.ok) {
          if (r.engineMissing) statusEl.textContent = 'The AI engine isn\u2019t installed yet — it\u2019s a one-time setup.';
          else if (r.action === 'video-download') { statusEl.textContent = r.error; refreshVideoState(); }
          else statusEl.textContent = 'Error: ' + (r.error || r.reason || 'failed');
          return;
        }
        statusEl.textContent = 'Generating video… (this takes minutes — a short clip first is the honest test)';
        const f = await videoPollOne(r.promptId, cancelState, statusEl, 'Generating video —');
        if (cancelState.cancelled || !f) { statusEl.textContent = 'Cancelled.'; return; }
        if (f.__error) { statusEl.textContent = 'Error: ' + f.__error; return; }
        if (f.__timeout) { statusEl.textContent = 'Timed out waiting for the engine (30 minutes).'; return; }
        videoCard(f, prompt.trim(), `${res} · ${dur}s · seed ${r.seed}`);
        statusEl.textContent = 'Done — video saved to the Library.';
      } catch (e) {
        if (vOut) vOut.textContent = 'Error: ' + (e.message || e);
      } finally {
        vGenBtn.disabled = false;
        vBusy = false;
        const bs = document.getElementById('videoStatusBtn');
        if (bs) bs.innerHTML = ''; // FIX-6: no dead Cancel after the run ends
      }
    });
    // M2.6: the video Ali pack — 2 prompts x 2 settings, one seed. After
    // all 4, the renderer draws first frames into a 2x2 contact sheet
    // and saves it (contact_sheet_video.png) next to the clips.
    if (vPackBtn) vPackBtn.addEventListener('click', async () => {
      if (!vInstalled) { if (vOut) vOut.textContent = 'Video Studio is not installed yet — download it above first.'; return; }
      vPackBtn.disabled = true;
      vBusy = true;
      const cancelState = { cancelled: false };
      try {
        const statusEl = videoStatus(vOut);
        statusEl.textContent = 'Starting the engine for the video Ali pack…';
        document.getElementById('videoStatusBtn').innerHTML = '<button class="btn small ghost2" id="videoPackCancel">Cancel</button>';
        document.getElementById('videoPackCancel').addEventListener('click', async () => {
          cancelState.cancelled = true;
          try { await window.takeone.comfyInterrupt(); } catch { /* best effort */ }
        });
        const seedRaw = ((($('#videoSeed') || {}).value || '').trim());
        const r = await window.takeone.comfyGenerateVideoPack(root, { seed: seedRaw, projectId });
        if (!r.ok) {
          if (r.engineMissing) statusEl.textContent = 'The AI engine isn\u2019t installed yet — it\u2019s a one-time setup.';
          else statusEl.textContent = 'Error: ' + (r.error || r.reason || 'failed');
          return;
        }
        statusEl.textContent = `Video Ali pack queued — 4 clips, one seed (${r.seed}). This takes a while; each clip renders in turn.`;
        const results = [];
        for (let ji = 0; ji < r.jobs.length; ji++) {
          const job = r.jobs[ji];
          if (cancelState.cancelled) { statusEl.textContent = 'Cancelled.'; return; }
          const f = await videoPollOne(job.promptId, cancelState, statusEl, `Video Ali pack ${ji + 1}/4 —`);
          if (cancelState.cancelled) { statusEl.textContent = 'Cancelled.'; return; }
          results.push(f && f.ok ? { ...job, dataUrl: f.dataUrl, path: f.path, projectId: f.projectId } : { ...job, dataUrl: null });
          statusEl.textContent = `Video Ali pack: ${ji + 1}/4 done.`;
        }
        const firstFrame = (dataUrl) => new Promise((resolve) => {
          try {
            const vid = document.createElement('video');
            vid.muted = true; vid.preload = 'auto'; vid.src = dataUrl;
            const done = (ok) => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = vid.videoWidth || 640; canvas.height = vid.videoHeight || 360;
                if (ok) canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
                resolve(ok ? canvas : null);
              } catch { resolve(null); }
            };
            const timer = setTimeout(() => done(false), 30000);
            vid.addEventListener('loadeddata', async () => {
              try { await vid.play().catch(() => {}); } catch {}
              setTimeout(() => { clearTimeout(timer); vid.pause(); done(true); }, 500);
            }, { once: true });
            vid.addEventListener('error', () => { clearTimeout(timer); done(false); }, { once: true });
          } catch { resolve(null); }
        });
        // FIX-5: the shared drawer — equal cells, contain-fit (no
        // square crop), clean label strips.
        const frames = [];
        for (let i = 0; i < 4; i++) {
          const res = results[i] || {};
          frames.push(res.dataUrl ? await firstFrame(res.dataUrl) : null);
        }
        const canvas = document.createElement('canvas');
        await window.TakeOneContactSheet.drawSheet(canvas,
          results.map((res, i) => ({ image: frames[i], label: `${(res || {}).resolution || ''} ${(res || {}).duration || ''}s` })), 2);
        const sheetUrl = canvas.toDataURL('image/png');
        const sr = await window.takeone.saveVideoContactSheet(root, r.projectId, sheetUrl);
        const cards = document.getElementById('videoCards');
        if (cards) {
          const el = document.createElement('div');
          el.style.cssText = 'margin-top:12px; padding:12px; border:1px solid var(--line); border-radius:12px;';
          el.innerHTML = `<img src="${esc(sheetUrl)}" style="max-width:100%; border-radius:8px;" />` +
            `<div style="margin-top:8px;"><b>Video Ali pack contact sheet</b> <span class="muted small">${sr && sr.ok ? esc(sr.path) : 'could not be saved — the sheet above is still yours to screenshot'}</span></div>` +
            (sr && sr.ok ? `<button class="btn small" id="videoSheetFolder">Open folder</button>` : '');
          cards.appendChild(el);
          const sf = document.getElementById('videoSheetFolder');
          if (sf) sf.addEventListener('click', () => window.takeone.showInFolder(sr.path));
        }
        const failed = results.filter((x) => !x.dataUrl).length;
        statusEl.textContent = failed
          ? `Video Ali pack done — ${4 - failed}/4 saved. ${failed} failed.`
          : 'Video Ali pack done — 4/4 saved.';
      } catch (e) {
        if (vOut) vOut.textContent = 'Error: ' + (e.message || e);
      } finally {
        vPackBtn.disabled = false;
        vBusy = false;
        const bs = document.getElementById('videoStatusBtn');
        if (bs) bs.innerHTML = ''; // FIX-6: no dead Cancel after the pack ends
      }
    });
  }


  // ------------------------------------------------------- empty state
  // Honest and alive: no fake projects, no dead ends, no black screens.
  // If no AI tools are installed yet, the first CTA leads to Models —
  // creating a project that can't render would be a dead end.
  async function renderNoProject() {
    let installedCount = 0;
    try {
      const ts = await window.takeone.toolStates(root);
      if (ts.ok) installedCount = Object.values(ts.states || {}).filter(x => x.state === 'installed').length;
    } catch {}
    // Real readiness per step: which installed tool powers it (catalog truth).
    const STEP_TOOLS = {
      0: ['brain'],
      1: ['image-studio', 'image-lite'],
      2: ['video-studio', 'video-quality'],
      3: [], // Director is built-in — always ready
      4: ['voice-studio', 'voice-lite'],
      5: [], // Final export is built-in — always ready
    };
    const steps = [
      ['Prompt', 'Shape the idea — brief or script analysis'],
      ['Image', 'Create the key visuals'],
      ['Animate', 'Bring stills to motion'],
      ['Director', 'Assemble the sequence'],
      ['Voice', 'Add narration and voice'],
      ['Final', 'Export the finished film'],
    ];
    let toolStates = {};
    try {
      const ts = await window.takeone.toolStates(root);
      if (ts.ok) toolStates = ts.states || {};
    } catch {}
    // WO-41.5: the Image step does NOT re-derive readiness from the file
    // badge — it uses imageStepReady (engineReady && image-studio
    // installed), the same fact the Models badge + engine chain rest on.
    // A missing engine therefore reads as "Engine not ready", never as
    // "Needs a tool" next to an "Installed" badge.
    let imageReady = null;
    try {
      if (window.takeone.imageStepReady) {
        const ir = await window.takeone.imageStepReady(root);
        if (ir && ir.ok) imageReady = ir;
      }
    } catch {}
    let CAT = [];
    try { const c = await window.takeone.catalog(); if (c && c.ok) CAT = c.catalog || []; } catch {}
    const preview = '<div class="pipe-preview">' + steps.map((s, i) => {
      const ids = STEP_TOOLS[i] || [];
      const toolInfos = ids.map((id) => ({ id, st: toolStates[id] || {} }));
      const readyTool = toolInfos.find((x) => x.st.state === 'installed');
      const readyName = readyTool ? (CAT.find((t) => t.id === readyTool.id) || {}).friendlyName : null;
      let badge;
      if (i === 1 && imageReady) {
        if (imageReady.ready) badge = '<span class="pp-ready">Ready — Image Studio</span>';
        else if (imageReady.modelInstalled) badge = '<span class="pp-warn" data-goto="models">Engine not ready — install it in Models</span>';
        else badge = '<span class="pp-missing" data-goto="models">Needs a tool — get it</span>';
      } else if (ids.length === 0) {
        badge = '<span class="pp-ready">Ready — built in</span>';
      } else if (readyName) {
        badge = `<span class="pp-ready">Ready — ${esc(readyName)}</span>`;
      } else {
        // Honest state: what actually happened with this step's tools?
        const active = toolInfos.find((x) => ['downloading', 'installing', 'queued', 'verifying'].includes(x.st.state));
        const interrupted = toolInfos.find((x) => ['paused', 'interrupted'].includes(x.st.state));
        const failed = toolInfos.find((x) => x.st.state === 'failed');
        if (active) badge = `<span class="pp-working" data-goto="models">Working — ${esc(active.st.state)}…</span>`;
        else if (interrupted) badge = '<span class="pp-warn" data-goto="models">Paused — resume in Models</span>';
        else if (failed) badge = '<span class="pp-warn" data-goto="models">Failed — try again in Models</span>';
        else badge = '<span class="pp-missing" data-goto="models">Needs a tool — get it</span>';
      }
      return `<div class="pp-step"><span class="pp-n">${i + 1}</span><b>${s[0]}</b><span>${s[1]}</span>${badge}</div>`;
    }).join('') + '</div>';
    const noTools = installedCount === 0;
    $('#studioBody').innerHTML = `
      <div class="empty-hero">
        <h2>${noTools ? 'Your studio is ready' : 'No project yet'}</h2>
        <p class="lede">${noTools
          ? 'One step before your first film: download the AI tools it will run on. Each shows its exact size first.'
          : 'A project is one film\u2019s permanent home — its brief, images, clips, voice and exports stay together.'}</p>
        ${noTools ? `<div class="need-tools">
          <b>No AI tools installed yet.</b>
          <p class="muted">A project without tools can\u2019t render anything — so start here instead.</p>
          <button class="primary" id="npTools">Browse AI tools</button>
        </div>` : ''}
        <div class="hero-ctas">
          <button class="primary" id="npScript">Start from a script</button>
          <button class="ghost" id="npCreate">New project</button>
        </div>
        <h3 class="pp-title">From one brief to the final master — every step feeds the next</h3>
        ${preview}
      </div>`;
    const goTools = $('#npTools');
    if (goTools) goTools.addEventListener('click', () => switchView('models'));
    document.querySelectorAll('.pp-missing, .pp-warn').forEach((b) =>
      b.addEventListener('click', () => switchView('models')));
    $('#npCreate').addEventListener('click', newProjectDialog);
    renderQuickGen();
    renderVideoPanel();
    $('#npScript').addEventListener('click', async () => {
      const name = await promptModal('New project', 'Project name');
      if (name === null) return;
      const r = await window.takeone.createProject(root, name);
      if (!r.ok) { notice(r.reason || 'Could not create the project.'); return; }
      await openProject(r.project.id);
      activeStep = 1;
      renderSteps(); renderStepPanel();
    });
  }

  async function newProjectDialog() {
    const name = await promptModal('New project', 'Project name');
    if (name === null) return;
    const r = await window.takeone.createProject(root, name);
    if (!r.ok) { notice(r.reason || 'Could not create the project.'); return; }
    const lp = await window.takeone.listProjects(root);
    const projects = (lp.ok && lp.projects) || [];
    const isFirst = projects.length <= 1;
    renderResume(projects);
    await openProject(r.project.id);
    if (isFirst) maybeAskNiche();
  }

  // Niche is asked once, contextually, at the first project — never in the
  // wizard. It tunes suggestions only; Skip is always available.
  const NICHES = ['Short Films', 'History Documentaries', 'Wedding Films', 'Real Estate', 'Product Ads', 'Vlogs', 'Horror Shorts'];
  async function maybeAskNiche() {
    const cfg = await window.takeone.getConfig();
    if (cfg && cfg.niche && cfg.niche !== 'none') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-back';
    overlay.innerHTML = `<div class="modal"><h2>What kind of films do you make?</h2>
      <p class="muted">This tunes suggestions and defaults for this project. It never locks tools or hides features — skip any time.</p>
      <div class="chips" id="nichePick" style="margin:14px 0"></div>
      <div class="mactions"><button class="ghost" id="nicheSkip">Skip</button></div></div>`;
    document.body.appendChild(overlay);
    const close = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
    $('#nichePick', overlay).innerHTML = NICHES.map((n) =>
      `<button class="chip" data-n="${esc(n)}">${esc(n)}</button>`).join('');
    $$('#nichePick .chip', overlay).forEach((c) => c.addEventListener('click', async () => {
      await window.takeone.setNiche(root, c.dataset.n);
      close();
    }));
    $('#nicheSkip', overlay).addEventListener('click', close);
  }

  // ------------------------------------------------------- resume strip
  async function renderResume(projects) {
    const box = $('#resumeStrip');
    const r = await window.takeone.resumeState(root);
    if (!r.ok || !r.resume) { box.hidden = true; box.innerHTML = ''; return; }
    const rs = r.resume;
    box.hidden = false;
    box.innerHTML = `
      <div><b>Pick up where you left off</b>
      <span class="muted">${esc(rs.projectName)} · Step ${rs.stepN} — ${esc(rs.stepName)} · ${rs.readySteps} step${rs.readySteps === 1 ? '' : 's'} ready</span></div>
      <button class="primary sm" id="rsGo">Resume</button>`;
    $('#rsGo').addEventListener('click', async () => {
      await openProject(rs.projectId);
      activeStep = rs.stepN;
      renderSteps(); renderStepPanel();
      switchView('studio');
    });
  }

  // Undo-toast (decision #47): for common undoable ops, a quiet toast with
  // Undo beats a warning dialog. Exposed globally for library/models views.
  let toastTimer = null;
  function toast(msg, actionLabel, actionFn, ms) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerHTML = `<span>${msg}</span>` + (actionLabel
      ? ` <button class="link" id="toastAct">${actionLabel}</button>` : '');
    t.hidden = false;
    const act = document.getElementById('toastAct');
    if (act) act.addEventListener('click', () => { clearTimeout(toastTimer); t.hidden = true; actionFn(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 8000);
  }
  window.takeoneToast = toast;

  function switchView(name) {
    $$('.railbtn').forEach((x) => x.classList.toggle('active', x.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
    // FIX-4: the Library re-reads from disk every time it opens. The old
    // code rendered it once at page load, so a project created afterwards
    // (e.g. by Quick Generate) never appeared until relaunch — the exact
    // "Library empty jabke project maujood" report.
    if (name === 'library' && window.takeoneLibraryRefresh) window.takeoneLibraryRefresh();
  }

  // ------------------------------------------------------- project thread
  function renderThread() {
    const box = $('#threadStrip');
    const t = projectThreadLocal();
    const locks = (project.lockedDecisions || []).map((d, i) =>
      `<span class="lockchip">${esc(d)}<button data-lock="${i}" aria-label="Remove lock">×</button></span>`).join('');
    box.innerHTML = `
      <div class="thread-top">
        <div class="thread-idea">
          <span class="tlabel">ORIGINAL IDEA</span>
          <input id="ideaInput" placeholder="One line — what is this film about?" value="${esc(project.originalIdea || '')}">
        </div>
        <div class="thread-cur">
          <span class="tlabel">CURRENT</span>
          <b>Step ${t.current.n} — ${esc(t.current.name)}</b>
          <span class="muted">${t.readyCount}/6 steps ready</span>
        </div>
        <div class="thread-proj">
          <span class="tlabel">PROJECT</span>
          <select id="projSwitch">${''}</select>
        </div>
      </div>
      <div class="thread-locks">
        <span class="tlabel">LOCKED DECISIONS</span>
        <span id="lockChips">${locks || '<span class="muted">None yet — lock style, palette, pacing and they will hold every step.</span>'}</span>
        <button class="ghost sm" id="lockAdd">+ Lock a decision</button>
      </div>
      <div class="thread-left"><span class="tlabel">WHAT'S LEFT</span><span>${t.whatsLeft.length ? esc(t.whatsLeft.join(' · ')) : 'Nothing — this film is complete.'}</span></div>`;
    fillProjectSwitch();
    $('#ideaInput').addEventListener('change', async (e) => {
      await window.takeone.updateProject(root, projectId, { originalIdea: e.target.value });
      queueSave(); refreshProject();
    });
    $$('#lockChips [data-lock]').forEach((b) => b.addEventListener('click', async () => {
      const locks2 = [...(project.lockedDecisions || [])];
      locks2.splice(parseInt(b.dataset.lock, 10), 1);
      await window.takeone.updateProject(root, projectId, { lockedDecisions: locks2 });
      refreshProject();
    }));
    $('#lockAdd').addEventListener('click', async () => {
      const v = await promptModal('Lock a decision', 'e.g. Dawn palette');
      if (!v || !v.trim()) return;
      const locks2 = [...(project.lockedDecisions || []), v.trim().slice(0, 120)].slice(0, 12);
      await window.takeone.updateProject(root, projectId, { lockedDecisions: locks2 });
      refreshProject();
    });
    $('#projSwitch').addEventListener('change', (e) => openProject(e.target.value));
  }

  async function fillProjectSwitch() {
    const lp = await window.takeone.listProjects(root);
    const sel = $('#projSwitch');
    if (!sel || !lp.ok) return;
    sel.innerHTML = lp.projects.map((p) =>
      `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  }

  function projectThreadLocal() {
    // mirror of main projectThread for instant render (main is source of truth on refresh)
    const steps = project.steps || {};
    let current = 1;
    for (let n = 1; n <= 6; n++) if (steps[n] && steps[n].status !== 'empty') current = Math.min(6, n + 1);
    const whatsLeft = [];
    for (let n = current; n <= 6; n++) if (!steps[n] || steps[n].status !== 'ready') whatsLeft.push(`${STEP_NAMES[n - 1]} → ${STEP_FROM_TO[n - 1][1]}`);
    return {
      current: { n: current, name: STEP_NAMES[current - 1] },
      whatsLeft,
      readyCount: STEP_NAMES.filter((_, i) => steps[i + 1] && steps[i + 1].status === 'ready').length,
    };
  }

  // ------------------------------------------------------- step rail
  function renderSteps() {
    const box = $('#stepRail');
    box.innerHTML = STEP_NAMES.map((name, i) => {
      const n = i + 1;
      const st = (project.steps || {})[n] || {};
      const badge = st.status === 'ready' ? '<span class="sbadge ready">Ready</span>'
        : st.status === 'failed' ? '<span class="sbadge failed">Failed</span>' : '<span class="sbadge">Empty</span>';
      const sub = st.status === 'ready' && st.finishedAt ? `<span class="stime">${esc(fmtDate(st.finishedAt))}${st.durationMs != null ? ' · ' + esc(fmtDur(st.durationMs)) : ''}</span>` : '';
      return `<button class="stepbtn ${activeStep === n ? 'active' : ''}" data-step="${n}">
        <span class="snum">STEP 0${n}</span><b>${esc(name)}</b>${badge}${sub}
        <span class="sflow">${esc(STEP_FROM_TO[i][0])} → ${esc(STEP_FROM_TO[i][1])}</span>
      </button>${n < 6 ? '<span class="sconn">→</span>' : ''}`;
    }).join('');
    $$('#stepRail .stepbtn').forEach((b) => b.addEventListener('click', () => {
      activeStep = parseInt(b.dataset.step, 10);
      renderSteps(); renderStepPanel();
    }));
  }

  // ------------------------------------------------------- step panel
  function statusBadge(st) {
    if (!st || st.status === 'empty') return '<span class="sbadge">Empty</span>';
    if (st.status === 'failed') return '<span class="sbadge failed">Failed</span>';
    return '<span class="sbadge ready">Ready</span>';
  }

  function renderStepPanel() {
    const n = activeStep;
    const st = (project.steps || {})[n] || {};
    const box = $('#stepPanel');
    let html = `<div class="phead"><div><h2>Step 0${n} — ${esc(STEP_NAMES[n - 1])}</h2>
      <p class="muted">${esc(STEP_FROM_TO[n - 1][0])} → ${esc(STEP_FROM_TO[n - 1][1])} · ${statusBadge(st)}</p></div>
      <span id="pipeSaved" class="saved"></span></div>`;

    if (st.status === 'failed') {
      html += `<div class="failcard" role="alert"><b>This step failed.</b><p>${esc(st.error || 'Something went wrong.')}</p>
        <div class="row"><button class="primary sm" id="stepRetry">Retry step</button>
        <button class="ghost sm" id="stepDismissFail">Dismiss</button></div>
        <p class="muted small">Retry clears the failure so you can run the step again. Real generation retry arrives with the engine update.</p></div>`;
    }

    html += `<div class="pgrid"><div class="pcontrols">${stepForm(n, st)}</div>
      <div class="pviewer" id="stepViewer">${viewerHtml(n, st)}</div></div>`;
    html += variationsHtml(n, st);
    html += `<div class="pgenerate" id="genZone"></div>`;
    box.innerHTML = html;
    wireStepForm(n, st);
    renderGenZone(n);
    if (st.status === 'failed') {
      $('#stepRetry').addEventListener('click', async () => {
        await window.takeone.retryStep(root, projectId, n);
        refreshProject();
      });
      $('#stepDismissFail').addEventListener('click', async () => {
        await window.takeone.retryStep(root, projectId, n);
        refreshProject();
      });
    }
  }

  function stepForm(n, st) {
    const s = st.settings || {};
    const inp = (id, label, val, ph, type) =>
      `<label class="fld"><span>${label}</span><${type === 'area' ? 'textarea id="' + id + '" rows="4"' : 'input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"'}${type === 'area' ? '>' + esc(val || '') + '</textarea>' : '>'}</label>`;
    const sel = (id, label, opts, val) =>
      `<label class="fld"><span>${label}</span><select id="${id}">${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    switch (n) {
      case 1: return `
        ${inp('f_brief', 'Production brief', s.brief, 'What should this film feel like? Who is it for?', 'area')}
        <div class="row"><button class="ghost sm" id="f_inspire">Inspire me (template-based)</button></div>
        <div class="scriptfilm"><h3>Script-to-Film</h3>
        <p class="muted">Paste a script — TakeOne finds the scenes, the dialogue and what a director would still need to ask. Nothing generates until the plan looks right.</p>
        <textarea id="f_script" rows="6" placeholder="EXT. ROMAN STREET — DAWN&#10;&#10;A baker opens his shutters…"></textarea>
        <div class="row"><button class="primary sm" id="f_analyze">Analyze script</button></div>
        <div id="scriptOut"></div></div>`;
      case 2: return `
        ${inp('f_prompt', 'Image prompt', s.prompt, 'A Roman street at dawn, fine ash in the air…', 'area')}
        ${sel('f_style', 'Style', [...BUILT_IN_STYLES, ...(project.customStyles || []).map((c) => c.name + ' (custom)')], s.style || 'Cinematic')}
        <div class="row"><button class="ghost sm" id="f_newstyle">+ Name a custom style</button></div>
        ${sel('f_ratio', 'Aspect ratio', RATIOS, s.ratio || '16:9')}
        ${inp('f_seed', 'Seed (repeatable)', s.seed, 'e.g. 42', 'number')}
        <div class="row"><button class="ghost sm" id="f_fromfilms">From my films…</button>
        ${s.inputAsset ? `<span class="picked">Using: ${esc(s.inputAsset.split('/').pop())} <button class="link" id="f_clearpick">clear</button></span>` : ''}</div>`;
      case 3: return `
        ${sel('f_motion', 'Motion', MOTIONS, s.motion || MOTIONS[0])}
        ${sel('f_camera', 'Camera', CAMERAS, s.camera || CAMERAS[0])}
        ${inp('f_duration', 'Duration (seconds)', s.duration, '8', 'number')}
        ${inp('f_seed3', 'Seed (repeatable)', s.seed, '', 'number')}
        <p class="muted small">Uses the Step 2 image as its first frame.</p>`;
      case 4: return `
        ${inp('f_shots', 'Shots (one per line)', s.shots, 'Wide Roman street — baker opens shutters&#10;Close bread detail — ash lands', 'area')}
        ${sel('f_pacing', 'Pacing', PACINGS, s.pacing || 'Measured')}
        <p class="muted small">Assembles the Step 3 clips into a sequence.</p>`;
      case 5: return `
        ${inp('f_vo', 'Voiceover script', s.voiceover, 'Write what the narrator says…', 'area')}
        ${sel('f_voice', 'Voice', ['Default narrator (local voice)'], s.voice || 'Default narrator (local voice)')}
        <p class="muted small">More voices in Model Manager. Voice cloning needs Voice Studio.</p>`;
      case 6: return `
        ${sel('f_preset', 'Delivery preset', PRESETS, s.preset || PRESETS[0])}
        ${inp('f_filename', 'File name', s.filename, 'my-film', 'text')}
        <p class="muted small">Export keeps the original in your Library — nothing is ever moved out.</p>`;
      default: return '';
    }
  }

  function viewerHtml(n, st) {
    const s = st.settings || {};
    let inner = '';
    if (s.inputAsset) {
      const rel = s.inputAsset;
      if (/\.(png|jpg|jpeg|webp|bmp)$/i.test(rel)) inner = `<img src="${fileUrl(absAsset(rel))}" alt="Selected input">`;
      else inner = `<div class="vfile">📄 ${esc(rel.split('/').pop())}</div>`;
      inner += `<p class="muted small">${esc(rel)}</p>`;
    } else if (st.outputs && st.outputs.length) {
      inner = st.outputs.map((o) => `<div class="vfile">📄 ${esc(o.label)}<span class="muted"> · ${esc(fmtDate(o.createdAt))}</span></div>`).join('');
    } else {
      inner = `<div class="vempty"><b>Nothing here yet</b><p class="muted">Step ${n} has no ${n === 1 ? 'brief' : 'output'} yet. ${n > 1 ? 'Generate below, or import a finished file from your Library to keep moving.' : 'Write the brief or analyze a script on the left.'}</p></div>`;
    }
    return `<div class="viewer">${inner}</div>
      <div class="vmeta"><span class="muted small">${st.finishedAt ? 'Finished ' + esc(fmtDate(st.finishedAt)) + (st.durationMs != null ? ' · ' + esc(fmtDur(st.durationMs)) : '') : 'Not run yet'}</span>
      ${s.inputAsset ? '' : `<button class="link" id="v_show">Show in folder</button>`}</div>`;
  }

  function variationsHtml(n, st) {
    if (n === 1 || n === 6) return '';
    const sel2 = st.variations || [];
    const slots = [0, 1, 2, 3].map((i) => {
      const id = 'var-' + i;
      const on = sel2.includes(id);
      return `<button class="varslot ${on ? 'sel' : ''}" data-var="${id}" aria-pressed="${on}">
        <span class="vnum">${i + 1}</span><span class="vlab">${on ? 'Selected' : 'Empty'}</span></button>`;
    }).join('');
    return `<div class="variations"><div class="vhead"><b>Variations ×4</b>
      <span class="muted">Select the ones you want to keep — selection is real, generation is not wired yet.</span></div>
      <div class="vargrid">${slots}</div>
      <div class="row"><button class="ghost sm" id="varGen">Generate 4 variations</button></div></div>`;
  }

  async function renderGenZone(n) {
    const zone = $('#genZone');
    if (n === 1 || n === 6) {
      zone.innerHTML = n === 6
        ? `<button class="primary" id="genBtn">Export film</button><div id="genGate"></div>`
        : `<div class="muted small">The brief flows into Step 2 automatically once written.</div>`;
    } else {
      zone.innerHTML = `<button class="primary" id="genBtn">Generate — Step ${n} ${esc(STEP_NAMES[n - 1])}</button><div id="genGate"></div>`;
    }
    const btn = $('#genBtn');
    if (btn) btn.addEventListener('click', async () => {
      const g = await window.takeone.engineGate(root, n);
      const gate = g.gate;
      const gz = $('#genGate');
      if (!gate) {
        gz.innerHTML = `<div class="gatecard"><b>Nothing to generate yet.</b><p class="muted">Finish the earlier steps first — each step feeds the next.</p></div>`;
        return;
      }
      gz.innerHTML = `<div class="gatecard"><b>${esc(gate.title)}</b><p class="muted">${esc(gate.body)}</p>
        ${gate.action === 'model-manager' ? `<button class="primary sm" id="gateGo">${esc(gate.actionLabel)}</button>` : ''}</div>`;
      const go = $('#gateGo');
      if (go) go.addEventListener('click', () => switchView('models'));
    });
  }

  function wireStepForm(n, st) {
    const s = st.settings || {};
    const bind = (id, key, isNum) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        let v = el.value;
        if (isNum) v = v === '' ? '' : parseInt(v, 10);
        persistSettings(n, { [key]: v });
      });
    };
    if (n === 1) {
      bind('f_brief', 'brief');
      const an = $('#f_analyze');
      if (an) an.addEventListener('click', async () => {
        const out = $('#scriptOut');
        out.innerHTML = '<p class="muted">Analyzing…</p>';
        const r = await window.takeone.analyzeScript($('#f_script').value);
        if (!r.ok) { out.innerHTML = `<div class="gatecard"><b>Not yet.</b><p class="muted">${esc(r.reason)}</p></div>`; return; }
        out.innerHTML = `<div class="scenes"><b>${r.counts.scenes} scene${r.counts.scenes === 1 ? '' : 's'} · ${r.counts.dialogue} dialogue lines · ${r.counts.ambiguities} things to clarify</b>
          ${r.scenes.map((sc) => `<div class="scene"><b>${esc(sc.heading)}</b><span class="muted"> · ${sc.dialogue.length} lines</span>
            ${sc.dialogue.map((d) => `<div class="dlg"><b>${esc(d.character)}</b> — ${esc(d.line)}${d.hasNote ? '' : ' <span class="amb">no delivery note</span>'}</div>`).join('')}</div>`).join('')}
          ${r.ambiguities.length ? `<div class="ambs"><b>To clarify</b>${r.ambiguities.map((a) => `<div class="ambrow"><span class="ambtag">${esc(a.type.replace(/-/g, ' '))}</span> ${esc(a.text)}<div class="muted small">${esc(a.suggestion)}</div></div>`).join('')}</div>` : '<p class="muted">No ambiguities found — this script is director-ready.</p>'}
        </div>`;
      });
      const ins = $('#f_inspire');
      if (ins) ins.addEventListener('click', async () => {
        const brief = ($('#f_brief') || {}).value || project.originalIdea || '';
        const taste = await window.takeone.getTaste(root);
        const rules = (taste.ok && taste.rules) || [];
        const always = rules.filter((r) => r.type === 'always').map((r) => r.text);
        const never = rules.filter((r) => r.type === 'never').map((r) => r.text);
        const expanded = [
          brief.trim() || 'An untitled film.',
          always.length ? 'Always: ' + always.join('; ') + '.' : '',
          never.length ? 'Never: ' + never.join('; ') + '.' : '',
          'Five shots. Measured pacing. Grounded realism.',
        ].filter(Boolean).join(' ');
        const fb = $('#f_brief');
        if (fb) { fb.value = expanded; persistSettings(n, { brief: expanded }); }
      });
    }
    if (n === 2) {
      bind('f_prompt', 'prompt'); bind('f_style', 'style'); bind('f_ratio', 'ratio'); bind('f_seed', 'seed', true);
      const ns = $('#f_newstyle');
      if (ns) ns.addEventListener('click', async () => {
        const name = await promptModal('Custom style', 'e.g. Mughal miniature');
        if (!name || !name.trim()) return;
        const styles = [...(project.customStyles || []), { id: 'style-' + Date.now(), name: name.trim().slice(0, 60), createdAt: new Date().toISOString() }];
        await window.takeone.updateProject(root, projectId, { customStyles: styles });
        refreshProject();
      });
      const ff = $('#f_fromfilms');
      if (ff) ff.addEventListener('click', () => fromFilmsPicker(n));
      const cp = $('#f_clearpick');
      if (cp) cp.addEventListener('click', () => persistSettings(n, { inputAsset: '' }).then(refreshProject));
    }
    if (n === 3) { bind('f_motion', 'motion'); bind('f_camera', 'camera'); bind('f_duration', 'duration', true); bind('f_seed3', 'seed', true); }
    if (n === 4) { bind('f_shots', 'shots'); bind('f_pacing', 'pacing'); }
    if (n === 5) { bind('f_vo', 'voiceover'); bind('f_voice', 'voice'); }
    if (n === 6) { bind('f_preset', 'preset'); bind('f_filename', 'filename'); }
    $$('#stepPanel .varslot').forEach((b) => b.addEventListener('click', async () => {
      const r = await window.takeone.toggleVariation(root, projectId, n, b.dataset.var);
      if (r.ok) refreshProject();
    }));
    const vg = $('#varGen');
    if (vg) vg.addEventListener('click', async () => {
      const g = await window.takeone.engineGate(root, n);
      const gz = $('#genGate');
      gz.innerHTML = `<div class="gatecard"><b>${esc(g.gate ? g.gate.title : 'Not available yet')}</b><p class="muted">${esc(g.gate ? g.gate.body : '')}</p>
        ${g.gate && g.gate.action === 'model-manager' ? `<button class="primary sm" id="gateGo2">Open Model Manager</button>` : ''}</div>`;
      const go = $('#gateGo2');
      if (go) go.addEventListener('click', () => switchView('models'));
    });
    const vs = $('#v_show');
    if (vs) vs.addEventListener('click', () => window.takeone.showInFolder(absAsset('')));
  }

  // ------------------------------------------------------- from-my-films
  async function fromFilmsPicker(stepN) {
    const r = await window.takeone.listAssets(root, projectId);
    const assets = (r.ok && r.assets) || [];
    const overlay = document.createElement('div');
    overlay.className = 'modal-back';
    overlay.innerHTML = `<div class="modal wide"><h2>From my films</h2>
      <p class="muted">Pick a file from this project's Library — it becomes Step ${stepN}'s input.</p>
      <div class="tabs"><button class="tab active" data-t="all">All</button><button class="tab" data-t="images">Images</button><button class="tab" data-t="videos">Video</button><button class="tab" data-t="audio">Audio</button></div>
      <div class="filmgrid" id="filmGrid"></div>
      <div class="mactions"><button class="ghost" id="ffClose">Cancel</button></div></div>`;
    document.body.appendChild(overlay);
    const grid = $('#filmGrid', overlay);
    const draw = (t) => {
      const list = assets.filter((a) => t === 'all' || a.type === t);
      grid.innerHTML = list.length ? list.map((a, i) => `
        <button class="filmcard" data-i="${assets.indexOf(a)}">
          ${a.type === 'images' ? `<img src="${fileUrl(absAsset(a.rel))}" alt="">` : `<div class="fthumb">📄</div>`}
          <span>${esc(a.fileName)}</span><span class="muted small">${esc(a.type)}</span>
        </button>`).join('') : '<p class="muted">No files of this type yet — import some in the Library.</p>';
      $$('.filmcard', grid).forEach((b) => b.addEventListener('click', async () => {
        const a = assets[parseInt(b.dataset.i, 10)];
        await persistSettings(stepN, { inputAsset: a.rel });
        document.body.removeChild(overlay);
        refreshProject();
      }));
    };
    draw('all');
    $$('.tab', overlay).forEach((t) => t.addEventListener('click', () => {
      $$('.tab', overlay).forEach((x) => x.classList.remove('active'));
      t.classList.add('active'); draw(t.dataset.t);
    }));
    $('#ffClose').addEventListener('click', () => document.body.removeChild(overlay));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
  }

  // ------------------------------------------------------- context assist
  async function renderMoves() {
    const box = $('#assistMoves');
    const r = await window.takeone.suggestMoves(root, projectId);
    const moves = (r.ok && r.moves) || [];
    if (!moves.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h3>Project-aware actions</h3><p class="muted">Suggestions from this film's real state — not a chatbot.</p>
      <div class="moves">${moves.map((m, i) => `
        <div class="move"><b>${esc(m.title)}</b>
          <button class="link" data-why="${i}">Why this?</button>
          <p class="muted why" data-whytext="${i}" hidden>${esc(m.why || '')}</p>
          <div class="row">${moveAction(m)}</div>
        </div>`).join('')}</div>`;
    $$('[data-why]', box).forEach((b) => b.addEventListener('click', () => {
      const t = $(`[data-whytext="${b.dataset.why}"]`, box);
      if (t) t.hidden = !t.hidden;
    }));
    $$('[data-goto]', box).forEach((b) => b.addEventListener('click', () => {
      activeStep = parseInt(b.dataset.goto, 10);
      renderSteps(); renderStepPanel();
    }));
    $$('[data-models]', box).forEach((b) => b.addEventListener('click', () => switchView('models')));
  }

  function moveAction(m) {
    if (m.kind === 'tool') return `<button class="primary sm" data-models="1">Open Model Manager</button>`;
    if (m.kind === 'generate' || m.kind === 'retry') return `<button class="primary sm" data-goto="${m.step || 1}">Go to Step ${m.step || 1}</button>`;
    if (m.kind === 'idea') return `<button class="ghost sm" id="mvIdea">Write the idea</button>`;
    if (m.kind === 'locks') return '';
    return '';
  }

  // ------------------------------------------------------- standalone tools
  const TOOLS = [
    { id: 'upscaler', name: 'Upscaler', desc: 'Upscale any image or frame to 2× or 4× detail.', tool: 'upscaler' },
    { id: 'voiceclone', name: 'Voice Clone', desc: 'Build a reusable voice profile from a short sample.', tool: 'voice-studio' },
    { id: 'styles', name: 'Styles', desc: 'Built-in looks, your named custom styles, and style mixing.', tool: null, custom: true },
    { id: 'reflab', name: 'Reference Lab', desc: 'Analyze pacing, shots and palette of a reference.', tool: 'vision' },
    { id: 'fixfootage', name: 'Fix My Footage', desc: 'Clean and stabilize a clip. The original is never changed.', tool: 'video-studio' },
    { id: 'repurposer', name: 'Repurposer', desc: 'Turn one long video into reviewable Shorts.', tool: 'video-studio' },
    { id: 'dream', name: 'Dream Capture', desc: 'Dreamlike, surreal video styles — for music videos and art films.', tool: 'video-studio' },
  ];

  async function renderTools() {
    const box = $('#toolCards');
    const ts = await window.takeone.toolStates(root);
    const states = (ts.ok && ts.states) || {};
    box.innerHTML = TOOLS.map((t) => {
      let action;
      if (t.custom) {
        const names = (project.customStyles || []).map((c) => esc(c.name)).join(', ');
        action = `<p class="muted small">${names ? 'Your styles: ' + names : 'No custom styles yet.'}</p>
          <button class="ghost sm" data-cstyle="1">+ Name a custom style</button>`;
      } else {
        const st = states[t.tool];
        const installed = st && st.state === 'installed';
        action = installed
          ? `<p class="muted small">Downloaded. The engine switches this tool on in the next update.</p>`
          : `<button class="primary sm" data-tmodels="1">Download in Model Manager</button>`;
      }
      return `<div class="toolcard"><b>${esc(t.name)}</b><p class="muted">${esc(t.desc)}</p>${action}</div>`;
    }).join('');
    $$('[data-tmodels]', box).forEach((b) => b.addEventListener('click', () => switchView('models')));
    $$('[data-cstyle]', box).forEach((b) => b.addEventListener('click', async () => {
      const name = await promptModal('Custom style', 'e.g. Mughal miniature');
      if (!name || !name.trim()) return;
      const styles = [...(project.customStyles || []), { id: 'style-' + Date.now(), name: name.trim().slice(0, 60), createdAt: new Date().toISOString() }];
      await window.takeone.updateProject(root, projectId, { customStyles: styles });
      refreshProject();
    }));
    const mv = $('#mvIdea');
    if (mv) mv.addEventListener('click', () => { const i = $('#ideaInput'); if (i) i.focus(); });
  }

  // ------------------------------------------------------- public
  document.addEventListener('DOMContentLoaded', () => { init().catch((e) => console.error(e)); });
  window.__pipeline = { refresh: refreshProject, openProject, newProjectDialog, maybeAskNiche };
})();
