from __future__ import annotations

import json

from lfx.custom import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.message import Message


class JudgmentSplitter(Component):
    display_name = "Judgment Splitter"
    description = (
        "Splits the relay-server input JSON {case_id, judgment, issue_catalog, scheme_catalog, catalog versions} "
        "into separate messages. Plain text input is treated as the judgment with empty catalogs."
    )
    icon = "Split"
    name = "JudgmentSplitter"

    inputs = [
        MessageTextInput(
            name="payload",
            display_name="Input JSON",
            info="JSON text from the relay server: {case_id, judgment, issue_catalog, issue_catalog_version, scheme_catalog, scheme_catalog_version}",
            required=True,
        ),
    ]

    outputs = [
        Output(display_name="Judgment", name="judgment", method="build_judgment", group_outputs=True),
        Output(display_name="Issue Catalog", name="issue_catalog", method="build_issue_catalog", group_outputs=True),
        Output(display_name="Scheme Catalog", name="scheme_catalog", method="build_scheme_catalog", group_outputs=True),
        Output(display_name="Catalog Versions", name="catalog_versions", method="build_catalog_versions", group_outputs=True),
        Output(display_name="Case ID", name="case_id", method="build_case_id", group_outputs=True),
    ]

    def _payload(self) -> dict:
        raw = getattr(self.payload, "text", None)
        text = str(raw if raw is not None else (self.payload or ""))
        stripped = text.strip()
        if stripped.startswith("{"):
            try:
                # Langflow 가 tweak 값의 \n 이스케이프를 실제 줄바꿈으로 바꿔 전달하는 경우가 있어 문자열 안의 제어 문자를 허용한다.
                value = json.loads(stripped, strict=False)
            except ValueError:
                value = None
            if isinstance(value, dict) and isinstance(value.get("judgment"), str):
                return value
        return {"case_id": "", "judgment": text, "issue_catalog": [], "scheme_catalog": []}

    def build_judgment(self) -> Message:
        # 원문 문자·공백·줄바꿈을 그대로 전달한다 (근거 인용 매칭 정확도).
        return Message(text=self._payload().get("judgment") or "")

    def build_issue_catalog(self) -> Message:
        items = self._payload().get("issue_catalog") or []
        lines = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict) or not item.get("issueId"):
                continue
            lines.append(
                json.dumps(
                    {
                        "issue_id": str(item.get("issueId")),
                        "category": str(item.get("categoryName") or ""),
                        "label": str(item.get("label") or ""),
                        "criteria": str(item.get("criteria") or ""),
                    },
                    ensure_ascii=False,
                )
            )
        self.status = f"{len(lines)} catalog issues"
        return Message(text="\n".join(lines))

    def build_scheme_catalog(self) -> Message:
        items = self._payload().get("scheme_catalog") or []
        lines = [json.dumps(item, ensure_ascii=False) for item in items if isinstance(item, dict) and item.get("schemeKey")]
        return Message(text="\n".join(lines))

    def build_catalog_versions(self) -> Message:
        payload = self._payload()
        return Message(
            text=json.dumps(
                {"issue": payload.get("issue_catalog_version"), "scheme": payload.get("scheme_catalog_version")},
                ensure_ascii=False,
            )
        )

    def build_case_id(self) -> Message:
        return Message(text=str(self._payload().get("case_id") or ""))
