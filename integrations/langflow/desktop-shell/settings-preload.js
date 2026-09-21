const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aifSettings", {
  get: () => ipcRenderer.invoke("aif-settings:get"),
  save: (values) => ipcRenderer.invoke("aif-settings:save", values),
});
