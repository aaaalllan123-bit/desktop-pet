const { contextBridge, ipcRenderer } = require('electron');

const IN = ['character', 'state', 'say', 'music', 'fx'];
const OUT = ['press', 'release', 'dblclick', 'petted', 'menu', 'ignore-mouse', 'music-state'];

contextBridge.exposeInMainWorld('pet', {
  on: (ch, fn) => { if (IN.includes(ch)) ipcRenderer.on(ch, (_e, data) => fn(data)); },
  send: (ch, data) => { if (OUT.includes(ch)) ipcRenderer.send(ch, data); },
});
