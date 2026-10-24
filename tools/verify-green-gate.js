/**
 * WO-40.4: fail-closed gate — build-installer may only build from a commit
 * whose verify workflow is ALL green.
 *
 * Inputs (GitHub API JSON, as fetched by the workflow with `gh api`):
 *   runs.json: { workflow_runs: [{ id, head_sha, status, conclusion, created_at }] }
 *   jobs.json: { jobs: [{ id, run_id, name, conclusion }] } for one run
 *   sha:       the commit the installer would be built from
 *
 * Rules:
 *   - No verify run for the commit            -> FAIL (never build blind).
 *   - Latest completed run is not `success`   -> FAIL (an earlier green run
 *     does not rescue a later red one).
 *   - Any job of that run is not `success` or `skipped` -> FAIL. `skipped`
 *     is allowed because pip-measure-windows only runs on workflow_dispatch.
 *   - jobs.json must belong to that latest completed run, else FAIL.
 *
 * Pure logic is exported for tests: gateDecision(runs, jobs, sha).
 * CLI: node tools/verify-green-gate.js runs.json jobs.json <sha>
 */
'use strict';

const fs = require('fs');

function asArray(x, key) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x[key])) return x[key];
  return [];
}

/** @returns {{ok:true, runId:number, jobNames:string[]} | {ok:false, reason:string}} */
function gateDecision(runsInput, jobsInput, sha) {
  const runs = asArray(runsInput, 'workflow_runs').filter((r) => r && r.head_sha === sha);
  if (!runs.length) {
    return { ok: false, reason: `no verify run found for commit ${sha}` };
  }
  const completed = runs
    .filter((r) => r.status === 'completed')
    .sort((a, b) => String(b.created_at || '') .localeCompare(String(a.created_at || '')) || (b.id - a.id));
  if (!completed.length) {
    return { ok: false, reason: `verify run for commit ${sha} has not completed yet (still running or queued)` };
  }
  const latest = completed[0];
  if (latest.conclusion !== 'success') {
    return { ok: false, reason: `latest completed verify run ${latest.id} for commit ${sha} concluded '${latest.conclusion}', not 'success'` };
  }
  const jobs = asArray(jobsInput, 'jobs');
  if (!jobs.length) {
    return { ok: false, reason: `no jobs found for verify run ${latest.id} — cannot prove all jobs green` };
  }
  const mismatched = jobs.filter((j) => j.run_id !== undefined && j.run_id !== latest.id);
  if (mismatched.length) {
    return { ok: false, reason: `jobs file belongs to a different run (expected verify run ${latest.id})` };
  }
  const bad = jobs.filter((j) => j.conclusion !== 'success' && j.conclusion !== 'skipped');
  if (bad.length) {
    return { ok: false, reason: `verify run ${latest.id} has non-green jobs: ${bad.map((j) => `${j.name || j.id}:${j.conclusion}`).join(', ')}` };
  }
  return { ok: true, runId: latest.id, jobNames: jobs.map((j) => `${j.name || j.id}:${j.conclusion}`) };
}

if (require.main === module) {
  const [runsPath, jobsPath, sha] = process.argv.slice(2);
  if (!runsPath || !jobsPath || !sha) {
    console.error('usage: node tools/verify-green-gate.js runs.json jobs.json <sha>');
    process.exit(2);
  }
  let runs, jobs;
  try { runs = JSON.parse(fs.readFileSync(runsPath, 'utf8')); } catch (e) { console.error('cannot read runs json: ' + e.message); process.exit(2); }
  try { jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8')); } catch (e) { console.error('cannot read jobs json: ' + e.message); process.exit(2); }
  const r = gateDecision(runs, jobs, sha);
  if (!r.ok) { console.error('WO-40 GATE FAILED: ' + r.reason); process.exit(1); }
  console.log(`WO-40 gate OK: verify run ${r.runId} all green for commit ${sha} (${r.jobNames.join(', ')})`);
}

module.exports = { gateDecision };
