// AIF 전용 중계(bridge). Langflow 화면 안의 AIF 화면은 같은 출처의 /aif-bridge/api/... 로 요청하고,
// 셸이 허용한 경로만 설정된 중앙 AIF 서버로 넘기며 검토용 토큰을 붙인다.
// - 임의 URL 프록시가 아니다: 대상 서버는 설정의 apiBase 하나, 경로·메서드는 아래 표에 있는 것만.
// - 토큰은 화면 코드·번들·Flow 에 들어가지 않는다. 쿠키는 넘기지 않는다.
// - 그 밖의 요청(Langflow 자체)은 그대로 통과시킨다.
const { net, protocol } = require("electron");
const FORWARD_HEADERS = ["content-type", "accept", "accept-language"];

const { PREFIX, allowed } = require("./bridge-rules");

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message, details: [] } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {string} appOrigin Langflow 화면 출처 (예: http://127.0.0.1:7870)
 * @param {() => {apiBase: string, reviewToken: string}} getConfig
 */
function installBridge(appOrigin, getConfig, session) {
  const target = session ? session.protocol : protocol;
  target.handle("http", async (request) => {
    const url = new URL(request.url);
    if (url.origin !== appOrigin || !url.pathname.startsWith(`${PREFIX}/`)) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    const apiPath = url.pathname.slice(PREFIX.length);
    if (!allowed(request.method, apiPath)) return jsonError(404, "BRIDGE_NOT_ALLOWED", "이 경로는 AIF 중계로 보낼 수 없습니다.");
    const config = getConfig();
    if (!config.apiBase || !config.reviewToken) {
      return jsonError(503, "BRIDGE_NOT_CONFIGURED", "AIF 서버 연결 설정이 없습니다. 메뉴의 'AIF 연결 설정'에서 입력하세요.");
    }
    const headers = { Authorization: `Bearer ${config.reviewToken}` };
    for (const name of FORWARD_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
    try {
      const response = await net.fetch(`${config.apiBase}${apiPath}${url.search}`, init);
      const out = new Headers();
      for (const name of ["content-type", "www-authenticate"]) {
        const value = response.headers.get(name);
        if (value) out.set(name, value);
      }
      return new Response(await response.arrayBuffer(), { status: response.status, headers: out });
    } catch (error) {
      return jsonError(502, "BRIDGE_UNREACHABLE", `AIF 서버에 연결하지 못했습니다: ${error.message}`);
    }
  });
}

module.exports = { installBridge };
