// AIF 연결 설정. 토큰은 Electron safeStorage(Windows DPAPI)로 암호화해 사용자 데이터 폴더에 둔다.
// 화면(renderer)에는 토큰을 넘기지 않는다. 환경변수(AIF_API_BASE, AIF_REVIEW_TOKEN, AIF_PUBLISH_TOKEN, AIF_SITE_URL)가 있으면
// 개발·자동 점검용으로 그 값을 우선한다.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const FILE = () => path.join(app.getPath("userData"), "aif-config.json");

function normalizeUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  const url = new URL(text);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("주소는 https 여야 합니다(개발용 localhost 만 http 허용).");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return {};
  }
}

function decrypt(value) {
  if (!value) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

function load() {
  const stored = readFile();
  return {
    apiBase: process.env.AIF_API_BASE || stored.apiBase || "",
    siteUrl: process.env.AIF_SITE_URL || stored.siteUrl || "",
    reviewToken: process.env.AIF_REVIEW_TOKEN || decrypt(stored.reviewToken),
    publishToken: process.env.AIF_PUBLISH_TOKEN || decrypt(stored.publishToken),
  };
}

/** 화면에 보여 줄 수 있는 요약(토큰 값 없음) */
function summary() {
  const config = load();
  return {
    apiBase: config.apiBase,
    siteUrl: config.siteUrl,
    reviewTokenSet: Boolean(config.reviewToken),
    publishTokenSet: Boolean(config.publishToken),
    encryption: safeStorage.isEncryptionAvailable(),
  };
}

/** 빈 토큰 칸은 기존 값을 유지한다. */
function save(input) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("이 PC 에서 암호화 저장소를 쓸 수 없어 토큰을 저장하지 않았습니다.");
  const stored = readFile();
  const next = {
    ...stored,
    apiBase: normalizeUrl(input.apiBase),
    siteUrl: input.siteUrl ? normalizeUrl(input.siteUrl) : "",
  };
  for (const key of ["reviewToken", "publishToken"]) {
    const value = String(input[key] || "").trim();
    if (value) next[key] = safeStorage.encryptString(value).toString("base64");
  }
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return summary();
}

function isComplete() {
  const config = load();
  return Boolean(config.apiBase && config.reviewToken && config.publishToken);
}

module.exports = { load, save, summary, isComplete, normalizeUrl };
