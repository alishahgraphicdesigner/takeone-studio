#!/usr/bin/env node
/* TakeOne Studio — catalog audit (release gate).
 *
 * Measures REAL values from the network and compares them with main/catalog.js.
 * Never edits catalog.js. Prints paste-ready snippets for a human to review.
 *
 * Usage (from repo root, Node 18+):
 *   node tools/audit-catalog.js                 fast: HEAD + registry metadata, no big downloads
 *   node tools/audit-catalog.js --hash          also downloads+hashes files that have NO published sha256
 *   node tools/audit-catalog.js --hash-all      downloads+hashes every file-type model (slow, ~20 GB)
 *   node tools/audit-catalog.js --only=brain,upscaler
 *   node tools/audit-catalog.js --json          machine-readable output only
 *
 * Env: HF_TOKEN (optional, for gated Hugging Face repos)
 *
 * Statuses (honest labels):
 *   VERIFIED       measured bytes == catalog sizeBytes AND catalog sha256 == measured/published sha256
 *   MISMATCH       catalog says X, server says Y
 *   UNPINNED       measured OK, but catalog lacks exact sizeBytes and/or sha256 (cannot gate a release)
 *   UNREACHABLE    request failed (network, 404, gated)
 *   NOT_AUDITABLE  external/adopt: no stable URL to measure — needs manual check
 *   NOT_CONFIGURED url missing for a type that needs one
 *
 * Exit code: 1 if any tool is MISMATCH / UNPINNED / UNREACHABLE / NOT_CONFIGURED, else 0.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { CATALOG, validateCatalog } = require(path.join(__dirname, '..', 'main', 'catalog.js'));

const argv = process.argv.slice(2);
const HASH = argv.includes('--hash') || argv.includes('--hash-all');
const HASH_ALL = argv.includes('--hash-all');
const JSON_ONLY = argv.includes('--json');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;

const MiB = 1024 * 1024;
const UA = 'TakeOne-catalog-audit/1.0';
const log = (...a) => { if (!JSON_ONLY) console.log(...a); };
const fmtBytes = (n) => (n == null ? '—' : `${n.toLocaleString('en-US')} B (${(n / MiB).toFixed(1)} MiB)`);
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

function headers(url, extra = {}) {
  const h = { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...extra };
  try {
    if (new URL(url).hostname === 'huggingface.co' && process.env.HF_TOKEN) {
      h.Authorization = `Bearer ${process.env.HF_TOKEN}`;
    }
  } catch (_) { /* ignore */ }
  return h;
}

/** Follow redirects manually so we can read Hugging Face's x-linked-size / x-linked-etag
 *  (the etag of an LFS file IS its sha256) from the first hop. */
async function headInfo(url) {
  let cur = url;
  const linked = { size: null, sha256: null };
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(cur, {
      method: 'HEAD', redirect: 'manual', headers: headers(cur), signal: AbortSignal.timeout(30000),
    });
    const xs = res.headers.get('x-linked-size');
    const xe = (res.headers.get('x-linked-etag') || '').replace(/"/g, '');
    if (xs && linked.size == null) linked.size = Number(xs);
    if (isSha(xe) && !linked.sha256) linked.sha256 = xe;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect without location (HTTP ${res.status})`);
      cur = new URL(loc, cur).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let len = res.headers.get('content-length') != null ? Number(res.headers.get('content-length')) : null;
    if (!len) {
      // Some CDNs omit length on HEAD: ask for 1 byte and read the total from content-range.
      const r2 = await fetch(cur, {
        method: 'GET', headers: headers(cur, { Range: 'bytes=0-0' }), signal: AbortSignal.timeout(30000),
      });
      const m = /\/(\d+)\s*$/.exec(r2.headers.get('content-range') || '');
      if (m) len = Number(m[1]);
      try { await r2.body?.cancel(); } catch (_) { /* ignore */ }
    }
    if (len == null && linked.size != null) len = linked.size;
    if (len == null) throw new Error('server did not report a size');
    return { bytes: len, publishedSha256: linked.sha256, finalUrl: cur };
  }
  throw new Error('too many redirects');
}

/** Stream the whole file and compute SHA-256 + exact byte count. */
async function hashFile(url, expectedBytes) {
  const res = await fetch(url, { headers: headers(url), signal: AbortSignal.timeout(6 * 60 * 60 * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} while hashing`);
  const h = crypto.createHash('sha256');
  let n = 0;
  let nextPct = 10;
  for await (const chunk of res.body) {
    h.update(chunk);
    n += chunk.length;
    if (expectedBytes && !JSON_ONLY) {
      const pct = (n / expectedBytes) * 100;
      if (pct >= nextPct) { process.stdout.write(`    hashing… ${Math.floor(pct)}%\r`); nextPct = Math.floor(pct / 10) * 10 + 10; }
    }
  }
  if (!JSON_ONLY) process.stdout.write('                      \r');
  return { sha256: h.digest('hex'), bytes: n };
}

async function auditFile(t) {
  const r = { expected: { sizeBytes: t.sizeBytes ?? null, sizeMiBEstimate: t.sizeMB, sha256: t.sha256 ?? null }, measured: {}, notes: [] };
  const info = await headInfo(t.url);
  r.measured.bytes = info.bytes;
  r.measured.publishedSha256 = info.publishedSha256;

  const published = info.publishedSha256;
  if (HASH && (HASH_ALL || !published)) {
    log(`    downloading to hash ${t.id} (${(info.bytes / MiB).toFixed(0)} MiB)…`);
    const hs = await hashFile(info.finalUrl, info.bytes);
    r.measured.computedSha256 = hs.sha256;
    if (hs.bytes !== info.bytes) r.notes.push(`downloaded ${hs.bytes} B but HEAD said ${info.bytes} B`);
    if (published && published !== hs.sha256) r.notes.push('published sha256 != computed sha256 (investigate!)');
  }
  const sha = r.measured.computedSha256 || published || null;
  r.measured.sha256 = sha;
  r.measured.sha256Source = r.measured.computedSha256 ? 'computed' : published ? 'published by host (HF LFS etag)' : null;

  // Size comparison
  const estMiB = t.sizeMB * MiB;
  r.measured.deltaVsEstimateMiB = +((info.bytes - estMiB) / MiB).toFixed(1);

  if (t.sizeBytes != null && t.sizeBytes !== info.bytes) {
    r.status = 'MISMATCH';
    r.notes.push(`catalog sizeBytes ${t.sizeBytes} != server ${info.bytes}`);
  } else if (t.sha256 && sha && t.sha256 !== sha) {
    r.status = 'MISMATCH';
    r.notes.push('catalog sha256 != measured sha256');
  } else if (t.sizeBytes == null || !t.sha256) {
    r.status = 'UNPINNED';
    if (t.sizeBytes == null) r.notes.push(`catalog has no sizeBytes (only sizeMB=${t.sizeMB}, real is ${(info.bytes / MiB).toFixed(1)} MiB)`);
    if (!t.sha256) r.notes.push(sha ? 'catalog has no sha256 (measured value available below)' : 'catalog has no sha256 and none measured — rerun with --hash');
  } else if (!sha) {
    r.status = 'UNPINNED';
    r.notes.push('sha256 in catalog but could not be cross-checked — rerun with --hash');
  } else {
    r.status = 'VERIFIED';
  }
  if (r.status !== 'VERIFIED') {
    const parts = [`sizeBytes: ${info.bytes}`];
    if (sha) parts.push(`sha256: '${sha}'`);
    r.suggest = parts.join(', ');
  }
  return r;
}

async function auditHf(t) {
  const r = { expected: { sizeMiBEstimate: t.sizeMB, repo: t.repo }, measured: {}, notes: [] };
  let url = `https://huggingface.co/api/models/${t.repo}/tree/main?recursive=true&expand=false`;
  const files = [];
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url, { headers: headers(url), signal: AbortSignal.timeout(30000) });
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status} — gated/private repo (set HF_TOKEN)`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    for (const e of arr) if (e.type === 'file') files.push({ path: e.path, bytes: e.size, sha256: e.lfs?.oid || null });
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
    url = m ? m[1] : null;
  }
  const total = files.reduce((s, f) => s + f.bytes, 0);
  r.measured = {
    fileCount: files.length,
    wholeRepoBytes: total,
    largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((f) => `${f.path} (${(f.bytes / MiB).toFixed(0)} MiB)`),
  };
  r.measured.manifest = files; // full per-file list for building a pinned manifest
  r.status = 'UNPINNED';
  r.notes.push(`whole repo = ${(total / MiB).toFixed(0)} MiB vs catalog estimate ${t.sizeMB} MiB`);
  r.notes.push('catalog has no per-file manifest (path + bytes + sha256) and no allow-patterns; snapshot_download would pull the WHOLE repo, including variants you may not need');
  return r;
}

async function auditPip(t) {
  const r = { expected: { sizeMiBEstimate: t.sizeMB, pipPackage: t.pipPackage }, measured: {}, notes: [] };
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(t.pipPackage)}/json`, { headers: headers('https://pypi.org'), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`PyPI HTTP ${res.status}`);
  const j = await res.json();
  const dists = (j.urls || []).map((u) => ({ file: u.filename, type: u.packagetype, bytes: u.size, sha256: u.digests?.sha256 }));
  r.measured = { latestVersion: j.info.version, distributions: dists };
  r.status = 'UNPINNED';
  r.notes.push(`PyPI ${t.pipPackage} ${j.info.version}: ${dists.map((d) => `${d.file} ${(d.bytes / MiB).toFixed(1)} MiB`).join('; ') || 'no files'}`);
  r.notes.push('package size only — dependencies (torch, model weights fetched at first run, etc.) are NOT included; real install size must be measured in a clean venv');
  r.notes.push('catalog does not pin a version; "latest" can change between audits');
  return r;
}

async function auditOne(t) {
  const base = { id: t.id, installType: t.installType, friendlyName: t.friendlyName };
  try {
    if (t.installType === 'file') {
      if (!t.url) return { ...base, status: 'NOT_CONFIGURED', expected: {}, measured: {}, notes: ['file type but url is empty'] };
      return { ...base, ...(await auditFile(t)) };
    }
    if (t.installType === 'hf') return { ...base, ...(await auditHf(t)) };
    if (t.installType === 'pip') return { ...base, ...(await auditPip(t)) };
    return { ...base, status: 'NOT_AUDITABLE', expected: { sizeMiBEstimate: t.sizeMB }, measured: {}, notes: [`${t.installType}: no stable direct URL — check by hand and mark Not Tested until then`] };
  } catch (e) {
    return { ...base, status: 'UNREACHABLE', expected: {}, measured: {}, notes: [String(e.message || e)] };
  }
}

async function main() {
  const v = validateCatalog(CATALOG);
  log(`catalog.js structure check: ${v.ok ? 'ok' : 'ERRORS'}`);
  if (!v.ok) v.errors.forEach((e) => log(`  - ${e}`));

  const tools = CATALOG.filter((t) => !ONLY || ONLY.has(t.id));
  const results = [];
  for (const t of tools) {
    log(`\n▶ ${t.id} (${t.installType})`);
    const r = await auditOne(t);
    results.push(r);
    log(`  status: ${r.status}`);
    if (r.measured.bytes != null) log(`  server size:   ${fmtBytes(r.measured.bytes)}`);
    if (r.expected.sizeBytes != null) log(`  catalog bytes: ${fmtBytes(r.expected.sizeBytes)}`);
    else if (r.expected.sizeMiBEstimate != null) log(`  catalog est.:  ${r.expected.sizeMiBEstimate} MiB (estimate)`);
    if (r.measured.sha256) log(`  sha256:        ${r.measured.sha256}  [${r.measured.sha256Source}]`);
    (r.notes || []).forEach((n) => log(`  · ${n}`));
    if (r.suggest) log(`  suggest (review, then paste into catalog.js): ${r.suggest}`);
  }

  const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const failing = results.filter((r) => ['MISMATCH', 'UNPINNED', 'UNREACHABLE', 'NOT_CONFIGURED'].includes(r.status));
  const report = {
    generatedAt: new Date().toISOString(),
    catalogStructureOk: v.ok,
    catalogStructureErrors: v.errors,
    counts,
    gate: failing.length === 0 && v.ok ? 'PASS' : 'FAIL',
    note: 'Generated by tools/audit-catalog.js. Statuses describe what was measured in this run only.',
    results,
  };
  const out = path.join(__dirname, 'audit-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  if (JSON_ONLY) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    log('\n──────── SUMMARY ────────');
    Object.entries(counts).forEach(([k, n]) => log(`  ${k.padEnd(15)} ${n}`));
    log(`  GATE: ${report.gate}${failing.length ? `  (blocked by: ${failing.map((f) => f.id).join(', ')})` : ''}`);
    log(`  full report: ${out}`);
  }
  process.exit(report.gate === 'PASS' ? 0 : 1);
}

main().catch((e) => { console.error('audit crashed:', e); process.exit(2); });
