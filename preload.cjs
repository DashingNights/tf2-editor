const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = ch => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  read: call('read'),
  write: call('write'),
  exists: call('exists'),
  openDialog: call('openDialog'),
  saveDialog: call('saveDialog'),
  openFiles: call('openFiles'),
  run: call('run'),
  readBytes: call('readBytes'),
  stat: call('stat'),
  listDir: call('listDir'),
  writeBinary: call('writeBinary'),
  remove: call('remove'),
  rename: call('rename'),
  // Path of a dropped File (Electron removed File.path); '' for files made in the page.
  pathFor: f => webUtils.getPathForFile(f),
  cancel: () => ipcRenderer.send('cancel'),
  setDirty: d => ipcRenderer.send('dirty', d),
  closeNow: () => ipcRenderer.send('closeNow'),
  setMinSize: (w, h) => ipcRenderer.send('minSize', w, h),
  closeWindow: () => ipcRenderer.send('closeWindow'),
  onCloseRequest: f => ipcRenderer.on('close-request', () => f()),
  onLog: f => ipcRenderer.on('log', (_, s) => f(s)),
  settingsPath: ipcRenderer.sendSync('settingsPath'),
});
