"""
외부(Langflow Desktop)에서 만든 분석 결과를 중앙 DB 에 게시한다.

- 분석은 Desktop 에서 끝났다. 여기서는 Langflow 를 다시 부르지 않는다.
- 기존 어댑터(build_proposal)로 결과 검증 → 실행별 ID namespace → 원문 근거 매칭 → 미검토 annotation 을 만든다.
  AI 제안은 acceptedGraph 에 넣지 않는다(검토 화면에서 미검토로 보인다).
- no_issues 는 빈 그래프와 사유를 가진 프로젝트로 저장하고, invalid 는 저장하지 않고 422 로 돌려준다.
- (principal, externalRunId) 가 이미 있으면: 정규화한 요청 해시가 같으면 기존 ID(200), 다르면 409.
  재전송은 사람이 이미 고친 프로젝트를 건드리지 않는다.
- 실행 기록·프로젝트·게시 매핑은 한 트랜잭션으로 저장한다(Database.publish_external).
- 카탈로그는 실행 당시 버전·해시가 지금 서버 카탈로그와 같을 때만 받는다. 과거 버전 스냅샷은 보관하지 않으므로 다르면 409.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError

from ..i18n import t
from ..schemas import PROJECT_SCHEMA_VERSION, LangflowResultPublish, ProjectFile
from ..storage.db import Database, PublicationConflict
from .aif_adapter import InvalidResultError, build_proposal, make_namespace
from .catalogs import MAX_SELECTED_ISSUES, IssueCatalog, SchemeCatalog, merged_scheme_catalog
from .run_manager import document_hash, now_iso

logger = logging.getLogger("annotation.publication")


@dataclass
class PublishOutcome:
    status: int
    body: dict


def request_hash(payload: LangflowResultPublish) -> str:
    """기본값까지 채운 요청을 키 순서를 고정해 직렬화한 해시. 같은 내용이면 필드 순서·생략 여부와 무관하게 같다."""
    canonical = json.dumps(payload.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def empty_accepted_graph(text: str) -> dict:
    """화면의 exportAifOva 가 빈 그래프에 대해 내는 모양과 같다."""
    return {
        "AIF": {
            "nodes": [],
            "edges": [],
            "schemefulfillments": [],
            "participants": [],
            "locutions": [],
            "descriptorfulfillments": [],
            "cqdescriptorfulfillments": [],
        },
        "text": text,
        "OVA": {"firstname": "Anon", "surname": "User", "url": "", "nodes": [], "edges": []},
    }


class PublicationService:
    def __init__(
        self,
        settings,
        db: Database,
        *,
        issue_catalog: IssueCatalog | None,
        scheme_catalog: SchemeCatalog | None,
    ):
        self.settings = settings
        self.db = db
        self.issue_catalog = issue_catalog
        self.scheme_catalog = scheme_catalog

    def schemes(self) -> SchemeCatalog | None:
        """사용자가 만든 scheme 을 얹은 카탈로그. version·sha256 은 정본 파일 값 그대로다."""
        return merged_scheme_catalog(self.scheme_catalog, self.db)

    # ---- 실행 컨텍스트 (Desktop Flow 가 실행 시작 때 읽는다) ----
    def context(self) -> dict | None:
        if self.issue_catalog is None or self.scheme_catalog is None:
            return None
        return {
            "schemaVersion": 1,
            "issueCatalog": self.issue_catalog.input_items(),
            "issueCatalogVersion": self.issue_catalog.version,
            "issueCatalogSha256": self.issue_catalog.sha256,
            "schemeCatalog": self.schemes().input_items(),
            "schemeCatalogVersion": self.scheme_catalog.version,
            "schemeCatalogSha256": self.scheme_catalog.sha256,
            "maxSelectedIssues": MAX_SELECTED_ISSUES,
        }

    def viewer_url(self, project_id: str) -> str | None:
        base = self.settings.public_site_url
        return f"{base}/?projectId={project_id}" if base else None

    def _duplicate(self, existing: dict, digest: str) -> PublishOutcome:
        if existing["request_hash"] != digest:
            return PublishOutcome(
                409,
                {"error": {"code": "EXTERNAL_RUN_CONFLICT", "message": t("publish.run_conflict"), "details": []}},
            )
        project_id = existing["project_id"]
        return PublishOutcome(
            200,
            {
                "projectId": project_id,
                "runId": existing["run_id"],
                "revision": self.db.get_project_revision(project_id),
                "status": "saved",
                "viewerUrl": self.viewer_url(project_id),
                "duplicate": True,
                "externalRunId": existing["external_run_id"],
            },
        )

    def _catalog_errors(self, payload: LangflowResultPublish) -> list[str]:
        catalogs = payload.catalogs
        errors = []
        if str(catalogs.issueCatalogVersion) != str(self.issue_catalog.version) or catalogs.issueCatalogSha256 != self.issue_catalog.sha256:
            errors.append(
                t("publish.catalog_issue", got=catalogs.issueCatalogVersion, expected=self.issue_catalog.version)
            )
        if str(catalogs.schemeCatalogVersion) != str(self.scheme_catalog.version) or catalogs.schemeCatalogSha256 != self.scheme_catalog.sha256:
            errors.append(
                t("publish.catalog_scheme", got=catalogs.schemeCatalogVersion, expected=self.scheme_catalog.version)
            )
        return errors

    def _namespace(self) -> str:
        namespace = make_namespace()
        bump = 0
        while self.db.namespace_exists(namespace):
            bump += 1
            namespace = make_namespace(datetime.now(timezone.utc).replace(microsecond=0) + timedelta(seconds=bump))
        return namespace

    def publish(self, principal: str, payload: LangflowResultPublish) -> PublishOutcome:
        digest = request_hash(payload)
        existing = self.db.find_publication(principal, payload.externalRunId)
        if existing:
            return self._duplicate(existing, digest)

        if self.issue_catalog is None or self.scheme_catalog is None:
            return PublishOutcome(503, {"error": {"code": "NO_CATALOG", "message": t("api.no_catalogs_for_run"), "details": []}})
        catalog_errors = self._catalog_errors(payload)
        if catalog_errors:
            return PublishOutcome(
                409, {"error": {"code": "CATALOG_MISMATCH", "message": t("publish.catalog_mismatch"), "details": catalog_errors}}
            )

        text = payload.document.text
        created_at = now_iso()
        run_id = uuid.uuid4().hex[:12]
        namespace = self._namespace()
        try:
            proposal = build_proposal(
                payload.result,
                run_id=run_id,
                document_text=text,
                document_version=1,
                namespace=namespace,
                created_at=created_at,
                issue_catalog=self.issue_catalog,
                # 사용자가 만든 scheme key 도 올바른 값으로 보게 합친 카탈로그를 넘긴다.
                scheme_catalog=self.schemes(),
            )
        except InvalidResultError as error:
            return PublishOutcome(
                422,
                {"error": {"code": getattr(error, "code", "INVALID_RESULT"), "message": str(error), "details": list(error.details)[:50]}},
            )

        source = payload.source.model_dump(mode="json")
        catalogs = {
            "issueCatalogVersion": self.issue_catalog.version,
            "issueCatalogSha256": self.issue_catalog.sha256,
            "schemeCatalogVersion": self.scheme_catalog.version,
            "schemeCatalogSha256": self.scheme_catalog.sha256,
        }
        # 실제로 받은 값만 남긴다. 모르는 Flow 해시·모델 설정은 만들어 넣지 않는다.
        pipeline = {key: value for key, value in {
            "flowId": source.get("flowId"),
            "flowName": source.get("flowName"),
            "componentVersion": source.get("componentVersion"),
            "models": source.get("models") or None,
        }.items() if value}
        result = proposal.to_dict()
        run_record = {
            "runId": run_id,
            "status": "succeeded",
            "createdAt": created_at,
            "updatedAt": created_at,
            "startedAt": None,
            "finishedAt": created_at,
            "documentId": None,  # 아래에서 프로젝트 문서 ID 로 채운다
            "documentVersion": 1,
            "documentHash": document_hash(text),
            "documentLength": len(text),
            "caseId": payload.document.caseId or "",
            "mode": "external",
            "namespace": namespace,
            "flowId": source.get("flowId"),
            "purpose": "analysis",
            "catalogs": catalogs,
            "pipeline": pipeline or None,
            "source": source,
            "externalRunId": payload.externalRunId,
            "publishedBy": principal,
            "cancelRequested": False,
            "error": None,
            "result": result,
            "langflow": None,
            "constraints": {"maxSelectedIssues": MAX_SELECTED_ISSUES, "cancelStopsComputation": False},
        }

        project_id = f"project-{uuid.uuid4().hex[:16]}"
        document_id = f"doc-{uuid.uuid4().hex[:12]}"
        run_record["documentId"] = document_id
        imported = proposal.outcome == "graph"
        # 화면의 toRunRecord 와 같은 모양 + 출처 정보
        run_entry = {
            "runId": run_id,
            "status": "succeeded",
            "createdAt": created_at,
            "startedAt": None,
            "finishedAt": created_at,
            "documentId": document_id,
            "documentVersion": 1,
            "documentHash": run_record["documentHash"],
            "namespace": namespace,
            "mode": "external",
            "flowId": source.get("flowId"),
            "error": None,
            "summary": result["summary"],
            "warnings": result["warnings"],
            "constraints": run_record["constraints"],
            "catalogs": catalogs,
            "pipeline": run_record["pipeline"],
            "outcome": proposal.outcome,
            "purpose": "analysis",
            "stale": False,
            "imported": imported,
            "source": source,
            "externalRunId": payload.externalRunId,
        }
        events = []
        if imported:
            events.append(
                {
                    "id": f"{uuid.uuid4().hex[:8]}-1",
                    "at": created_at,
                    "type": "run-imported",
                    "runId": run_id,
                    "detail": t("publish.event_imported", count=len(result["annotations"])),
                }
            )
        project = {
            "schemaVersion": PROJECT_SCHEMA_VERSION,
            "projectId": project_id,
            "revision": 1,
            "title": payload.document.title or payload.document.caseId or None,
            "document": {
                "id": document_id,
                "text": text,
                "hash": run_record["documentHash"],
                "version": 1,
                "caseId": payload.document.caseId,
            },
            "acceptedGraph": empty_accepted_graph(text),
            "analysisRuns": [run_entry],
            "annotations": result["annotations"],
            "reviewEvents": events,
            "analysisSettings": None,
            "catalogs": catalogs,
            "savedAt": created_at,
        }
        try:
            # 화면이 저장할 때와 같은 검증을 통과하는 문서만 만든다.
            ProjectFile.model_validate(project)
        except ValidationError as error:
            logger.error("published project failed validation: %s", error.errors()[:3])
            return PublishOutcome(
                422, {"error": {"code": "INVALID_RESULT", "message": t("publish.project_invalid"), "details": []}}
            )

        try:
            self.db.publish_external(
                principal=principal,
                external_run_id=payload.externalRunId,
                request_hash=digest,
                run_record=run_record,
                document_text=text,
                project_id=project_id,
                project_revision=1,
                project_document=project,
                created_at=created_at,
            )
        except PublicationConflict as conflict:
            # 동시에 들어온 같은 게시 요청이 먼저 저장됐다.
            return self._duplicate(conflict.existing, digest)
        logger.info("published external run %s → project %s (%s)", run_id, project_id, proposal.outcome)
        return PublishOutcome(
            201,
            {
                "projectId": project_id,
                "runId": run_id,
                "revision": 1,
                "status": "saved",
                "outcome": proposal.outcome,
                "viewerUrl": self.viewer_url(project_id),
                "duplicate": False,
                "externalRunId": payload.externalRunId,
            },
        )
