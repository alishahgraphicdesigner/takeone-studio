/* Regression test: ensurePip must not throw ReferenceError when pip is missing.
 * Bug: ensurePip(root, onProgress) referenced `onCancel` in its body without
 * declaring it -> ReferenceError the moment pip was absent (ensurepip path).
 * Run: node --test tests/deps-ensurepip.test.js
 * Label: logic is tested with a missing-Python root; real pip/Windows NOT covered.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { ensurePip } = require('../main/deps.js');

test('ensurePip with no Python/pip resolves (no ReferenceError), passing onCancel', async () => {
  const fakeRoot = path.join(__dirname, 'nonexistent-root-' + Date.now());
  let threw = null, result = null;
  try {
    result = await ensurePip(fakeRoot, null, () => {});
  } catch (e) { threw = e; }
  assert.strictEqual(threw, null, 'ensurePip threw: ' + (threw && threw.message));
  assert.ok(result && typeof result.ok === 'boolean', 'expected a result object');
  assert.strictEqual(result.ok, false, 'no Python here, so ok must be false — but without throwing');
});

test('ensurePip without onCancel arg also resolves', async () => {
  const fakeRoot = path.join(__dirname, 'nonexistent-root-' + Date.now());
  let threw = null;
  try { await ensurePip(fakeRoot); } catch (e) { threw = e; }
  assert.strictEqual(threw, null, 'ensurePip threw: ' + (threw && threw.message));
});
