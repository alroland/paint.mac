// Renders the app icon with Electron's own canvas, then writes the PNG sizes
// that iconutil needs. Keeps the icon in version control as code rather than a
// binary blob nobody can edit.
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const OUT = path.join(__dirname, '..', '..', 'build');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'render.html'));
  await win.webContents.executeJavaScript('new Promise(r => (window.__iconReady ? r(1) : setTimeout(r, 300)))');
  const dataURL = await win.webContents.executeJavaScript(
    "document.getElementById('c').toDataURL('image/png')"
  );
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'icon.png'), Buffer.from(dataURL.split(',')[1], 'base64'));
  console.log('wrote build/icon.png (1024x1024)');
  app.exit(0);
});
