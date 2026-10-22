/* WO-32: diagnostics report — masking + structure tests. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const diag = require('../main/diagnostics.js');

describe('maskUserName', () => {
  it('masks Windows user names in paths', () => {
    const out = diag.maskUserName('C:\\Users\\AliAhmed\\TakeOne\\file.txt');
    assert.ok(!out.includes('AliAhmed'), 'user name must not appear');
    assert.ok(out.includes('C:\\Users\\...'), out);
  });
  it('masks unix home dirs', () => {
    const out = diag.maskUserName('/home/someone/projects/x');
    assert.ok(!out.includes('someone'));
    assert.ok(out.includes('/home/...'));
  });
  it('leaves non-user paths alone', () => {
    assert.equal(diag.maskUserName('D:\\TakeOne\\Models'), 'D:\\TakeOne\\Models');
  });
});

describe('scrubSecrets', () => {
  it('scrubs assigned secrets', () => {
    const out = diag.scrubSecrets('connecting with api_key=sk-abc123XYZ and token: hunter2');
    assert.ok(!out.includes('sk-abc123XYZ'), 'api key must not appear');
    assert.ok(!out.includes('hunter2'), 'token must not appear');
    assert.ok(out.includes('api_key=...'));
  });
  it('does not scrub ordinary words', () => {
    assert.equal(diag.scrubSecrets('no secrets here'), 'no secrets here');
  });
});

describe('buildDiagnosticsReport', () => {
  const over = {
    version: '2.2.10',
    windows: 'Windows 11 Pro (win32 10.0.26100)',
    gpu: 'NVIDIA GeForce RTX 5070 Ti, driver 616.92',
    engineSummary: 'installed (86 wheels, python 3.11.17)',
    disk: '412.3 GB free',
    appLog: 'line1\nline2',
    comfyLog: 'comfy started',
  };
  it('contains every required section', () => {
    const r = diag.buildDiagnosticsReport('C:\\TakeOne', over);
    for (const need of ['TakeOne Studio diagnostics', 'App version: 2.2.10', 'Windows:', 'GPU:',
      'Engine:', 'Free disk:', 'App log (last 100 lines)', 'ComfyUI log (last 100 lines)']) {
      assert.ok(r.includes(need), 'missing section: ' + need);
    }
  });
  it('masks the user name and carries no secrets', () => {
    const r = diag.buildDiagnosticsReport('C:\\Users\\RealName\\TakeOne', {
      ...over,
      appLog: 'opened C:\\Users\\RealName\\TakeOne\\x.png with api_key=sk-topsecret999',
      comfyLog: 'token: abcdef12345',
    });
    assert.ok(!r.includes('RealName'), 'user name leaked into report');
    assert.ok(!r.includes('sk-topsecret999'), 'api key leaked into report');
    assert.ok(!r.includes('abcdef12345'), 'token leaked into report');
    // No common secret shapes anywhere in the report.
    assert.ok(!/\b(sk-[A-Za-z0-9]{8,})\b/.test(r), 'sk- secret shape present');
  });
});

describe('tailFile', () => {
  it('returns the last n lines', () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diag-')), 't.log');
    fs.writeFileSync(p, Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n');
    const t = diag.tailFile(p, 3);
    assert.equal(t, 'l7\nl8\nl9');
  });
  it('handles a missing file', () => {
    assert.equal(diag.tailFile('/no/such/file.log', 5), '(no log yet)');
  });
});

describe('appendComfyLog', () => {
  it('writes and rotates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-root-'));
    diag.appendComfyLog(root, 'first line');
    diag.appendComfyLog(root, 'second line');
    const p = diag.comfyLogPath(root);
    const data = fs.readFileSync(p, 'utf8');
    assert.ok(data.includes('first line') && data.includes('second line'));
    const tail = diag.tailFile(p, 100);
    assert.ok(tail.includes('second line'));
  });
});
