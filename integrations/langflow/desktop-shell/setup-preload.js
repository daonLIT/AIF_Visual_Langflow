const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aifSetup", {
  onProgress: (callback) => ipcRenderer.on("aif-setup:progress", (_event, value) => callback(value)),
});
