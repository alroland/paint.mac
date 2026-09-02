'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, nativeImage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { buildMenu } = require('./menu');

const isDev = process.argv.includes('--dev');

const AUTHOR = 'Al Roland';
const SITE = 'www.alroland.com/paint.mac';

// Set before anything reads it: this drives the About panel, the userData
// directory, and the application menu's own title.
app.setName('Paint.mac');

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** Files requested via Finder "Open With" before the window is ready. */
const pendingOpenFiles = [];
/** Set by the renderer; lets us skip the close prompt once the user has decided. */
let forceClose = false;
/**
 * True once a quit is under way. Vetoing a window's close (to ask the renderer
 * about unsaved changes) also cancels the quit that triggered it, so the quit
 * has to be restarted once the renderer answers — otherwise Cmd+Q closes the
 * window but leaves the app running with no way out but Force Quit.
 */
let isQuitting = false;
/** Pending "did the renderer hear us?" watchdog; see requestRendererClose(). */
let closeAckTimer = null;
const CLOSE_ACK_TIMEOUT = 3000;

const IMAGE_FILTERS = [
  { name: 'All Supported Images', extensions: ['pmac', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
  { name: 'Paint.mac Document', extensions: ['pmac'] },
  { name: 'PNG', extensions: ['png'] },
  { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP', extensions: ['webp'] },
  { name: 'Bitmap', extensions: ['bmp'] },
  { name: 'GIF', extensions: ['gif'] }
];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1e1e',
    // The inset title bar (and the space we reserve for the traffic lights) is
    // a macOS affordance; other platforms keep their normal window frame.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Canvas-heavy app: keep the compositor busy even when partially occluded.
      backgroundThrottling: false
    }
  });

  const devFlags = {};
  if (isDev && process.argv.includes('--assume-discard')) devFlags.discard = '1';
  if (isDev && process.argv.includes('--dirty-on-start')) devFlags.dirty = '1';
  if (isDev && process.argv.includes('--ignore-close')) devFlags.ignoreClose = '1';
  const shotsArg = process.argv.find((a) => a.startsWith('--screenshots='));
  if (isDev && shotsArg) devFlags.shots = shotsArg.slice('--screenshots='.length);
  const captureArg = process.argv.find((a) => a.startsWith('--capture='));
  const query = {
    ...devFlags,
    ...(process.argv.includes('--selftest')
      ? {
          selftest: '1',
          ...(captureArg ? { capture: captureArg.slice('--capture='.length) } : {}),
          ...(process.argv.includes('--exit-after-tests') ? { exit: '1' } : {})
        }
      : {})
  };
  mainWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'index.html'),
    Object.keys(query).length ? { query } : undefined
  );

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
    flushPendingOpens();
  });

  mainWindow.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    requestRendererClose();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (isDev) {
    // Surface renderer errors in the terminal during development.
    mainWindow.webContents.on('console-message', (...args) => {
      // Electron >= 37 passes a details object; older versions pass positional args.
      const d = typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      const isError = d.level === 'error' || d.level === 'warning' || d.level >= 2;
      if (isError) console.error(`[renderer:${d.level}] ${d.message} (${d.sourceId}:${d.lineNumber})`);
    });
    mainWindow.webContents.on('preload-error', (_e, path, err) => console.error('[preload]', path, err));
    mainWindow.webContents.on('render-process-gone', (_e, details) => console.error('[renderer gone]', details));
  }

  // External links open in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  buildMenu(mainWindow);
}

/**
 * Asks the renderer whether it is safe to close. The renderer acknowledges
 * immediately, before it puts up any save prompt, so a missing acknowledgement
 * means it is wedged — in which case we close anyway. A user who cannot quit
 * would otherwise have no option but Force Quit, which loses the same work.
 */
function requestRendererClose() {
  if (!mainWindow) return;
  mainWindow.webContents.send('app:request-close');
  clearTimeout(closeAckTimer);
  closeAckTimer = setTimeout(() => {
    console.warn('renderer did not acknowledge the close request; closing anyway');
    forceClose = true;
    if (isQuitting) app.quit();
    else mainWindow?.close();
  }, CLOSE_ACK_TIMEOUT);
}

/**
 * A packaged build gets its name and icon from the app bundle. When running
 * unpackaged the bundle is Electron's, so the dock icon has to be set at
 * runtime — the menu-bar title still comes from the bundle and will read
 * "Electron" until the app is packaged.
 */
function applyBranding() {
  app.setAboutPanelOptions({
    applicationName: 'Paint.mac',
    applicationVersion: app.getVersion(),
    credits: `A Paint.NET-style raster image editor for macOS.\nBy ${AUTHOR}\n${SITE}`,
    copyright: `© 2026 ${AUTHOR} · 0BSD — free for any use`
  });

  if (app.isPackaged || !app.dock) return;
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  if (!fsSync.existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

function flushPendingOpens() {
  if (!mainWindow) return;
  while (pendingOpenFiles.length) {
    mainWindow.webContents.send('menu:command', { id: 'file.openPath', path: pendingOpenFiles.shift() });
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('menu:command', { id: 'file.openPath', path: filePath });
  } else {
    pendingOpenFiles.push(filePath);
  }
});

/**
 * Dev-only: simulates the Quit menu item (which is just app.quit()) after a
 * delay, so the shutdown path can be exercised without a human at the keyboard.
 */
function scheduleQuitProbe() {
  const arg = process.argv.find((a) => a.startsWith('--quit-after='));
  if (!isDev || !arg) return;
  const ms = Number(arg.slice('--quit-after='.length)) || 2000;
  if (process.argv.includes('--close-window-first')) {
    setTimeout(() => {
      console.log('quit-probe: closing the window');
      mainWindow?.close();
    }, Math.max(500, ms - 1200));
  }
  setTimeout(() => {
    console.log('quit-probe: calling app.quit()');
    app.quit();
  }, ms);
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';

  // Cut and paste need clipboard access. Grant only that, only to our own
  // pages, and refuse everything else outright.
  const CLIPBOARD_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  const isOwnPage = (url) => url.startsWith('file://');
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(CLIPBOARD_PERMISSIONS.has(permission) && isOwnPage(contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return CLIPBOARD_PERMISSIONS.has(permission) && isOwnPage(contents?.getURL() ?? '');
  });

  applyBranding();
  createWindow();
  scheduleQuitProbe();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* IPC: file system + dialogs                                          */
/* ------------------------------------------------------------------ */

ipcMain.handle('dialog:open', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: opts.filters || IMAGE_FILTERS
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:save', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: opts.defaultPath,
    filters: opts.filters || IMAGE_FILTERS
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('dialog:message', async (_e, opts = {}) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: opts.type || 'question',
    buttons: opts.buttons || ['OK'],
    defaultId: opts.defaultId ?? 0,
    cancelId: opts.cancelId ?? 0,
    message: opts.message || '',
    detail: opts.detail
  });
  return res.response;
});

ipcMain.handle('fs:read', async (_e, filePath) => {
  const buf = await fs.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), ext: path.extname(filePath).toLowerCase(), data: buf };
});

ipcMain.handle('fs:write', async (_e, filePath, data) => {
  await fs.writeFile(filePath, Buffer.from(data));
  return true;
});

ipcMain.on('app:set-title', (_e, { title, edited }) => {
  if (!mainWindow) return;
  mainWindow.setTitle(title);
  mainWindow.setDocumentEdited(!!edited);
});

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:get-platform', () => process.platform);

ipcMain.handle('app:open-external', async (_e, url) => {
  // Only ever hand http(s) to the OS: anything else (file:, javascript:) would
  // be a way to turn a link click into something far more interesting.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  await shell.openExternal(parsed.toString());
  return true;
});

ipcMain.on('app:set-represented-file', (_e, filePath) => {
  if (mainWindow) mainWindow.setRepresentedFilename(filePath || '');
});

// The self-test reports back so `npm test` can exit with a meaningful code.
ipcMain.on('selftest:done', (_e, { passed, total }) => {
  console.log(`self-test: ${passed}/${total} passed`);
  app.exit(passed === total ? 0 : 1);
});

// Dev-only: the clipboard API refuses to run unless the document is focused,
// which an unattended test window is not.
ipcMain.handle('dev:focus-window', () => {
  if (!isDev || !mainWindow) return false;
  app.focus({ steal: true });
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  return true;
});

// Dev-only: lets the self-test save a screenshot of the rendered window.
ipcMain.handle('dev:capture-page', async (_e, filePath) => {
  if (!isDev || !mainWindow) return false;
  const image = await mainWindow.webContents.capturePage();
  await fs.writeFile(filePath, image.toPNG());
  return true;
});

// Sent the moment the renderer receives the request, ahead of any prompt.
ipcMain.on('app:close-ack', () => {
  clearTimeout(closeAckTimer);
  closeAckTimer = null;
});

ipcMain.on('app:close-confirmed', () => {
  clearTimeout(closeAckTimer);
  forceClose = true;
  if (isQuitting) app.quit();          // resume the quit our veto cancelled
  else if (mainWindow) mainWindow.close();
});

// The user backed out of the save prompt, so a later window close must not be
// mistaken for the tail end of that quit.
ipcMain.on('app:close-cancelled', () => {
  clearTimeout(closeAckTimer);
  isQuitting = false;
});
