/* WO-40.4 gate tests: the installer must only build from an all-green verify commit. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gateDecision } = require('../tools/verify-green-gate.js');

const SHA = 'a'.repeat(40);
const run = (id, over = {}) => ({ id, head_sha: SHA, status: 'completed', conclusion: 'success', created_at: '2026-10-24T10:00:00Z', ...over });
const job = (name, conclusion, runId = 1) => ({ id: name, run_id: runId, name, conclusion });
const greenJobs = [job('logic-and-real-aria2-linux', 'success'), job('windows-aria2', 'success'), job('windows-installer', 'success'), job('pip-measure-windows', 'skipped')];

test('no verify run for the commit -> fail', () => {
  const r = gateDecision({ workflow_runs: [run(1, { head_sha: 'b'.repeat(40) })] }, { jobs: greenJobs }, SHA);
  assert.strictEqual(r.ok, false);
});

test('verify still running -> fail', () => {
  const r = gateDecision({ workflow_runs: [run(1, { status: 'in_progress', conclusion: null })] }, { jobs: [] }, SHA);
  assert.strictEqual(r.ok, false);
});

test('latest completed run failed -> fail even if an earlier run was green', () => {
  const runs = { workflow_runs: [run(2, { conclusion: 'failure', created_at: '2026-10-24T11:00:00Z' }), run(1)] };
  const r = gateDecision(runs, { jobs: greenJobs.map((j) => ({ ...j, run_id: 2 })) }, SHA);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /failure/);
});

test('green run but one job failed -> fail, naming the job', () => {
  const jobs = [...greenJobs.slice(0, 2), job('windows-installer', 'failure')];
  const r = gateDecision({ workflow_runs: [run(1)] }, { jobs }, SHA);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /windows-installer:failure/);
});

test('green run, jobs success + skipped pip job -> pass', () => {
  const r = gateDecision({ workflow_runs: [run(1)] }, { jobs: greenJobs }, SHA);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.runId, 1);
});

test('jobs file for a different run -> fail', () => {
  const r = gateDecision({ workflow_runs: [run(1)] }, { jobs: greenJobs.map((j) => ({ ...j, run_id: 99 })) }, SHA);
  assert.strictEqual(r.ok, false);
});

test('empty jobs list -> fail (fail-closed)', () => {
  const r = gateDecision({ workflow_runs: [run(1)] }, { jobs: [] }, SHA);
  assert.strictEqual(r.ok, false);
});
