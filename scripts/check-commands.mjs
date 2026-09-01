// Static check: every menu item and toolbar button must map to a registered
// command handler, and no handler should be unreachable. Cheap insurance
// against the menu bar and the dispatcher drifting apart.

import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const menu = read('src/main/menu.js');
const main = read('src/main/main.js');
const commands = read('src/renderer/js/commands.js');
const html = read('src/renderer/index.html');

const referenced = new Set([
  ...menu.matchAll(/send\('([\w.]+)'/g),
  ...menu.matchAll(/id:\s*'([\w.]+)'/g),
  ...main.matchAll(/id:\s*'([\w.]+)'/g),
  ...html.matchAll(/data-cmd="([\w.]+)"/g)
].map((m) => m[1]));

const handlers = new Set([...commands.matchAll(/^ {4}'([\w.]+)':/gm)].map((m) => m[1]));

// 'Cmd+X' binds only on macOS; cross-platform menus must use CmdOrCtrl.
const macOnly = [...menu.matchAll(/accelerator: '([^']*)'/g)]
  .map((m) => m[1])
  .filter((a) => /(^|\+)Cmd\+/.test(a));
if (macOnly.length) {
  console.error(`Accelerators that only bind on macOS: ${[...new Set(macOnly)].join(', ')}`);
}

const missing = [...referenced].filter((id) => !handlers.has(id)).sort();
const unused = [...handlers].filter((id) => !referenced.has(id)).sort();

if (missing.length) console.error(`Menu/button ids with no handler: ${missing.join(', ')}`);
if (unused.length) console.error(`Command handlers never referenced: ${unused.join(', ')}`);

if (missing.length || unused.length || macOnly.length) process.exit(1);
console.log(`command check: ${handlers.size} handlers wired, all accelerators cross-platform`);
