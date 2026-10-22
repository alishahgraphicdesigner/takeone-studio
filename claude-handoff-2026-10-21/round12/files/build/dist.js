/**
 * Windows-safe `npm run dist` wrapper.
 *
 * The old script used Unix shell env-prefix syntax (`TAKEONE_SKIP_WINE=1 node ...`),
 * which fails on Windows cmd/PowerShell (e.g. GitHub Actions windows-latest).
 * This wrapper sets the variable in-process instead: on non-Windows it keeps the
 * wine-step skip (needed for the Linux NSIS build); on Windows electron-builder
 * never uses wine, so the variable is unnecessary there.
 */
const { execSync } = require('child_process');

if (process.platform !== 'win32') {
  process.env.TAKEONE_SKIP_WINE = '1';
}

execSync('node build/make-readme.js', { stdio: 'inherit' });
// Forward extra CLI args (e.g. "--publish never" from CI) to electron-builder.
const extraArgs = process.argv.slice(2).join(' ');
execSync(`npx electron-builder --win nsis${extraArgs ? ' ' + extraArgs : ''}`, { stdio: 'inherit', env: process.env });
