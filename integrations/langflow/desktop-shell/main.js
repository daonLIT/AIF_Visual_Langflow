// AIF 전용 Langflow Desktop 셸
//
// 공식 Langflow Desktop 은 화면을 exe 안에 내장해 로드하므로 포크한 프런트엔드를 넣을 수 없다.
// 이 셸은 별도 앱 ID·데이터 경로로, 포크 빌드를 제공하는 Langflow 서버를 네이티브 창에 띄운다.
// - AIF 화면의 API 요청은 /aif-bridge 로 받아 설정된 중앙 서버로만 넘긴다(bridge.js). 토큰은 화면에 주지 않는다.
// - Langflow 를 직접 띄울 때 Flow 게시용 환경변수(AIF_API_BASE, AIF_PUBLISH_TOKEN, AIF_OUTBOX_DIR)를 넘긴다.
// - 게시 대기 결과(outbox)는 시작할 때와 5분마다 다시 보낸다(outbox.js).
//
// 환경변수
//   AIF_LANGFLOW_URL    창에 띄울 Langflow 주소 (기본 http://127.0.0.1:7870)
//   AIF_LANGFLOW_START  서버가 응답하지 않을 때 실행할 PowerShell 스크립트 (선택)
//   AIF_API_BASE, AIF_SITE_URL, AIF_REVIEW_TOKEN, AIF_PUBLISH_TOKEN
//                       연결 설정(메뉴 'AIF 연결 설정')보다 우선하는 값. 개발·자동 점검용
//   AIF_SHELL_PROBE     p0 | p1 | p2 이면 자동 점검을 돌리고 결과 JSON(과 캡처)을 남긴 뒤 종료 (1 은 p0)
//   AIF_SHELL_PROBE_OUT 점검 결과 파일 경로

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

app.setName("AIF Langflow Desktop");
// 자동 점검 캡처가 창 가림·GPU 상태에 따라 비지 않도록 점검 때만 소프트웨어 렌더링을 쓴다.
if (process.env.AIF_SHELL_PROBE) app.disableHardwareAcceleration();
app.setPath("userData", path.join(app.getPath("appData"), "com.aif.LangflowDesktop"));

const config = require("./config");
const { installBridge } = require("./bridge");
const { flushOutbox } = require("./outbox");

const LANGFLOW_URL = process.env.AIF_LANGFLOW_URL || "http://127.0.0.1:7870";
const APP_ORIGIN = new URL(LANGFLOW_URL).origin;
const START_SCRIPT = process.env.AIF_LANGFLOW_START || "";
const OUTBOX_DIR = path.join(app.getPath("userData"), "outbox");
// 마지막으로 보던 앱 안 주소. 다시 켜면 그 화면(예: 검토 중인 AIF 프로젝트)을 연다.
const LAST_VIEW_FILE = path.join(app.getPath("userData"), "last-view.json");

function rememberView(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== APP_ORIGIN || parsed.pathname.startsWith("/login")) return;
    fs.writeFileSync(LAST_VIEW_FILE, JSON.stringify({ path: parsed.pathname + parsed.search }));
  } catch {
    // 기록하지 못해도 동작에는 지장 없다
  }
}

function startPath() {
  // 자동 점검(p0~p2)은 늘 Flow 목록에서 시작한다. p3 복원 점검과 사용자 실행만 마지막 화면을 연다.
  if (PROBE && !PROBE.startsWith("p3")) return "/flows";
  try {
    const { path: last } = JSON.parse(fs.readFileSync(LAST_VIEW_FILE, "utf8"));
    if (typeof last === "string" && last.startsWith("/") && !last.startsWith("//")) return last;
  } catch {
    // 처음 실행
  }
  return "/flows";
}
const PROBE = { 1: "p0", p0: "p0", p1: "p1", p2: "p2", p2b: "p2b", p3: "p3", p3r: "p3r" }[process.env.AIF_SHELL_PROBE] ?? null;

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
  const { apiBase, publishToken } = config.load();
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  backend = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", START_SCRIPT], {
    stdio: "ignore",
    windowsHide: true,
    // Flow 의 AIF Run Context·AIF Publish 가 읽는다. Flow JSON 에는 들어가지 않는다.
    env: { ...process.env, AIF_API_BASE: apiBase, AIF_PUBLISH_TOKEN: publishToken, AIF_OUTBOX_DIR: OUTBOX_DIR },
  });
  for (let i = 0; i < 180; i += 1) {
    if (await isHealthy()) return "started";
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Langflow 서버 시작 대기 시간 초과");
}

/** 기본 브라우저로 넘겨도 되는 주소: 설정된 웹사이트 출처만. */
function isAllowedExternal(url) {
  try {
    const site = config.load().siteUrl;
    return Boolean(site) && new URL(url).origin === new URL(site).origin;
  } catch {
    return false;
  }
}

let settingsWindow = null;
function openSettings(parent) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 560,
    parent,
    title: "AIF 연결 설정",
    webPreferences: { preload: path.join(__dirname, "settings-preload.js"), contextIsolation: true, sandbox: true },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
}

ipcMain.handle("aif-settings:get", () => config.summary());
ipcMain.handle("aif-settings:save", (_event, values) => config.save(values || {}));
ipcMain.handle("aif:open-settings", (event) => openSettings(BrowserWindow.fromWebContents(event.sender)));
ipcMain.handle("aif:open-web", async (_event, projectId) => {
  const site = config.load().siteUrl;
  if (!site) return { ok: false, reason: "no-site-url" };
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(projectId)) return { ok: false, reason: "bad-id" };
  await shell.openExternal(`${site}/?projectId=${encodeURIComponent(projectId)}`);
  return { ok: true };
});

ipcMain.handle("aif:retry-outbox", () => flushNow());

async function flushNow() {
  const report = await flushOutbox(OUTBOX_DIR, config.load());
  if (report.sent.length || report.failed.length) console.log("outbox", JSON.stringify(report));
  return report;
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
  // 앱 안의 링크(예: Flow 출력의 'AIF 검토 화면에서 열기')는 새 창이 아니라 같은 창에서 연다.
  // 앱 밖 주소는 창 안에서 열지 않고, 설정된 웹사이트 출처만 기본 브라우저로 넘긴다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin === APP_ORIGIN) win.loadURL(url);
      else if (isAllowedExternal(url)) shell.openExternal(url);
    } catch {
      // 잘못된 주소는 무시한다
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === APP_ORIGIN) return;
    event.preventDefault();
    if (isAllowedExternal(url)) shell.openExternal(url);
  });
  win.webContents.on("did-navigate", (_event, url) => rememberView(url));
  win.webContents.on("did-navigate-in-page", (_event, url) => rememberView(url));
  // 페이지가 저장 안 한 변경으로 닫기·새로고침을 막으면(beforeunload) Electron 은 아무 안내 없이 막는다. 물어보고 결정한다.
  win.webContents.on("will-prevent-unload", (event) => {
    if (PROBE) {
      event.preventDefault(); // 자동 점검은 그대로 닫는다
      return;
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["떠나기", "머무르기"],
      defaultId: 1,
      cancelId: 1,
      title: "저장하지 않은 변경",
      message: "저장하지 않은 변경이 있습니다. 버리고 떠날까요?",
    });
    if (choice === 0) event.preventDefault();
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

// P2: 실제 Flow 실행(로컬 Ollama) → 자동 게시 → 같은 창에서 결과 열기 → 게시만 다시 실행.
// 테스트 Langflow 프로필에 Desktop Flow 를 새로 올리고 예제 판결문을 넣는다(사용자 Flow·데이터는 건드리지 않음).
async function prepareP2Flow() {
  const repo = path.resolve(__dirname, "..", "..", "..");
  const flow = JSON.parse(fs.readFileSync(path.join(repo, "langflow", "TopDown_Judgment_to_AIF_v11_Desktop.json"), "utf8"));
  const sample = JSON.parse(fs.readFileSync(path.join(repo, "packages", "aif-workbench", "fixtures", "sample-case.json"), "utf8"));
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  for (const node of flow.data.nodes) {
    const template = node.data?.node?.template ?? {};
    if (node.id === "CustomComponent-k5fj9") template.value.value = sample.text;
    if (node.id === "CustomComponent-Ctx12") {
      template.case_id.value = `P2-${stamp}`;
      template.title.value = `P2 자동 점검 ${stamp}`;
    }
  }
  const login = await (await fetch(new URL("/api/v1/auto_login", LANGFLOW_URL))).json();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.access_token}` };
  const created = await fetch(new URL("/api/v1/flows/", LANGFLOW_URL), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `${flow.name} ${stamp}`, description: flow.description, data: flow.data }),
  });
  if (!created.ok) throw new Error(`flow 업로드 실패 HTTP ${created.status}: ${(await created.text()).slice(0, 300)}`);
  return { flowId: (await created.json()).id, caseId: `P2-${stamp}`, textLength: sample.text.length };
}

async function probeP2(win, mode) {
  const { wc, js, sleep, waitFor, steps, step, waitPath } = probeTools(win);
  const consoleErrors = [];
  wc.on("console-message", (event) => {
    if (event.level === "error") consoleErrors.push(String(event.message).slice(0, 300));
  });
  const outDir = path.dirname(process.env.AIF_SHELL_PROBE_OUT || path.join(app.getPath("userData"), "p2-probe.json"));
  const shot = async (name) => {
    await sleep(1200);
    fs.writeFileSync(path.join(outDir, `p2-${name}.png`), (await wc.capturePage()).toPNG());
  };
  const central = config.load();
  const centralGet = async (apiPath) => {
    const response = await fetch(`${central.apiBase}${apiPath}`, { headers: { Authorization: `Bearer ${central.reviewToken}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const panel = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const state = await js(`(() => { const p = document.querySelector('[data-testid="aif-publish-panel"]'); return p ? { status: p.dataset.publishStatus, projectId: p.dataset.projectId, externalRunId: p.dataset.externalRunId, text: p.innerText } : null; })()`);
      if (state) return state;
      await sleep(2000);
    }
    throw new Error("게시 결과 패널이 나타나지 않음");
  };
  const clickRun = async (label) => {
    const ok = await js(`(() => { const el = document.querySelector('[data-testid="button_run_${label}"]'); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`실행 버튼 없음: ${label}`);
  };

  let prepared = null;
  let first = null;
  await step("테스트 프로필에 Desktop Flow 올리기", async () => {
    prepared = await prepareP2Flow();
    return prepared;
  });
  await step("Flow 화면 열기", async () => {
    await win.loadURL(new URL(`/flow/${prepared.flowId}`, LANGFLOW_URL).toString());
    if (!(await waitFor('[data-testid="button_run_final aif json"]', 60000))) throw new Error("출력 노드 실행 버튼 없음");
    return await js("location.pathname");
  });
  await step("출력 노드 실행 → 분석 → 자동 게시", async () => {
    const started = Date.now();
    await clickRun("final aif json");
    // 실행이 시작돼 이전 패널이 사라진 뒤 새 결과를 기다린다.
    await sleep(3000);
    first = await panel(40 * 60 * 1000);
    await shot("flow-published");
    if (first.status !== "saved") throw new Error(`게시 상태 ${first.status}: ${first.text}`);
    return { ...first, seconds: Math.round((Date.now() - started) / 1000) };
  });
  let latest = null;
  await step("게시 노드 실행 버튼 다시 누르기 (Langflow 부분 재실행 동작 확인)", async () => {
    // Langflow 는 노드 하나를 실행해도 앞 단계를 다시 빌드한다. 그러면 Run Context 가 새 실행 ID 를 만들고 분석도 다시 돈다.
    // 게시만 다시 보내는 길은 outbox 재전송이다(패널의 [다시 보내기], 메뉴). 여기서는 그 동작을 기록만 한다.
    if (!(await waitFor('[data-testid="button_run_8. aif publish"]', 10000))) throw new Error("게시 노드 실행 버튼 없음");
    const started = Date.now();
    await clickRun("8. aif publish");
    await sleep(3000);
    latest = await panel(40 * 60 * 1000);
    const seconds = Math.round((Date.now() - started) / 1000);
    return { ...latest, seconds, sameProject: latest.projectId === first.projectId, sameRun: latest.externalRunId === first.externalRunId };
  });
  await step("중앙 서버에 저장된 내용 확인", async () => {
    const project = await centralGet(`/api/projects/${first.projectId}`);
    if (project.status !== 200) throw new Error(`프로젝트 조회 HTTP ${project.status}`);
    const run = project.body.analysisRuns[0];
    const pending = project.body.annotations.filter((a) => a.status === "pending").length;
    if (run.externalRunId !== first.externalRunId) throw new Error("externalRunId 불일치");
    if (project.body.document.caseId !== prepared.caseId) throw new Error("caseId 불일치");
    if (project.body.document.text.length !== prepared.textLength) throw new Error("원문 길이 불일치");
    return { source: run.source, outcome: run.outcome, pending, acceptedNodes: project.body.acceptedGraph.AIF.nodes.length, catalogs: run.catalogs };
  });
  await step("[이 결과 보기] → 같은 창 검토 화면", async () => {
    // 패널은 가장 최근 실행의 결과만 보여 준다.
    const target = (latest ?? first).projectId;
    await js(`document.querySelector('[data-testid="aif-open-result"]').click()`);
    await waitPath(`/aif/projects/${target}`);
    if (!(await waitFor(`[data-loaded-project="${target}"]`, 30000))) throw new Error("프로젝트가 화면에 로드되지 않음");
    for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.aif-root .react-flow__node').length`)); i++) await sleep(200);
    const nodes = await js(`document.querySelectorAll('.aif-root .react-flow__node').length`);
    const textLen = await js(`(document.querySelector('.aif-root .pane-text')?.innerText || '').length`);
    await shot("review");
    if (!nodes) throw new Error("그래프 노드 없음");
    return { target, windows: BrowserWindow.getAllWindows().length, nodes, textLen, path: await js("location.pathname") };
  });
  await step("사건 목록에 표시", async () => {
    await js(`document.querySelector('[data-testid="aif-back-to-list"]').click()`);
    await waitPath("/aif/projects");
    if (!(await waitFor(`[data-project-id="${first.projectId}"]`, 20000))) throw new Error("목록에 없음");
    await shot("list");
    return await js(`document.querySelector('[data-project-id="${first.projectId}"]').innerText.replace(/\s+/g, ' ')`);
  });
  writeProbe("p2", mode, steps, { consoleErrors: consoleErrors.slice(0, 20) });
}

// P2b: 중앙 서버가 꺼진 상태에서 실행 → 게시 실패·outbox 보관 → 서버가 돌아오면 [다시 보내기] → 같은 실행 ID 로 저장.
// 점검하는 쪽이 서버를 끄고 켠다. 이 점검은 실패 패널이 뜨면 outDir/p2b-waiting 파일을 만들고 서버가 돌아오기를 기다린다.
async function probeP2b(win, mode) {
  const { js, sleep, waitFor, steps, step } = probeTools(win);
  const outDir = path.dirname(process.env.AIF_SHELL_PROBE_OUT || path.join(app.getPath("userData"), "p2b-probe.json"));
  const central = config.load();
  let prepared = null;
  let failed = null;
  const panel = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const state = await js(`(() => { const p = document.querySelector('[data-testid="aif-publish-panel"]'); return p ? { status: p.dataset.publishStatus, externalRunId: p.dataset.externalRunId, text: p.innerText } : null; })()`);
      if (state) return state;
      await sleep(2000);
    }
    throw new Error("게시 결과 패널이 나타나지 않음");
  };
  await step("테스트 프로필에 Desktop Flow 올리기", async () => (prepared = await prepareP2Flow()));
  await step("서버 없이 실행 → 게시 실패·outbox 보관", async () => {
    await win.loadURL(new URL(`/flow/${prepared.flowId}`, LANGFLOW_URL).toString());
    if (!(await waitFor('[data-testid="button_run_final aif json"]', 60000))) throw new Error("출력 노드 실행 버튼 없음");
    await js(`document.querySelector('[data-testid="button_run_final aif json"]').click()`);
    await sleep(3000);
    failed = await panel(40 * 60 * 1000);
    const pending = fs.existsSync(path.join(OUTBOX_DIR, `${failed.externalRunId}.json`));
    if (failed.status !== "failed") throw new Error(`게시 상태 ${failed.status}`);
    if (!pending) throw new Error("outbox 에 없음");
    const stored = fs.readFileSync(path.join(OUTBOX_DIR, `${failed.externalRunId}.json`), "utf8");
    return { ...failed, outbox: true, tokenInOutbox: stored.includes(central.publishToken) };
  });
  await step("서버 복구 후 [다시 보내기]", async () => {
    fs.writeFileSync(path.join(outDir, "p2b-waiting"), failed.externalRunId);
    const end = Date.now() + 10 * 60 * 1000;
    while (Date.now() < end) {
      const ok = await fetch(`${central.apiBase}/api/health`).then((r) => r.ok).catch(() => false);
      if (ok) break;
      await sleep(2000);
    }
    await js(`document.querySelector('[data-testid="aif-retry-publish"]').click()`);
    let note = "";
    for (let i = 0; i < 60 && !note.startsWith("다시 보냄") && !note.startsWith("서버가") && !note.startsWith("아직"); i++) {
      await sleep(500);
      note = await js(`document.querySelector('[data-testid="aif-publish-panel"]').innerText`);
      note = note.split("\n").find((line) => line.startsWith("다시 보냄") || line.startsWith("서버가") || line.startsWith("아직")) ?? "";
    }
    const list = await fetch(`${central.apiBase}/api/projects`, { headers: { Authorization: `Bearer ${central.reviewToken}` } }).then((r) => r.json());
    const saved = list.projects.find((row) => row.caseId === prepared.caseId);
    if (!saved) throw new Error(`중앙 서버에 없음 (${note})`);
    const project = await fetch(`${central.apiBase}/api/projects/${saved.projectId}`, { headers: { Authorization: `Bearer ${central.reviewToken}` } }).then((r) => r.json());
    return {
      note,
      projectId: saved.projectId,
      sameRun: project.analysisRuns[0].externalRunId === failed.externalRunId,
      outboxCleared: !fs.existsSync(path.join(OUTBOX_DIR, `${failed.externalRunId}.json`)),
      pending: project.annotations.filter((a) => a.status === "pending").length,
    };
  });
  writeProbe("p2b", mode, steps);
}

function runP3(kind, win, mode) {
  const { probeP3, probeP3Restore } = require("./probe-p3");
  const ctx = { probeTools, writeProbe, config, LANGFLOW_URL, app };
  return kind === "p3" ? probeP3(ctx, win, mode) : probeP3Restore(ctx, win, mode);
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
  // 저장 안 한 변경이 있는 페이지(beforeunload)에서도 앱이 종료되는지는 이 점검이 끝나고 프로세스가 끝나는 것으로 확인한다.
  await js(`window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; })`);
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

function installMenu() {
  const template = [
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "AIF",
      submenu: [
        { label: "AIF 연결 설정", click: () => openSettings(BrowserWindow.getFocusedWindow() ?? undefined) },
        { label: "게시 대기 결과 다시 보내기", click: () => void flushNow() },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  installMenu();
  installBridge(APP_ORIGIN, () => config.load());
  let mode;
  try {
    mode = await ensureBackend();
  } catch (e) {
    console.error(String(e));
    app.exit(1);
    return;
  }
  const win = createWindow();
  await win.loadURL(new URL(startPath(), LANGFLOW_URL).toString());
  void flushNow();
  setInterval(() => void flushNow(), 5 * 60 * 1000);
  if (!PROBE && !config.isComplete()) openSettings(win);
  if (PROBE) {
    await (PROBE === "p3" || PROBE === "p3r" ? runP3(PROBE, win, mode) : PROBE === "p2b" ? probeP2b(win, mode) : PROBE === "p2" ? probeP2(win, mode) : PROBE === "p1" ? probeP1(win, mode) : probe(win, mode));
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
