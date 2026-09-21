// 게시 대기 결과(outbox) 재전송. Flow 의 AIF Publish 가 네트워크 오류 등으로 보내지 못한 요청을
// 앱을 다시 켠 뒤·주기적으로 다시 보낸다. 파일에는 토큰이 없고, 보내는 주소는 파일의 url 이 아니라 설정된 apiBase 다.
// - 200/201: 저장됨(또는 이미 저장됨) → 파일 삭제
// - 401/403: 토큰 문제 → 남겨 두고 다음에 다시
// - 그 밖의 4xx: 내용 문제 → failed/ 로 옮김 (무한 재시도하지 않음)
// - 네트워크 오류·5xx: 남겨 두고 다음에 다시
const fs = require("node:fs");
const path = require("node:path");

async function flushOutbox(dir, config, fetchImpl = fetch) {
  const report = { sent: [], kept: [], failed: [] };
  if (!config.apiBase || !config.publishToken) return report;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return report;
  }
  for (const name of files) {
    const file = path.join(dir, name);
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      report.kept.push(name);
      continue;
    }
    let status = null;
    try {
      const response = await fetchImpl(`${config.apiBase}/api/integrations/langflow/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.publishToken}` },
        body: JSON.stringify(stored.body),
        signal: AbortSignal.timeout(60000),
      });
      status = response.status;
    } catch {
      status = null;
    }
    if (status === 200 || status === 201) {
      fs.rmSync(file, { force: true });
      report.sent.push(name);
    } else if (status !== null && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) {
      fs.mkdirSync(path.join(dir, "failed"), { recursive: true });
      fs.renameSync(file, path.join(dir, "failed", name));
      report.failed.push(name);
    } else {
      report.kept.push(name);
    }
  }
  return report;
}

module.exports = { flushOutbox };
