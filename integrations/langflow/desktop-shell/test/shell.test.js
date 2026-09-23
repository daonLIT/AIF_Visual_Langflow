// 셸의 순수 로직 테스트 (Electron 없이): node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { allowed } = require("../bridge-rules");
const { flushOutbox } = require("../outbox");

test("bridge forwards only the review API", () => {
  assert.ok(allowed("GET", "/api/projects"));
  assert.ok(allowed("GET", "/api/projects/project-abc_1.2"));
  assert.ok(allowed("PUT", "/api/projects/project-abc"));
  assert.ok(allowed("GET", "/api/catalogs/schemes"));
  assert.ok(allowed("POST", "/api/evidence/verify"));
  // 그래프 화면에서 직접 만든 scheme
  assert.ok(allowed("POST", "/api/catalogs/schemes/custom"));
  assert.ok(allowed("PUT", "/api/catalogs/schemes/custom/custom-ab12cd34"));
  for (const [method, p] of [
    ["POST", "/api/integrations/langflow/results"], // 게시는 Flow(게시 토큰)만
    ["DELETE", "/api/catalogs/schemes/custom/custom-ab12cd34"], // 지우기는 없다(폐기로만)
    ["PUT", "/api/catalogs/schemes/custom/witness_testimony"], // 정본 scheme 은 바꿀 수 없다
    ["PUT", "/api/catalogs/schemes/custom/custom-XYZ"],
    ["DELETE", "/api/projects/x"],
    ["GET", "/api/pipelines"],
    ["POST", "/api/analysis-runs"],
    ["GET", "/api/projects/../pipelines"],
    ["GET", "/api/projects/a/b"],
    ["GET", "http://evil.example/api/projects"],
  ]) {
    assert.equal(allowed(method, p), false, `${method} ${p}`);
  }
});

function outbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-outbox-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ url: "http://attacker.example/steal", body }));
  }
  return dir;
}

test("outbox: saved → removed, conflict → failed/, auth/network → kept; uses configured apiBase only", async () => {
  const dir = outbox({ "a.json": { id: "a" }, "b.json": { id: "b" }, "c.json": { id: "c" }, "d.json": { id: "d" } });
  const seen = [];
  const statuses = { a: 201, b: 409, c: 401 };
  const fakeFetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    const id = JSON.parse(init.body).id;
    if (id === "d") throw new Error("offline");
    return { status: statuses[id] };
  };
  const report = await flushOutbox(dir, { apiBase: "https://aif.example.org", publishToken: "tok" }, fakeFetch);
  assert.deepEqual(report.sent, ["a.json"]);
  assert.deepEqual(report.failed, ["b.json"]);
  assert.deepEqual(report.kept.sort(), ["c.json", "d.json"]);
  assert.ok(seen.every((call) => call.url === "https://aif.example.org/api/integrations/langflow/results"));
  assert.ok(seen.every((call) => call.auth === "Bearer tok"));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(), ["c.json", "d.json"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "failed")), ["b.json"]);
});

test("outbox: nothing is sent without configuration", async () => {
  const dir = outbox({ "a.json": { id: "a" } });
  let called = false;
  const report = await flushOutbox(dir, { apiBase: "", publishToken: "" }, async () => {
    called = true;
  });
  assert.equal(called, false);
  assert.deepEqual(report, { sent: [], kept: [], failed: [] });
});
