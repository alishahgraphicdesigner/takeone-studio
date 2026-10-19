#!/usr/bin/env node
/* Minimal simulated aria2c (JSON-RPC) for logic tests of DownloadManager.
 * Mimics what the manager relies on: addUri/tellStatus/remove/forcePause/unpause/shutdown,
 * ".aria2" control files, "File already exists" when a partial has no control file
 * (allow-overwrite=false), resume from control file, and stale RPC answers (MOCK_RPC_DELAY_MS).
 * It is NOT real aria2: real-aria2 behaviour stays "Not Tested" until tests run with aria2c itself. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const port = +arg('rpc-listen-port'), secret = arg('rpc-secret'), dir = arg('dir');
const LOG = process.env.MOCK_LOG, DELAY = +(process.env.MOCK_RPC_DELAY_MS || 0);
const log = (s) => { if (LOG) fs.appendFileSync(LOG, s + '\n'); };
const world = () => JSON.parse(fs.readFileSync(process.env.MOCK_WORLD, 'utf8'));
const failsLeft = new Map();
const dls = new Map(); let next = 1;
const chunk = (seed, start, len) => { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = ((start + i) * 7 + seed) & 255; return b; };

function startHttp(d) {
  // http:// URLs are really fetched (Range resume), so server-based tests can run against this simulator too.
  const u = new URL(d.url); const headers = {}; if (d.done > 0) headers.Range = `bytes=${d.done}-`;
  d.req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
    if (res.statusCode >= 400) { d.status = 'error'; d.err = 'HTTP ' + res.statusCode; return; }
    d.size = d.done + Number(res.headers['content-length'] || 0);
    res.on('data', (c) => {
      if (d.status !== 'active') { res.destroy(); return; }
      fs.appendFileSync(d.p, c); d.done += c.length; fs.writeFileSync(d.p + '.aria2', JSON.stringify({ done: d.done }));
    });
    res.on('end', () => { if (d.status === 'active') { d.status = 'complete'; try { fs.unlinkSync(d.p + '.aria2'); } catch (e) { /* ignore */ } } });
  });
  d.req.on('error', (e) => { if (d.status === 'active') { d.status = 'error'; d.err = String(e.message || e); } });
}

function addUri(url, out) {
  if (url.startsWith('http://')) {
    const d = { gid: String(next++).padStart(16, '0'), url, out, p: path.join(dir, out), size: 0, done: 0, status: 'active', err: null, mode: 'http' };
    const ctl = d.p + '.aria2'; log(`ADD ${url} ${out}`);
    const fe = fs.existsSync(d.p), ce = fs.existsSync(ctl);
    if (fe && !ce) { d.status = 'error'; d.err = 'File already exists.'; }
    else if (fe && ce) { d.done = JSON.parse(fs.readFileSync(ctl, 'utf8')).done; fs.truncateSync(d.p, d.done); log(`RESUME ${out} ${d.done}`); }
    else fs.writeFileSync(d.p, '');
    dls.set(d.gid, d); if (d.status === 'active') startHttp(d); return d.gid;
  }
  const w = world()[url];
  const d = { gid: String(next++).padStart(16, '0'), url, out, p: path.join(dir, out), size: w ? w.size : 0, seed: w ? w.seed : 1, bps: (w && w.bps) || 300000, failAt: (w && w.failAt) || 0, done: 0, status: 'active', err: null };
  if (!w) { d.status = 'error'; d.err = 'Not found (404)'; }
  const ctl = d.p + '.aria2';
  log(`ADD ${url} ${out}`);
  if (d.status === 'active') {
    const fe = fs.existsSync(d.p), ce = fs.existsSync(ctl);
    if (fe && !ce) { d.status = 'error'; d.err = 'File already exists.'; }
    else if (fe && ce) { d.done = JSON.parse(fs.readFileSync(ctl, 'utf8')).done; fs.truncateSync(d.p, d.done); log(`RESUME ${out} ${d.done}`); }
    else fs.writeFileSync(d.p, '');
    if (d.status === 'active' && d.failAt && !failsLeft.has(url)) failsLeft.set(url, w.failTimes || 0);
  }
  dls.set(d.gid, d);
  return d.gid;
}
setInterval(() => {
  for (const d of dls.values()) {
    if (d.status !== 'active' || d.mode === 'http') continue;
    const n = Math.min(d.bps, d.size - d.done);
    if (n > 0) { fs.appendFileSync(d.p, chunk(d.seed, d.done, n)); d.done += n; fs.writeFileSync(d.p + '.aria2', JSON.stringify({ done: d.done })); }
    if (d.failAt && d.done >= d.failAt && (failsLeft.get(d.url) || 0) > 0) { failsLeft.set(d.url, failsLeft.get(d.url) - 1); d.status = 'error'; d.err = 'simulated network failure'; continue; }
    if (d.done >= d.size) { d.status = 'complete'; try { fs.unlinkSync(d.p + '.aria2'); } catch (e) { /* ignore */ } }
  }
}, 40);
const stat = (d) => ({ status: d.status, totalLength: String(d.size), completedLength: String(d.done), downloadSpeed: d.status === 'active' ? String(d.bps * 25) : '0', errorMessage: d.err || undefined });

http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body); const [tok, ...ps] = j.params; const reply = (r, e) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(e ? { jsonrpc: '2.0', id: j.id, error: { message: e } } : { jsonrpc: '2.0', id: j.id, result: r })); };
    if (tok !== `token:${secret}`) return reply(null, 'Unauthorized');
    const m = j.method.replace('aria2.', '');
    if (m === 'getGlobalStat') return reply({});
    if (m === 'addUri') return reply(addUri(ps[0][0], ps[1].out));
    if (m === 'tellStatus') { const d = dls.get(ps[0]); if (!d) return reply(null, 'GID is not found'); log('TELL'); const s = stat(d); return setTimeout(() => reply(s), DELAY); }
    if (m === 'remove' || m === 'forceRemove') { const d = dls.get(ps[0]); if (d) { d.status = 'removed'; if (d.req) d.req.destroy(); } return reply(ps[0]); }
    if (m === 'forcePause' || m === 'pause') { const d = dls.get(ps[0]); if (d && d.status === 'active') { d.status = 'paused'; if (d.req) d.req.destroy(); } return reply(ps[0]); }
    if (m === 'unpause') { const d = dls.get(ps[0]); if (d && d.status === 'paused') { d.status = 'active'; if (d.mode === 'http') startHttp(d); } return reply(ps[0]); }
    if (m === 'shutdown') { reply('OK'); return setTimeout(() => process.exit(0), 50); }
    return reply(null, 'unknown method ' + m);
  });
}).listen(port, '127.0.0.1');
