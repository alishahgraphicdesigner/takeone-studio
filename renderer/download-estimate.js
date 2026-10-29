/* Plain-words download time from the MEASURED PC-check speed — never
 * guessed (Decision #25, same rule as models.js dlTime). The video
 * download is ~34 GB, so hours are shown as a RANGE: the estimate is
 * honest about its own error (network speed varies), and the range
 * brackets the single-number math. No measured speed -> null, never
 * a fabricated label. Pure function, unit-tested in node; the card
 * and the Video panel share it so both offers say the same thing.
 * NOTE on units: catalog sizeMB is MiB (32617 MiB = 34.20 GB), and
 * this follows dlTime's sizeMB/(speed/8) convention — the hour range
 * absorbs the ~5% MiB/MB difference (3.18 h computed vs 3.33 h true
 * at 22.8 Mbps; both read 'about 3-4 hours'). */
(function (global) {
  'use strict';

  /**
   * Returns e.g. 'about 3-4 hours at your speed' for 32617 MB at
   * 22.8 Mbps (32617 / (22.8/8) = 11445 s = 3.18 h -> 3-4). Exact-hour
   * math collapses to one number ('about 2 hours at your speed');
   * under an hour -> minutes; under a minute -> 'under a minute'.
   * sizeMB/speedMbps missing, zero or negative -> null.
   */
  function formatDownloadEstimate(sizeMB, speedMbps) {
    if (!(sizeMB > 0) || !(speedMbps > 0)) return null;
    const seconds = sizeMB / (speedMbps / 8);
    if (seconds < 60) return 'under a minute at your speed';
    if (seconds < 3600) {
      const m = Math.round(seconds / 60);
      return 'about ' + m + (m === 1 ? ' minute' : ' minutes') + ' at your speed';
    }
    const h = seconds / 3600;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    if (lo === hi) return 'about ' + lo + (lo === 1 ? ' hour' : ' hours') + ' at your speed';
    return 'about ' + lo + '-' + hi + ' hours at your speed';
  }

  const api = { formatDownloadEstimate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TakeOneDownloadEstimate = api;
})(typeof window !== 'undefined' ? window : globalThis);
