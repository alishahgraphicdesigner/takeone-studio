/* FIX-5: ONE contact-sheet drawer for the image Ali pack (3x3) and the
 * video Ali pack (2x2). Cells are EQUAL squares; every image is drawn
 * CONTAIN-fit — fully visible, never square-cropped — centered on a
 * dark background; the label sits in a clean strip at the cell bottom
 * (never clipped, never overlapping the next cell). The old inline code
 * used Math.max (cover = crop) with a 28px/16px label; both packs now
 * share this drawer, so a fix here fixes both sheets.
 * Pure geometry (containFit) is unit-tested in node; drawing needs a
 * browser canvas, so drawSheet is exercised by the UI audit's screenshots
 * and by real pack runs, not by node tests. */
(function (global) {
  'use strict';
  const CELL = 448;
  const LABEL_H = 32;
  const LABEL_FONT = '18px sans-serif';

  /**
   * Contain-fit geometry: scale so the WHOLE image fits inside the cell.
   * Returns { dw, dh, dx, dy } — draw at (cellX + dx, cellY + dy) with
   * size dw x dh. dw/dh never exceed the cell; aspect is preserved
   * exactly (no crop, no stretch). Degenerate input -> an empty rect.
   */
  function containFit(imgW, imgH, cell) {
    if (!(imgW > 0) || !(imgH > 0) || !(cell > 0)) return { dw: 0, dh: 0, dx: 0, dy: 0 };
    const scale = Math.min(cell / imgW, cell / imgH);
    const dw = imgW * scale;
    const dh = imgH * scale;
    return { dw, dh, dx: (cell - dw) / 2, dy: (cell - dh) / 2 };
  }

  function loadImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /**
   * Draw the sheet. items: [{ image, label }] where image is an
   * HTMLCanvasElement, an HTMLImageElement, a PNG data URL string, or
   * null (failed cell). cols: columns (3 for the image pack, 2 for
   * video). The canvas is resized to cols x rows of CELL squares.
   */
  async function drawSheet(canvas, items, cols) {
    const list = Array.isArray(items) ? items : [];
    const c = Math.max(1, cols | 0);
    const rows = Math.max(1, Math.ceil(list.length / c));
    canvas.width = CELL * c;
    canvas.height = CELL * rows;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const cx = (i % c) * CELL;
      const cy = Math.floor(i / c) * CELL;
      let drawable = item.image || null;
      if (typeof drawable === 'string') drawable = await loadImage(drawable);
      const iw = drawable ? (drawable.naturalWidth || drawable.width || 0) : 0;
      const ih = drawable ? (drawable.naturalHeight || drawable.height || 0) : 0;
      if (drawable && iw > 0 && ih > 0) {
        const g = containFit(iw, ih, CELL);
        ctx.drawImage(drawable, cx + g.dx, cy + g.dy, g.dw, g.dh);
      } else {
        ctx.fillStyle = '#333';
        ctx.fillRect(cx, cy, CELL, CELL);
        ctx.fillStyle = '#999';
        ctx.font = '24px sans-serif';
        ctx.fillText('failed', cx + 20, cy + 40);
      }
      // Clean label strip: full-width scrim, one line, padded — the text
      // can never run into the next cell or under the image edge.
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(cx, cy + CELL - LABEL_H, CELL, LABEL_H);
      ctx.fillStyle = '#fff';
      ctx.font = LABEL_FONT;
      ctx.fillText(String(item.label || ''), cx + 8, cy + CELL - 10);
    }
    return canvas;
  }

  const api = { CELL, LABEL_H, LABEL_FONT, containFit, drawSheet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TakeOneContactSheet = api;
})(typeof window !== 'undefined' ? window : globalThis);
