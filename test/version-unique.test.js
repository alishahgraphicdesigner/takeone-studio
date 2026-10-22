/* WO-34: version uniqueness check — CI must fail on a rebuilt version. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkVersionUnique } = require('../tools/check-version-unique.js');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const VERSIONS = [
  '| version | commit | exe sha256 |',
  `| 2.2.10 | ${SHA_A} | ${'c'.repeat(64)} |`,
].join('\n');

describe('checkVersionUnique', () => {
  it('passes for a brand-new version', () => {
    assert.equal(checkVersionUnique('2.2.11', SHA_B, VERSIONS).ok, true);
  });
  it('passes when the version maps to the same commit', () => {
    assert.equal(checkVersionUnique('2.2.10', SHA_A, VERSIONS).ok, true);
  });
  it('FAILS when the version was already built from a different commit', () => {
    const r = checkVersionUnique('2.2.10', SHA_B, VERSIONS);
    assert.equal(r.ok, false);
    assert.match(r.reason, /already built from a different commit/);
    assert.match(r.reason, /Bump the version/);
  });
});
