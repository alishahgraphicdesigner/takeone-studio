/* TakeOne Studio 2.2.0 — Phase B unit tests: catalog, gates, download logic. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CATALOG, validateCatalog, vramAllowed, estimateBytes, catalogSignature, verifyCatalog,
  postCheckResult, mapAriaStatus, parsePipProgress, installPlan,
} = require('../main.js');

describe('validateCatalog', () => {
  it('has exactly 21 tools', () => {
    assert.equal(CATALOG.length, 21);
  });
  it('passes its own validation', () => {
    const v = validateCatalog(CATALOG);
    assert.deepEqual(v.errors, [], 'catalog errors: ' + JSON.stringify(v.errors));
    assert.equal(v.ok, true);
  });
  it('has no LTX or RealESRGAN references anywhere', () => {
    const blob = JSON.stringify(CATALOG).toLowerCase();
    assert.ok(!blob.includes('ltx'), 'no ltx');
    assert.ok(!blob.includes('realesrgan'), 'no realesrgan');
  });
  it('uses SwinIR for the upscaler', () => {
    const u = CATALOG.find((t) => t.id === 'upscaler');
    assert.ok(u.url.includes('SwinIR'));
    assert.equal(u.sha256, '4e78e33f22c1aa8a773db0cf4a7381bae97c2362c717f155439ebc690cbd9215');
  });
  it('has exactly one 24GB-tier tool', () => {
    assert.deepEqual(CATALOG.filter((t) => t.tier24).map((t) => t.id), ['video-pro']);
  });
  it('rejects a banned entry', () => {
    const bad = [...CATALOG, { id: 'x', group: 'g', friendlyName: 'n', technical: 'LTX-9', installType: 'file', url: 'https://x', sizeMB: 1, vramMB: 1, license: 'L', category: 'c', why: 'w' }];
    assert.equal(validateCatalog(bad).ok, false);
  });
  it('signature verifies', () => {
    assert.equal(verifyCatalog(catalogSignature()), true);
    assert.equal(verifyCatalog('deadbeef'), false);
  });
});

describe('vramAllowed (Gate 2 poka-yoke)', () => {
  const pro = CATALOG.find((t) => t.id === 'video-pro');
  const img = CATALOG.find((t) => t.id === 'image-studio');
  it('blocks the 24GB tier on a 16GB card with a plain reason', () => {
    const r = vramAllowed(pro, 16303);
    assert.equal(r.ok, false);
    assert.match(r.reason, /24 GB/);
    assert.match(r.reason, /15\.9 GB/); // honest: 16303 MB is 15.9 GB
    assert.ok(r.whyLink && r.whyLink.length > 20);
  });
  it('allows the 24GB tier on a 24GB+ card', () => {
    assert.equal(vramAllowed(pro, 24576).ok, true);
  });
  it('allows normal tools on a 16GB card', () => {
    assert.equal(vramAllowed(img, 16303).ok, true);
  });
  it('blocks a tool far above the card', () => {
    const heavy = { ...img, vramMB: 32768 };
    assert.equal(vramAllowed(heavy, 4096).ok, false);
  });
  it('is permissive when VRAM is unknown (null)', () => {
    assert.equal(vramAllowed(pro, null).ok, true); // unknown ≠ blocked; measured later
  });
});

describe('estimateBytes', () => {
  it('sums planning estimates', () => {
    const two = CATALOG.filter((t) => ['upscaler', 'face-restore'].includes(t.id));
    const b = estimateBytes(two);
    assert.ok(b > 0 && b < 1024 * 1024 * 1024);
  });
});

describe('postCheckResult (Gate 1)', () => {
  it('passes a good file', () => {
    assert.deepEqual(postCheckResult({ exists: true, size: 1000, expectedBytes: 1000, sha256: 'ab', actualSha: 'AB' }), { ok: true });
  });
  it('fails a missing file', () => {
    assert.equal(postCheckResult({ exists: false, size: 0 }).ok, false);
  });
  it('fails an empty file', () => {
    const r = postCheckResult({ exists: true, size: 0, expectedBytes: 100 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /0 bytes/);
  });
  it('fails a truncated download', () => {
    assert.equal(postCheckResult({ exists: true, size: 50, expectedBytes: 1000 }).ok, false);
  });
  it('fails a checksum mismatch', () => {
    const r = postCheckResult({ exists: true, size: 1000, expectedBytes: 1000, sha256: 'aa', actualSha: 'bb' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /corrupt/);
  });
  it('passes without a known checksum (size only)', () => {
    assert.equal(postCheckResult({ exists: true, size: 1000, expectedBytes: 1000, sha256: null, actualSha: null }).ok, true);
  });
});

describe('mapAriaStatus', () => {
  it('maps all aria2c states', () => {
    assert.equal(mapAriaStatus('active'), 'downloading');
    assert.equal(mapAriaStatus('waiting'), 'queued');
    assert.equal(mapAriaStatus('paused'), 'paused');
    assert.equal(mapAriaStatus('error'), 'failed');
    assert.equal(mapAriaStatus('removed'), 'cancelled');
    assert.equal(mapAriaStatus('complete'), 'verifying');
  });
});

describe('parsePipProgress', () => {
  it('reads percentages', () => { assert.equal(parsePipProgress('  45% |██|'), 0.45); });
  it('reads success', () => { assert.equal(parsePipProgress('Successfully installed x'), 1); });
  it('returns null on chatter', () => { assert.equal(parsePipProgress('Collecting foo'), null); });
});

describe('installPlan (honest, no jargon)', () => {
  it('shows hf helper dependency honestly', () => {
    const t = CATALOG.find((x) => x.id === 'video-studio');
    const p = installPlan(t);
    assert.equal(p.dependencies.length, 1);
    assert.equal(p.dependencies[0].name, 'huggingface_hub');
    assert.ok(p.steps.length >= 2);
  });
  it('file tools have no hidden deps', () => {
    const p = installPlan(CATALOG.find((x) => x.id === 'upscaler'));
    assert.equal(p.dependencies.length, 0);
  });
  it('plan text has no terminal words', () => {
    const bad = /terminal|pip install|command line|powershell|\.bat/i;
    for (const t of CATALOG) {
      const p = installPlan(t);
      for (const s of p.steps) assert.ok(!bad.test(s), `${t.id}: ${s}`);
      for (const d of p.dependencies) assert.ok(!bad.test(d.note), `${t.id} dep note`);
    }
  });
});
