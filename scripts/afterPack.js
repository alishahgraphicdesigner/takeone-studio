/* electron-builder afterPack: strip unused Chromium locales.
 * Saves ~40MB unpacked (~15MB in the installer). en-US is the only locale TakeOne ships. */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;
  let removed = 0;
  for (const f of fs.readdirSync(localesDir)) {
    if (f.toLowerCase() !== 'en-us.pak' && f.endsWith('.pak')) {
      fs.unlinkSync(path.join(localesDir, f));
      removed++;
    }
  }
  console.log(`afterPack: removed ${removed} unused locale packs`);
};
