/* TakeOne Studio — Extras: free web assets (SIDE section, never primary).
 * Decision #37: local AI generation is primary; these links are extras.
 * Every entry carries its honest license note — license is per-asset, not per-site.
 * Verified Oct 2026 (workspace/takeone-demo/free-stock-assets.md). */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const GROUPS = [
    { name: 'Stock video', items: [
      ['Pexels', 'https://www.pexels.com/', 'Free for commercial use, no attribution. 4K, no watermark.'],
      ['Pixabay', 'https://pixabay.com/videos/', 'Free for commercial use. Check Content-ID on music tracks.'],
      ['Mixkit', 'https://mixkit.co/', 'Mostly free for commercial use — check each clip: Restricted ones are personal-only.'],
      ['Coverr', 'https://coverr.co/', 'Free for commercial use. Smaller, curated library.'],
    ]},
    { name: 'Stock images', items: [
      ['Unsplash', 'https://unsplash.com/', 'Free for commercial use, no attribution needed.'],
      ['Pexels', 'https://www.pexels.com/', 'Free for commercial use, no attribution.'],
      ['Pixabay', 'https://pixabay.com/images/', 'Free for commercial use. Illustrations and vectors too.'],
    ]},
    { name: 'Music', items: [
      ['YouTube Audio Library', 'https://www.youtube.com/audiolibrary', 'Free for monetized videos. Some tracks need attribution — check the license column.'],
      ['Pixabay Music', 'https://pixabay.com/music/', 'Free for commercial use. Watch the Content-ID flag on some tracks.'],
      ['Mixkit Music', 'https://mixkit.co/free-stock-music/', 'Free for online/social use. NOT for TV/radio broadcast.'],
    ]},
    { name: 'Sound effects', items: [
      ['Pixabay SFX', 'https://pixabay.com/sound-effects/', 'Free for commercial use. 130,000+ sounds.'],
      ['Freesound', 'https://freesound.org/', 'License is PER SOUND: CC0/CC-BY ok, CC BY-NC never commercial. Check each one.'],
      ['Mixkit SFX', 'https://mixkit.co/', 'Free for commercial use, WAV+MP3.'],
    ]},
    { name: 'Fonts', items: [
      ['Google Fonts', 'https://fonts.google.com/', 'Mostly SIL Open Font License — free for commercial use, including video text.'],
      ['Fontshare', 'https://fontshare.com/', 'Free for commercial use. Do not modify or redistribute the font files.'],
    ]},
  ];

  function render() {
    const box = $('#extrasBody');
    if (!box) return;
    box.innerHTML = `<h1>Extras</h1>
      <p class="lede">Free assets from the web — a side shelf, never the main act. TakeOne's primary engine is local AI generation.</p>
      <div class="notice"><b>License is per asset, not per site.</b> Always check the license on the exact file you download — especially on Mixkit and Freesound.</div>
      ` + GROUPS.map((g) => `
        <h2 class="libsec">${esc(g.name)}</h2>
        <div class="xgrid">` + g.items.map(([name, url, note]) => `
          <div class="xcard"><b>${esc(name)}</b>
            <p class="muted small">${esc(note)}</p>
            <button class="link" data-xurl="${esc(url)}">Open ${esc(name)} ↗</button>
          </div>`).join('') + `</div>`).join('');
    box.querySelectorAll('[data-xurl]').forEach((b) =>
      b.addEventListener('click', () => window.takeone.openExternal(b.dataset.xurl)));
  }

  document.addEventListener('DOMContentLoaded', () => { render(); });
})();
