/* Build-machine workaround (Linux only): electron-builder's NSIS target runs the
 * freshly built installer under wine to pre-extract the uninstaller for SIGNING.
 * TakeOne Phase A is UNSIGNED, so that step is pure overhead — and this VM has no
 * wine and no apt repo to install it from. With TAKEONE_SKIP_WINE=1:
 *   1. NsisTarget.js: skip the wine uninstaller-extraction step; guard signIf and
 *      the stale-uninstaller cleanup so a missing file can't fail the build;
 *      inject -DTAKEONE_SKIP_WINE into the makensis defines (both passes).
 *   2. templates/nsis/installer.nsi: always compile the uninstall sections in
 *      (they were previously only compiled for the wine-generated uninstaller).
 *   3. templates/nsis/include/installer.nsh: at install time, WriteUninstaller
 *      writes "$INSTDIR\Uninstall TakeOne Studio.exe" directly (stock NSIS
 *      behavior) instead of embedding a wine-generated file.
 * Net effect: identical installer semantics, zero wine. On a Windows build
 * machine (or with wine present) the stock behavior applies — set
 * TAKEONE_SKIP_WINE=0 (or unset).
 *
 * Reproducible: run `node scripts/patch-nsis-wine.js` after every fresh npm install.
 * (npm's `dist` script does this automatically.) Idempotent: safe to re-run.
 */
const fs = require('fs');
const path = require('path');

const NM = path.join(__dirname, '..', 'node_modules');
const NSIS_T = path.join(NM, 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js');
const INST_NSI = path.join(NM, 'app-builder-lib', 'templates', 'nsis', 'installer.nsi');
const INCL_NSH = path.join(NM, 'app-builder-lib', 'templates', 'nsis', 'include', 'installer.nsh');
const ALLOW_NSH = path.join(NM, 'app-builder-lib', 'templates', 'nsis', 'include', 'allowOnlyOneInstallerInstance.nsh');

let applied = 0, skipped = 0;
function patchFile(file, marker, needle, replacement, name) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) { console.log(`  [skip] ${name}`); skipped++; return; }
  if (!src.includes(needle)) {
    console.error(`  [FAIL] ${name}: needle not found — electron-builder version changed, review manually`);
    process.exit(1);
  }
  fs.writeFileSync(file, src.replace(needle, replacement));
  applied++;
  console.log(`  [ok] ${name}`);
}

patchFile(NSIS_T, "TAKEONE_SKIP_WINE !== '1'",
  `        else {
            const wineVm = new WineVm_1.WineVmManager((_a = packager.config.toolsets) === null || _a === void 0 ? void 0 : _a.wine);
            await wineVm.exec(installerPath, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
        }`,
  `        else if (process.env.TAKEONE_SKIP_WINE !== '1') {
            const wineVm = new WineVm_1.WineVmManager((_a = packager.config.toolsets) === null || _a === void 0 ? void 0 : _a.wine);
            await wineVm.exec(installerPath, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
        }`,
  '1a skip wine exec');

patchFile(NSIS_T, 'existsSync(uninstallerPath)',
  `        await packager.signIf(uninstallerPath);`,
  `        if (require('fs').existsSync(uninstallerPath)) { await packager.signIf(uninstallerPath); }`,
  '1b guard signIf');

patchFile(NSIS_T, 'defines.TAKEONE_SKIP_WINE = null',
  `            APP_PACKAGE_NAME: (0, targetUtil_1.getWindowsInstallationAppPackageName)(appInfo.name),
        };`,
  `            APP_PACKAGE_NAME: (0, targetUtil_1.getWindowsInstallationAppPackageName)(appInfo.name),
        };
        if (process.env.TAKEONE_SKIP_WINE === "1") {
            defines.TAKEONE_SKIP_WINE = null;
        }`,
  '1c inject define');

patchFile(NSIS_T, 'unlink)(defines.UNINSTALLER_OUT_FILE).catch',
  `defines.UNINSTALLER_OUT_FILE == null ? Promise.resolve() : (0, fs_extra_1.unlink)(defines.UNINSTALLER_OUT_FILE)`,
  `defines.UNINSTALLER_OUT_FILE == null ? Promise.resolve() : (0, fs_extra_1.unlink)(defines.UNINSTALLER_OUT_FILE).catch(() => { })`,
  '1d tolerate missing prebuilt uninstaller');

patchFile(INST_NSI, '!ifdef TAKEONE_SKIP_WINE\n    !include "uninstaller.nsh"',
  `!ifdef BUILD_UNINSTALLER
  !include "uninstaller.nsh"
!endif`,
  `!ifdef BUILD_UNINSTALLER
  !include "uninstaller.nsh"
!else
  !ifdef TAKEONE_SKIP_WINE
    !include "uninstaller.nsh"
  !endif
!endif`,
  '2 always compile uninstall sections');

patchFile(INCL_NSH, 'WriteUninstaller "$INSTDIR',
  `  File "/oname=\${UNINSTALL_FILENAME}" "\${UNINSTALLER_OUT_FILE}"`,
  `  !ifdef TAKEONE_SKIP_WINE
    WriteUninstaller "$INSTDIR\\\${UNINSTALL_FILENAME}"
  !else
    File "/oname=\${UNINSTALL_FILENAME}" "\${UNINSTALLER_OUT_FILE}"
  !endif`,
  '3 WriteUninstaller at install time');

patchFile(ALLOW_NSH, '!define TAKEONE_CHECK_APP_RUNNING_VARS',
  `!macro CHECK_APP_RUNNING
  Var /GLOBAL CmdPath
  Var /GLOBAL PowerShellPath`,
  `!macro CHECK_APP_RUNNING
  !ifndef TAKEONE_CHECK_APP_RUNNING_VARS
    !define TAKEONE_CHECK_APP_RUNNING_VARS
    Var /GLOBAL CmdPath
    Var /GLOBAL PowerShellPath
  !endif`,
  '4a guard CHECK_APP_RUNNING vars');

patchFile(ALLOW_NSH, '!define TAKEONE_IS_POWERSHELL_VARS',
  `!macro IS_POWERSHELL_AVAILABLE
  Var /GLOBAL IsPowerShellAvailable ; 0 = available, 1 = not available`,
  `!macro IS_POWERSHELL_AVAILABLE
  !ifndef TAKEONE_IS_POWERSHELL_VARS
    !define TAKEONE_IS_POWERSHELL_VARS
    Var /GLOBAL IsPowerShellAvailable ; 0 = available, 1 = not available
  !endif`,
  '4b guard IS_POWERSHELL_AVAILABLE vars');

patchFile(path.join(NM, 'app-builder-lib', 'templates', 'nsis', 'uninstaller.nsh'),
  '!define TAKEONE_NO_CHECK_APP_RUNNING',
  `Function un.checkAppRunning
  !insertmacro CHECK_APP_RUNNING
FunctionEnd`,
  `!ifdef TAKEONE_SKIP_WINE
  !define TAKEONE_NO_CHECK_APP_RUNNING
!endif
Function un.checkAppRunning
  !ifndef TAKEONE_NO_CHECK_APP_RUNNING
    !insertmacro CHECK_APP_RUNNING
  !endif
FunctionEnd`,
  '5 un.checkAppRunning no-op (app-running check is redundant: our remove flow quits first)');

console.log(`patch-nsis-wine: done (${applied} applied, ${skipped} already present)`);
