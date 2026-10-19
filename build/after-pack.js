// afterPack hook: embed build/icon.ico into the Windows exe WITHOUT wine.
// (electron-builder's rcedit needs wine, which is broken on this build VM.
//  signAndEditExecutable=false skips rcedit; we do the icon ourselves via resedit.)
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

async function patchExeIcon(exePath, icoPath) {
  const exeData = fs.readFileSync(exePath);
  const exe = NtExecutable.from(exeData.buffer.slice(
    exeData.byteOffset, exeData.byteOffset + exeData.byteLength));
  const res = NtExecutableResource.from(exe);
  // IconFile isn't in resedit's exports map — use the vendored copy.
  const vendorPath = path.join(__dirname, 'vendor', 'resedit-dist', 'data', 'IconFile.js');
  const { default: IconFile } = await import(pathToFileURL(vendorPath).href);
  const icoBuf = fs.readFileSync(icoPath);
  const iconFile = IconFile.from(
    icoBuf.buffer.slice(icoBuf.byteOffset, icoBuf.byteOffset + icoBuf.byteLength));
  // Electron's icon group is id 1, lang 1033 (en-US)
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, 1, 1033, iconFile.icons.map((icon) => icon.data));
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return true;
}

exports.default = async function (context) {
  if (context.packager.platform.name !== 'windows') return;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const icoPath = path.join(context.packager.projectDir, 'build', 'icon.ico');
  if (!fs.existsSync(exePath)) { console.log('afterPack: exe not found, skipping icon'); return; }
  await patchExeIcon(exePath, icoPath);
  console.log(`afterPack: embedded icon into ${exeName}`);
};

// Exported for the pre-ship gate test.
exports.patchExeIcon = patchExeIcon;
