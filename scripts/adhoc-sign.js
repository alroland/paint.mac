// electron-builder afterPack hook: ad-hoc sign the macOS bundle.
//
// Without a Developer ID we have no real signature to apply, but leaving the
// bundle unsigned is worse than useless on Apple Silicon: electron-builder
// rewrites the Info.plist and injects the asar, which invalidates the ad-hoc
// signature Electron's own binary ships with. macOS then sees a signature whose
// sealed resources no longer match and reports the app as *damaged* — a
// dead-end dialog with no "open anyway" escape.
//
// Re-signing ad-hoc reseals the bundle, so the app is merely un-notarised and
// the user gets the normal, bypassable Gatekeeper prompt instead.

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // Bundles must be signed inside-out: nested helpers and frameworks first,
  // then the outer app, or the outer seal covers stale inner signatures.
  const inner = execFileSync('/usr/bin/find', [
    path.join(appPath, 'Contents', 'Frameworks'),
    '-maxdepth', '1',
    '-name', '*.app', '-o', '-maxdepth', '1', '-name', '*.framework'
  ], { encoding: 'utf8' }).split('\n').filter(Boolean);

  for (const target of inner) {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--deep', target]);
  }
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--deep', appPath]);

  // Fail the build rather than ship another "damaged" bundle.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  console.log(`  • ad-hoc signed and verified  ${appName}`);
};
