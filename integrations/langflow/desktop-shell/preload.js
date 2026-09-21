// 페이지에는 호스트 종류와 버전만 알린다. Node API 는 노출하지 않는다.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("aifHost", {
  kind: "aif-desktop-shell",
  version: `electron ${process.versions.electron}`,
});
