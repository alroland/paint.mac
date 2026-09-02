// Sanity-checks built artifacts before they are published.
//
// Two failures got this far in the past, both silent: an NSIS installer that
// came out as a 226 KB stub because the .ico was missing, and a .deb that came
// out as a 96-byte empty ar archive. Both were the right *name* and the wrong
// thing entirely, so size floors and a structural check earn their keep.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = path.resolve(import.meta.dirname, '..', 'dist');
const MIN_BYTES = 40 * 1024 * 1024;   // every real artifact here is 80 MB+

const problems = [];
const files = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter((f) => /\.(dmg|exe|AppImage|deb|rpm)$/.test(f))
  : [];

if (!files.length) problems.push('no artifacts found in dist/');

for (const name of files) {
  const full = path.join(dist, name);
  const size = fs.statSync(full).size;
  if (size < MIN_BYTES) {
    problems.push(`${name} is only ${(size / 1024).toFixed(0)} KB — almost certainly a stub`);
    continue;
  }
  if (name.endsWith('.deb')) {
    const why = checkDeb(full);
    if (why) problems.push(`${name}: ${why}`);
  }
  console.log(`ok    ${name}  ${(size / 1048576).toFixed(0)}MB`);
}

/** A .deb is an ar archive of exactly debian-binary, control.tar.gz, data.tar.xz. */
function checkDeb(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString() !== '!<arch>\n') return 'not an ar archive';
  const members = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const header = buf.subarray(off, off + 60);
    if (header.subarray(58, 60).toString() !== '`\n') return `bad member header at ${off}`;
    const nm = header.subarray(0, 16).toString().trim();
    const size = parseInt(header.subarray(48, 58).toString().trim(), 10);
    members.push({ name: nm, body: buf.subarray(off + 60, off + 60 + size) });
    off += 60 + size + (size % 2);
  }
  const names = members.map((m) => m.name);
  if (names.join(',') !== 'debian-binary,control.tar.gz,data.tar.xz') {
    return `members are ${names.join(', ') || '(none)'}`;
  }
  if (members[0].body.toString() !== '2.0\n') return 'debian-binary is not 2.0';
  try {
    zlib.gunzipSync(members[1].body);
  } catch {
    return 'control.tar.gz does not decompress';
  }
  return null;
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log(`artifact check: ${files.length} artifacts look real`);
