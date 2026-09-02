'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Narrow, explicit surface. The renderer never touches fs or dialogs directly;
 * every path it can reach is one the user picked in a native dialog or dropped
 * onto the window.
 */
contextBridge.exposeInMainWorld('api', {
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  messageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),

  readFile: (path) => ipcRenderer.invoke('fs:read', path),
  writeFile: (path, data) => ipcRenderer.invoke('fs:write', path, data),

  capturePage: (path) => ipcRenderer.invoke('dev:capture-page', path),
  focusWindow: () => ipcRenderer.invoke('dev:focus-window'),
  scratchFile: (name) => ipcRenderer.invoke('dev:scratch-file', name),
  selfTestDone: (result) => ipcRenderer.send('selftest:done', result),

  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  setTitle: (title, edited) => ipcRenderer.send('app:set-title', { title, edited }),
  setRepresentedFile: (path) => ipcRenderer.send('app:set-represented-file', path),
  confirmClose: () => ipcRenderer.send('app:close-confirmed'),
  cancelClose: () => ipcRenderer.send('app:close-cancelled'),
  ackClose: () => ipcRenderer.send('app:close-ack'),

  onMenuCommand: (cb) => ipcRenderer.on('menu:command', (_e, payload) => cb(payload)),
  onRequestClose: (cb) => ipcRenderer.on('app:request-close', () => cb())
});
