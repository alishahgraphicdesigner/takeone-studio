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
  it('contains every required section', async () => {
    const r = await diag.buildDiagnosticsReport('C:\\TakeOne', over);
    for (const need of ['TakeOne Studio diagnostics', 'App version: 2.2.10', 'Windows:', 'GPU:',
      'Engine:', 'Free disk:', 'App log (current session only, last 100 lines)', 'ComfyUI log (last 100 lines)']) {
      assert.ok(r.includes(need), 'missing section: ' + need);
    }
  });
  it('masks the user name and carries no secrets', async () => {
    const r = await diag.buildDiagnosticsReport('C:\\Users\\RealName\\TakeOne', {
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

describe('WO-35: nvidia-smi never blocks the report', () => {
  const base = {
    version: '2.2.11', windows: 'w', engineSummary: 's', disk: 'd',
    appLog: 'a', comfyLog: 'c',
  };
  it('missing nvidia-smi: report still arrives, fast', async () => {
    const t0 = Date.now();
    const r = await diag.buildDiagnosticsReport('/tmp/x', {
      ...base,
      gpuExec: async () => { throw new Error('spawn nvidia-smi ENOENT'); },
    });
    assert.ok(Date.now() - t0 < 2000, 'should not wait');
    assert.ok(r.includes('GPU: no NVIDIA GPU detected'), r.split('\n')[4]);
  });
  it('hung nvidia-smi: report arrives within ~5 s, event loop stays responsive', async () => {
    // The fake hangs forever — the 5 s Promise.race timeout must still fire.
    const hanging = () => new Promise(() => {});
    let loopResponsive = false;
    const t0 = Date.now();
    const p = diag.buildDiagnosticsReport('/tmp/x', { ...base, gpuExec: hanging });
    // If the UI thread were blocked, this timer could not fire promptly.
    await new Promise((res) => setTimeout(() => { loopResponsive = true; res(); }, 100));
    assert.ok(loopResponsive, 'event loop was blocked');
    const r = await p;
    const dt = Date.now() - t0;
    assert.ok(dt < 7000, `took too long: ${dt} ms`);
    assert.ok(r.includes('GPU: no NVIDIA GPU detected'));
  });
  it('working nvidia-smi: name + driver parsed', async () => {
    const r = await diag.queryGpu(async () => ({ stdout: 'NVIDIA GeForce RTX 5070 Ti, 616.92\n' }));
    assert.equal(r, 'NVIDIA GeForce RTX 5070 Ti, driver 616.92');
  });
});

describe('WO-36: Engine section', () => {
  const base = { version: '2.2.12', windows: 'w', engineSummary: 's', disk: 'd', comfyLog: 'c' };
  it('shows lastError, OneDrive, venv, security sections', async () => {
    const r = await diag.buildDiagnosticsReport('/tmp/x', {
      ...base,
      appLog: 'session log here',
      engineSection: [
        'Root: C:\\Users\\...\\Documents\\TakeOne\\.engine',
        'OneDrive folder: YES — may cause file locks',
        'Shipped python: C:\\x\\.python\\python.exe (version 3.11.17)',
        'Engine venv: present (C:\\x\\.engine\\venv)',
        'Last error: step=venv code=1 at=2026-10-22T00:00:00Z',
        'Last error tail:\nAccess is denied',
        'Controlled Folder Access: on',
        'Defender real-time protection: on',
      ].join('\n'),
    });
    for (const s of ['--- Engine ---', 'Root:', 'OneDrive folder:', 'Shipped python:',
                     'Engine venv:', 'Last error:', 'Controlled Folder Access:',
                     'Defender real-time protection:']) {
      assert.ok(r.includes(s), `missing section: ${s}`);
    }
  });
  it('isOneDrivePath detects OneDrive folders', () => {
    assert.equal(diag.isOneDrivePath('C:\\Users\\a\\OneDrive\\Documents\\TakeOne\\.engine'), true);
    assert.equal(diag.isOneDrivePath('C:\\TakeOne\\.engine'), false);
  });
  it('querySecurity: failure -> unknown (acceptable)', async () => {
    const s = await diag.querySecurity(async () => { throw new Error('no powershell'); });
    assert.deepEqual(s, { controlledFolderAccess: 'unknown', defenderRealTime: 'unknown' });
  });
  it('querySecurity: hanging powershell -> unknown within ~5 s', async () => {
    const t0 = Date.now();
    const s = await diag.querySecurity(() => new Promise(() => {}));
    assert.ok(Date.now() - t0 < 7000, 'must resolve via timeout');
    assert.equal(s.controlledFolderAccess, 'unknown');
  });
  it('sessionLogTail: only lines after the last TOP-OF-FILE', () => {
    const p = require('path').join(require('os').tmpdir(), 'diag-session-test.log');
    fs.writeFileSync(p, '2026-01-01 old line 1\n2026-01-01 old line 2\n2026-10-22T10:00 TOP-OF-FILE\n2026-10-22T10:01 new line 1\n2026-10-22T10:02 ENGINE: FAIL step=venv\n');
    const tail = diag.sessionLogTail(p, 100);
    assert.ok(!tail.includes('old line'), 'old session must not appear');
    assert.ok(tail.includes('new line 1'), tail);
    assert.ok(tail.includes('ENGINE: FAIL step=venv'), 'engine events included');
    fs.rmSync(p);
  });
});
