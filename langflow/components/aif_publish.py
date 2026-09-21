from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import httpx
from lfx.custom import Component
from lfx.io import IntInput, MessageTextInput, Output
from lfx.schema.message import Message

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
COMPONENT_VERSION = "aif-publish/1"
# 4xx 중 인증 문제는 토큰을 고친 뒤 다시 보낼 수 있으므로 outbox 에 남기고, 내용 문제는 failed/ 로 옮긴다.
KEEP_PENDING = (401, 403)


def outbox_dir() -> Path:
    configured = os.environ.get("AIF_OUTBOX_DIR", "").strip()
    return Path(configured) if configured else Path.home() / ".aif-langflow" / "outbox"


class AIFPublish(Component):
    display_name = "AIF Publish"
    description = (
        "Sends the final AIF JSON, the original judgment and the run context to the central AIF server and outputs "
        "the saved project. Analysis status and publish status are reported separately. Before sending, the request "
        "is written to a local outbox (without the token) so it can be re-sent after a network failure or an app "
        "restart; it is removed once the server confirms. Temporary failures are retried a limited number of times; "
        "authentication, validation and conflict errors are not retried."
    )
    icon = "UploadCloud"
    name = "AIFPublish"

    inputs = [
        MessageTextInput(name="final_graph", display_name="Final AIF JSON", required=True),
        MessageTextInput(name="run_context", display_name="Run Context", required=True),
        IntInput(name="retries", display_name="Retries", value=3, advanced=True),
        IntInput(name="timeout", display_name="Timeout (s)", value=60, advanced=True),
    ]

    outputs = [Output(display_name="Publish Result", name="publish_result", method="publish")]

    retry_delays = (1.0, 3.0, 9.0)

    @staticmethod
    def _text(value) -> str:
        text = getattr(value, "text", None)
        return str(text if text is not None else (value or ""))

    def _flow_source(self) -> dict:
        """Langflow 가 알려 주는 Flow ID·이름만 담는다. 알 수 없으면 비운다."""
        graph = getattr(self, "graph", None)
        flow_id = getattr(graph, "flow_id", None) or getattr(self, "flow_id", None)
        flow_name = getattr(graph, "flow_name", None) or getattr(self, "flow_name", None)
        source = {"kind": "langflow-desktop", "componentVersion": COMPONENT_VERSION}
        if flow_id:
            source["flowId"] = str(flow_id)
        if flow_name:
            source["flowName"] = str(flow_name)
        return source

    def post(self, url: str, body: dict, token: str) -> httpx.Response:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return httpx.post(url, json=body, headers=headers, timeout=float(self.timeout or 60))

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def send(self, url: str, body: dict) -> tuple[int | None, dict | None, str | None]:
        """(HTTP 상태, 응답 JSON, 오류 설명). 일시적 오류만 제한된 횟수로 다시 보낸다."""
        token = os.environ.get("AIF_PUBLISH_TOKEN", "")
        attempts = max(1, int(self.retries or 0) + 1)
        last_error = None
        for attempt in range(attempts):
            try:
                response = self.post(url, body, token)
            except httpx.HTTPError as error:
                last_error = f"{error.__class__.__name__}"
                status, data = None, None
            else:
                try:
                    data = response.json()
                except ValueError:
                    data = None
                status = response.status_code
                if status < 500 and status != 429:
                    return status, data, None
                last_error = f"HTTP {status}"
            if attempt + 1 < attempts:
                self.sleep(self.retry_delays[min(attempt, len(self.retry_delays) - 1)])
        return None, None, last_error

    def publish(self) -> Message:
        graph_text = self._text(self.final_graph).strip()
        match = _FENCE.match(graph_text)
        result = json.loads(match.group(1) if match else graph_text, strict=False)
        context = json.loads(self._text(self.run_context), strict=False)
        run_id = context["externalRunId"]
        analysis_status = result.get("status") or "ok"

        if analysis_status not in ("ok", "no_issues"):
            errors = result.get("errors") or []
            self.status = f"analysis {analysis_status}: not published"
            return Message(text=self.render({"analysisStatus": analysis_status, "publishStatus": "skipped", "externalRunId": run_id, "errors": errors[:10]}))

        body = {
            "schemaVersion": 1,
            "externalRunId": run_id,
            "source": self._flow_source(),
            "document": context["document"],
            "catalogs": context["catalogs"],
            "result": result,
        }
        url = f"{context['apiBase']}/api/integrations/langflow/results"
        pending = outbox_dir() / f"{run_id}.json"
        pending.parent.mkdir(parents=True, exist_ok=True)
        # 토큰은 넣지 않는다. 같은 실행 ID 의 재전송은 같은 본문이어야 서버가 같은 결과로 인정한다.
        if not pending.exists():
            pending.write_text(json.dumps({"url": url, "body": body}, ensure_ascii=False), encoding="utf-8")

        status, data, error = self.send(url, body)
        summary = {"analysisStatus": analysis_status, "externalRunId": run_id}
        if status in (200, 201):
            pending.unlink(missing_ok=True)
            summary.update(
                publishStatus="saved",
                duplicate=bool((data or {}).get("duplicate")),
                projectId=(data or {}).get("projectId"),
                runId=(data or {}).get("runId"),
                outcome=(data or {}).get("outcome"),
                viewerUrl=(data or {}).get("viewerUrl"),
            )
            self.status = f"saved: {summary['projectId']}"
        elif status is not None:
            message = ((data or {}).get("error") or {}).get("message") or f"HTTP {status}"
            code = ((data or {}).get("error") or {}).get("code")
            if status not in KEEP_PENDING:
                failed = pending.parent / "failed"
                failed.mkdir(exist_ok=True)
                if pending.exists():
                    pending.replace(failed / pending.name)
            summary.update(publishStatus="failed", httpStatus=status, code=code, error=message, retryable=status in KEEP_PENDING)
            self.status = f"publish failed: HTTP {status}"
        else:
            summary.update(publishStatus="failed", error=error, retryable=True, outbox=str(pending))
            self.status = f"publish failed: {error}"
        return Message(text=self.render(summary))

    @staticmethod
    def render(summary: dict) -> str:
        """사람이 읽는 요약 + 기계가 읽는 JSON. 링크는 이 실행의 프로젝트만 가리킨다."""
        lines = []
        state = summary.get("publishStatus")
        if state == "saved":
            label = "이미 저장된 결과" if summary.get("duplicate") else "저장됨"
            lines.append(f"**AIF 게시: {label}** (분석: {summary['analysisStatus']})")
            lines.append(f"[AIF 검토 화면에서 열기](/aif/projects/{summary['projectId']})")
        elif state == "skipped":
            lines.append(f"**AIF 게시 안 함**: 분석 결과가 {summary['analysisStatus']} 입니다.")
            lines.extend(f"- {error}" for error in summary.get("errors") or [])
        else:
            lines.append(f"**AIF 게시 실패** (분석: {summary['analysisStatus']}): {summary.get('error')}")
            if summary.get("retryable"):
                lines.append("분석 결과는 로컬 outbox 에 보관했습니다. 셸이 다음 시작 때 다시 보냅니다.")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(summary, ensure_ascii=False, indent=2))
        lines.append("```")
        return "\n".join(lines)
