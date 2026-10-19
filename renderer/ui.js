/* TakeOne Studio — shared in-app notice modal.
 * Replaces the native alert() everywhere: same purpose, on-brand design.
 * Usage: notice('message') or notice('title', 'message').
 */
'use strict';
(function () {
  const css = `
.t1-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;
  display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.t1-notice{background:#1d1d26;border:1px solid rgba(255,255,255,.12);border-radius:14px;
  padding:22px 24px;max-width:420px;width:calc(100% - 48px);
  box-shadow:0 20px 60px rgba(0,0,0,.6)}
.t1-notice h3{margin:0 0 8px;font-size:16px;color:#f2f2f5}
.t1-notice p{margin:0 0 18px;font-size:14px;line-height:1.5;color:#c9c9d4}
.t1-notice .row{display:flex;justify-content:flex-end;gap:10px}
.t1-notice .btn{background:#f5a623;border:0;border-radius:8px;padding:9px 22px;
  font-size:14px;font-weight:600;color:#1a1a1a;cursor:pointer;font-family:inherit}
.t1-notice .btn:hover{background:#ffB638}`;
  function ensureCss() {
    if (document.getElementById('t1-ui-css')) return;
    const st = document.createElement('style');
    st.id = 't1-ui-css';
    st.textContent = css;
    document.head.appendChild(st);
  }
  window.notice = function (title, message) {
    if (message === undefined) { message = title; title = 'TakeOne Studio'; }
    ensureCss();
    document.querySelectorAll('.t1-overlay').forEach((o) => o.remove());
    const ov = document.createElement('div');
    ov.className = 't1-overlay';
    ov.innerHTML = `<div class="t1-notice" role="alertdialog" aria-label="${String(title).replace(/"/g, '')}">
      <h3></h3><p></p><div class="row"><button class="btn">OK</button></div></div>`;
    ov.querySelector('h3').textContent = title;
    ov.querySelector('p').textContent = message;
    const close = () => ov.remove();
    ov.querySelector('.btn').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(ov);
    ov.querySelector('.btn').focus();
  };
  /* Styled input modal — replaces native prompt(). Resolves the string or null. */
  window.promptModal = function (title, placeholder) {
    ensureCss();
    const css2 = `.t1-notice input{width:100%;box-sizing:border-box;background:#14141b;
      border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:10px 12px;
      font-size:14px;color:#f2f2f5;font-family:inherit;margin-bottom:18px}
      .t1-notice input:focus{outline:none;border-color:#f5a623}
      .t1-notice .btn.ghost{background:transparent;color:#c9c9d4;border:1px solid rgba(255,255,255,.2)}`;
    if (!document.getElementById('t1-ui-css2')) {
      const st = document.createElement('style');
      st.id = 't1-ui-css2'; st.textContent = css2;
      document.head.appendChild(st);
    }
    return new Promise((resolve) => {
      document.querySelectorAll('.t1-overlay').forEach((o) => o.remove());
      const ov = document.createElement('div');
      ov.className = 't1-overlay';
      ov.innerHTML = `<div class="t1-notice" role="dialog" aria-label="${String(title).replace(/"/g, '')}">
        <h3></h3><div class="row" style="justify-content:stretch">
        <input type="text" /></div>
        <div class="row"><button class="btn ghost">Cancel</button><button class="btn ok">Create</button></div></div>`;
      ov.querySelector('h3').textContent = title;
      const input = ov.querySelector('input');
      input.placeholder = placeholder || '';
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('.ok').addEventListener('click', () => done(input.value.trim() || null));
      ov.querySelector('.ghost').addEventListener('click', () => done(null));
      ov.addEventListener('click', (e) => { if (e.target === ov) done(null); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value.trim() || null);
        if (e.key === 'Escape') done(null);
      });
      document.body.appendChild(ov);
      input.focus();
    });
  };
})();
