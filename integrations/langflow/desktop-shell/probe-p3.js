// P3 자동 점검: Desktop 안 검토(수락·거절·수정·근거 연결·저장) → 웹(로그인) 확인 → 동시 수정 409 → 재시작 복원(p3r).
// 점검용 프로젝트는 실제 v11 실행 결과 fixture 를 중앙 서버에 게시해 만든다(LLM 을 다시 돌리지 않음).
const { BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");

async function publishFixture(central) {
  const live = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "fixtures", "langflow_run_response.live_v11.json"), "utf8"));
  const output = live.outputs[0].outputs[0].results.message.text;
  // Langflow 1.11 은 입력 JSON 문자열 안의 \n 이스케이프를 실제 줄바꿈으로 바꿔 둔다(한 줄 JSON 이라 제어 문자를 되돌리면 된다).
  const raw = live.outputs[0].inputs.input_value.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const judgment = JSON.parse(raw).judgment;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${central.publishToken}` };
  const context = await (await fetch(`${central.apiBase}/api/integrations/langflow/context`, { headers })).json();
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const body = {
    schemaVersion: 1,
    externalRunId: `p3-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
    source: { kind: "langflow-desktop", componentVersion: "p3-probe" },
    document: { text: judgment, caseId: `P3-${stamp}`, title: `P3 검토 점검 ${stamp}` },
    catalogs: {
      issueCatalogVersion: context.issueCatalogVersion,
      issueCatalogSha256: context.issueCatalogSha256,
      schemeCatalogVersion: context.schemeCatalogVersion,
      schemeCatalogSha256: context.schemeCatalogSha256,
    },
    result: JSON.parse(output),
  };
  const response = await fetch(`${central.apiBase}/api/integrations/langflow/results`, { method: "POST", headers, body: JSON.stringify(body) });
  if (response.status !== 201) throw new Error(`게시 실패 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json()).projectId;
}

async function centralProject(central, projectId) {
  const response = await fetch(`${central.apiBase}/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${central.reviewToken}` } });
  return response.json();
}

function summarize(project) {
  const by = (status) => project.annotations.filter((a) => a.status === status).length;
  return {
    revision: project.revision,
    pending: by("pending"),
    accepted: by("accepted"),
    modified: by("modified"),
    rejected: by("rejected"),
    manualEvidence: project.annotations.filter((a) => (a.evidence || []).some((e) => e.match === "manual")).length,
    acceptedNodes: project.acceptedGraph.AIF.nodes.length,
  };
}

// 페이지 안에서 쓰는 도우미(카드 찾기·버튼 누르기·입력 값 넣기)
const PAGE_HELPERS = `
window.__aif = {
  cards: (status) => [...document.querySelectorAll('.aif-root li.annotation-card' + (status ? '.is-' + status : ''))],
  counts: () => document.querySelector('.aif-root .annotation-counts')?.innerText.replace(/\\s+/g, ' ') ?? '',
  click: (el) => { el.scrollIntoView({ block: 'center' }); el.click(); },
  setValue: (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
};
true;
`;

async function reviewSteps(tools, win, central, projectId, outDir) {
  const { js, sleep, waitFor, step } = tools;
  const shot = async (name) => {
    await sleep(1000);
    fs.writeFileSync(path.join(outDir, `p3-${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const waitSaved = async (revision) => {
    for (let i = 0; i < 40; i++) {
      const project = await centralProject(central, projectId);
      if (project.revision === revision) return project;
      await sleep(500);
    }
    throw new Error(`서버 revision ${revision} 이 되지 않음`);
  };

  await step("Desktop 에서 프로젝트 열기", async () => {
    await win.loadURL(new URL(`/aif/projects/${projectId}`, tools.LANGFLOW_URL).toString());
    if (!(await waitFor(`[data-loaded-project="${projectId}"]`, 30000))) throw new Error("로드 안 됨");
    await js(PAGE_HELPERS);
    return await js("__aif.counts()");
  });
  let edited = null;
  await step("수락 · 거절 · 수정 후 수락 · 수동 근거 연결", async () => {
    await js(PAGE_HELPERS);
    // 1) 첫 미검토 노드 카드 수락(필요한 노드 포함)
    await js(`(() => { const card = __aif.cards('pending').find((c) => c.querySelector('[data-action="accept"]') && !c.classList.contains('is-edge')); __aif.click(card.querySelector('[data-action="accept"]')); })()`);
    await sleep(500);
    // 2) 다음 미검토 카드 거절
    await js(`__aif.click(__aif.cards('pending')[0].querySelector('[data-action="reject"]'))`);
    await sleep(500);
    // 3) 미검토 노드 하나를 고쳐서 수락
    const editId = await js(`(() => {
      const card = __aif.cards('pending').find((c) => c.querySelector('[data-action="accept-edited"]'));
      __aif.click(card.querySelector('[data-action="accept-edited"]'));
      return card.dataset.annotationId;
    })()`);
    // 편집창은 다음 렌더에서 나타난다.
    if (!(await waitFor(`[data-annotation-id="${editId}"] textarea`, 5000))) throw new Error("편집창이 열리지 않음");
    edited = await js(`(() => {
      const area = document.querySelector('[data-annotation-id="${editId}"] textarea');
      const text = 'P3 수정: ' + area.value.slice(0, 40);
      __aif.setValue(area, text);
      return { id: ${JSON.stringify(editId)}, text };
    })()`);
    await sleep(300);
    await js(`__aif.click(document.querySelector('[data-annotation-id="${edited.id}"] [data-action="accept-edited-confirm"]'))`);
    await sleep(500);
    // 4) 미검토 노드 카드를 골라 원문 일부를 근거로 연결
    const linked = await js(`(() => {
      const card = __aif.cards('pending').find((c) => !c.classList.contains('is-edge'));
      __aif.click(card.querySelector('.annotation-card-main'));
      return card.dataset.annotationId;
    })()`);
    await sleep(400);
    const selected = await js(`(() => {
      const root = document.querySelector('.aif-root .judgment-text');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && node.textContent.trim().length < 12) {}
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(12, node.textContent.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return selection.toString();
    })()`);
    await sleep(300);
    const clicked = await js(`(() => { const b = document.querySelector('.aif-root .selection-action.is-secondary'); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) throw new Error("근거 연결 버튼 없음");
    await sleep(300);
    await shot("desktop-reviewed");
    return { counts: await js("__aif.counts()"), edited, linked, selected };
  });
  let afterDesktop = null;
  await step("Desktop 저장 → 서버 revision 2", async () => {
    await js(`__aif.click(document.querySelector('[data-action="project-menu"]'))`);
    await sleep(200);
    await js(`__aif.click(document.querySelector('[data-action="save-server"]'))`);
    const project = await waitSaved(2);
    afterDesktop = summarize(project);
    const editedValue = project.annotations.find((a) => a.id === edited.id)?.currentValue?.text;
    if (editedValue !== edited.text) throw new Error("수정한 본문이 저장되지 않음");
    if (!afterDesktop.accepted || !afterDesktop.rejected || !afterDesktop.modified || !afterDesktop.manualEvidence) {
      throw new Error(`저장된 상태가 부족함 ${JSON.stringify(afterDesktop)}`);
    }
    return { ...afterDesktop, desktopCounts: await js("__aif.counts()") };
  });
  return afterDesktop;
}

async function webSteps(tools, central, projectId, webUrl, credentials, outDir, expected) {
  const { sleep, step } = tools;
  // 새 파티션: 쿠키·저장소가 비어 있고, 셸의 AIF 중계도 거치지 않는 보통 브라우저와 같은 조건
  const web = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    title: "web check",
    webPreferences: { partition: `webcheck-${Date.now()}`, contextIsolation: true, sandbox: true },
  });
  const wjs = (code) => web.webContents.executeJavaScript(code, true);
  const wwait = async (selector, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await wjs(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await sleep(300);
    }
    return false;
  };
  const wshot = async (name) => {
    await sleep(1000);
    fs.writeFileSync(path.join(outDir, `p3-${name}.png`), (await web.webContents.capturePage()).toPNG());
  };
  let webCounts = null;
  await step("웹: ?projectId= 직접 접근 → 로그인 → 원래 프로젝트로 복귀", async () => {
    await web.loadURL(`${webUrl}/?projectId=${projectId}`);
    if (!(await wwait('[data-testid="aif-login"]'))) throw new Error("로그인 화면이 나오지 않음");
    await wjs(PAGE_HELPERS);
    await wjs(`__aif.setValue(document.querySelector('input[name="username"]'), ${JSON.stringify(credentials.username)})`);
    await wjs(`__aif.setValue(document.querySelector('input[name="password"]'), ${JSON.stringify(credentials.password)})`);
    await wjs(`document.querySelector('.login-card button[type="submit"]').click()`);
    if (!(await wwait(`[data-loaded-project="${projectId}"]`, 30000))) throw new Error("로그인 뒤 프로젝트가 열리지 않음");
    await wjs(PAGE_HELPERS);
    webCounts = await wjs("__aif.counts()");
    const url = await wjs("location.search");
    // 검토 권한만 있는 계정: 파이프라인 탭·사이트 분석 버튼이 보이지 않아야 한다.
    const hidden = await wjs(`({ pipelineTab: !!document.querySelector('[data-view="pipeline"]'), analysis: !!document.querySelector('.aif-root .analysis-status') })`);
    await wshot("web-review");
    if (hidden.pipelineTab || hidden.analysis) throw new Error(`권한 없는 기능이 보임 ${JSON.stringify(hidden)}`);
    return { url, webCounts, hidden, expected };
  });
  await step("웹: 새로고침해도 유지(쿠키 세션)", async () => {
    web.webContents.reload();
    await new Promise((resolve) => web.webContents.once("did-finish-load", resolve));
    if (!(await wwait(`[data-loaded-project="${projectId}"]`, 30000))) throw new Error("새로고침 뒤 로드 안 됨");
    await wjs(PAGE_HELPERS);
    return await wjs("__aif.counts()");
  });
  return { web, wjs, wwait, webCounts };
}

/** p3: Desktop 검토 → 웹 확인 → 동시 수정 409. 결과와 복원 점검(p3r)용 기대값을 남긴다. */
async function probeP3(ctx, win, mode) {
  const tools = { ...ctx.probeTools(win), LANGFLOW_URL: ctx.LANGFLOW_URL };
  const { js, sleep, step, steps } = tools;
  const central = ctx.config.load();
  const outDir = path.dirname(process.env.AIF_SHELL_PROBE_OUT || path.join(ctx.app.getPath("userData"), "p3-probe.json"));
  const credentials = { username: process.env.AIF_P3_WEB_USER || "", password: process.env.AIF_P3_WEB_PASSWORD || "" };
  const webUrl = process.env.AIF_P3_WEB_URL || "http://localhost:5173";
  let projectId = null;
  await step("점검용 프로젝트 게시 (실제 v11 결과 fixture)", async () => (projectId = await publishFixture(central)));
  const afterDesktop = await reviewSteps(tools, win, central, projectId, outDir);
  const web = await webSteps(tools, central, projectId, webUrl, credentials, outDir, afterDesktop);

  await step("동시 수정: 웹이 먼저 저장(rev 3) → Desktop 저장은 409, 편집 유지", async () => {
    // 웹: 미검토 하나 거절 후 저장
    await web.wjs(`__aif.click(__aif.cards('pending')[0].querySelector('[data-action="reject"]'))`);
    await sleep(300);
    await web.wjs(`__aif.click(document.querySelector('[data-action="project-menu"]'))`);
    await sleep(200);
    await web.wjs(`__aif.click(document.querySelector('[data-action="save-server"]'))`);
    for (let i = 0; i < 40 && (await centralProject(central, projectId)).revision !== 3; i++) await sleep(500);
    // Desktop(아직 rev 2 기준): 다른 미검토 하나를 수락하고 저장
    await js(PAGE_HELPERS);
    const desktopEdit = await js(`(() => { const card = __aif.cards('pending').find((c) => c.querySelector('[data-action="accept"]') && !c.classList.contains('is-edge')); __aif.click(card.querySelector('[data-action="accept"]')); return card.dataset.annotationId; })()`);
    await sleep(400);
    const before = await js("__aif.counts()");
    await js(`__aif.click(document.querySelector('[data-action="project-menu"]'))`);
    await sleep(200);
    await js(`__aif.click(document.querySelector('[data-action="save-server"]'))`);
    if (!(await tools.waitFor('[data-testid="aif-save-conflict"]', 15000))) throw new Error("충돌 배너가 나오지 않음");
    const after = await js("__aif.counts()");
    const server = summarize(await centralProject(central, projectId));
    const stillMine = await js(`!document.querySelector('[data-annotation-id="${desktopEdit}"]').classList.contains('is-pending')`);
    fs.writeFileSync(path.join(outDir, "p3-conflict.png"), (await win.webContents.capturePage()).toPNG());
    if (before !== after || !stillMine) throw new Error("충돌 뒤 화면 편집이 바뀜");
    if (server.revision !== 3) throw new Error(`서버 revision ${server.revision}`);
    return { before, after, editPreserved: stillMine, serverRevision: server.revision };
  });
  let expected = null;
  await step("[서버 최신본 불러오기] → 웹 변경 반영(rev 3)", async () => {
    await js(`window.confirm = () => true; document.querySelector('[data-action="conflict-reload"]').click()`);
    for (let i = 0; i < 40 && (await js(`!!document.querySelector('[data-testid="aif-save-conflict"]')`)); i++) await sleep(300);
    await sleep(800);
    await js(PAGE_HELPERS);
    const counts = await js("__aif.counts()");
    const webNow = await web.wjs("__aif.counts()");
    expected = { projectId, counts };
    if (counts !== webNow) throw new Error(`Desktop ${counts} / 웹 ${webNow}`);
    return { desktop: counts, web: webNow, server: summarize(await centralProject(central, projectId)) };
  });
  fs.writeFileSync(path.join(outDir, "p3-expected.json"), JSON.stringify(expected));
  web.web.destroy();
  ctx.writeProbe("p3", mode, steps);
}

/** p3r: 셸을 다시 켰을 때 마지막 화면(검토 중이던 프로젝트)과 저장된 상태가 그대로 열리는지. */
async function probeP3Restore(ctx, win, mode) {
  const tools = ctx.probeTools(win);
  const { js, waitFor, step, steps } = tools;
  const outDir = path.dirname(process.env.AIF_SHELL_PROBE_OUT || path.join(ctx.app.getPath("userData"), "p3r-probe.json"));
  const expected = JSON.parse(fs.readFileSync(path.join(outDir, "p3-expected.json"), "utf8"));
  await step("재시작 → 마지막 화면 복원", async () => {
    if (!(await waitFor(`[data-loaded-project="${expected.projectId}"]`, 60000))) throw new Error(`복원 안 됨 (${await js("location.pathname")})`);
    await js(PAGE_HELPERS);
    const counts = await js("__aif.counts()");
    if (counts !== expected.counts) throw new Error(`개수 다름: ${counts} / ${expected.counts}`);
    return { path: await js("location.pathname"), counts };
  });
  ctx.writeProbe("p3r", mode, steps);
}

module.exports = { probeP3, probeP3Restore };
