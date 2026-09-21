// 페이지에는 호스트 종류·버전과 몇 가지 동작만 알린다. Node API·토큰은 노출하지 않는다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aifHost", {
  kind: "aif-desktop-shell",
  version: `electron ${process.versions.electron}`,
  // AIF API 는 같은 출처의 /aif-bridge 로 보낸다(셸이 중앙 서버로 넘긴다).
  apiBase: "/aif-bridge",
  /** 이 프로젝트를 웹사이트(설정된 주소)에서 기본 브라우저로 연다. */
  openWeb: (projectId) => ipcRenderer.invoke("aif:open-web", String(projectId)),
  openSettings: () => ipcRenderer.invoke("aif:open-settings"),
  /** 게시 대기 결과(outbox)를 지금 다시 보낸다. 분석은 다시 돌리지 않는다. */
  retryOutbox: () => ipcRenderer.invoke("aif:retry-outbox"),
});
