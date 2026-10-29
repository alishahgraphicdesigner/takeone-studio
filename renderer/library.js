/* TakeOne Studio 2.2.0 — Phase C: Library view.
 * Real projects, real files, real trash. Every card maps to a folder on disk. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let root = null;
  let openId = null;


  function gb(b) { return (b / 2 ** 30).toFixed(2) + ' GB'; }
  function mb(b) { return b > 2 ** 30 ? gb(b) : (b / 2 ** 20).toFixed(1) + ' MB'; }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch { return '—'; }
  }
  function fileUrl(abs) {
    return 'file:///' + String(abs).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  }

  async function init() {
    const cfg = await window.takeone.getConfig();
    if (!cfg) return;
    root = cfg.storageRoot;
    // FIX-4 (FINAL item 2): the main process announces every project/asset
    // change. Re-read on the event, even while this tab is open — a
    // Quick Generate / Ali pack save appears at once, no restart, no
    // tab switch needed. (Tab switches re-read too; both paths exist.)
    if (window.takeone.onLibraryChanged) window.takeone.onLibraryChanged(() => { render().catch((e) => console.error(e)); });
    render();
  }

  async function render() {
    const box = $('#libraryBody');
    const lp = await window.takeone.listProjects(root);
    const projects = (lp.ok && lp.projects) || [];
    const tp = await window.takeone.listTrash(root);
    const trash = (tp.ok && tp.trash) || [];

    let html = `<div class="lib-head"><div><h1>Library</h1>
      <p class="lede">Every project has one permanent home. Images, videos, audio and exports stay together — on your disk, in your TakeOne folder.</p></div>
      <button class="primary" id="libNew">New project</button></div>`;

    if (!projects.length) {
      html += `<div class="empty-hero"><h2>Your library is empty</h2>
        <p class="lede">Every film you make lives here — its images, clips, voice and exports, together in one real folder on your disk.</p>
        <div class="hero-ctas">
          <button class="primary" id="libNew2">New project</button>
        </div>
        <p class="muted small">Already have files? Open a project and use <b>Import files</b> — duplicates are caught automatically, nothing is ever copied twice.</p>
      </div>`;
    } else {
      html += `<h2 class="libsec">Your films</h2><div class="projgrid">` + projects.map((p) => `
        <div class="projcard ${openId === p.id ? 'open' : ''}">
          ${p.thumb ? `<img class="projthumb" src="${fileUrl(root + '/Projects/' + p.id + '/' + p.thumb)}" alt="">` : ''}
          <b>${esc(p.name)}</b>
          <span class="muted small">${p.counts.total} file${p.counts.total === 1 ? '' : 's'} · ${p.readySteps}/6 steps ready · Updated ${esc(fmtDate(p.updatedAt))}</span>
          <div class="counts"><span>🖼 ${p.counts.images}</span><span>🎬 ${p.counts.videos}</span><span>🎙 ${p.counts.audio}</span><span>📦 ${p.counts.exports}</span></div>
          <div class="row">
            <button class="ghost sm" data-open="${p.id}">${openId === p.id ? 'Close' : 'Open'}</button>
            <button class="link" data-showproj="${p.id}">Show in folder</button>
            <button class="link danger-t" data-delproj="${p.id}">Delete</button>
          </div>
          ${openId === p.id ? `<div class="projdetail" id="projDetail"><p class="muted">Loading files…</p></div>` : ''}
        </div>`).join('') + `</div>`;
    }

    html += `<h2 class="libsec">Trash <span class="muted small">— recoverable for 30 days, then gone for good</span></h2>`;
    if (!trash.length) {
      html += `<p class="muted">Nothing in Trash.</p>`;
    } else {
      html += `<div class="trashlist">` + trash.map((t) => `
        <div class="trashrow"><div><b>${esc(t.label)}</b>
          <span class="muted small">${t.kind} · ${mb(t.size)} · ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left</span></div>
          <div class="row"><button class="ghost sm" data-restore="${esc(t.trashName)}" data-kind="${t.kind}">Restore</button>
          <button class="link danger-t" data-forget="${esc(t.trashName)}" data-kind="${t.kind}">Delete forever</button></div>
        </div>`).join('') + `</div>
        <div class="row"><button class="ghost sm" id="trashEmpty">Empty trash</button></div>`;
    }

    box.innerHTML = html;
    wire(projects);
    if (openId) renderProjectDetail(openId);
  }

  function wire(projects) {
    const mk = async () => {
      const name = prompt('Project name:', '');
      if (name === null) return;
      const before = await window.takeone.listProjects(root);
      const wasFirst = !before.ok || (before.projects || []).length === 0;
      const r = await window.takeone.createProject(root, name);
      if (!r.ok) { notice(r.reason || 'Could not create the project.'); return; }
      if (wasFirst && window.__pipeline && window.__pipeline.maybeAskNiche) {
        window.__pipeline.maybeAskNiche();
      }
      render();
    };
    $('#libNew').addEventListener('click', mk);
    const n2 = $('#libNew2');
    if (n2) n2.addEventListener('click', mk);

    $$('[data-open]').forEach((b) => b.addEventListener('click', () => {
      openId = openId === b.dataset.open ? null : b.dataset.open;
      render();
    }));
    $$('[data-showproj]').forEach((b) => b.addEventListener('click', () => {
      window.takeone.showInFolder(root + '/Projects/' + b.dataset.showproj);
    }));
    $$('[data-delproj]').forEach((b) => b.addEventListener('click', async () => {
      const p = projects.find((x) => x.id === b.dataset.delproj);
      if (!confirm(`Move "${p ? p.name : 'this project'}" to Trash? You can restore it within 30 days.`)) return;
      // FIX-7: render in finally — Library AND Trash re-read from disk
      // even if the IPC call rejects or the notice throws, so the view
      // can never go stale after a Trash action.
      try {
        const r = await window.takeone.trashProject(root, b.dataset.delproj);
        if (!r.ok) notice(r.reason || 'Could not delete.');
      } finally {
        if (openId === b.dataset.delproj) openId = null;
        render();
      }
    }));
    $$('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await window.takeone.restoreFromTrash(root, b.dataset.restore, b.dataset.kind);
        if (!r.ok) notice(r.reason || 'Could not restore.');
      } finally { render(); }
    }));
    $$('[data-forget]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete forever? This cannot be undone.')) return;
      try {
        const r = await window.takeone.deleteForever(root, b.dataset.forget, b.dataset.kind);
        if (!r.ok) notice(r.reason || 'Could not delete.');
      } finally { render(); }
    }));
    const te = $('#trashEmpty');
    if (te) te.addEventListener('click', async () => {
      if (!confirm('Empty the entire Trash? This cannot be undone.')) return;
      try {
        const r = await window.takeone.emptyTrash(root);
        if (r && !r.ok) notice(r.reason || 'Could not empty Trash.');
      } finally { render(); }
    });
  }

  async function renderProjectDetail(id) {
    const box = $('#projDetail');
    if (!box) return;
    const r = await window.takeone.listAssets(root, id);
    const assets = (r.ok && r.assets) || [];
    const groups = {};
    for (const a of assets) { (groups[a.type] = groups[a.type] || []).push(a); }
    const card = (a) => `
      <div class="assetcard">
        ${a.type === 'images' ? `<img src="${fileUrl(root + '/Projects/' + id + '/' + a.rel)}" alt="">` : `<div class="fthumb">📄</div>`}
        <span class="aname">${esc(a.fileName)}</span>
        <span class="muted small">${mb(a.size)}${a.external ? ' · added outside TakeOne' : ''}</span>
        <div class="row"><button class="link" data-ashow="${esc(a.rel)}">Show in folder</button>
        <button class="link danger-t" data-adel="${esc(a.rel)}">Delete</button></div>
      </div>`;
    box.innerHTML = `
      <div class="row"><button class="primary sm" id="assImport">Import files…</button>
      <span class="muted small">Duplicates are caught — the same file is never copied twice.</span></div>
      <div id="dupNote"></div>
      ${['images', 'videos', 'audio', 'exports'].map((t) => `
        <h4>${t[0].toUpperCase() + t.slice(1)} (${(groups[t] || []).length})</h4>
        ${(groups[t] || []).length ? `<div class="assetgrid">${groups[t].map(card).join('')}</div>` : '<p class="muted small">Empty.</p>'}`).join('')}`;
    $('#assImport').addEventListener('click', async () => {
      const ir = await window.takeone.importAsset(root, id, {});
      if (!ir.ok && ir.reason !== 'cancelled') { notice(ir.reason || 'Import failed.'); return; }
      if (ir.ok) {
        const dupes = ir.results.filter((x) => x.duplicate);
        const added = ir.results.filter((x) => x.ok);
        $('#dupNote').innerHTML =
          (added.length ? `<p class="oknote">${added.length} file${added.length === 1 ? '' : 's'} imported.</p>` : '') +
          (dupes.length ? `<p class="warnnote">${dupes.length} already in Library — no second copy was made.</p>` : '');
      }
      renderProjectDetail(id);
      render(); // refresh counts
    });
    $$('[data-ashow]', box).forEach((b) => b.addEventListener('click', () => {
      window.takeone.showInFolder(root + '/Projects/' + id + '/' + b.dataset.ashow);
    }));
    $$('[data-adel]', box).forEach((b) => b.addEventListener('click', async () => {
      const rel = b.dataset.adel;
      const dr = await window.takeone.deleteAsset(root, id, rel);
      if (!dr.ok) { notice(dr.reason || 'Could not delete.'); return; }
      renderProjectDetail(id);
      render();
      if (window.takeoneToast && dr.trashName) {
        window.takeoneToast('Moved to Trash — recoverable for 30 days.', 'Undo', async () => {
          const rr = await window.takeone.restoreFromTrash(root, dr.trashName, 'asset');
          if (!rr.ok) notice(rr.reason || 'Could not restore.');
          renderProjectDetail(id);
          render();
        });
      }
    }));
  }

  // FIX-4: re-read from disk every time the Library tab opens (see
  // pipeline.switchView / studio rail wiring). Called on tab switches;
  // harmless if the page is still loading (init renders anyway).
  window.takeoneLibraryRefresh = () => { render().catch((e) => console.error(e)); };

  document.addEventListener('DOMContentLoaded', () => { init().catch((e) => console.error(e)); });
})();
