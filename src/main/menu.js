'use strict';

const { Menu, app, shell } = require('electron');

/**
 * Menu items are thin: every item forwards a command id to the renderer,
 * which owns all document state. Keeps one dispatch path for menus,
 * keyboard shortcuts and toolbar buttons alike.
 */
function buildMenu(win) {
  const send = (id, args) => () => win.webContents.send('menu:command', { id, ...args });
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New…', accelerator: 'CmdOrCtrl+N', click: send('file.new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('file.open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('file.save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: send('file.saveAs') },
        { label: 'Export As…', accelerator: 'Alt+CmdOrCtrl+S', click: send('file.export') },
        { type: 'separator' },
        ...(isMac
          ? [{ label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' }]
          : [{ role: 'quit', label: 'Exit', accelerator: 'CmdOrCtrl+Q' }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('edit.undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('edit.redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: send('edit.cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: send('edit.copy') },
        { label: 'Copy Merged', accelerator: 'Shift+CmdOrCtrl+C', click: send('edit.copyMerged') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: send('edit.paste') },
        { label: 'Paste Into New Layer', accelerator: 'Shift+CmdOrCtrl+V', click: send('edit.pasteLayer') },
        { type: 'separator' },
        { label: 'Erase Selection', accelerator: 'Backspace', click: send('edit.eraseSelection') },
        { label: 'Fill Selection with Primary', accelerator: 'Alt+Backspace', click: send('edit.fillSelection') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('select.all') },
        { label: 'Deselect', accelerator: 'CmdOrCtrl+D', click: send('select.none') },
        { label: 'Invert Selection', accelerator: 'CmdOrCtrl+I', click: send('select.invert') }
      ]
    },
    {
      label: 'Image',
      submenu: [
        { label: 'Crop to Selection', accelerator: 'Shift+CmdOrCtrl+X', click: send('image.crop') },
        { label: 'Trim Transparent Edges', click: send('image.trim') },
        { type: 'separator' },
        { label: 'Resize Image…', accelerator: 'CmdOrCtrl+R', click: send('image.resize') },
        { label: 'Canvas Size…', accelerator: 'Shift+CmdOrCtrl+R', click: send('image.canvasSize') },
        { type: 'separator' },
        { label: 'Flip Horizontal', click: send('image.flipH') },
        { label: 'Flip Vertical', click: send('image.flipV') },
        { label: 'Rotate 90° Clockwise', accelerator: 'CmdOrCtrl+]', click: send('image.rotateCW') },
        { label: 'Rotate 90° Counter-clockwise', accelerator: 'CmdOrCtrl+[', click: send('image.rotateCCW') },
        { label: 'Rotate 180°', click: send('image.rotate180') },
        { label: 'Arbitrary Rotate…', click: send('image.rotateArbitrary') },
        { type: 'separator' },
        { label: 'Flatten', accelerator: 'Shift+CmdOrCtrl+F', click: send('image.flatten') }
      ]
    },
    {
      label: 'Layers',
      submenu: [
        { label: 'Add New Layer', accelerator: 'Shift+CmdOrCtrl+N', click: send('layer.add') },
        { label: 'Duplicate Layer', accelerator: 'Shift+CmdOrCtrl+D', click: send('layer.duplicate') },
        { label: 'Delete Layer', click: send('layer.delete') },
        { label: 'Merge Layer Down', accelerator: 'CmdOrCtrl+M', click: send('layer.mergeDown') },
        { type: 'separator' },
        { label: 'Move Layer Up', accelerator: 'CmdOrCtrl+Up', click: send('layer.moveUp') },
        { label: 'Move Layer Down', accelerator: 'CmdOrCtrl+Down', click: send('layer.moveDown') },
        { type: 'separator' },
        { label: 'Import from File…', click: send('layer.import') },
        { label: 'Layer Properties…', accelerator: 'F4', click: send('layer.properties') },
        { type: 'separator' },
        { label: 'Flip Layer Horizontal', click: send('layer.flipH') },
        { label: 'Flip Layer Vertical', click: send('layer.flipV') },
        { label: 'Rotate / Zoom Layer…', click: send('layer.rotateZoom') }
      ]
    },
    {
      label: 'Adjustments',
      submenu: [
        { label: 'Auto Level', accelerator: 'Shift+CmdOrCtrl+L', click: send('adjust.autoLevel') },
        { label: 'Black and White', accelerator: 'Shift+CmdOrCtrl+G', click: send('adjust.blackAndWhite') },
        { label: 'Invert Colors', accelerator: 'Shift+CmdOrCtrl+I', click: send('adjust.invert') },
        { label: 'Sepia', click: send('adjust.sepia') },
        { type: 'separator' },
        { label: 'Brightness / Contrast…', accelerator: 'Shift+CmdOrCtrl+B', click: send('adjust.brightnessContrast') },
        { label: 'Hue / Saturation…', accelerator: 'Shift+CmdOrCtrl+U', click: send('adjust.hueSaturation') },
        { label: 'Levels…', click: send('adjust.levels') },
        { label: 'Curves…', click: send('adjust.curves') },
        { label: 'Posterize…', click: send('adjust.posterize') },
        { label: 'Color Temperature…', click: send('adjust.temperature') }
      ]
    },
    {
      label: 'Effects',
      submenu: [
        {
          label: 'Blurs',
          submenu: [
            { label: 'Gaussian Blur…', click: send('effect.gaussianBlur') },
            { label: 'Motion Blur…', click: send('effect.motionBlur') },
            { label: 'Zoom Blur…', click: send('effect.zoomBlur') },
            { label: 'Pixelate…', click: send('effect.pixelate') }
          ]
        },
        {
          label: 'Photo',
          submenu: [
            { label: 'Sharpen…', click: send('effect.sharpen') },
            { label: 'Unsharp Mask…', click: send('effect.unsharp') },
            { label: 'Glow…', click: send('effect.glow') },
            { label: 'Vignette…', click: send('effect.vignette') }
          ]
        },
        {
          label: 'Stylize',
          submenu: [
            { label: 'Edge Detect…', click: send('effect.edgeDetect') },
            { label: 'Emboss…', click: send('effect.emboss') },
            { label: 'Outline…', click: send('effect.outline') },
            { label: 'Oil Painting…', click: send('effect.oil') }
          ]
        },
        {
          label: 'Noise',
          submenu: [
            { label: 'Add Noise…', click: send('effect.addNoise') },
            { label: 'Median…', click: send('effect.median') },
            { label: 'Reduce Noise…', click: send('effect.reduceNoise') }
          ]
        },
        {
          label: 'Distort',
          submenu: [
            { label: 'Bulge…', click: send('effect.bulge') },
            { label: 'Twist…', click: send('effect.twist') },
            { label: 'Tile Reflection…', click: send('effect.tile') }
          ]
        },
        {
          label: 'Render',
          submenu: [
            { label: 'Clouds…', click: send('effect.clouds') },
            { label: 'Julia Fractal…', click: send('effect.julia') }
          ]
        },
        { type: 'separator' },
        { label: 'Repeat Last Effect', accelerator: 'CmdOrCtrl+F', click: send('effect.repeat') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: send('view.zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('view.zoomOut') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: send('view.zoom100') },
        { label: 'Fit to Window', accelerator: 'CmdOrCtrl+B', click: send('view.fit') },
        { type: 'separator' },
        { label: 'Show Grid', accelerator: 'CmdOrCtrl+G', type: 'checkbox', checked: false, click: (mi) => win.webContents.send('menu:command', { id: 'view.grid', value: mi.checked }) },
        { label: 'Show Rulers', type: 'checkbox', checked: true, click: (mi) => win.webContents.send('menu:command', { id: 'view.rulers', value: mi.checked }) },
        { label: 'Show Pixel Grid at High Zoom', type: 'checkbox', checked: true, click: (mi) => win.webContents.send('menu:command', { id: 'view.pixelGrid', value: mi.checked }) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'togglefullscreen' }]
    },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: send('help.shortcuts') },
        { label: 'Visit the Website', click: send('help.website') },
        { label: 'About Paint.mac', click: send('help.about') }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
