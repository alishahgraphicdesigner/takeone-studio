/**
 * WO-34: unique versions.
 *
 * Fails (exit 1) when package.json's version already has a line in docs/VERSIONS.md
 * with a DIFFERENT commit sha — i.e. someone tried to rebuild the same version from
 * different code. A version maps to exactly one commit.
 *
 * Usage: node tools/check-version-unique.js [sha]
 *   sha defaults to `git rev-parse HEAD`.
 * Pure logic is exported for tests: checkVersionUnique(version, sha, versionsText).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parseVersions(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\|\s*([0-9]+\.[0-9]+\.[0-9]+)\s*\|\s*([0-9a-f]{40})\s*\|/);
    if (m) rows.push({ version: m[1], sha: m[2] });
  }
  return rows;
}

/** @returns {ok:true} or {ok:false, reason} */
function checkVersionUnique(version, sha, versionsText) {
  const rows = parseVersions(versionsText);
  const dup = rows.find((r) => r.version === version && r.sha !== sha);
  if (dup) {
    return {
      ok: false,
      reason: `version ${version} already built from a different commit in docs/VERSIONS.md (${dup.sha.slice(0, 7)} vs ${String(sha).slice(0, 7)}). Bump the version for a new build.`,
    };
  }
  return { ok: true };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const version = require(path.join(root, 'package.json')).version;
  const sha = process.argv[2] || execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  let text = '';
  try { text = fs.readFileSync(path.join(root, 'docs', 'VERSIONS.md'), 'utf8'); }
  catch { console.error('docs/VERSIONS.md not found'); process.exit(1); }
  const r = checkVersionUnique(version, sha, text);
  if (!r.ok) { console.error('VERSION CHECK FAILED: ' + r.reason); process.exit(1); }
  console.log(`version check OK: ${version} @ ${String(sha).slice(0, 7)}`);
}

module.exports = { checkVersionUnique, parseVersions };
