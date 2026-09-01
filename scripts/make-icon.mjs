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

// Windows .ico. macOS ships no converter, so assemble the container by hand:
// an ICONDIR header, one 16-byte directory entry per size, then the PNG bytes.
// Vista and later accept PNG-compressed entries directly.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoDir = path.join(build, 'ico-tmp');
fs.rmSync(icoDir, { recursive: true, force: true });
fs.mkdirSync(icoDir, { recursive: true });

const images = icoSizes.map((s) => {
  const file = path.join(icoDir, `${s}.png`);
  spawnSync('sips', ['-z', String(s), String(s), path.join(build, 'icon.png'), '--out', file], { stdio: 'ignore' });
  return { size: s, data: fs.readFileSync(file) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);                 // reserved
header.writeUInt16LE(1, 2);                 // 1 = icon
header.writeUInt16LE(images.length, 4);

const entries = Buffer.alloc(16 * images.length);
let offset = header.length + entries.length;
images.forEach((img, i) => {
  const at = i * 16;
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, at);      // 0 means 256
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1);
  entries.writeUInt8(0, at + 2);            // palette size
  entries.writeUInt8(0, at + 3);            // reserved
  entries.writeUInt16LE(1, at + 4);         // colour planes
  entries.writeUInt16LE(32, at + 6);        // bits per pixel
  entries.writeUInt32LE(img.data.length, at + 8);
  entries.writeUInt32LE(offset, at + 12);
  offset += img.data.length;
});

fs.writeFileSync(path.join(build, 'icon.ico'), Buffer.concat([header, entries, ...images.map((i) => i.data)]));
fs.rmSync(icoDir, { recursive: true, force: true });
console.log(`wrote build/icon.ico (${icoSizes.join(', ')})`);

const icns = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(build, 'icon.icns')], { stdio: 'inherit' });
if (icns.status !== 0) process.exit(icns.status ?? 1);
fs.rmSync(iconset, { recursive: true, force: true });
console.log('wrote build/icon.icns');
