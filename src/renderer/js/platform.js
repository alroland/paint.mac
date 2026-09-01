// Platform differences that reach the UI. The app is written with macOS key
// symbols throughout; on Windows and Linux those are rewritten to words so the
// hints match the accelerators Electron actually binds (CmdOrCtrl).

export const PLATFORM = (typeof window !== 'undefined' && window.api?.platform) || 'darwin';
export const IS_MAC = PLATFORM === 'darwin';

const SYMBOLS = [
  ['⌘', 'Ctrl+'],
  ['⇧', 'Shift+'],
  ['⌥', 'Alt+'],
  ['⌃', 'Ctrl+'],
  ['⎋', 'Esc'],
  ['⌫', 'Backspace'],
  ['⌦', 'Delete'],
  ['⏎', 'Enter']
];

/** Rewrites macOS key symbols into words. Exported so it stays testable on any host. */
export function rewriteKeys(text) {
  if (!text) return text;
  let out = String(text);
  for (const [symbol, word] of SYMBOLS) out = out.split(symbol).join(word);
  return out
    .replace(/\+-/g, '-')        // "Ctrl+-click" -> "Ctrl-click"
    .replace(/Ctrl\+\+/g, 'Ctrl+Plus')
    .replace(/Ctrl\+−/g, 'Ctrl+Minus');
}

/** Platform-aware form: a no-op on macOS, rewritten everywhere else. */
export function formatKeys(text) {
  return IS_MAC ? text : rewriteKeys(text);
}
