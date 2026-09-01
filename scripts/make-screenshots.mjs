// Renders the README screenshots, then downscales them for the repo.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });

const child = spawn(electron, ['.', '--dev', `--screenshots=${out}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; process.stdout.write(String(d).includes('SHOT') ? d : ''); });

const done = new Promise((resolve) => {
  const timer = setInterval(() => {
    if (log.includes('SHOTS DONE')) { clearInterval(timer); child.kill(); resolve(true); }
  }, 400);
  setTimeout(() => { clearInterval(timer); child.kill(); resolve(false); }, 90000);
});

if (!await done) {
  console.error('screenshot run timed out');
  console.error(log.split('\n').slice(-15).join('\n'));
  process.exit(1);
}

// Captures come back at device resolution; halve them for a sane repo size.
for (const file of fs.readdirSync(out).filter((f) => f.endsWith('.png'))) {
  const p = path.join(out, file);
  spawnSync('sips', ['-Z', '1440', p], { stdio: 'ignore' });
  console.log(`${file}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
}
console.log(`screenshots written to docs/screenshots/`);
