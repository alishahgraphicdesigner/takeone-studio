/* TakeOne Studio 2.2.0 — Phase B: Model Manager view.
 * Honest labels only: "Untested on this PC" until an on-PC smoke test passes.
 * No terminal text anywhere. Keyboard: Escape closes open detail boxes. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let CAT = [];
  let STATES = {};
  const INSTALL_START = {}; // persists across renders — elapsed time for installs
  const VERIFYING = new Set(); // ids with a verify in flight (survives re-renders)
  let ROOT = null;
  let ONLINE = true;

  const fmtMB = (mb) => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
  // Ali verdict 2026-10-17: freed bytes after a download cancel, formatted for the notice.
  const fmtFreed = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function badge(st) {
    if (st.unavailable || st.unavailableUser) return '<span class="badge coming">Coming soon</span>';
    if (st.state === 'installed') return '<span class="badge ok">Installed</span>';
    if (st.state === 'failed') return '<span class="badge bad">Failed</span>';
    if (['downloading', 'verifying', 'installing', 'retrying'].includes(st.state)) return '<span class="badge working">Working</span>';
    if (st.state === 'paused' || st.state === 'interrupted') return '<span class="badge expected">Paused</span>';
    return '<span class="badge untested">Untested on this PC</span>';
  }

  function actionFor(tool, st) {
    const id = tool.id;
    if (st.unavailable || tool.unavailable) return ''; // WO-12: Not Available — no Install button
    if (!st.gateOk) return ''; // gated cards show the reason box instead
    switch (st.state) {
      case 'installed':
        // Verified state is PERSISTED (tool-status.json) — always visible,
        // across restarts. Re-check stays available, quietly.
        if (st.verifiedAt)
          return `<span class="ok-inline">✓ Verified</span>
                  <button class="btn small ghost2 quiet" data-act="verify" data-id="${id}">Check again</button>
                  <span class="verify-note" id="verify-${id}"></span>`;
        return `<button class="btn small ghost2" data-act="verify" data-id="${id}">Verify</button>
                <span class="verify-note" id="verify-${id}"></span>`;
      case 'downloading':
        return `<button class="btn small ghost2" data-act="pause" data-id="${id}">Pause</button>
                <button class="btn small ghost2" data-act="cancel" data-id="${id}">Cancel</button>
                <span class="progwrap">Pause: baad mein wahin se jari rakhein.</span>`;
      case 'paused': case 'interrupted':
        return `<button class="btn small" data-act="resume" data-id="${id}">Resume</button>
                <button class="btn small ghost2" data-act="cancel" data-id="${id}">Cancel</button>`;
      case 'verifying': return `<span class="progwrap">Checking the file…</span>`;
      case 'retrying': return `<span class="progwrap">Retrying automatically…</span>`;
      case 'installing': return `<span class="progwrap">Installing…</span> <button class="btn small ghost2" data-act="install-cancel" data-id="${id}">Cancel</button>`;
      case 'queued': return `<span class="progwrap">${esc(st.detail || 'Queued — starts automatically.')}</span> <button class="btn small ghost2" data-act="install-cancel" data-id="${id}">Cancel</button>`;
      case 'cancelling': return `<span class="progwrap">Stopping…</span>`;
      case 'failed':
        return `<button class="btn small" data-act="retry" data-id="${id}">Try again</button>`;
      default: break;
    }
    // not-installed → primary action per install type
    if (tool.installType === 'file') return `<button class="btn small" data-act="download" data-id="${id}">Download</button>`;
    if (tool.installType === 'pip') return `<button class="btn small" data-act="install" data-id="${id}">Install</button>`;
    if (tool.installType === 'hf') return `<button class="btn small" data-act="download" data-id="${id}">Install</button>`;
    if (tool.installType === 'external') return `<button class="btn small ghost2" data-act="external" data-id="${id}">Open official page</button>`;
    if (tool.installType === 'adopt') return `<button class="btn small ghost2" data-act="adopt-open" data-id="${id}">Open author\u2019s folder</button>
      <button class="btn small" data-act="adopt-pick" data-id="${id}">I\u2019ve downloaded — find the files</button>`;
    return '';
  }

  function progressFor(tool, st) {
    if (!['downloading', 'verifying', 'installing', 'retrying'].includes(st.state)) return '';
    const pct = Math.round((st.progress || 0) * 100);
    const label = st.state === 'verifying' ? 'Checking the file…' : st.state === 'installing' ? 'Installing…' : st.state === 'retrying' ? 'Retrying…' : pct + '%';
    return `<div class="progwrap"><div class="row"><span>${esc(label)}</span></div>
      <div class="prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Download progress for ${esc(tool.friendlyName)}"><i style="width:${pct}%"></i></div></div>`;
  }

  function errorFor(st) {
    if (st.state !== 'failed' || !st.error) return '';
    return `<div class="err"><b>Didn\u2019t work.</b> ${esc(st.error)}<br>Nothing was installed. You can try again — no files were left half-written.</div>`;
  }

  // WO-16: only the plain-language user text is shown — dev wording never reaches the user.
  function unavailableFor(tool, st) {
    const msg = st.unavailableUser || tool.unavailableUser;
    const isU = st.unavailable || tool.unavailable;
    if (!isU && !msg) return '';
    return `<div class="soonbox"><b>Coming soon.</b> ${esc(msg || 'Coming soon.')}</div>`;
  }

  function gateFor(tool, st) {
    if (st.gateOk) return '';
    return `<div class="gatereason"><b>Not available on this PC.</b> ${esc(st.gateReason)}
      <br><button class="link" data-act="why" data-id="${tool.id}" aria-expanded="false">Why?</button>
      <div class="whybox" id="why-${tool.id}" hidden>${esc(st.gateWhy || '')}</div></div>`;
  }

  function depsFor(tool, st) {
    if (!st.deps || !st.deps.length) return '';
    return `<div class="plan"><div class="dep"><b>Also installed (once, with your OK):</b> ${st.deps.map((d) => esc(d.name) + ' — ' + esc(d.note)).join(' ')}</div></div>`;
  }

  // Decision #25: honest time labels from the MEASURED speed — never guessed.
  // size / (speed/8) = seconds. No measured speed -> no label (never fake it).
  function dlTime(tool) {
    if (!(SPEED_MBPS > 0) || !(tool.sizeMB > 0)) return '';
    const mins = Math.round(tool.sizeMB / (SPEED_MBPS / 8) / 60);
    const label = mins < 1 ? 'under a minute' : mins < 60 ? mins + ' min' : Math.round(mins / 60 * 10) / 10 + ' hr';
    return `<span title="At your measured speed of ${SPEED_MBPS} Mbps">≈ ${label} download</span>`;
  }
  function card(tool) {
    const st0 = STATES[tool.id] || { state: 'not-installed', gateOk: true, deps: [] };
    // WO-12: fall back to the catalog copy's own field if the state predates it.
    const st = tool.unavailable && !st0.unavailable ? { ...st0, unavailable: tool.unavailable } : st0;
    return `<div class="tcard${st.gateOk ? '' : ' gated'}" data-tool="${tool.id}">
      <div class="thead"><div><div class="tname">${esc(tool.friendlyName)}</div>
      <div class="ttech">powered by ${esc(tool.technical)}</div></div>${badge(st)}</div>
      <div class="why">${esc(tool.why)}</div>
      <div class="tmeta"><span>${fmtMB(tool.sizeMB)}</span><span>${tool.vramMB === 0 ? 'CPU' : fmtMB(tool.vramMB) + ' VRAM'}</span><span>${esc(tool.license)}</span>${dlTime(tool)}</div>
      ${progressFor(tool, st)}
      ${errorFor(st)}
      ${unavailableFor(tool, st)}
      ${gateFor(tool, st)}
      ${depsFor(tool, st)}
      <div class="actions">${actionFor(tool, st)}</div>
    </div>`;
  }

  // Honest suggestions: which pipeline groups have nothing installed yet,
  // and what each unlocks. Real state, no fake recommendations.
  const GROUP_WHY = {
    'Image': 'key visuals, thumbnails and style frames',
    'Video': 'turning stills into motion',
    'Voice': 'narration and dialogue',
    'Audio': 'music and sound design',
    'Edit': 'polishing and finishing',
    'Fix': 'upscaling and restoring footage',
    'Analyze': 'understanding scripts and footage',
    'AI Brain': 'a local assistant that guides each step',
  };
  function suggestions() {
    const missing = [];
    const seen = {};
    for (const t of CAT) {
      if (seen[t.group]) continue;
      seen[t.group] = true;
      const anyInstalled = CAT.some((x) => x.group === t.group && (STATES[x.id] || {}).state === 'installed');
      const isUn = (STATES[t.id] || {}).unavailable || t.unavailable;
      if (!anyInstalled && !isUn && (STATES[t.id] || {}).gateOk !== false) missing.push(t.group);
    }
    if (!missing.length) return '';
    return `<div class="suggest"><b>Complete your pipeline</b>
      <p class="muted">Nothing installed yet for: ${missing.map((g) => `<span class="sgroup">${esc(g)}</span>`).join(' ')}</p>
      <p class="muted small">${missing.map((g) => `${esc(g)} — for ${esc(GROUP_WHY[g] || 'more of your film')}`).join(' · ')}</p></div>`;
  }
  function groups() {
    const order = [];
    const byGroup = {};
    for (const t of CAT) {
      if (!byGroup[t.group]) { byGroup[t.group] = []; order.push(t.group); }
      byGroup[t.group].push(t);
    }
    return order.map((g) => `<div class="mgroup"><h2>${esc(g)}</h2><div class="mgrid">${byGroup[g].map(card).join('')}</div></div>`).join('');
  }

  let refreshQueued = false;
  let lastRefresh = 0;
  let pointerDown = false; // C6: never re-render mid-click
  async function refreshStates() {
    // Throttle: max once per 800ms. Progress ticks fire much faster than that,
    // and each re-render replaces dock buttons mid-click, eating user clicks.
    // C6: If the pointer is down (user mid-click), defer until pointerup.
    if (pointerDown) {
      if (!refreshQueued) {
        refreshQueued = true;
        const waitForUp = () => {
          if (pointerDown) { setTimeout(waitForUp, 50); return; }
          refreshQueued = false;
          refreshStates();
        };
        setTimeout(waitForUp, 50);
      }
      return;
    }
    const now = Date.now();
    if (now - lastRefresh < 800) {
      if (!refreshQueued) {
        refreshQueued = true;
        setTimeout(() => { refreshQueued = false; refreshStates(); }, 800 - (now - lastRefresh));
      }
      return;
    }
    lastRefresh = now;
    try {
      const r = await window.takeone.toolStates(ROOT);
      if (r.ok) STATES = r.states;
    } catch { /* keep old */ }
    const host = $('#modelCards');
    if (host) host.innerHTML = suggestions() + groups();
    renderDock();
  }

  function renderDock() {
    const active = CAT.filter((t) => {
      const s = (STATES[t.id] || {}).state;
      return ['downloading', 'paused', 'verifying', 'retrying', 'installing', 'interrupted', 'queued'].includes(s);
    });
    const dock = $('#dlDock');
    if (!dock) return;
    if (!active.length) { dock.hidden = true; dock.classList.remove('minimized');
      document.body.classList.remove('dock-open');
      const fab0 = document.getElementById('dockFab'); if (fab0) fab0.hidden = true; return; }
    dock.classList.remove('minimized');
    document.body.classList.add('dock-open');
    dock.hidden = false;
    const fab = document.getElementById('dockFab');
    if (fab && !fab.dataset.wired) { fab.dataset.wired = '1'; fab.onclick = () => {
      dock.classList.remove('minimized'); fab.hidden = true;
      document.body.classList.add('dock-open'); }; }
    const minBtn = document.getElementById('dockMinBtn');
    if (minBtn) minBtn.onclick = () => {
      dock.classList.add('minimized');
      document.body.classList.remove('dock-open');
      const fab = document.getElementById('dockFab');
      if (fab) { fab.hidden = false; fab.textContent = `Activity (${count})`; }
    };
    const count = active.length;
    const dlStates = ['downloading', 'paused', 'interrupted', 'verifying', 'retrying'];
    const instStates = ['installing', 'queued', 'cancelling'];
    const dls = active.filter((t) => dlStates.includes((STATES[t.id] || {}).state));
    const insts = active.filter((t) => instStates.includes((STATES[t.id] || {}).state));
    const phaseName = { preparing: 'Preparing…', installing: 'Installing packages…', downloading: 'Fetching packages…', dependency: 'Setting up helper…', done: 'Finishing…' };
    const rowHtml = (t) => {
      const st = STATES[t.id];
      const pct = Math.round((st.progress || 0) * 100);
      // Elapsed time for installs — so a long install doesn't look frozen.
      let elapsed = '';
      if (st.state === 'installing') {
        const started = INSTALL_START[t.id] || Date.now();
        INSTALL_START[t.id] = started;
        const s = Math.floor((Date.now() - started) / 1000);
        elapsed = s >= 60 ? ` · ${Math.floor(s / 60)}m ${s % 60}s` : s >= 5 ? ` · ${s}s` : '';
      } else { delete INSTALL_START[t.id]; }
      const isDl = dlStates.includes(st.state);
      const speed = st.state === 'downloading' && st.speedBps > 0
        ? ' · ' + (st.speedBps > 1048576 ? (st.speedBps / 1048576).toFixed(1) + ' MB/s' : Math.round(st.speedBps / 1024) + ' KB/s')
        : st.state === 'downloading' ? ' · stalled?' : '';
      let label;
      if (st.state === 'cancelling') {
        label = 'Stopping…';
      } else if (st.state === 'installing') {
        const ph = phaseName[st.detail] || 'Installing…';
        label = (pct > 0 ? `${pct}% · ${ph}` : ph) + elapsed;
        // PROACTIVE 2: Long install without progress — reassure, don't alarm.
        const startedAt = INSTALL_START[t.id] || Date.now();
        if (Date.now() - startedAt > 10 * 60 * 1000 && pct === 0) {
          label += ' — still working, large packages take a while';
        }
      } else {
        label = { downloading: pct + '%' + speed, paused: 'Paused', interrupted: 'Interrupted — resume to continue', verifying: 'Checking…', retrying: 'Retrying…', queued: st.detail || 'Queued — starts automatically.' }[st.state] || st.state;
      }
      const ops = st.state === 'downloading'
        ? `<button class="btn small ghost2" data-act="pause" data-id="${t.id}">Pause</button><button class="btn small ghost2" data-act="cancel" data-id="${t.id}">Cancel</button><span class="progwrap"> Pause: baad mein wahin se jari rakhein.</span>`
        : st.state === 'paused' || st.state === 'interrupted'
          ? `<button class="btn small" data-act="resume" data-id="${t.id}">Resume</button><button class="btn small ghost2" data-act="cancel" data-id="${t.id}">Cancel</button>`
          : st.state === 'installing' || st.state === 'queued'
            ? `<button class="btn small ghost2" data-act="install-cancel" data-id="${t.id}">Cancel</button>` : '';
      return `<div class="dockrow"><div class="nm">${esc(t.friendlyName)}</div>
        <div class="prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress for ${esc(t.friendlyName)}"><i style="width:${pct}%"></i></div>
        <div class="st">${esc(label)}</div><div class="ops">${ops}</div></div>`;
    };
    let html = `<h3>Downloads &amp; Installs (${count}) <button class="dockmin" id="dockMinBtn" title="Minimize">—</button></h3>`;
    if (dls.length) html += `<div class="docksec">Downloads</div>` + dls.map(rowHtml).join('');
    if (insts.length) html += `<div class="docksec">Installs</div>` + insts.map(rowHtml).join('');
    dock.innerHTML = html;
  }

  async function renderMeter() {
    try {
      const free = await window.takeone.diskFree(ROOT);
      const el = $('#diskMeter');
      if (!el) return;
      if (free === null) { el.innerHTML = '<span class="mtext">Disk space: could not measure.</span>'; return; }
      const totalEst = CAT.filter((t) => (STATES[t.id] || {}).state === 'not-installed'
        && !(STATES[t.id] || {}).unavailable && !t.unavailable)
        .reduce((s, t) => s + t.sizeMB, 0) / 1024;
      el.innerHTML = `<span class="mtext"><b>${free.toFixed(1)} GB</b> free on this drive.</span>
        <div class="meter" role="progressbar" aria-valuenow="${Math.round(totalEst)}" aria-valuemin="0" aria-valuemax="${Math.round(free)}" aria-label="Estimated space for all remaining tools versus free disk space"><i style="width:${Math.min(100, (totalEst / Math.max(free, 1)) * 100)}%"></i></div>
        <span class="mtext">All remaining tools need about <b>${totalEst.toFixed(1)} GB</b> (estimates — real sizes come from the servers).</span>`;
    } catch { /* ignore */ }
  }

  async function act(action, id) {
    const tool = CAT.find((t) => t.id === id);
    if (!tool) return;
    try {
      if (action === 'download') await window.takeone.dlStart(id, ROOT);
      else if (action === 'pause') await window.takeone.dlPause(id, ROOT);
      else if (action === 'resume') await window.takeone.dlResume(id, ROOT);
      else if (action === 'cancel') {
        // Ali verdict 2026-10-17: cancel = active partial deleted, freed bytes shown.
        const r = await window.takeone.dlCancel(id, ROOT);
        if (r && r.ok) notice('Cancelled. ' + fmtFreed(r.freedBytes || 0) + ' free ho gaya. Dobara chahiye to Install dabayein.');
      }
      else if (action === 'retry') {
        const t = (tool.installType === 'file' || tool.installType === 'hf') ? await window.takeone.dlRetry(id, ROOT) : await window.takeone.depInstall(id, ROOT);
        if (t && !t.ok && t.reason) notice(t.reason);
      }
      else if (action === 'install-cancel') {
        await window.takeone.depCancel(id, ROOT);
        refreshStates();
      }
      else if (action === 'install') {
        // No confirm dialog: the card already shows size, time and dependencies,
        // so clicking Install IS the OK. Starts immediately with live progress.
        // Refresh right away so a queued position shows instead of silence.
        refreshStates();
        const r = await window.takeone.depInstall(id, ROOT);
        if (!r.ok) notice(r.reason || 'Installation did not finish.');
      }
      else if (action === 'external') await window.takeone.openExternal(tool.externalUrl);
      else if (action === 'adopt-open') await window.takeone.openExternal(tool.adoptUrl);
      else if (action === 'adopt-pick') {
        const r = await window.takeone.adoptPick(id, ROOT);
        if (!r.ok && r.reason && r.reason !== 'cancelled') notice(r.reason);
      }
      else if (action === 'verify') {
        if (VERIFYING.has(id)) return; // already running — re-render can't defeat this
        VERIFYING.add(id);
        const note = document.getElementById('verify-' + id);
        const btn = document.querySelector(`button[data-act="verify"][data-id="${id}"]`);
        if (btn) btn.disabled = true; // no double-runs
        if (note) note.innerHTML = '<span class="muted">Checking the file…</span>';
        let r = null;
        try { r = await window.takeone.verifyTool(id, ROOT).catch(() => null); }
        finally { VERIFYING.delete(id); }
        if (btn) btn.disabled = false;
        if (note) {
          if (!r || !r.ok) note.innerHTML = '<span class="err-inline">Could not check.</span>';
          else if (r.verified) {
            note.innerHTML = `<span class="ok-inline">Verified${r.sizeMB ? ' · ' + r.sizeMB + ' MB' : ''} — ${esc(r.note || '')}</span>`;
            if (btn) { btn.textContent = 'Check again'; btn.classList.add('quiet'); }
          }
          else note.innerHTML = `<span class="err-inline">Problem found — ${esc(r.note || '')}</span>`;
        }
      }
      else if (action === 'why') {
        const box = document.getElementById('why-' + id);
        const btn = document.querySelector(`button[data-act="why"][data-id="${id}"]`);
        if (box) { box.hidden = !box.hidden; if (btn) btn.setAttribute('aria-expanded', String(!box.hidden)); }
        return;
      }
    } catch (e) { notice('Something went wrong: ' + String(e.message || e)); }
    refreshStates();
  }

  function wire() {
    document.addEventListener('pointerdown', () => { pointerDown = true; });
    document.addEventListener('pointerup', () => { pointerDown = false; });
    document.addEventListener('pointercancel', () => { pointerDown = false; });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) act(b.dataset.act, b.dataset.id);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelectorAll('.whybox').forEach((w) => { w.hidden = true; });
    });
    if (window.takeone.onDlEvent) window.takeone.onDlEvent(() => refreshStates());
    if (window.takeone.onDepEvent) window.takeone.onDepEvent(() => refreshStates());
  }

  let SPEED_MBPS = null;
  async function init() {
    const cfg = await window.takeone.getConfig().catch(() => null);
    ROOT = (cfg && cfg.storageRoot) || null;
    SPEED_MBPS = (cfg && cfg.pcCheck && cfg.pcCheck.speedMbps) || null;
    const cat = await window.takeone.catalog().catch(() => null);
    if (!cat || !cat.ok) {
      const host = $('#modelCards');
      if (host) host.innerHTML = '<div class="err"><b>Could not load the tool catalog.</b> ' + esc((cat && cat.errors || []).join(' ')) + '</div>';
      return;
    }
    CAT = cat.catalog;
    ONLINE = (await window.takeone.checkOnline().catch(() => ({ online: true }))).online;
    const banner = $('#offlineBanner');
    if (banner) banner.hidden = ONLINE;
    await refreshStates();
    await renderMeter();
    wire();
    console.log('models-ready');
  }

  // Init when the Models view first opens (lazy), or immediately if present.
  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('view-models')) init();
  });
})();
