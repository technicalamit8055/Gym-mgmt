// CommonJS: a sandboxed preload cannot be an ES module.
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Everything the dock's page can ask the main process for — one method per
 * method of src/controller.js, on the channel `studio:<name>`. Each resolves
 * to { ok, data } or { ok: false, error, status?, details? }.
 */
const METHODS = [
  'status', 'pair', 'unpair', 'chooseNotesDir', 'lectures', 'goLive', 'session', 'socketUrl',
  'endClass', 'findNotes', 'pickNotesFile', 'publishNotes', 'resize', 'quit',
  'streamSettings', 'saveStreamSettings', 'streamStart', 'streamStop', 'attachStream',
  'setStartAtLogin',
];

contextBridge.exposeInMainWorld('studio', {
  ...Object.fromEntries(METHODS.map((name) => [name, (arg) => ipcRenderer.invoke(`studio:${name}`, arg)])),
  drag: (phase, screenX, screenY) => ipcRenderer.send('studio:drag', { phase, screenX, screenY }),
  // The broadcast: the recorder's chunks out to ffmpeg, and how it is going back.
  streamChunk: (chunk) => ipcRenderer.send('studio:stream-chunk', chunk),
  onUnfold: (callback) => ipcRenderer.on('studio:unfold', () => callback()),
  onStreamStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('studio:stream-status', listener);
    return () => ipcRenderer.removeListener('studio:stream-status', listener);
  },
});
