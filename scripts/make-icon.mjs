// Builds build/icon.icns (and icon.png) from scripts/icon/render.html.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const build = path.join(root, 'build');

const render = spawnSync(electron, [path.join(root, 'scripts', 'icon', 'main.js')], { stdio: 'inherit' });
if (render.status !== 0) process.exit(render.status ?? 1);

// iconutil wants a .iconset directory of specific sizes.
const iconset = path.join(build, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const s of sizes) {
  const scale1 = `icon_${s}x${s}.png`;
  const scale2 = `icon_${s / 2}x${s / 2}@2x.png`;
  spawnSync('sips', ['-z', String(s), String(s), path.join(build, 'icon.png'), '--out', path.join(iconset, scale1)],
    { stdio: 'ignore' });
  if (s >= 32) {
    fs.copyFileSync(path.join(iconset, scale1), path.join(iconset, scale2));
  }
}
fs.rmSync(path.join(iconset, 'icon_1024x1024.png'), { force: true });

// A renderer-sized copy, bundled with the app for the in-app About box.
const assets = path.join(root, 'src', 'renderer', 'assets');
fs.mkdirSync(assets, { recursive: true });
spawnSync('sips', ['-z', '256', '256', path.join(build, 'icon.png'), '--out', path.join(assets, 'icon.png')],
  { stdio: 'ignore' });
console.log('wrote src/renderer/assets/icon.png (256x256)');

const icns = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(build, 'icon.icns')], { stdio: 'inherit' });
if (icns.status !== 0) process.exit(icns.status ?? 1);
fs.rmSync(iconset, { recursive: true, force: true });
console.log('wrote build/icon.icns');
