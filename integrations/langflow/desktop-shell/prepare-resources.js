// 설치 파일에 넣을 자원을 build-resources/ 에 모은다(npm run dist 전에 자동 실행).
//   uv/uv.exe                 고정 버전 uv (GitHub 릴리스, sha256 확인)
//   runtime/requirements.lock.txt   Langflow 실행 환경 잠금 파일 (../runtime)
//   langflow-frontend/        포크 화면 빌드 (../build-fork.ps1 결과)
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UV_VERSION = "0.11.29";
const UV_ASSET = "uv-x86_64-pc-windows-msvc.zip";
const OUT = path.join(__dirname, "build-resources");
const REPO = path.resolve(__dirname, "..", "..", "..");
const FRONTEND = path.join(REPO, "vendor", "langflow-fork", "src", "frontend", "build");
const LOCK = path.join(__dirname, "..", "runtime", "requirements.lock.txt");

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function prepareUv() {
  const target = path.join(OUT, "uv", "uv.exe");
  const stamp = path.join(OUT, "uv", "VERSION");
  if (fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === UV_VERSION) return;
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  const zip = await download(`${base}/${UV_ASSET}`);
  const expected = (await download(`${base}/${UV_ASSET}.sha256`)).toString("utf8").trim().split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(zip).digest("hex");
  if (actual !== expected) throw new Error(`uv sha256 불일치: ${actual} / ${expected}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aif-uv-"));
  const zipPath = path.join(temp, UV_ASSET);
  fs.writeFileSync(zipPath, zip);
  // Windows 내장 bsdtar 는 zip 을 푼다(Git Bash 의 GNU tar 는 C: 를 원격 호스트로 읽으므로 경로를 지정한다).
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", zipPath, "-C", temp]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(temp, "uv.exe"), target);
  fs.writeFileSync(stamp, `${UV_VERSION}\n`);
  fs.rmSync(temp, { recursive: true, force: true });
}

function prepareFrontend() {
  if (!fs.existsSync(path.join(FRONTEND, "index.html"))) {
    throw new Error(`포크 빌드가 없습니다: ${FRONTEND}\n  powershell -ExecutionPolicy Bypass -File integrations\\langflow\\build-fork.ps1`);
  }
  const target = path.join(OUT, "langflow-frontend");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(FRONTEND, target, { recursive: true });
}

function prepareRuntime() {
  const target = path.join(OUT, "runtime");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(LOCK, path.join(target, "requirements.lock.txt"));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await prepareUv();
  prepareRuntime();
  prepareFrontend();
  const mark = fs.existsSync(path.join(FRONTEND, "aif-build-mark.txt")) ? fs.readFileSync(path.join(FRONTEND, "aif-build-mark.txt"), "utf8").trim() : "(표식 없음)";
  console.log(`build-resources 준비: uv ${UV_VERSION}, 잠금 파일, 포크 화면 ${mark}`);
})().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});
