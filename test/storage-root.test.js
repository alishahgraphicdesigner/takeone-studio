/* WO-39: stay out of Windows protected folders. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sr = require('../main/storage-root.js');

function fakeGetPath(map) {
  return (name) => map[name] || null;
}

describe('WO-39 protected folders', () => {
  const winPaths = {
    documents: 'C:\\Users\\Ali\\Documents',
    pictures: 'C:\\Users\\Ali\\Pictures',
    videos: 'C:\\Users\\Ali\\Videos',
    music: 'C:\\Users\\Ali\\Music',
    desktop: 'C:\\Users\\Ali\\Desktop',
    appData: 'C:\\Users\\Ali\\AppData\\Roaming',
  };
  const gp = fakeGetPath(winPaths);

  it('default root is %LOCALAPPDATA%\\TakeOne', () => {
    const oldLad = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Users\\Ali\\AppData\\Local';
    try {
      assert.equal(sr.defaultRoot(gp), 'C:\\Users\\Ali\\AppData\\Local\\TakeOne');
    } finally {
      if (oldLad === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLad;
    }
  });
  it('default root falls back to appData Roaming->Local when no env', () => {
    const oldLad = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      assert.equal(sr.defaultRoot(gp), 'C:\\Users\\Ali\\AppData\\Local\\TakeOne');
    } finally {
      if (oldLad !== undefined) process.env.LOCALAPPDATA = oldLad;
    }
  });
  it('detects Documents/Pictures/Videos/Music/Desktop', () => {
    assert.equal(sr.isProtectedFolder('C:\\Users\\Ali\\Videos\\TakeOne Studio', gp), true);
    assert.equal(sr.isProtectedFolder('C:\\Users\\Ali\\Documents\\TakeOne', gp), true);
    assert.equal(sr.isProtectedFolder('C:\\Users\\Ali\\Desktop', gp), true);
    assert.equal(sr.isProtectedFolder('C:\\Users\\Ali\\AppData\\Local\\TakeOne', gp), false);
    assert.equal(sr.isProtectedFolder('D:\\TakeOne', gp), false);
  });
  it('probeWritable: ok on a writable dir', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-probe-'));
    const r = await sr.probeWritable(d);
    assert.equal(r.ok, true);
    fs.rmSync(d, { recursive: true, force: true });
  });
  it('probeWritable: fake EPERM -> blocked code', async () => {
    const fakeFsp = {
      mkdir: async () => {},
      writeFile: async () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; },
      rm: async () => {},
    };
    const r = await sr.probeWritable('C:\\Users\\Ali\\Videos\\TakeOne', fakeFsp);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EPERM');
    assert.ok(sr.isBlockedBySecurity(r.code), 'EPERM counts as security-blocked');
    assert.ok(sr.isBlockedBySecurity('EACCES'));
    assert.ok(sr.isBlockedBySecurity('EBUSY'));
    assert.ok(!sr.isBlockedBySecurity('ENOENT'));
  });
  it('blockedMessage is plain words with what-to-do', () => {
    const m = sr.blockedMessage('C:\\Users\\Ali\\Videos\\TakeOne');
    assert.ok(m.body.includes('Windows Security is blocking TakeOne from saving files in'), m.body);
    assert.ok(m.body.includes('What to do:'), m.body);
    assert.ok(!m.body.includes('EPERM'), 'no dev jargon');
  });
});

describe('WO-39 library save blocked -> plain message', () => {
  const lib = require('../main/library.js');
  it('guardBlocked: EPERM -> plain message, no throw', async () => {
    const boom = async () => { const e = new Error('x'); e.code = 'EPERM'; throw e; };
    const r = await lib.guardBlocked(boom)();
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.ok(r.reason.includes('Windows Security is blocking'), r.reason);
    assert.ok(r.whatNext.includes('Controlled folder access') || r.whatNext.includes('allowed apps'));
  });
  it('guardBlocked: other errors still throw', async () => {
    const boom = async () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; };
    await assert.rejects(() => lib.guardBlocked(boom)(), /disk full/);
  });
  it('guardBlocked: success passes through', async () => {
    const r = await lib.guardBlocked(async () => ({ ok: true, v: 1 }))();
    assert.deepEqual(r, { ok: true, v: 1 });
  });
});
