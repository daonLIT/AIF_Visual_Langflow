const STEPS = { python: "1/3 Python 준비", venv: "2/3 실행 환경 만들기", packages: "3/3 Langflow 패키지 설치", done: "완료", error: "실패" };
const log = document.getElementById("log");
const step = document.getElementById("step");
const lines = [];

window.aifSetup.onProgress(({ stage, line }) => {
  step.textContent = STEPS[stage] ?? stage;
  step.className = stage === "error" ? "error" : "";
  lines.push(line);
  if (lines.length > 400) lines.splice(0, lines.length - 400);
  log.textContent = lines.join("\n");
  log.scrollTop = log.scrollHeight;
});
