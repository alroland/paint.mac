// Builds the Linux targets with a working `ar` on PATH.
//
// fpm assembles a .deb with `ar -qc`. Apple's ar treats that as a static
// library, runs ranlib, and silently emits a 96-byte archive with the payload
// dropped. scripts/deb-ar/ar writes a plain archive instead.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shim = path.join(root, 'scripts', 'deb-ar');

const result = spawnSync(
  path.join(root, 'node_modules', '.bin', 'electron-builder'),
  ['--linux', ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root, env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}` } }
);
process.exit(result.status ?? 1);
