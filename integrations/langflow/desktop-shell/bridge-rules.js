// 중계 허용 규칙(Electron 없이 테스트할 수 있게 분리). 표에 없는 메서드·경로는 중앙 서버로 넘기지 않는다.
const PREFIX = "/aif-bridge";
const ALLOWED = [
  ["GET", /^\/api\/health$/],
  ["GET", /^\/api\/catalogs\/(issues|schemes)$/],
  ["GET", /^\/api\/projects$/],
  ["GET", /^\/api\/projects\/[A-Za-z0-9_.-]{1,128}$/],
  ["PUT", /^\/api\/projects\/[A-Za-z0-9_.-]{1,128}$/],
  ["POST", /^\/api\/evidence\/verify$/],
];

function allowed(method, apiPath) {
  return ALLOWED.some(([m, pattern]) => m === method && pattern.test(apiPath));
}

module.exports = { PREFIX, ALLOWED, allowed };
