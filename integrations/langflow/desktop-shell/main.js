// AIF 전용 Langflow Desktop 셸 (P0 실험)
//
// 공식 Langflow Desktop 은 화면을 exe 안에 내장해 로드하므로 포크한 프런트엔드를 넣을 수 없다.
// 이 셸은 별도 앱 ID·데이터 경로로, 포크 빌드를 제공하는 Langflow 서버를 네이티브 창에 띄운다.
//
// 환경변수
//   AIF_LANGFLOW_URL    창에 띄울 Langflow 주소 (기본 http://127.0.0.1:7870)
//   AIF_LANGFLOW_START  서버가 응답하지 않을 때 실행할 PowerShell 스크립트 (선택)
//   AIF_WEB_ORIGINS     [웹에서 열기]로 기본 브라우저에 넘길 수 있는 출처, 쉼표 구분 (선택)
//   AIF_SHELL_PROBE     p0 | p1 이면 자동 점검을 돌리고 결과 JSON(과 p1 은 캡처)을 남긴 뒤 종료 (1 은 p0)
//   AIF_SHELL_PROBE_OUT 점검 결과 파일 경로

const { app, BrowserWindow, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

app.setName("AIF Langflow Desktop");
// 자동 점검 캡처가 창 가림·GPU 상태에 따라 비지 않도록 점검 때만 소프트웨어 렌더링을 쓴다.
if (process.env.AIF_SHELL_PROBE) app.disableHardwareAcceleration();
app.setPath("userData", path.join(app.getPath("appData"), "com.aif.LangflowDesktop"));

const LANGFLOW_URL = process.env.AIF_LANGFLOW_URL || "http://127.0.0.1:7870";
const START_SCRIPT = process.env.AIF_LANGFLOW_START || "";
const WEB_ORIGINS = (process.env.AIF_WEB_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PROBE = { 1: "p0", p0: "p0", p1: "p1" }[process.env.AIF_SHELL_PROBE] ?? null;

let backend = null;

async function isHealthy() {
  try {
    const res = await fetch(new URL("/health_check", LANGFLOW_URL), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBackend() {
  if (await isHealthy()) return "attached";
  if (!START_SCRIPT) throw new Error(`Langflow 가 ${LANGFLOW_URL} 에서 응답하지 않고 AIF_LANGFLOW_START 가 없습니다.`);
  backend = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", START_SCRIPT], {
    stdio: "ignore",
    windowsHide: true,
  });
  for (let i = 0; i < 180; i += 1) {
    if (await isHealthy()) return "started";
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Langflow 서버 시작 대기 시간 초과");
}

function isAllowedExternal(url) {
  try {
    return WEB_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "AIF Langflow Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const appOrigin = new URL(LANGFLOW_URL).origin;
  // 앱 밖 주소는 창 안에서 열지 않는다. 허용된 웹 출처만 기본 브라우저로 넘긴다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === appOrigin) return;
    event.preventDefault();
    if (isAllowedExternal(url)) shell.openExternal(url);
  });
  return win;
}

function probeTools(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (selector, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await sleep(300);
    }
    return false;
  };
  const steps = [];
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      steps.push({ name, ok: false, detail: String(e) });
    }
  };
  const waitPath = async (prefix, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const p = await js("location.pathname");
      if (p.startsWith(prefix)) return p;
      await sleep(300);
    }
    throw new Error(`${prefix} 로 이동하지 않음 (현재 ${await js("location.pathname")})`);
  };
  return { wc, js, sleep, waitFor, steps, step, waitPath };
}

function writeProbe(mode, backend, steps, extra = {}) {
  const out =
    process.env.AIF_SHELL_PROBE_OUT || path.join(app.getPath("userData"), `${mode}-probe.json`);
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        probe: mode,
        electron: process.versions.electron,
        url: LANGFLOW_URL,
        backend,
        userData: app.getPath("userData"),
        steps,
        ...extra,
      },
      null,
      2,
    ),
  );
  return out;
}

// P1: Langflow 안의 AIF 화면에서 예제 사건의 원문·그래프·상세를 띄우고, Flow 화면 스타일이 바뀌지 않는지 본다.
async function probeP1(win, mode) {
  const { wc, js, sleep, waitFor, steps, step, waitPath } = probeTools(win);
  const consoleErrors = [];
  wc.on("console-message", (event) => {
    if (event.level === "error") consoleErrors.push(String(event.message).slice(0, 300));
  });
  const outDir = path.dirname(
    process.env.AIF_SHELL_PROBE_OUT || path.join(app.getPath("userData"), "p1-probe.json"),
  );
  const shot = async (name) => {
    await sleep(1200);
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(outDir, `p1-${name}.png`), img.toPNG());
    return img.toBitmap();
  };
  let flowsBefore = null;
  let flowsAfter = null;
  await step("flows 화면 로드", async () => {
    if (!(await waitFor('[data-testid="app-header"]'))) throw new Error("헤더 없음");
    flowsBefore = await shot("flows-before");
    return await js("location.pathname");
  });
  await step("헤더 AIF → 검토 화면", async () => {
    await js(`document.querySelector('[data-testid="aif-menu-button"]').click()`);
    if (!(await waitFor('[data-testid="aif-workbench-page"] .toolbar'))) throw new Error("AIF 화면 안 열림");
    return await js("location.pathname");
  });
  await step("예제 열기 → 원문·그래프", async () => {
    const clicked = await js(
      `(() => { const b = [...document.querySelectorAll('.aif-root .toolbar button')].find((x) => x.textContent.trim() === '예제 열기' || x.textContent.trim() === 'Open example'); b?.click(); return !!b; })()`,
    );
    if (!clicked) throw new Error("예제 열기 버튼 없음");
    for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.aif-root .react-flow__node').length`)); i++) await sleep(200);
    const nodes = await js(`document.querySelectorAll('.aif-root .react-flow__node').length`);
    const textLen = await js(`(document.querySelector('.aif-root .pane-text')?.innerText || '').length`);
    if (!nodes) throw new Error("그래프 노드 없음");
    if (textLen < 200) throw new Error("원문이 보이지 않음");
    await shot("workbench-sample");
    return { nodes, textLen };
  });
  await step("노드 클릭 → 상세 패널", async () => {
    await js(`document.querySelector('.aif-root .react-flow__node')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    if (!(await waitFor(".aif-root .node-detail", 10000))) throw new Error("상세 패널 없음");
    await shot("workbench-detail");
    return await js(`document.querySelector('.aif-root .node-detail h2, .aif-root .node-detail header')?.textContent?.trim() ?? ''`);
  });
  await step("Flow 목록 복귀 → 스타일 비교", async () => {
    // 로고는 "/" 로 간다. 테스트 DB 에 Flow 가 없으면 Langflow 는 "/" 에서 첫 화면을 보여 준다(첫 캡처와 같은 화면).
    await js(`document.querySelector('[data-testid="icon-ChevronLeft"]').click()`);
    await waitPath("/");
    if (await js(`!!document.querySelector('[data-testid="aif-workbench-page"]')`)) throw new Error("AIF 화면이 남아 있음");
    if (!(await waitFor('[data-testid="app-header"]'))) throw new Error("헤더 없음");
    flowsAfter = await shot("flows-after");
    let diff = 0;
    for (let i = 0; i < flowsBefore.length; i += 4) {
      if (flowsBefore[i] !== flowsAfter[i] || flowsBefore[i + 1] !== flowsAfter[i + 1] || flowsBefore[i + 2] !== flowsAfter[i + 2]) diff++;
    }
    return { diffPixels: diff, total: flowsBefore.length / 4 };
  });
  await step("다시 AIF → 편집 상태 유지", async () => {
    await js(`document.querySelector('[data-testid="aif-menu-button"]').click()`);
    if (!(await waitFor('[data-testid="aif-workbench-page"] .toolbar'))) throw new Error("AIF 화면 안 열림");
    for (let i = 0; i < 25 && !(await js(`document.querySelectorAll('.aif-root .react-flow__node').length`)); i++) await sleep(200);
    return { nodes: await js(`document.querySelectorAll('.aif-root .react-flow__node').length`) };
  });
  await step("AIF 화면 새로고침", async () => {
    wc.reload();
    await new Promise((r) => wc.once("did-finish-load", r));
    if (!(await waitFor('[data-testid="aif-workbench-page"] .toolbar'))) throw new Error("새로고침 후 화면 없음");
    return await js("location.pathname");
  });
  writeProbe("p1", mode, steps, { consoleErrors });
}

async function probe(win, mode) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const waitFor = async (selector, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };
  const steps = [];
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      steps.push({ name, ok: false, detail: String(e) });
    }
  };
  await step("flows 화면 로드", async () => {
    if (!(await waitFor('[data-testid="app-header"]'))) throw new Error("헤더 없음");
    return await js("location.pathname");
  });
  await step("테스트 페이지 열기", async () => {
    // 헤더 AIF 메뉴는 P1 부터 검토 화면(/aif)으로 간다. 테스트 페이지는 주소로 연다.
    if (!(await waitFor('[data-testid="aif-menu-button"]'))) throw new Error("AIF 메뉴 없음");
    await win.loadURL(new URL("/aif/check", LANGFLOW_URL).toString());
    if (!(await waitFor('[data-testid="aif-integration-check"]'))) throw new Error("테스트 페이지 안 열림");
    return {
      path: await js("location.pathname"),
      build: await js(`document.querySelector('[data-testid="aif-build-mark"]').textContent`),
      host: await js(`document.querySelector('[data-testid="aif-host"]').textContent`),
    };
  });
  await step("테스트 페이지 새로고침", async () => {
    wc.reload();
    await new Promise((r) => wc.once("did-finish-load", r));
    if (!(await waitFor('[data-testid="aif-integration-check"]'))) throw new Error("새로고침 후 페이지 없음");
    return await js("location.pathname");
  });
  await step("Flow 목록으로 복귀", async () => {
    await js(`document.querySelector('[data-testid="aif-back"]').click()`);
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const p = await js("location.pathname");
      if (p.startsWith("/flows")) return p;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("flows 로 돌아가지 않음");
  });
  await step("재시작 유지 표식", async () => js(`localStorage.getItem("aif-check-visits")`));
  const out =
    process.env.AIF_SHELL_PROBE_OUT || path.join(app.getPath("userData"), "p0-probe.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        electron: process.versions.electron,
        url: LANGFLOW_URL,
        backend: mode,
        userData: app.getPath("userData"),
        steps,
      },
      null,
      2,
    ),
  );
}

app.whenReady().then(async () => {
  let mode;
  try {
    mode = await ensureBackend();
  } catch (e) {
    console.error(String(e));
    app.exit(1);
    return;
  }
  const win = createWindow();
  await win.loadURL(new URL("/flows", LANGFLOW_URL).toString());
  if (PROBE) {
    await (PROBE === "p1" ? probeP1(win, mode) : probe(win, mode));
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => {
  // PowerShell 아래의 langflow·python 자식까지 함께 종료한다. 붙기만 한 서버(attached)는 건드리지 않는다.
  if (backend && backend.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
});
