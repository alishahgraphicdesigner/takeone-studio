// Generates dist/README-v<version>.txt from the template at build time,
// so version/date/changelog always match the installer. Run: node build/make-readme.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
let t = fs.readFileSync(path.join(root, 'build', 'README.template.txt'), 'utf8');
const date = new Date().toISOString().slice(0, 10);

let changelog = 'See the in-app release notes for details.';
try {
  const cl = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const lines = cl.split('\n');
  const start = lines.findIndex(l => /^##\s+\[?v?2\.2/.test(l));
  if (start >= 0) {
    let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
    if (end < 0) end = lines.length;
    changelog = lines.slice(start, end).join('\n').trim().slice(0, 1500) || changelog;
  }
} catch {}

t = t.split('{{VERSION}}').join(pkg.version)
     .split('{{DATE}}').join(date)
     .split('{{CHANGELOG}}').join(changelog);

const out = path.join(root, 'dist', 'README-v' + pkg.version + '.txt');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, t);
console.log('wrote', out, '(' + t.length + ' bytes)');
