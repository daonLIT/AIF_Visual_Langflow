const $ = (id) => document.getElementById(id);

function show(summary) {
  $("apiBase").value = summary.apiBase || "";
  $("siteUrl").value = summary.siteUrl || "";
  $("reviewHint").textContent = summary.reviewTokenSet ? "저장됨. 바꿀 때만 입력하세요." : "아직 없습니다.";
  $("publishHint").textContent = summary.publishTokenSet ? "저장됨. 바꿀 때만 입력하세요." : "아직 없습니다.";
  if (!summary.encryption) {
    $("status").className = "error";
    $("status").textContent = "이 PC 에서 암호화 저장소를 쓸 수 없어 토큰을 저장할 수 없습니다.";
  }
}

window.aifSettings.get().then(show);

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("status").className = "";
  $("status").textContent = "저장 중…";
  try {
    const summary = await window.aifSettings.save({
      apiBase: $("apiBase").value,
      siteUrl: $("siteUrl").value,
      reviewToken: $("reviewToken").value,
      publishToken: $("publishToken").value,
    });
    $("reviewToken").value = "";
    $("publishToken").value = "";
    show(summary);
    $("status").className = "ok";
    $("status").textContent = "저장했습니다. Flow 게시 토큰은 Langflow 를 다시 시작하면 적용됩니다.";
  } catch (error) {
    $("status").className = "error";
    $("status").textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  }
});

$("close").addEventListener("click", () => window.close());
