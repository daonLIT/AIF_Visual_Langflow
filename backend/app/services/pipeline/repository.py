"""
flow 저장소 어댑터.

- LangflowFlowRepository: 실제 Langflow REST API (Langflow 1.11 설치본의 라우터에서 확인한 계약)
    GET    /api/v1/flows/?get_all=true&header_flows=true&remove_example_flows=true   목록(데이터 제외)
    GET    /api/v1/flows/{id}                                                        전체(data 포함)
    POST   /api/v1/flows/                                                            생성 (FlowCreate)
    PATCH  /api/v1/flows/{id}                                                        수정 (FlowUpdate: name/description/data ...)
    POST   /api/v1/flows/{id}/versions/                                              스냅샷 (description)
    POST   /api/v1/custom_component                                                  코드로 컴포넌트 template 재구성
    POST   /api/v1/validate/code                                                     코드 import/함수 검사
    GET    /api/v1/all                                                               설치된 컴포넌트 template
  인증은 x-api-key 헤더. 키는 서버에만 있고 응답에 넣지 않는다.
- LocalFlowRepository: mock 모드. 저장소의 flow JSON 을 SQLite 에 복제해 같은 인터페이스로 편집한다.
  Langflow 가 필요한 기능(코드 재구성·코드 검사)은 명시적으로 지원하지 않음 오류를 낸다.
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx

from ...config import Settings
from ...storage import Database
from ..langflow_client import LangflowError, auth_headers, raise_for_langflow_status
from .flow_model import component_kind, node_info


class PipelineError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 400, details: list | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details or []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def flow_header(flow: dict) -> dict:
    return {
        "id": str(flow.get("id")),
        "name": flow.get("name") or "",
        "description": flow.get("description") or "",
        "updatedAt": flow.get("updated_at"),
        "folderId": flow.get("folder_id"),
        "tags": flow.get("tags") or [],
        "isComponent": bool(flow.get("is_component")),
    }


def _templates_from_flow(flow: dict) -> dict[str, dict]:
    """flow 에 들어 있는 노드 정의를 '추가 가능한 컴포넌트' 목록으로 쓴다."""
    templates: dict[str, dict] = {}
    for node in (flow.get("data") or {}).get("nodes") or []:
        data = node.get("data") or {}
        info = node_info(node)
        if not info.get("template"):
            continue
        kind = component_kind(node)
        key = f"{data.get('type')}::{info.get('display_name')}" if kind == "custom" else str(data.get("type"))
        if key in templates:
            continue
        templates[key] = {
            "key": key,
            "type": data.get("type"),
            "displayName": info.get("display_name") or data.get("type"),
            "description": info.get("description") or "",
            "kind": kind,
            "source": "flow",
            "node": copy.deepcopy(info),
        }
    return templates


class LangflowFlowRepository:
    # /api/v1/all 에서 편집기 팔레트로 가져올 컴포넌트 (없는 키는 건너뛴다)
    PALETTE_KEYS = ("Prompt Template", "Prompt", "ChatInput", "ChatOutput", "TextInput", "TextOutput", "CustomComponent")

    def __init__(self, settings: Settings, http_transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.http_transport = http_transport

    async def _request(self, method: str, path: str, *, json_body=None, params=None, timeout: float = 30.0, not_found: str = "flow 를 찾을 수 없습니다."):
        url = f"{self.settings.langflow_base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0), transport=self.http_transport) as client:
                response = await client.request(method, url, json=json_body, params=params, headers=auth_headers(self.settings))
        except httpx.TimeoutException as error:
            raise LangflowError("TIMEOUT", f"Langflow 응답 대기 시간({timeout:.0f}s)을 초과했습니다.") from error
        except httpx.HTTPError as error:
            raise LangflowError("CONNECTION", f"Langflow 서버에 연결할 수 없습니다: {error.__class__.__name__}") from error
        raise_for_langflow_status(response, not_found=not_found)
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise LangflowError("BAD_RESPONSE", f"Langflow 응답이 JSON 이 아닙니다 ({path}).") from error

    async def list_flows(self) -> list[dict]:
        body = await self._request(
            "GET", "/api/v1/flows/", params={"get_all": "true", "header_flows": "true", "remove_example_flows": "true"}
        )
        items = body.get("items") if isinstance(body, dict) else body
        return [flow_header(item) for item in items or [] if isinstance(item, dict) and not item.get("is_component")]

    async def get_flow(self, flow_id: str) -> dict:
        body = await self._request("GET", f"/api/v1/flows/{flow_id}")
        if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
            raise PipelineError("BAD_FLOW", "Langflow 가 돌려준 flow 에 data 가 없습니다.", status=502)
        return body

    async def create_flow(self, payload: dict) -> dict:
        return await self._request("POST", "/api/v1/flows/", json_body=payload)

    async def update_flow(self, flow_id: str, payload: dict) -> dict:
        return await self._request("PATCH", f"/api/v1/flows/{flow_id}", json_body=payload)

    async def create_snapshot(self, flow_id: str, description: str) -> dict | None:
        return await self._request("POST", f"/api/v1/flows/{flow_id}/versions/", json_body={"description": description[:500]})

    async def rebuild_component(self, code: str, frontend_node: dict | None) -> dict:
        body = await self._request(
            "POST", "/api/v1/custom_component", json_body={"code": code, "frontend_node": frontend_node}, timeout=120.0
        )
        if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
            raise PipelineError("BAD_COMPONENT", "Langflow 가 컴포넌트 template 을 돌려주지 않았습니다.", status=502)
        return body

    async def validate_code(self, code: str) -> dict:
        return await self._request("POST", "/api/v1/validate/code", json_body={"code": code}, timeout=60.0)

    async def component_templates(self) -> list[dict]:
        body = await self._request("GET", "/api/v1/all", timeout=120.0)
        found = []
        if isinstance(body, dict):
            for category, components in body.items():
                if not isinstance(components, dict) or category == "component_display_names":
                    continue
                for key, node in components.items():
                    if key in self.PALETTE_KEYS and isinstance(node, dict) and isinstance(node.get("template"), dict):
                        found.append(
                            {
                                "key": key,
                                "type": key,
                                "displayName": node.get("display_name") or key,
                                "description": node.get("description") or "",
                                "kind": component_kind({"data": {"type": key, "node": node}}),
                                "source": "langflow",
                                "category": category,
                                "node": node,
                            }
                        )
        return found

    async def ping(self) -> dict:
        version = await self._request("GET", "/api/v1/version", timeout=10.0)
        return version if isinstance(version, dict) else {"version": version}


class LocalFlowRepository:
    def __init__(self, db: Database, seed_files: tuple[Path, ...]):
        self.db = db
        self.seed_files = seed_files

    def seed(self) -> list[str]:
        seeded = []
        for path in self.seed_files:
            if not path.exists():
                continue
            flow = json.loads(path.read_text(encoding="utf-8"))
            if not flow.get("id") or self.db.get_local_flow(str(flow["id"])):
                continue
            flow = {**flow, "id": str(flow["id"]), "updated_at": flow.get("updated_at") or now_iso()}
            self.db.save_local_flow(flow)
            seeded.append(flow["id"])
        return seeded

    async def list_flows(self) -> list[dict]:
        self.seed()
        return [flow_header(flow) for flow in self.db.list_local_flows()]

    async def get_flow(self, flow_id: str) -> dict:
        self.seed()
        flow = self.db.get_local_flow(flow_id)
        if flow is None:
            raise LangflowError("FLOW_NOT_FOUND", "flow 를 찾을 수 없습니다.", status=404)
        return flow

    async def create_flow(self, payload: dict) -> dict:
        flow = {
            **copy.deepcopy(payload),
            "id": str(uuid.uuid4()),
            "updated_at": now_iso(),
            "is_component": False,
            "locked": False,
        }
        self.db.save_local_flow(flow)
        return flow

    async def update_flow(self, flow_id: str, payload: dict) -> dict:
        flow = await self.get_flow(flow_id)
        updated = {**flow, **{k: v for k, v in payload.items() if v is not None}, "id": flow_id, "updated_at": now_iso()}
        self.db.save_local_flow(updated)
        return updated

    async def create_snapshot(self, flow_id: str, description: str) -> dict | None:
        return None  # 로컬 버전 기록(pipeline_versions)만 사용한다.

    async def rebuild_component(self, code: str, frontend_node: dict | None) -> dict:
        raise PipelineError(
            "UNSUPPORTED_IN_MOCK",
            "mock 모드에서는 코드로 컴포넌트 입력·출력을 다시 만들 수 없습니다. 코드 텍스트는 저장되지만 필드 구성은 그대로입니다.",
            status=501,
        )

    async def validate_code(self, code: str) -> dict:
        raise PipelineError("UNSUPPORTED_IN_MOCK", "mock 모드에서는 Langflow 코드 검사를 사용할 수 없습니다.", status=501)

    async def component_templates(self) -> list[dict]:
        templates: dict[str, dict] = {}
        for flow in self.db.list_local_flows() or []:
            for key, template in _templates_from_flow(flow).items():
                templates.setdefault(key, template)
        return list(templates.values())

    async def ping(self) -> dict:
        return {"version": "mock", "main_version": "mock"}
