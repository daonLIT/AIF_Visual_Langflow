"""
파이프라인 편집 서비스: 불러오기 → 작업용 복제 → 초안 저장 → 검증 → Langflow 적용(재조회 확인) → 테스트 실행 → 이전 버전 복원.

- 프로덕션 flow(LANGFLOW_FLOW_ID)와 실행용 스냅샷 flow 에는 적용하지 않는다. 작업용 복제본에 적용한다.
- 적용 전에 현재 원격 flow 를 백업(pipeline_versions)하고, 가능하면 Langflow 버전 스냅샷도 만든다.
- 편집을 시작한 뒤 원격 flow 가 바뀌었으면(updated_at 또는 실행 해시 불일치) 적용하지 않고 충돌로 알린다.
- 적용 후 Langflow 에서 다시 읽어 실행 해시가 보낸 내용과 같은지 확인한다. 다르면 성공으로 표시하지 않는다.
- 브라우저에는 비밀 값이 마스킹된 data 만 보낸다. 로컬 DB 에도 마스킹된 data 만 저장한다.
- 실행 버전 고정: 실행마다 flow 해시·모델 설정·입출력 컴포넌트를 기록하고, live 에서는 해시별 실행용 스냅샷 flow 로 실행한다.
"""
from __future__ import annotations

import copy
import uuid

import httpx

from ...config import Settings
from ...storage import Database
from ..langflow_client import LangflowError
from .flow_model import (
    component_kind,
    contains_sentinel,
    execution_hash,
    mask_secrets,
    model_settings,
    node_info,
    node_template,
    resolve_relay,
    restore_secrets,
    summarize,
    support_info,
    validate_flow_data,
)
from .repository import PipelineError, _templates_from_flow, flow_header, now_iso

WORKING_COPY_TAG = "aif-working-copy"
RUN_SNAPSHOT_TAG = "aif-run-snapshot"
ANALYSIS_FLOW_SETTING = "analysis_flow_id"


def has_component_class(node: dict, class_name: str) -> bool:
    """커스텀 컴포넌트 종류 확인. Langflow 가 만든 노드에는 name 이 없을 수 있어 코드의 클래스 정의로 본다."""
    code = (node_template(node).get("code") or {}).get("value")
    return node_info(node).get("name") == class_name or (isinstance(code, str) and f"class {class_name}(" in code)


def _error_count(issues: list[dict]) -> int:
    return sum(1 for issue in issues if issue["level"] == "error")


def _node_fingerprints(data: dict) -> dict[str, str]:
    result = {}
    for node in data.get("nodes") or []:
        if isinstance(node, dict) and node.get("id"):
            result[node["id"]] = execution_hash({"nodes": [node], "edges": []})
    return result


def diff_flow_data(base: dict, current: dict) -> dict:
    """초안(current)과 적용본(base)의 차이 요약. 위치 이동은 실행에 영향이 없어 따로 센다."""
    base_nodes, current_nodes = _node_fingerprints(base), _node_fingerprints(current)
    base_edges = {e.get("id") for e in base.get("edges") or [] if isinstance(e, dict)}
    current_edges = {e.get("id") for e in current.get("edges") or [] if isinstance(e, dict)}
    base_pos = {n.get("id"): n.get("position") for n in base.get("nodes") or [] if isinstance(n, dict)}
    moved = [n.get("id") for n in current.get("nodes") or [] if isinstance(n, dict) and n.get("id") in base_pos and base_pos[n.get("id")] != n.get("position")]
    return {
        "nodesAdded": sorted(set(current_nodes) - set(base_nodes)),
        "nodesRemoved": sorted(set(base_nodes) - set(current_nodes)),
        "nodesChanged": sorted(k for k in set(base_nodes) & set(current_nodes) if base_nodes[k] != current_nodes[k]),
        "nodesMoved": sorted(moved),
        "edgesAdded": len(current_edges - base_edges),
        "edgesRemoved": len(base_edges - current_edges),
        "sameExecution": execution_hash(base) == execution_hash(current),
    }


class PipelineService:
    def __init__(self, settings: Settings, db: Database, repository, *, issue_catalog=None, scheme_catalog=None):
        self.settings = settings
        self.db = db
        self.repo = repository
        self.issue_catalog = issue_catalog
        self.scheme_catalog = scheme_catalog

    # ---- helpers ----
    @property
    def production_flow_id(self) -> str | None:
        return self.settings.langflow_flow_id or None

    def analysis_flow_id(self) -> str | None:
        """분석에 사용할 flow. 파이프라인 탭에서 지정한 값이 없으면 LANGFLOW_FLOW_ID."""
        return self.db.get_setting(ANALYSIS_FLOW_SETTING) or self.production_flow_id

    @staticmethod
    def _is_snapshot(header_or_flow: dict) -> bool:
        return RUN_SNAPSHOT_TAG in (header_or_flow.get("tags") or [])

    def _decorate(self, header: dict, meta: dict[str, dict]) -> dict:
        flow_id = header["id"]
        return {
            **header,
            "isProduction": flow_id == self.production_flow_id,
            "isAnalysisFlow": flow_id == self.analysis_flow_id(),
            "isWorkingCopy": flow_id in meta or WORKING_COPY_TAG in (header.get("tags") or []),
            "isRunSnapshot": self._is_snapshot(header),
            "sourceFlowId": (meta.get(flow_id) or {}).get("sourceFlowId"),
            "hasDraft": self.db.get_pipeline_draft(flow_id) is not None,
        }

    def _relay(self, data: dict) -> dict:
        return resolve_relay(data, self.settings.langflow_input_component_id, self.settings.langflow_output_component_id)

    def _view(self, flow: dict) -> dict:
        data = flow.get("data") or {}
        nodes_edges = {"nodes": data.get("nodes") or [], "edges": data.get("edges") or []}
        masked, secret_paths = mask_secrets(nodes_edges)
        view_data = {**{k: v for k, v in data.items() if k not in ("nodes", "edges")}, **masked}
        meta = self.db.list_flow_meta()
        flow_id = flow_header(flow)["id"]
        relay = self._relay(nodes_edges)
        remote_hash = execution_hash(nodes_edges)
        return {
            "flow": self._decorate(flow_header(flow), meta),
            "data": view_data,
            "hash": remote_hash,
            "support": {node.get("id"): support_info(node) for node in masked["nodes"] if node_info(node).get("template")},
            "secretFields": secret_paths,
            "summary": summarize(masked),
            "models": model_settings(nodes_edges),
            "relay": {
                "inputComponentId": relay["inputComponentId"] or self.settings.langflow_input_component_id,
                "outputComponentId": relay["outputComponentId"] or self.settings.langflow_output_component_id,
                "configuredInputComponentId": self.settings.langflow_input_component_id,
                "configuredOutputComponentId": self.settings.langflow_output_component_id,
                "notes": relay["notes"],
                "errors": [e["message"] for e in relay["errors"]],
            },
            "draft": self._draft_header(flow_id, masked, remote_hash, flow.get("updated_at")),
        }

    def _draft_header(self, flow_id: str, remote_data: dict, remote_hash: str, remote_updated_at) -> dict | None:
        draft = self.db.get_pipeline_draft(flow_id)
        if not draft:
            return None
        base_changed = bool(
            (draft.get("baseHash") and draft["baseHash"] != remote_hash)
            or (draft.get("baseUpdatedAt") and str(draft["baseUpdatedAt"]) != str(remote_updated_at))
        )
        return {
            **{k: v for k, v in draft.items() if k != "data"},
            "remoteChangedSinceDraft": base_changed,
            "diff": diff_flow_data(remote_data, draft["data"]),
        }

    def _validate(self, data: dict) -> list[dict]:
        return validate_flow_data(
            data,
            input_component_id=self.settings.langflow_input_component_id,
            output_component_id=self.settings.langflow_output_component_id,
        )

    def _guard_writable(self, flow_id: str, flow: dict | None = None) -> None:
        if flow_id == self.production_flow_id:
            raise PipelineError(
                "PRODUCTION_PROTECTED",
                "프로덕션 flow(LANGFLOW_FLOW_ID)에는 직접 적용하지 않습니다. 작업용 flow 를 복제한 뒤 적용하세요.",
                status=409,
            )
        if flow is not None and self._is_snapshot(flow):
            raise PipelineError("SNAPSHOT_PROTECTED", "실행용 스냅샷 flow 는 수정하지 않습니다(실행 기록의 버전 고정).", status=409)

    # ---- API ----
    async def list_flows(self) -> dict:
        headers = await self.repo.list_flows()
        meta = self.db.list_flow_meta()
        visible = [h for h in headers if not self._is_snapshot(h)]
        return {
            "mode": self.settings.langflow_mode,
            "productionFlowId": self.production_flow_id,
            "analysisFlowId": self.analysis_flow_id(),
            "hiddenRunSnapshots": len(headers) - len(visible),
            "flows": [self._decorate(header, meta) for header in visible],
        }

    async def get_flow(self, flow_id: str) -> dict:
        return self._view(await self.repo.get_flow(flow_id))

    async def get_draft(self, flow_id: str) -> dict | None:
        return self.db.get_pipeline_draft(flow_id)

    async def save_draft(self, flow_id: str, data: dict, base_updated_at: str | None, note: str | None, base_hash: str | None = None) -> dict:
        masked, _ = mask_secrets(data)
        saved_at = now_iso()
        self.db.save_pipeline_draft(flow_id, base_updated_at, saved_at, note, masked, base_hash=base_hash)
        return {"flowId": flow_id, "savedAt": saved_at, "issues": self._validate(masked)}

    async def discard_draft(self, flow_id: str) -> None:
        self.db.delete_pipeline_draft(flow_id)

    async def validate(self, flow_id: str | None, data: dict, *, check_code: bool = False) -> dict:
        issues = self._validate(data)
        code_checks = []
        if check_code and self.settings.is_live and flow_id:
            remote = await self.repo.get_flow(flow_id)
            remote_nodes = {n.get("id"): n for n in (remote.get("data") or {}).get("nodes") or []}
            for node in data.get("nodes") or []:
                code = (node_template(node).get("code") or {}).get("value")
                remote_code = (node_template(remote_nodes.get(node.get("id"), {})).get("code") or {}).get("value")
                if not isinstance(code, str) or code == remote_code:
                    continue
                result = await self.repo.validate_code(code)
                errors = []
                for section in ("imports", "function"):
                    errors.extend((result or {}).get(section, {}).get("errors") or [])
                code_checks.append({"nodeId": node.get("id"), "errors": errors})
                for message in errors:
                    issues.append({"level": "error", "code": "CODE", "message": f"{node.get('id')}: {message}", "nodeId": node.get("id"), "field": "code"})
        return {"issues": issues, "errorCount": _error_count(issues), "codeChecks": code_checks}

    async def clone(self, flow_id: str, name: str | None) -> dict:
        source = await self.repo.get_flow(flow_id)
        stamp = now_iso()[:16].replace("T", " ")
        payload = {
            "name": (name or f"{source.get('name') or 'flow'} (작업용 {stamp})")[:200],
            "description": f"AIF_Visual 파이프라인 편집 작업용 복제본. 원본: {source.get('name')} ({flow_id})",
            # 서버 안에서 원격 → 원격으로 복사하므로 비밀 값도 그대로 유지된다(브라우저를 거치지 않음).
            "data": copy.deepcopy(source.get("data") or {}),
            "tags": sorted(set((t for t in source.get("tags") or [] if t != RUN_SNAPSHOT_TAG)) | {WORKING_COPY_TAG}),
            "is_component": False,
        }
        if source.get("folder_id"):
            payload["folder_id"] = source["folder_id"]
        created = await self.repo.create_flow(payload)
        created_id = str(created.get("id"))
        self.db.set_flow_meta(created_id, flow_id, now_iso(), None)
        self.db.add_pipeline_version(
            uuid.uuid4().hex, created_id, "cloned", now_iso(), f"{flow_id} 에서 복제", created.get("updated_at"),
            mask_secrets(payload["data"])[0], data_hash=execution_hash(payload["data"]),
        )
        return self._view(created if isinstance(created.get("data"), dict) else await self.repo.get_flow(created_id))

    async def apply(
        self,
        flow_id: str,
        data: dict,
        *,
        base_updated_at: str | None,
        note: str | None,
        base_hash: str | None = None,
        name: str | None = None,
        description: str | None = None,
        kind: str = "applied",
    ) -> dict:
        self._guard_writable(flow_id)
        issues = self._validate(data)
        if _error_count(issues):
            raise PipelineError("VALIDATION", "검증 오류가 있어 적용하지 않았습니다.", status=422, details=issues)

        remote = await self.repo.get_flow(flow_id)
        self._guard_writable(flow_id, remote)
        remote_data = remote.get("data") or {}
        remote_hash = execution_hash(remote_data)
        if base_updated_at and str(remote.get("updated_at")) != str(base_updated_at):
            raise PipelineError(
                "CONFLICT",
                f"편집을 시작한 뒤 Langflow 의 flow 가 바뀌었습니다 (현재 {remote.get('updated_at')}). 다시 불러와 변경을 합치세요.",
                status=409,
            )
        if base_hash and base_hash != remote_hash:
            raise PipelineError(
                "CONFLICT",
                "편집을 시작한 뒤 Langflow 의 flow 내용(실행 해시)이 바뀌었습니다. 다시 불러와 변경을 합치세요.",
                status=409,
            )
        restored, secret_warnings = restore_secrets({"nodes": data.get("nodes") or [], "edges": data.get("edges") or []}, remote_data)
        if contains_sentinel(restored):
            raise PipelineError("SECRET_SENTINEL", "마스킹 값이 남아 있어 적용하지 않았습니다.", status=500)
        extra_keys = {k: v for k, v in remote_data.items() if k not in ("nodes", "edges")}
        extra_keys.update({k: v for k, v in data.items() if k not in ("nodes", "edges")})
        new_data = {**extra_keys, **restored}
        expected_hash = execution_hash(new_data)

        backup_id = uuid.uuid4().hex
        self.db.add_pipeline_version(
            backup_id, flow_id, "backup", now_iso(), "적용 직전 원격 flow 백업", remote.get("updated_at"),
            mask_secrets(remote_data)[0], data_hash=remote_hash,
        )
        snapshot_error = None
        try:
            await self.repo.create_snapshot(flow_id, f"AIF_Visual 적용 전 백업: {note or ''}".strip())
        except (LangflowError, PipelineError) as error:  # 스냅샷 기능이 없거나 권한이 없어도 로컬 백업은 있다.
            snapshot_error = str(error)

        payload = {"data": new_data}
        if name:
            payload["name"] = name
        if description is not None:
            payload["description"] = description
        await self.repo.update_flow(flow_id, payload)

        # 저장됐는지 Langflow 에서 다시 읽어 확인한다.
        reread = await self.repo.get_flow(flow_id)
        actual_hash = execution_hash(reread.get("data") or {})
        verified = actual_hash == expected_hash
        version_id = uuid.uuid4().hex
        self.db.add_pipeline_version(
            version_id, flow_id, kind if verified else f"{kind}-unverified", now_iso(), note, reread.get("updated_at"),
            mask_secrets(reread.get("data") or {})[0], data_hash=actual_hash,
        )
        if not verified:
            diff = diff_flow_data(new_data, reread.get("data") or {})
            raise PipelineError(
                "APPLY_NOT_VERIFIED",
                "Langflow 에 저장을 요청했지만 다시 읽은 flow 가 보낸 내용과 다릅니다. 적용이 완료되었다고 볼 수 없습니다.",
                status=502,
                details=[
                    f"변경된 컴포넌트: {', '.join(diff['nodesChanged']) or '없음'}",
                    f"추가 {len(diff['nodesAdded'])} / 삭제 {len(diff['nodesRemoved'])} / 연결 +{diff['edgesAdded']} -{diff['edgesRemoved']}",
                    f"백업 버전 {backup_id} 으로 복원할 수 있습니다.",
                ],
            )
        self.db.delete_pipeline_draft(flow_id)
        view = self._view(reread)
        view["applied"] = {
            "versionId": version_id,
            "backupVersionId": backup_id,
            "verified": True,
            "expectedHash": expected_hash,
            "actualHash": actual_hash,
            "langflowSnapshotError": snapshot_error,
            "warnings": secret_warnings,
            "issues": issues,
        }
        return view

    async def list_versions(self, flow_id: str) -> dict:
        return {"versions": self.db.list_pipeline_versions(flow_id)}

    async def get_version(self, version_id: str) -> dict:
        version = self.db.get_pipeline_version(version_id)
        if version is None:
            raise PipelineError("NOT_FOUND", "버전을 찾을 수 없습니다.", status=404)
        return version

    async def restore_version(self, flow_id: str, version_id: str, base_updated_at: str | None, base_hash: str | None = None) -> dict:
        version = await self.get_version(version_id)
        if version["flowId"] != flow_id:
            raise PipelineError("VERSION_MISMATCH", "다른 flow 의 버전입니다.", status=400)
        return await self.apply(
            flow_id,
            version["data"],
            base_updated_at=base_updated_at,
            base_hash=base_hash,
            note=f"{version['createdAt']} 버전({version['kind']}) 복원",
            kind="restored",
        )

    async def pin_run_flow(self, flow_id: str | None) -> dict:
        """실행에 쓸 flow 를 고정한다: 해시·모델 설정·입출력 컴포넌트, live 에서는 해시별 실행용 스냅샷 flow."""
        if not flow_id:
            if self.settings.is_live:
                raise PipelineError("NOT_CONFIGURED", "분석에 사용할 flow 가 없습니다. LANGFLOW_FLOW_ID 를 설정하세요.", status=400)
            return {"flowId": None, "runFlowId": None, "mock": True, "note": "mock 모드: fixture 응답을 사용합니다."}
        try:
            flow = await self.repo.get_flow(flow_id)
        except LangflowError:
            if not self.settings.is_live:
                return {"flowId": flow_id, "runFlowId": flow_id, "mock": True, "note": "mock 모드: 로컬 flow 를 찾지 못했습니다."}
            raise
        data = flow.get("data") or {}
        relay = self._relay(data)
        if relay["errors"]:
            raise PipelineError("RELAY", "실행할 flow 에서 중계 서버 입력·출력 컴포넌트를 정할 수 없습니다.", status=409, details=[e["message"] for e in relay["errors"]])
        flow_hash = execution_hash(data)
        version = self.db.find_pipeline_version_by_hash(flow_id, flow_hash)
        pinned = {
            "flowId": flow_id,
            "flowName": flow.get("name"),
            "flowUpdatedAt": flow.get("updated_at"),
            "flowHash": flow_hash,
            "pipelineVersion": version,
            "models": model_settings(data),
            "relay": {"inputComponentId": relay["inputComponentId"], "outputComponentId": relay["outputComponentId"], "notes": relay["notes"]},
            "runFlowId": flow_id,
            "snapshot": False,
            "mock": not self.settings.is_live,
        }
        if not self.settings.is_live or not self.settings.run_snapshot_flows:
            return pinned

        snapshot_id = self.db.get_run_snapshot(flow_id, flow_hash)
        if snapshot_id:
            try:
                existing = await self.repo.get_flow(snapshot_id)
                if execution_hash(existing.get("data") or {}) != flow_hash:
                    snapshot_id = None  # 누군가 스냅샷을 수정했다 → 새로 만든다
            except LangflowError:
                snapshot_id = None
        if not snapshot_id:
            payload = {
                "name": f"[AIF 실행 스냅샷] {flow.get('name') or flow_id} #{flow_hash[:8]}"[:200],
                "description": f"실행 버전 고정용 스냅샷. 원본 {flow_id}, 실행 해시 {flow_hash}. 수정하지 마세요.",
                "data": copy.deepcopy(data),
                "tags": [RUN_SNAPSHOT_TAG],
                "is_component": False,
            }
            if flow.get("folder_id"):
                payload["folder_id"] = flow["folder_id"]
            created = await self.repo.create_flow(payload)
            snapshot_id = str(created.get("id"))
            check = await self.repo.get_flow(snapshot_id)
            if execution_hash(check.get("data") or {}) != flow_hash:
                raise PipelineError("SNAPSHOT_NOT_VERIFIED", "실행용 스냅샷 flow 를 만들었지만 내용이 원본과 달라 실행하지 않았습니다.", status=502)
            self.db.save_run_snapshot(flow_id, flow_hash, snapshot_id, now_iso())
        pinned["runFlowId"] = snapshot_id
        pinned["snapshot"] = True
        return pinned

    async def summarizer_config(self, flow_id: str | None) -> dict:
        """분석 flow 의 I-node Summarizer 설정(프롬프트·모델). 사이트의 '요약 생성'도 같은 설정을 쓴다."""
        if not flow_id:
            raise PipelineError("NOT_CONFIGURED", "분석 flow 가 설정되지 않았습니다.", status=400)
        flow = await self.repo.get_flow(flow_id)
        for node in (flow.get("data") or {}).get("nodes") or []:
            if has_component_class(node, "NodeSummarizer"):
                template = node_template(node)
                value = lambda key, default=None: (template.get(key) or {}).get("value", default)  # noqa: E731
                return {
                    "flowId": flow_id,
                    "componentId": node.get("id"),
                    "promptTemplate": value("prompt_template", ""),
                    "systemMessage": value("system_message", ""),
                    "baseUrl": value("base_url", "http://localhost:11434"),
                    "model": value("model_name"),
                    "temperature": value("temperature", 0.1),
                    "numCtx": value("num_ctx", 8192),
                    "timeout": value("timeout", 600),
                }
        raise PipelineError("NO_SUMMARIZER", "분석 flow 에 I-node Summarizer 컴포넌트가 없습니다.", status=409)

    async def component_templates(self, flow_id: str | None) -> dict:
        templates: dict[str, dict] = {}
        warnings = []
        try:
            for item in await self.repo.component_templates():
                templates.setdefault(item["key"], item)
        except (LangflowError, PipelineError) as error:
            warnings.append(f"Langflow 컴포넌트 목록을 가져오지 못했습니다: {error}")
        if flow_id:
            flow = await self.repo.get_flow(flow_id)
            for key, item in _templates_from_flow(flow).items():
                templates.setdefault(key, item)
        items = []
        for item in templates.values():
            masked, _ = mask_secrets({"nodes": [{"id": "template", "data": {"node": item["node"]}}], "edges": []})
            items.append({**item, "node": masked["nodes"][0]["data"]["node"]})
        return {"templates": sorted(items, key=lambda t: (t["kind"], t["displayName"])), "warnings": warnings}

    async def rebuild_component(self, code: str, frontend_node: dict | None) -> dict:
        body = await self.repo.rebuild_component(code, frontend_node)
        masked, _ = mask_secrets({"nodes": [{"id": "component", "data": {"node": body["data"]}}], "edges": []})
        return {"node": masked["nodes"][0]["data"]["node"], "type": body.get("type")}

    async def set_analysis_flow(self, flow_id: str | None) -> dict:
        if flow_id:
            flow = await self.repo.get_flow(flow_id)
            if self._is_snapshot(flow):
                raise PipelineError("SNAPSHOT_PROTECTED", "실행용 스냅샷 flow 는 분석 flow 로 지정할 수 없습니다.", status=409)
        self.db.set_setting(ANALYSIS_FLOW_SETTING, flow_id or None)
        return {"analysisFlowId": self.analysis_flow_id(), "productionFlowId": self.production_flow_id}

    async def connection_status(self) -> dict:
        """설정 존재 여부와 실제 연결 결과를 구분해 보고한다."""
        report: dict = {"mode": self.settings.langflow_mode, "config": self.settings.public_dict(), "checks": []}

        def add(name: str, ok: bool | None, detail: str) -> None:
            report["checks"].append({"name": name, "ok": ok, "detail": detail})

        try:
            version = await self.repo.ping()
            add("langflow", True, f"응답함 (version {version.get('version') or version.get('main_version') or '?'})")
        except (LangflowError, PipelineError) as error:
            add("langflow", False, str(error))

        flow_models: list[dict] = []
        flow_id = self.analysis_flow_id()
        if flow_id:
            try:
                flow = await self.repo.get_flow(flow_id)
                data = flow.get("data") or {}
                issues = self._validate(data)
                relay = self._relay(data)
                flow_models = model_settings(data)
                detail = f"{flow.get('name')} — 검증 오류 {_error_count(issues)}개"
                if relay["notes"]:
                    detail += " · " + " ".join(relay["notes"])
                add("analysis_flow", _error_count(issues) == 0, detail)
                stages = {name: any(has_component_class(n, name) for n in data.get("nodes") or []) for name in ("IssueSelector", "NodeSummarizer", "SchemeAssigner", "ResultValidator")}
                missing = [name for name, present in stages.items() if not present]
                add(
                    "flow_contract",
                    not missing,
                    "쟁점 자동 선택(최대 3개)·요약·scheme·검증 단계가 있는 v11 flow" if not missing else f"계획서의 처리 단계가 없는 flow 입니다: {', '.join(missing)} (v11 flow 가져오기 필요)",
                )
            except (LangflowError, PipelineError) as error:
                add("analysis_flow", False, str(error))
        else:
            add("analysis_flow", None if not self.settings.is_live else False, "분석 flow 가 설정되지 않았습니다 (LANGFLOW_FLOW_ID).")

        urls = sorted({str(m.get("base_url")).rstrip("/") for m in flow_models if m.get("base_url")}) or ["http://localhost:11434"]
        for url in urls:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    response = await client.get(f"{url}/api/tags")
                installed = [m.get("name") for m in response.json().get("models", [])] if response.status_code == 200 else []
                add("ollama", response.status_code == 200, f"{url} — 모델 {len(installed)}개")
                needed = sorted({str(m.get("model_name")) for m in flow_models if m.get("model_name") and str(m.get("base_url", url)).rstrip("/") == url})
                missing = [name for name in needed if name not in installed]
                if needed:
                    add("ollama_models", not missing, f"flow 가 쓰는 모델 {', '.join(needed)}" + (f" — 설치 안 됨: {', '.join(missing)}" if missing else " 모두 설치됨"))
            except (httpx.HTTPError, ValueError) as error:
                add("ollama", False, f"{url} 에 연결할 수 없습니다: {error.__class__.__name__}")
        add(
            "catalogs",
            bool(self.issue_catalog and self.scheme_catalog),
            f"쟁점 카탈로그 v{self.issue_catalog.version if self.issue_catalog else '?'} ({len(self.issue_catalog.active_ids()) if self.issue_catalog else 0}개) · "
            f"scheme 카탈로그 v{self.scheme_catalog.version if self.scheme_catalog else '?'} ({len(self.scheme_catalog.by_key) if self.scheme_catalog else 0}개, {self.scheme_catalog.data.get('status') if self.scheme_catalog else ''})",
        )
        return report

    @staticmethod
    def kind_of(node: dict) -> str:
        return component_kind(node)
