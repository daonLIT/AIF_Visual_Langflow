from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone

import httpx
from lfx.custom import Component
from lfx.io import IntInput, MessageTextInput, Output, StrInput
from lfx.schema.message import Message


class AIFRunContext(Component):
    display_name = "AIF Run Context"
    description = (
        "Starts a Desktop analysis run: reads the issue and scheme catalogues from the central AIF server, pins their "
        "versions and hashes, and creates the external run ID that the publish step sends. Fails loudly when the "
        "catalogues cannot be read (it never analyses with empty catalogues). The access token is read from the "
        "AIF_PUBLISH_TOKEN environment variable and is never written into the flow or its outputs."
    )
    icon = "PlayCircle"
    name = "AIFRunContext"

    inputs = [
        MessageTextInput(name="judgment", display_name="Judgment", info="판결문 원문. 공백·줄바꿈을 그대로 보존한다.", required=True),
        StrInput(name="case_id", display_name="Case ID", value="", advanced=False),
        StrInput(name="title", display_name="Title", value="", advanced=False),
        StrInput(
            name="api_base",
            display_name="AIF API base URL",
            value="",
            info="중앙 AIF 서버 주소 (예: https://aif.example.org). 비우면 환경변수 AIF_API_BASE.",
            advanced=True,
        ),
        IntInput(name="timeout", display_name="Timeout (s)", value=30, advanced=True),
    ]

    outputs = [
        Output(display_name="Splitter Input", name="payload", method="build_payload", group_outputs=True),
        Output(display_name="Run Context", name="context", method="build_context", group_outputs=True),
    ]

    @staticmethod
    def _text(value) -> str:
        text = getattr(value, "text", None)
        return str(text if text is not None else (value or ""))

    def resolved_base(self) -> str:
        # 입력값은 Langflow 가 같은 이름의 속성(self.api_base)으로 넣는다.
        return (self._text(getattr(self, "api_base", "")) or os.environ.get("AIF_API_BASE", "")).strip().rstrip("/")

    def fetch_context(self, base: str) -> dict:
        token = os.environ.get("AIF_PUBLISH_TOKEN", "")
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            response = httpx.get(f"{base}/api/integrations/langflow/context", headers=headers, timeout=float(self.timeout or 30))
        except httpx.HTTPError as error:
            raise ValueError(f"AIF 서버에서 카탈로그를 읽지 못했습니다 ({base}): {error.__class__.__name__}") from error
        if response.status_code != 200:
            try:
                message = response.json().get("error", {}).get("message", "")
            except ValueError:
                message = ""
            raise ValueError(f"AIF 서버가 카탈로그 요청을 거절했습니다: HTTP {response.status_code} {message}".strip())
        context = response.json()
        if not context.get("issueCatalog") or not context.get("schemeCatalog"):
            raise ValueError("AIF 서버가 빈 카탈로그를 돌려주었습니다. 빈 카탈로그로는 분석하지 않습니다.")
        return context

    def _run(self) -> dict:
        # 두 출력이 같은 실행 ID·카탈로그를 쓰도록 한 번만 만든다.
        cached = getattr(self, "_aif_run", None)
        if cached is not None:
            return cached
        judgment = self._text(self.judgment)
        if not judgment.strip():
            raise ValueError("판결문 원문이 비어 있습니다.")
        base = self.resolved_base()
        if not base:
            raise ValueError("AIF 서버 주소가 없습니다. 'AIF API base URL' 또는 환경변수 AIF_API_BASE 를 설정하세요.")
        context = self.fetch_context(base)
        run = {
            "externalRunId": f"lfd-{uuid.uuid4().hex}",
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "apiBase": base,
            "document": {
                "text": judgment,
                "caseId": self._text(self.case_id).strip() or None,
                "title": self._text(self.title).strip() or None,
            },
            "catalogs": {
                "issueCatalogVersion": context["issueCatalogVersion"],
                "issueCatalogSha256": context["issueCatalogSha256"],
                "schemeCatalogVersion": context["schemeCatalogVersion"],
                "schemeCatalogSha256": context["schemeCatalogSha256"],
            },
            "splitter": {
                "case_id": self._text(self.case_id).strip(),
                "judgment": judgment,
                "issue_catalog": context["issueCatalog"],
                "issue_catalog_version": context["issueCatalogVersion"],
                "scheme_catalog": context["schemeCatalog"],
                "scheme_catalog_version": context["schemeCatalogVersion"],
            },
        }
        self._aif_run = run
        self.status = f"run {run['externalRunId']} · issue catalog v{context['issueCatalogVersion']} · scheme v{context['schemeCatalogVersion']}"
        return run

    def build_payload(self) -> Message:
        return Message(text=json.dumps(self._run()["splitter"], ensure_ascii=False))

    def build_context(self) -> Message:
        run = self._run()
        return Message(text=json.dumps({k: v for k, v in run.items() if k != "splitter"}, ensure_ascii=False))
