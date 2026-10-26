/* TakeOne Studio 2.2.0 — Phase A minimal Studio shell. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let cfg = null;
  let root = null;

  function gb(bytes) { return (bytes / 2 ** 30).toFixed(1) + ' GB'; }

  function card(k, v, extra) {
    return `<div class="card"><div class="k">${k}</div><b>${v}</b>${extra ? `<p>${extra}</p>` : ''}</div>`;
  }

  async function render() {
    cfg = await window.takeone.getConfig();
    if (!cfg) return;
    root = cfg.storageRoot;
    // WO-39: show the boot-time storage notice once (protected folder move /
    // Windows Security block). Plain words, dismissible.
    try {
      const notice = window.takeone.rootNotice && await window.takeone.rootNotice();
      if (notice && notice.text) {
        const host = $('#studioMain') || document.body;
        const banner = document.createElement('div');
        banner.className = 'notice-banner';
        banner.innerHTML = `<span></span><button class="btn small ghost2" aria-label="Dismiss">Got it</button>`;
        banner.querySelector('span').textContent = notice.text;
        banner.querySelector('button').addEventListener('click', () => banner.remove());
        host.prepend(banner);
      }
    } catch { /* non-fatal */ }
    renderSettings();
  }

  const NICHES = ['Short Films', 'History Documentaries', 'Wedding Films', 'Real Estate', 'Product Ads', 'Vlogs', 'Horror Shorts'];

  async function renderNiche() {
    const box = $('#nicheChips');
    if (!box) return;
    const c = await window.takeone.getConfig();
    const cur = (c && c.niche) || 'none';
    const all = ['none', ...NICHES];
    box.innerHTML = all.map((n) =>
      `<button class="chip ${cur === n ? 'sel' : ''}" data-niche="${n}">${n === 'none' ? 'No lens' : n}</button>`).join('');
    box.querySelectorAll('[data-niche]').forEach((ch) => ch.addEventListener('click', async () => {
      await window.takeone.setNiche(root, ch.dataset.niche);
      renderNiche(); renderSettings();
    }));
  }

  async function renderTaste() {
    const box = $('#tasteList');
    if (!box) return;
    const r = await window.takeone.getTaste(root);
    const rules = (r.ok && r.rules) || [];
    box.innerHTML = rules.length ? rules.map((t) => `
      <div class="tasterow"><span class="tbadge ${t.type}">${t.type === 'always' ? 'Always' : 'Never'}</span>
      <span class="ttext" data-tid="${t.id}">${escHtml(t.text)}</span>
      <button class="link" data-tedit="${t.id}">Edit</button>
      <button class="link danger-t" data-tdel="${t.id}">Remove</button></div>`).join('')
      : '<p class="muted">No rules yet. Add one — e.g. Always "Warm narrator voice", Never "Shaky handheld".</p>';
    box.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', async () => {
      await window.takeone.removeTaste(root, b.dataset.tdel);
      renderTaste();
    }));
    box.querySelectorAll('[data-tedit]').forEach((b) => b.addEventListener('click', async () => {
      const cur = box.querySelector(`[data-tid="${b.dataset.tedit}"]`);
      const v = prompt('Edit rule:', cur ? cur.textContent : '');
      if (v === null) return;
      const ur = await window.takeone.updateTaste(root, b.dataset.tedit, v);
      if (!ur.ok) notice(ur.reason || 'Could not update.');
      renderTaste();
    }));
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function renderSettings() {
    const pc = cfg.pcCheck || {};
    const shownRoot = await window.takeone.displayPath(root);
    $('#settingsCards').innerHTML =
      // M1.g: the data folder, shown read-only (plain text, never an
      // editable field) + the diagnostics button alongside it.
      card('Data folder', shownRoot, '<span class="muted small">Read-only — this is where TakeOne keeps everything (projects, models, Library).</span>') +
      card('Language', 'English') +
      card('PC check', pc.measuredAt ? 'Completed ' + new Date(pc.measuredAt).toLocaleString() : 'Not run',
        pc.speedMbps !== null && pc.speedMbps !== undefined ? `Download speed: ${pc.speedMbps} Mbps (measured)` : 'Download speed: not measured') +
      card('TakeOne folder', shownRoot, `<button class="link" id="showFolder2">Show in folder</button> <button class="link" id="changeFolder2">Change...</button>`) +
      // WO-32: one-click diagnostics — plain-text report on the clipboard (user names masked, no secrets).
      card('Diagnostics', 'App version, Windows, GPU, engine status and recent logs as plain text.',
        `<button class="link" id="copyDiagnostics">Copy diagnostics</button> <span class="muted small" id="diagNote"></span>`);
    $('#copyDiagnostics').addEventListener('click', async () => {
      const note = $('#diagNote');
      try {
        const r = await window.takeone.diagnostics(root);
        if (!r || !r.ok || !r.report) { note.textContent = 'Could not build the report.'; return; }
        await navigator.clipboard.writeText(r.report);
        note.textContent = 'Copied — paste it anywhere.';
      } catch { note.textContent = 'Could not copy.'; }
      setTimeout(() => { note.textContent = ''; }, 5000);
    });
    $('#showFolder2').addEventListener('click', () => window.takeone.showInFolder(root));
    $('#changeFolder2').addEventListener('click', async () => {
      const p = await window.takeone.pickFolder();
      if (!p) return;
      if (!confirm('Move your TakeOne library to the new folder?\n\nThe app will restart. Downloads in progress will need to be restarted.')) return;
      const r = await window.takeone.changeRoot(p);
      if (!r.ok) { notice('Could not change folder: ' + r.reason); return; }
      await window.takeone.relaunch();
    });
    try {
      const s = await window.takeone.folderSizes(root);
      const row = (name, bytes) => card(name, gb(bytes));
      $('#storageCards').innerHTML = row('Models', s.Models) + row('Projects', s.Projects) + row('Trash', s.Trash) + row('Temporary files', s['.staging']);
    } catch { $('#storageCards').innerHTML = card('Storage', 'Could not measure.'); }
    renderNiche();
    renderTaste();
    const ta = $('#tasteAdd');
    if (ta && !ta.dataset.wired) {
      ta.dataset.wired = '1';
      ta.addEventListener('click', async () => {
        const type = $('#tasteType').value;
        const text = $('#tasteText').value;
        const r = await window.takeone.addTaste(root, type, text);
        if (!r.ok) { notice(r.reason || 'Could not add the rule.'); return; }
        $('#tasteText').value = '';
        renderTaste();
      });
    }
  }

  // ---- Remove TakeOne (adopt-vs-wipe questionnaire) --------------------------
  function openRemove() {
    $('#removeModal').hidden = false;
    $('#removeList').innerHTML = '<p class="muted">Measuring…</p>';
    $('#removeNote').textContent = '';
    window.takeone.folderSizes(root).then(s => {
      const rows = [
        ['models', 'Downloaded models', s.Models],
        ['projects', 'My projects & creations', s.Projects],
        ['trash', 'Trash (recoverable files)', s.Trash],
        ['temp', 'Temporary files', s['.staging']],
      ];
      const note = (k, bytes) => bytes === 0 ? 'nothing here'
        : k === 'temp' ? 'safe to remove'
        : k === 'projects' ? 'moved to Trash (recoverable for 30 days) — never deleted outright'
        : 'kept unless you tick this';
      $('#removeList').innerHTML = '<div class="rmlist">' + rows.map(([k, label, bytes]) =>
        `<label class="rmrow"><input type="checkbox" data-rm="${k}" ${k === 'temp' ? 'checked' : ''}>
         <div><b>${label}</b><div class="sz">${gb(bytes)} — ${note(k, bytes)}</div></div></label>`
      ).join('') + '</div><p class="muted">Anything unticked stays in your TakeOne folder, ready if you reinstall. Creations are never permanently deleted by uninstall.</p>';
    }).catch(() => { $('#removeList').innerHTML = '<p class="muted">Could not measure folders.</p>'; });
  }

  async function doRemove() {
    const sel = {};
    document.querySelectorAll('#removeList input[data-rm]').forEach(cb => { sel[cb.dataset.rm] = cb.checked; });
    $('#removeNote').textContent = 'Removing selected data…';
    $('#removeGo').disabled = true;
    try {
      await window.takeone.uninstallData(root, sel);
    } catch (err) {
      $('#removeNote').textContent = 'Could not remove data: ' + String(err.message || err);
      $('#removeGo').disabled = false;
      return;
    }
    const r = await window.takeone.runUninstaller();
    if (!r.ok) {
      $('#removeNote').textContent = r.reason;
      $('#removeGo').disabled = false;
    }
    // on success the app quits as the uninstaller launches
  }

  function wire() {
    document.querySelectorAll('.railbtn').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.railbtn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
      $('#view-' + b.dataset.view).classList.add('on');
    }));
    $('#removeBtn').addEventListener('click', openRemove);
    $('#removeCancel').addEventListener('click', () => { $('#removeModal').hidden = true; });
    $('#removeGo').addEventListener('click', doRemove);
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); render(); console.log('studio-ready'); });
})();

// Auto-inject app version from main process (never hardcoded).
(async () => {
  try {
    const v = await window.takeone.getVersion();
    const el = document.getElementById('appVersion');
    if (el) el.textContent = 'v' + v;
    const el2 = document.getElementById('appVersionTitle');
    if (el2) el2.textContent = v;
  } catch { /* ignore */ }
})();
