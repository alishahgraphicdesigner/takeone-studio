/* WO-37: no [hidden] element may be forced visible by a CSS display rule.
 *
 * Root cause of the "dark pill": .toast{display:flex} has the same specificity
 * as the UA stylesheet's [hidden]{display:none}, and author order wins — so the
 * empty toast rendered as a dark pill fixed over the UI even while hidden.
 * Every element carrying `hidden` in studio.html must have a matching
 * `[hidden]{display:none}` (or equivalent) rule in the renderer CSS.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'studio.html'), 'utf8');
const css = ['studio.css', 'models.css', 'pipeline.css']
  .map((f) => { try { return fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8'); } catch { return ''; } })
  .join('\n');

describe('WO-37: hidden elements stay hidden', () => {
  it('every [hidden] element in studio.html has a CSS [hidden] override when its class/id sets display', () => {
    // All elements with a hidden attribute.
    const hiddenEls = [...html.matchAll(/<([a-z]+)[^>]*\bhidden\b[^>]*>/gi)];
    assert.ok(hiddenEls.length > 0, 'expected some hidden elements in studio.html');
    for (const m of hiddenEls) {
      const tag = m[0];
      const id = (tag.match(/\bid="([^"]+)"/) || [])[1] || '';
      const cls = (tag.match(/\bclass="([^"]+)"/) || [])[1] || '';
      // Does any CSS rule set `display:` for this id or class?
      const setsDisplay =
        (id && new RegExp(`#${id}\\s*{[^}]*display\\s*:`, 's').test(css)) ||
        cls.split(/\s+/).some((c) => c && new RegExp(`\\.${c}\\s*{[^}]*display\\s*:`, 's').test(css));
      if (!setsDisplay) continue; // no display rule -> UA [hidden] wins, fine
      // Then there must be an explicit [hidden] override.
      const covered =
        (id && new RegExp(`#${id}\\[hidden\\]\\s*{[^}]*display\\s*:\\s*none`, 's').test(css)) ||
        cls.split(/\s+/).some((c) => c && new RegExp(`\\.${c}\\[hidden\\]\\s*{[^}]*display\\s*:\\s*none`, 's').test(css));
      assert.ok(covered, `<${id || cls}> sets display but has no [hidden]{display:none} override (WO-37 regression)`);
    }
  });

  it('.toast specifically hides when the hidden attribute is set', () => {
    assert.match(css, /\.toast\[hidden\]\s*\{\s*display\s*:\s*none/, '.toast[hidden]{display:none} missing');
  });
});
