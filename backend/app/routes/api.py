"""HTTP 라우트. FastAPI 대신 그 기반인 Starlette 를 직접 사용한다(의존성 최소화)."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from pydantic import ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..i18n import t
from ..schemas import (
    PROJECT_SCHEMA_VERSION,
    AnalysisRunCreate,
    CustomSchemeCreate,
    CustomSchemeUpdate,
    EvidenceVerifyRequest,
    ProjectFile,
    SummariesRequest,
)
from ..services.catalogs import build_custom_definition, merged_scheme_catalog, new_custom_scheme_key
from ..services.evidence_matcher import DocumentMatcher
from ..services.langflow_client import LangflowError
from ..services.pipeline.repository import PipelineError
from ..services.summaries import generate_summaries
from ..services.run_manager import document_hash

logger = logging.getLogger("annotation.api")


def _error(status: int, code: str, message: str, details: list | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "details": details or []}}, status_code=status)


def catalog_errors(request: Request) -> list[str]:
    """서버 시작 때 모아 둔 카탈로그 오류를 이 요청의 언어로 만든다."""
    return [str(item) for item in request.app.state.catalog_errors]


def _validation_error(error: ValidationError) -> JSONResponse:
    details = [f"{'.'.join(str(p) for p in item['loc'])}: {item['msg']}" for item in error.errors()]
    return _error(422, "VALIDATION", t("api.validation"), details)


async def _json_body(request: Request):
    try:
        return await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        # UTF-8 이 아닌 본문도 잘못된 요청이다(서버 오류가 아니다).
        return None


async def health(request: Request) -> Response:
    settings = request.app.state.settings
    if settings.auth_mode != "off" and getattr(request.state, "principal", None) is None:
        # 인증 없이 보는 상태 확인은 살아 있는지만 알린다(설정·카탈로그 정보는 숨김).
        return JSONResponse({"status": "ok", "time": datetime.now(timezone.utc).isoformat(), "authMode": settings.auth_mode})
    catalog = request.app.state.issue_catalog
    return JSONResponse(
        {
            "status": "ok",
            "time": datetime.now(timezone.utc).isoformat(),
            # 설정값 존재 여부만 담는다. 실제 연결 확인은 /api/diagnostics.
            "langflow": {**settings.public_dict(), "analysisFlowConfigured": bool(request.app.state.pipeline.analysis_flow_id())},
            "catalogs": {
                "issueCatalogVersion": catalog.version if catalog else None,
                "schemeCatalogVersion": request.app.state.scheme_catalog.version if request.app.state.scheme_catalog else None,
                "schemeCatalogStatus": request.app.state.scheme_catalog.data.get("status") if request.app.state.scheme_catalog else None,
                "errors": catalog_errors(request),
            },
            "activeRuns": len(request.app.state.runs._tasks),
        }
    )


async def issue_catalog(request: Request) -> Response:
    catalog = request.app.state.issue_catalog
    if catalog is None:
        return _error(503, "NO_CATALOG", t("api.no_issue_catalog"), catalog_errors(request))
    return JSONResponse(catalog.data)


async def scheme_catalog(request: Request) -> Response:
    catalog = merged_scheme_catalog(request.app.state.scheme_catalog, request.app.state.db)
    if catalog is None:
        return _error(503, "NO_CATALOG", t("api.no_scheme_catalog"), catalog_errors(request))
    return JSONResponse(catalog.public_data())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _name_taken(db, name: str, *, except_key: str | None = None) -> bool:
    """같은 이름의 scheme 이 이미 있는지. 이름이 같으면 목록에서 고를 때 구분할 수 없다."""
    for record in db.list_custom_schemes():
        if record["retired"] or record["schemeKey"] == except_key:
            continue
        if record["definition"].get("nameKo", "").strip() == name:
            return True
    return False


async def create_custom_scheme(request: Request) -> Response:
    """사용자가 그래프 화면에서 만든 scheme 을 목록에 추가한다."""
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", t("api.bad_json"))
    try:
        payload = CustomSchemeCreate.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)
    db = request.app.state.db
    if _name_taken(db, payload.nameKo):
        return _error(409, "NAME_TAKEN", t("api.custom_scheme_name_taken", name=payload.nameKo))
    definition = build_custom_definition(
        new_custom_scheme_key(),
        name_ko=payload.nameKo,
        name_en=payload.nameEn,
        description=payload.description,
        premise_roles=[role.model_dump() for role in payload.premiseRoles],
    )
    record = db.insert_custom_scheme(
        definition["schemeKey"],
        definition,
        enabled_for_ai=payload.enabledForAi,
        by=request.state.principal.principal if getattr(request.state, "principal", None) else "unknown",
        at=_now(),
    )
    catalog = merged_scheme_catalog(request.app.state.scheme_catalog, db)
    return JSONResponse({"schemeKey": record["schemeKey"], "catalog": catalog.public_data() if catalog else None}, status_code=201)


async def update_custom_scheme(request: Request) -> Response:
    """이름·설명·전제 역할을 고치거나, AI 사용 허용·폐기 상태만 바꾼다."""
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", t("api.bad_json"))
    try:
        payload = CustomSchemeUpdate.model_validate(body)
        fields = payload.definition_fields()
    except ValidationError as error:
        return _validation_error(error)
    except ValueError as error:
        return _error(422, "VALIDATION", str(error))
    db = request.app.state.db
    scheme_key = request.path_params["scheme_key"]
    existing = db.get_custom_scheme(scheme_key)
    if existing is None:
        return _error(404, "NOT_FOUND", t("api.custom_scheme_not_found"))
    definition = None
    if fields is not None:
        name_ko, name_en, description, roles = fields
        if _name_taken(db, name_ko, except_key=scheme_key):
            return _error(409, "NAME_TAKEN", t("api.custom_scheme_name_taken", name=name_ko))
        definition = build_custom_definition(
            scheme_key,
            name_ko=name_ko,
            name_en=name_en,
            description=description,
            premise_roles=[role.model_dump() for role in roles],
            previous=existing["definition"],
        )
    db.update_custom_scheme(
        scheme_key,
        definition=definition,
        enabled_for_ai=payload.enabledForAi,
        retired=payload.retired,
        by=request.state.principal.principal if getattr(request.state, "principal", None) else "unknown",
        at=_now(),
    )
    catalog = merged_scheme_catalog(request.app.state.scheme_catalog, db)
    return JSONResponse({"schemeKey": scheme_key, "catalog": catalog.public_data() if catalog else None})


async def create_run(request: Request) -> Response:
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", t("api.bad_json"))
    try:
        payload = AnalysisRunCreate.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)

    if request.app.state.issue_catalog is None or request.app.state.scheme_catalog is None:
        return _error(503, "NO_CATALOG", t("api.no_catalogs_for_run"), catalog_errors(request))
    flow_id = payload.flowId or request.app.state.pipeline.analysis_flow_id()

    record, created = await request.app.state.runs.submit(
        text=payload.text,
        document_id=payload.documentId,
        document_version=payload.documentVersion,
        case_id=payload.caseId,
        idempotency_key=payload.idempotencyKey,
        flow_id=flow_id,
        purpose=payload.purpose,
    )
    return JSONResponse(record, status_code=202 if created else 200)


async def get_run(request: Request) -> Response:
    record = request.app.state.runs.get(request.path_params["run_id"])
    if record is None:
        return _error(404, "NOT_FOUND", t("api.run_not_found"))
    return JSONResponse(record)


async def cancel_run(request: Request) -> Response:
    record = await request.app.state.runs.cancel(request.path_params["run_id"])
    if record is None:
        return _error(404, "NOT_FOUND", t("api.run_not_found"))
    return JSONResponse(record)


async def list_runs(request: Request) -> Response:
    records = request.app.state.db.list_runs(limit=50)
    slim = [
        {k: v for k, v in record.items() if k != "result"} | {"hasResult": record.get("result") is not None}
        for record in records
    ]
    return JSONResponse({"runs": slim})


async def get_project(request: Request) -> Response:
    project = request.app.state.db.get_project(request.path_params["project_id"])
    if project is None:
        return _error(404, "NOT_FOUND", t("api.project_not_found"))
    return JSONResponse(project)


async def put_project(request: Request) -> Response:
    project_id = request.path_params["project_id"]
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", t("api.bad_json"))
    try:
        project = ProjectFile.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)
    if project.projectId != project_id:
        return _error(400, "ID_MISMATCH", t("api.project_id_mismatch"))
    if document_hash(project.document.text) != project.document.hash:
        return _error(400, "HASH_MISMATCH", t("api.hash_mismatch"))

    db = request.app.state.db
    current = db.get_project_revision(project_id)
    # revision 검사: 클라이언트는 자신이 읽은 revision 을 보내고, 서버는 그것이 최신일 때만 +1 로 저장한다.
    if current is not None and project.revision != current:
        return _error(
            409,
            "REVISION_CONFLICT",
            t("api.revision_conflict", server=current, requested=project.revision),
        )
    next_revision = (current if current is not None else project.revision) + 1
    saved_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    document = project.model_dump(mode="json")
    document["schemaVersion"] = PROJECT_SCHEMA_VERSION
    document["revision"] = next_revision
    document["savedAt"] = saved_at
    db.save_project(project_id, next_revision, saved_at, document)
    return JSONResponse({"projectId": project_id, "revision": next_revision, "savedAt": saved_at})


async def list_projects(request: Request) -> Response:
    return JSONResponse({"projects": request.app.state.db.list_projects()})


async def summaries(request: Request) -> Response:
    """요청 시 요약 생성. 분석 flow 의 Summarizer 설정을 쓴다."""
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", t("api.bad_json"))
    try:
        payload = SummariesRequest.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)
    pipeline = request.app.state.pipeline
    try:
        if not request.app.state.settings.is_live:
            raise PipelineError("UNSUPPORTED_IN_MOCK", t("summaries.unsupported_in_mock"), status=501)
        config = await pipeline.summarizer_config(payload.flowId or pipeline.analysis_flow_id())
        result = await generate_summaries(request.app.state.settings, config, [item.model_dump() for item in payload.items])
    except PipelineError as error:
        return _error(error.status, error.code, str(error), error.details)
    except LangflowError as error:
        return _error(502, error.code, str(error))
    return JSONResponse(result)


async def verify_evidence(request: Request) -> Response:
    """UI 가 만든 수동 근거 범위 또는 인용문을 서버 규칙으로 재검증한다."""
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", t("api.bad_json"))
    try:
        payload = EvidenceVerifyRequest.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)
    matcher = DocumentMatcher(payload.text)
    results = []
    for span in payload.spans:
        quote = span.get("quote")
        start, end = span.get("start"), span.get("end")
        if isinstance(start, int) and isinstance(end, int):
            ok = matcher.verify_span(start, end, quote if isinstance(quote, str) else None)
            results.append({"start": start, "end": end, "quote": quote, "valid": ok})
        elif isinstance(quote, str):
            results.append(matcher.match(quote).to_dict(int(span.get("documentVersion") or 1)))
        else:
            results.append({"valid": False, "reason": t("api.evidence_needs_quote")})
    return JSONResponse({"results": results})


routes = [
    Route("/api/health", health, methods=["GET"]),
    Route("/api/catalogs/issues", issue_catalog, methods=["GET"]),
    Route("/api/catalogs/schemes", scheme_catalog, methods=["GET"]),
    Route("/api/catalogs/schemes/custom", create_custom_scheme, methods=["POST"]),
    Route("/api/catalogs/schemes/custom/{scheme_key}", update_custom_scheme, methods=["PUT"]),
    Route("/api/analysis-runs", create_run, methods=["POST"]),
    Route("/api/analysis-runs", list_runs, methods=["GET"]),
    Route("/api/analysis-runs/{run_id}", get_run, methods=["GET"]),
    Route("/api/analysis-runs/{run_id}/cancel", cancel_run, methods=["POST"]),
    Route("/api/projects", list_projects, methods=["GET"]),
    Route("/api/projects/{project_id}", get_project, methods=["GET"]),
    Route("/api/projects/{project_id}", put_project, methods=["PUT"]),
    Route("/api/evidence/verify", verify_evidence, methods=["POST"]),
    Route("/api/summaries", summaries, methods=["POST"]),
]
