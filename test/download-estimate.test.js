'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { formatDownloadEstimate } = require('../renderer/download-estimate.js');
const { CATALOG } = require('../main/catalog.js');

test('order example: 32617 MB at 22.8 Mbps -> about 3-4 hours at your speed', () => {
  assert.strictEqual(formatDownloadEstimate(32617, 22.8), 'about 3-4 hours at your speed');
});

test('exact-hour math collapses to one number', () => {
  // 7200 s at 10 Mbps = 2.0 h exactly (9000 MB / 1.25 MB/s).
  assert.strictEqual(formatDownloadEstimate(9000, 10), 'about 2 hours at your speed');
  assert.strictEqual(formatDownloadEstimate(4500, 10), 'about 1 hour at your speed');
});

test('under an hour -> minutes; under a minute -> under a minute', () => {
  assert.strictEqual(formatDownloadEstimate(1500, 10), 'about 20 minutes at your speed');
  assert.strictEqual(formatDownloadEstimate(100, 10), 'about 1 minute at your speed');
  assert.strictEqual(formatDownloadEstimate(5, 10), 'under a minute at your speed');
});

test('missing/zero/negative speed or size -> null (never a fabricated label)', () => {
  for (const [size, speed] of [[32617, null], [32617, 0], [32617, -5], [null, 22.8], [0, 22.8], [-1, 22.8]]) {
    assert.strictEqual(formatDownloadEstimate(size, speed), null, `${size}/${speed}`);
  }
});

test('catalog pin for the panel estimate: video-studio sizeMB is 32617', () => {
  const vs = CATALOG.find((t) => t.id === 'video-studio');
  assert.ok(vs, 'video-studio in catalog');
  assert.strictEqual(vs.sizeMB, 32617);
  assert.strictEqual(vs.sizeBytes, 34201772383);
});

test('studio.html loads the helper before pipeline.js', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'studio.html'), 'utf8');
  const est = html.indexOf('download-estimate.js');
  const pipe = html.indexOf('pipeline.js');
  assert.ok(est > 0 && pipe > est, 'download-estimate.js must load before pipeline.js');
});
