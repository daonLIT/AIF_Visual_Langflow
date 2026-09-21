// 설치형 Desktop 의 Langflow 실행 환경.
// - 설치 파일에는 셸·포크 화면(langflow-frontend)·uv·잠금 파일만 들어 있다(공식 Desktop 과 같은 방식).
// - 처음 실행하거나 잠금 파일이 바뀌면(업데이트) uv 로 Python 3.13 과 Langflow 환경을 사용자 폴더에 설치한다.
//   잠금 파일은 공식 Langflow Desktop 1.11.0 의 환경을 해시까지 고정한 것이다(runtime/README.md).
// - Langflow 의 Flow·설정 DB 는 이 앱 전용 폴더(userData/langflow)에 둔다. 공식 Desktop 의 데이터와 섞이지 않고,
//   앱을 다시 설치·업데이트해도 남는다.
const { app } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

function resourcesDir() {
  // 설치본: <설치 폴더>/resources, 개발: 저장소의 빌드 산출물
  if (app.isPackaged) return process.resourcesPath;
  return path.resolve(__dirname, "build-resources");
}

function paths() {
  const home = process.env.AIF_DESKTOP_HOME || path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "com.aif.LangflowDesktop");
  const resources = resourcesDir();
  return {
    home,
    venv: path.join(home, "langflow-venv"),
    python: path.join(home, "python"),
    uvCache: path.join(home, "uv-cache"),
    marker: path.join(home, "langflow-venv", ".aif-runtime.json"),
    logs: path.join(app.getPath("userData"), "logs"),
    langflowData: path.join(app.getPath("userData"), "langflow"),
    uv: path.join(resources, "uv", "uv.exe"),
    lock: path.join(resources, "runtime", "requirements.lock.txt"),
    frontend: path.join(resources, "langflow-frontend"),
  };
}

function lockHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runtimeReady() {
  const p = paths();
  try {
    const marker = JSON.parse(fs.readFileSync(p.marker, "utf8"));
    return marker.lockSha256 === lockHash(p.lock) && fs.existsSync(path.join(p.venv, "Scripts", "langflow.exe"));
  } catch {
    return false;
  }
}

function run(command, args, env, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true });
    const feed = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => onLine(line));
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args[0]} 실패 (종료 코드 ${code})`))));
  });
}

/** Langflow 환경을 설치한다(이미 맞으면 건너뜀). onProgress(단계, 줄) */
async function ensureRuntime(onProgress) {
  const p = paths();
  if (runtimeReady()) return { installed: false };
  for (const required of [p.uv, p.lock, path.join(p.frontend, "index.html")]) {
    if (!fs.existsSync(required)) throw new Error(`설치 파일이 빠졌습니다: ${required}`);
  }
  fs.mkdirSync(p.home, { recursive: true });
  // 설치 창이 닫혀도 원인을 볼 수 있게 모든 줄을 파일에도 남긴다.
  fs.mkdirSync(p.logs, { recursive: true });
  const setupLog = path.join(p.logs, "runtime-setup.log");
  fs.writeFileSync(setupLog, `${new Date().toISOString()} runtime setup (app ${app.getVersion()}, home ${p.home})
`);
  const report = onProgress;
  onProgress = (stage, line) => {
    fs.appendFileSync(setupLog, `[${stage}] ${line}
`);
    report(stage, line);
  };
  const env = { UV_CACHE_DIR: p.uvCache, UV_PYTHON_INSTALL_DIR: p.python, UV_PYTHON_PREFERENCE: "only-managed", UV_NO_CONFIG: "1", UV_LINK_MODE: "copy" };
  const started = Date.now();
  onProgress("python", "Python 3.13 준비");
  await run(p.uv, ["python", "install", "3.13"], env, (line) => onProgress("python", line));
  onProgress("venv", "실행 환경 만들기");
  // 업데이트: 잠금 파일이 바뀌었으면 환경을 새로 만든다(이전 패키지가 섞이지 않게). Flow·설정은 userData 에 있어 지워지지 않는다.
  fs.rmSync(p.venv, { recursive: true, force: true });
  await run(p.uv, ["venv", "--python", "3.13", p.venv], env, (line) => onProgress("venv", line));
  onProgress("packages", "Langflow 1.11.0 패키지 설치 (처음에는 몇 분 걸립니다)");
  await run(
    p.uv,
    ["pip", "install", "--python", path.join(p.venv, "Scripts", "python.exe"), "--require-hashes", "--no-deps", "-r", p.lock],
    env,
    (line) => onProgress("packages", line),
  );
  fs.writeFileSync(
    p.marker,
    JSON.stringify({ lockSha256: lockHash(p.lock), installedAt: new Date().toISOString(), appVersion: app.getVersion(), seconds: Math.round((Date.now() - started) / 1000) }),
  );
  return { installed: true, seconds: Math.round((Date.now() - started) / 1000) };
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** 설치된 환경의 Langflow 를 포크 화면으로 띄운다. 로그는 userData/logs/langflow.log */
async function startLangflow(port, extraEnv) {
  const p = paths();
  if (!(await portFree(port))) throw new Error(`포트 ${port} 를 다른 프로그램이 쓰고 있습니다. AIF_LANGFLOW_PORT 로 다른 포트를 지정하세요.`);
  fs.mkdirSync(p.logs, { recursive: true });
  fs.mkdirSync(p.langflowData, { recursive: true });
  const logFile = path.join(p.logs, "langflow.log");
  try {
    if (fs.statSync(logFile).size > 10 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // 첫 실행
  }
  const log = fs.openSync(logFile, "a");
  const database = path.join(p.langflowData, "database.db").replace(/\\/g, "/");
  const child = spawn(
    path.join(p.venv, "Scripts", "langflow.exe"),
    ["run", "--host", "127.0.0.1", "--port", String(port), "--no-open-browser", "--frontend-path", p.frontend],
    {
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ...extraEnv,
        PYTHONUTF8: "1",
        LANGFLOW_CONFIG_DIR: path.join(p.langflowData, "config"),
        LANGFLOW_DATABASE_URL: `sqlite:///${database}`,
        LANGFLOW_AUTO_LOGIN: "true",
        // 이 앱은 버전을 고정한다. Langflow 자체 업데이트 알림·원격 로그는 끈다.
        LANGFLOW_DO_NOT_TRACK: "true",
      },
    },
  );
  return child;
}

module.exports = { paths, runtimeReady, ensureRuntime, startLangflow };
