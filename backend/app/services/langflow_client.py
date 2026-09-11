"""
Langflow REST API 호출과 응답 envelope 해석.

- 입력은 커스텀 입력 컴포넌트의 `value` 필드에 tweaks 로 전달한다.
  현재 flow 의 입력 컴포넌트는 `{"case_id": ..., "judgment": ...}` 형태의 JSON 문자열을 기대한다.
- 출력은 명시된 출력 컴포넌트(ChatOutput)의 Message 텍스트만 사용한다. 임의의 첫 텍스트를 고르지 않는다.
- 실제 응답 envelope 는 버전에 따라 다를 수 있어 알려진 형태를 순서대로 시도하고,
  어느 것도 맞지 않으면 원인을 설명하는 오류를 낸다.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx

from ..config import Settings


class LangflowError(Exception):
    """사용자에게 보여줄 수 있는 오류. code 는 UI/로그용 분류 코드."""

    def __init__(self, code: str, message: str, *, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass
class LangflowResult:
    output_text: str
    session_id: str | None
    component_id: str | None
    raw_envelope: dict


def build_input_value(judgment_text: str, case_id: str | None) -> str:
    return json.dumps({"case_id": case_id or "", "judgment": judgment_text}, ensure_ascii=False)


def build_run_payload(settings: Settings, judgment_text: str, case_id: str | None) -> dict:
    """
    Langflow v1 run 요청 본문. 커스텀 입력 컴포넌트에는 tweaks 로 값을 넣는다.
    input_value 도 함께 보내지만(일부 버전은 필수) 실제 입력 경로는 tweaks 이다.
    """
    value = build_input_value(judgment_text, case_id)
    return {
        "input_type": "chat",
        "output_type": "chat",
        "input_value": value,
        "output_component": settings.langflow_output_component_id,
        "tweaks": {settings.langflow_input_component_id: {"value": value}},
    }


def _message_text(candidate: Any) -> str | None:
    """Message 유사 객체에서 text 를 꺼낸다."""
    if isinstance(candidate, str):
        return candidate
    if not isinstance(candidate, dict):
        return None
    for key in ("text", "message"):
        value = candidate.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            nested = _message_text(value)
            if nested is not None:
                return nested
    data = candidate.get("data")
    if isinstance(data, dict):
        return _message_text(data)
    return None


def extract_output_text(envelope: dict, component_id: str) -> tuple[str, str | None]:
    """
    run 응답에서 지정된 출력 컴포넌트의 텍스트를 찾는다.
    반환: (text, session_id). 찾지 못하면 LangflowError.
    """
    if not isinstance(envelope, dict):
        raise LangflowError("BAD_ENVELOPE", "Langflow 응답이 JSON 객체가 아닙니다.")
    session_id = envelope.get("session_id") if isinstance(envelope.get("session_id"), str) else None
    outputs = envelope.get("outputs")
    if not isinstance(outputs, list):
        raise LangflowError("BAD_ENVELOPE", "Langflow 응답에 outputs 배열이 없습니다.")

    seen_components: list[str] = []
    for flow_output in outputs:
        if not isinstance(flow_output, dict):
            continue
        for component_output in flow_output.get("outputs") or []:
            if not isinstance(component_output, dict):
                continue
            cid = component_output.get("component_id")
            if isinstance(cid, str):
                seen_components.append(cid)
            if cid != component_id:
                continue
            # 1) results.message (Langflow 1.x)
            results = component_output.get("results")
            if isinstance(results, dict):
                text = _message_text(results.get("message"))
                if text is not None:
                    return text, session_id
                # 2) results.text 등 임의 키의 Message
                for value in results.values():
                    text = _message_text(value)
                    if text is not None:
                        return text, session_id
            # 3) outputs.message.message
            nested = component_output.get("outputs")
            if isinstance(nested, dict):
                for value in nested.values():
                    text = _message_text(value)
                    if text is not None:
                        return text, session_id
            # 4) messages[]
            messages = component_output.get("messages")
            if isinstance(messages, list) and messages:
                text = _message_text(messages[0])
                if text is not None:
                    return text, session_id
            raise LangflowError(
                "BAD_ENVELOPE",
                f"출력 컴포넌트 {component_id} 의 응답에서 Message 텍스트를 찾지 못했습니다.",
            )
    raise LangflowError(
        "OUTPUT_COMPONENT_NOT_FOUND",
        f"출력 컴포넌트 {component_id} 가 응답에 없습니다. 응답에 포함된 컴포넌트: {seen_components or '없음'}",
    )


class LangflowTransport(Protocol):
    async def run(self, judgment_text: str, case_id: str | None) -> dict: ...


class HttpLangflowTransport:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def run(self, judgment_text: str, case_id: str | None) -> dict:
        settings = self.settings
        if not settings.langflow_flow_id:
            raise LangflowError("NOT_CONFIGURED", "LANGFLOW_FLOW_ID 가 설정되지 않았습니다.")
        url = f"{settings.langflow_base_url}/api/v1/run/{settings.langflow_flow_id}"
        headers = {"Content-Type": "application/json"}
        if settings.langflow_api_key:
            headers["x-api-key"] = settings.langflow_api_key
        payload = build_run_payload(settings, judgment_text, case_id)
        timeout = httpx.Timeout(settings.langflow_timeout_seconds, connect=15.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(url, json=payload, headers=headers)
        except httpx.TimeoutException as error:
            raise LangflowError("TIMEOUT", f"Langflow 응답 대기 시간({settings.langflow_timeout_seconds}s)을 초과했습니다.") from error
        except httpx.HTTPError as error:
            raise LangflowError("CONNECTION", f"Langflow 서버에 연결할 수 없습니다: {error.__class__.__name__}") from error

        if response.status_code in (401, 403):
            raise LangflowError("AUTH", "Langflow 인증에 실패했습니다. API 키 설정을 확인하세요.", status=response.status_code)
        if response.status_code == 404:
            raise LangflowError("FLOW_NOT_FOUND", "Flow ID 에 해당하는 flow 를 찾을 수 없습니다.", status=404)
        if response.status_code >= 400:
            detail = ""
            try:
                body = response.json()
                detail = str(body.get("detail") or body.get("message") or "")[:300]
            except ValueError:
                detail = response.text[:300]
            raise LangflowError("HTTP", f"Langflow 오류 {response.status_code}: {detail}", status=response.status_code)
        try:
            return response.json()
        except ValueError as error:
            raise LangflowError("BAD_ENVELOPE", "Langflow 응답이 JSON 이 아닙니다.") from error


class MockLangflowTransport:
    """fixture 파일의 envelope 를 돌려준다. 실제 서버 검증을 대체하지 않는다."""

    def __init__(self, fixture_path: Path, delay_seconds: float = 0.0):
        self.fixture_path = fixture_path
        self.delay_seconds = delay_seconds

    async def run(self, judgment_text: str, case_id: str | None) -> dict:
        if not self.fixture_path.exists():
            raise LangflowError("NOT_CONFIGURED", f"mock fixture 가 없습니다: {self.fixture_path.name}")
        if self.delay_seconds > 0:
            await asyncio.sleep(self.delay_seconds)
        with self.fixture_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)


def make_transport(settings: Settings) -> LangflowTransport:
    if settings.langflow_mode == "live":
        return HttpLangflowTransport(settings)
    return MockLangflowTransport(settings.mock_fixture_path, settings.mock_delay_seconds)


class LangflowClient:
    def __init__(self, settings: Settings, transport: LangflowTransport | None = None):
        self.settings = settings
        self.transport = transport or make_transport(settings)

    async def analyze(self, judgment_text: str, case_id: str | None) -> LangflowResult:
        envelope = await self.transport.run(judgment_text, case_id)
        text, session_id = extract_output_text(envelope, self.settings.langflow_output_component_id)
        return LangflowResult(
            output_text=text,
            session_id=session_id,
            component_id=self.settings.langflow_output_component_id,
            raw_envelope=envelope,
        )
