const { contextBridge, ipcRenderer } = require('electron');
const inv = (c) => (...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld('dw', {
  screenId: inv('screen-id'),
  hostStart: () => ipcRenderer.send('host-start'),
  hostStop: () => ipcRenderer.send('host-stop'),
  input: (line) => ipcRenderer.send('input', line),
  notify: () => ipcRenderer.send('notify'),
  list: inv('fs-list'),
  size: inv('fs-size'),
  uniq: inv('fs-uniq'),
  open: inv('fh-open'),
  read: inv('fh-read'),
  write: inv('fh-write'),
  close: inv('fh-close'),
  pick: inv('pick-file'),
  clipRead: inv('clip-read'),
  clipWrite: inv('clip-write')
});
