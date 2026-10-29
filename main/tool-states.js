/* TakeOne Studio — per-tool state decision (pure, no Electron, no disk).
 * Extracted from main.js mergedToolStates (FIX-8) so the decision is
 * unit-testable: a finished download whose manifest check fails is a
 * FAILED verification naming the bad file — never a fresh "not
 * installed" offer, which is the lie that sent users back to a full
 * re-download after 34 GB had already landed.
 */
'use strict';

function decideToolState({ installed, dl, ts, bad }) {
  if (installed) {
    return { state: 'installed', progress: 0, error: null, detail: null, needsAutoRetry: false };
  }
  if (dl && dl.status === 'done') {
    return {
      state: 'failed', progress: 0,
      error: `Download finished but ${bad || 'files do not match the download'} — re-checking the download automatically.`,
      detail: null, needsAutoRetry: true,
    };
  }
  if (dl) {
    return {
      state: dl.status, progress: dl.progress || 0, error: dl.error || null,
      detail: dl.status === 'retrying' ? 'Retrying automatically…' : null,
      needsAutoRetry: false,
    };
  }
  if (ts && ts.status === 'installing') {
    return { state: 'installing', progress: ts.fraction || 0, error: null, detail: ts.note, needsAutoRetry: false };
  }
  if (ts && ts.status === 'cancelling') {
    return { state: 'cancelling', progress: 0, error: null, detail: ts.detail || 'Stopping…', needsAutoRetry: false };
  }
  if (ts && ts.status === 'queued') {
    return { state: 'queued', progress: 0, error: null, detail: ts.detail || 'Queued — starts automatically.', needsAutoRetry: false };
  }
  if (ts && ts.status === 'failed') {
    return { state: 'failed', progress: 0, error: ts.error, detail: null, needsAutoRetry: false };
  }
  return { state: 'not-installed', progress: 0, error: null, detail: null, needsAutoRetry: false };
}

module.exports = { decideToolState };
