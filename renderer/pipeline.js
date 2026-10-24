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
        <div class="quickgen" id="quickGen" style="margin-top:32px; padding:20px; border:1px solid var(--line); border-radius:12px; background:var(--panel);">
          <h3 style="margin:0 0 8px;">⚡ Quick Generate <span class="muted small">(engine test)</span></h3>
          <p class="muted small" style="margin:0 0 12px;">Test the local AI engine directly. Needs ComfyUI + an SDXL model in Models.</p>
          <div style="display:flex; gap:8px; margin-bottom:12px;">
            <input type="text" id="qgPrompt" placeholder="A cinematic sunset over mountains…" style="flex:1; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:#fff;" />
            <button class="primary" id="qgBtn">Generate</button>
          </div>
          <div id="qgOut" class="muted small"></div>
        </div>
      </div>`;
    const goTools = $('#npTools');
    if (goTools) goTools.addEventListener('click', () => switchView('models'));
    document.querySelectorAll('.pp-missing, .pp-warn').forEach((b) =>
      b.addEventListener('click', () => switchView('models')));
    $('#npCreate').addEventListener('click', newProjectDialog);
    const qgBtn = $('#qgBtn');
    const qgPrompt = $('#qgPrompt');
    // Brain: suggest based on prompt keywords as user types.
    if (qgPrompt) qgPrompt.addEventListener('input', async () => {
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
    if (qgBtn) qgBtn.addEventListener('click', async () => {
      const prompt = (qgPrompt || {}).value || '';
      const out = $('#qgOut');
      if (!prompt.trim()) { if (out) out.textContent = 'Pehle prompt likhein.'; return; }
      // Brain: learn that this prompt led to a generation (reward +1 for trying)
      try {
        const low = prompt.toLowerCase();
        const ctx = low.includes('cinematic') ? 'prompt:cinematic'
          : low.includes('portrait') ? 'prompt:portrait'
          : low.includes('landscape') ? 'prompt:landscape' : 'prompt:general';
        await window.takeone.brainLearn(root, ctx, 'suggest:sdxl', 1);
      } catch { /* brain optional */ }
      qgBtn.disabled = true;
      if (out) out.textContent = 'Starting the engine…';
      try {
        const r = await window.takeone.comfyGenerate(root, { prompt: prompt.trim() });
        if (!r.ok) {
          // WO-27: engine not installed -> plain message + the Install path.
          if (r.engineMissing) {
            if (out) out.innerHTML = '<span>The AI engine isn\u2019t installed yet — it\u2019s a one-time setup.</span><br><button class="btn small" id="qgInstallEngine">Install the engine</button>';
            const ib = document.getElementById('qgInstallEngine');
            if (ib) ib.addEventListener('click', () => switchView('models'));
          } else if (r.modelNotVisible) {
            // WO-41.3: plain words + an action. The error text is plain by
            // construction (main.js strips the raw ComfyUI JSON) — it is
            // shown escaped, never as raw JSON.
            if (out) out.innerHTML = `<span>${esc(r.error)}</span><br><button class="btn small" id="qgModels">Open Models</button>`;
            const mb = document.getElementById('qgModels');
            if (mb) mb.addEventListener('click', () => switchView('models'));
          } else if (out) out.textContent = 'Error: ' + (r.error || r.reason || 'failed');
          return;
        }
        const pid = r.promptId;
        const port = r.port || 8188; // WO-27: never hardcode 8188 — ComfyUI picks a free port
        let genCancelled = false;
        if (out) out.innerHTML = 'Generating… (this takes a minute on first run) <button class="btn small ghost2" id="qgCancel">Cancel</button>';
        const cancelBtn = document.getElementById('qgCancel');
        if (cancelBtn) cancelBtn.addEventListener('click', async () => {
          genCancelled = true;
          try { await window.takeone.comfyInterrupt(); } catch { /* best effort */ }
        });
        // Poll for completion (max 5 min)
        for (let i = 0; i < 60; i++) {
          await new Promise((res) => setTimeout(res, 5000));
          if (genCancelled) { if (out) out.textContent = 'Cancelled.'; return; }
          const h = await window.takeone.comfyHistory(pid);
          if (h.ok && h.history && h.history.outputs) {
            const outs = h.history.outputs;
            const imgNode = Object.values(outs).find((o) => o.images && o.images.length);
            if (imgNode) {
              const img = imgNode.images[0];
              const url = `http://127.0.0.1:${port}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
              if (out) out.innerHTML = `<img src="${url}" style="max-width:100%; border-radius:8px; margin-top:8px;" />`;
              break;
            }
          }
          if (out) out.textContent = `Generating… ${Math.floor((i + 1) * 5 / 60)}m ${((i + 1) * 5) % 60}s`;
        }
      } catch (e) {
        if (out) out.textContent = 'Error: ' + (e.message || e);
      } finally {
        qgBtn.disabled = false;
      }
    });
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
