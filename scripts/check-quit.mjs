// Drives the real shutdown path: launches the app, calls app.quit() the way the
// Quit menu item does, and fails if the process does not actually exit.
//
// Regression guard for a hang that could only be escaped with Force Quit.

import { spawn } from 'node:child_process';
import electron from 'electron';

const QUIT_AFTER = 2500;
const TIMEOUT = 15000;   // generous: the ack watchdog itself waits 3s

function run(label, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(electron, ['.', '--dev', `--quit-after=${QUIT_AFTER}`, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    const started = Date.now();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ label, ok: false, reason: `still running ${TIMEOUT}ms after quit was requested`, out });
    }, TIMEOUT);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      // Exiting only because the harness killed it is a failure, not a pass.
      if (signal === 'SIGKILL') {
        resolve({ label, ok: false, reason: 'had to be killed', out });
      } else {
        resolve({ label, ok: true, reason: `exited with code ${code} after ${ms}ms`, out });
      }
    });
  });
}

const cases = [
  ['quits from a clean document', []],
  ['quits after the window was closed first', ['--close-window-first']],
  // The path that was broken: the save prompt resolves, and the quit that the
  // prompt interrupted has to resume.
  ['quits after answering the unsaved-changes prompt', ['--dirty-on-start', '--assume-discard']],
  // Watchdog: even a renderer that never answers must not trap the user.
  ['quits when the renderer never responds', ['--ignore-close']]
];

let failed = 0;
for (const [label, args] of cases) {
  const r = await run(label, args);
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${label} — ${r.reason}`);
  if (!r.ok) {
    failed++;
    console.log(r.out.split('\n').filter(Boolean).slice(-8).map((l) => `        ${l}`).join('\n'));
  }
}

if (failed) {
  console.error(`quit check: ${failed} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`quit check: ${cases.length} shutdown paths exit cleanly`);
