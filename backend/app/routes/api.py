"""HTTP 라우트. FastAPI 대신 그 기반인 Starlette 를 직접 사용한다(의존성 최소화)."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from pydantic import ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..schemas import PROJECT_SCHEMA_VERSION, AnalysisRunCreate, EvidenceVerifyRequest, ProjectFile, SummariesRequest
from ..services.evidence_matcher import DocumentMatcher
from ..services.langflow_client import LangflowError
from ..services.pipeline.repository import PipelineError
from ..services.summaries import generate_summaries
from ..services.run_manager import document_hash

logger = logging.getLogger("annotation.api")


def _error(status: int, code: str, message: str, details: list | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "details": details or []}}, status_code=status)


def _validation_error(error: ValidationError) -> JSONResponse:
    details = [f"{'.'.join(str(p) for p in item['loc'])}: {item['msg']}" for item in error.errors()]
    return _error(422, "VALIDATION", "요청 본문이 올바르지 않습니다.", details)


async def _json_body(request: Request):
    try:
        return await request.json()
    except json.JSONDecodeError:
        return None


async def health(request: Request) -> Response:
    settings = request.app.state.settings
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
                "errors": request.app.state.catalog_errors,
            },
            "activeRuns": len(request.app.state.runs._tasks),
        }
    )


async def issue_catalog(request: Request) -> Response:
    catalog = request.app.state.issue_catalog
    if catalog is None:
        return _error(503, "NO_CATALOG", "쟁점 카탈로그를 불러오지 못했습니다.", request.app.state.catalog_errors)
    return JSONResponse(catalog.data)


async def scheme_catalog(request: Request) -> Response:
    catalog = request.app.state.scheme_catalog
    if catalog is None:
        return _error(503, "NO_CATALOG", "스킴 카탈로그를 불러오지 못했습니다.", request.app.state.catalog_errors)
    return JSONResponse(catalog.data)


async def create_run(request: Request) -> Response:
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", "JSON 본문을 해석할 수 없습니다.")
    try:
        payload = AnalysisRunCreate.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)

    if request.app.state.issue_catalog is None or request.app.state.scheme_catalog is None:
        return _error(503, "NO_CATALOG", "쟁점·scheme 카탈로그를 불러오지 못해 분석할 수 없습니다.", request.app.state.catalog_errors)
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
        return _error(404, "NOT_FOUND", "실행을 찾을 수 없습니다.")
    return JSONResponse(record)


async def cancel_run(request: Request) -> Response:
    record = await request.app.state.runs.cancel(request.path_params["run_id"])
    if record is None:
        return _error(404, "NOT_FOUND", "실행을 찾을 수 없습니다.")
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
        return _error(404, "NOT_FOUND", "프로젝트를 찾을 수 없습니다.")
    return JSONResponse(project)


async def put_project(request: Request) -> Response:
    project_id = request.path_params["project_id"]
    body = await _json_body(request)
    if body is None:
        return _error(400, "BAD_JSON", "JSON 본문을 해석할 수 없습니다.")
    try:
        project = ProjectFile.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)
    if project.projectId != project_id:
        return _error(400, "ID_MISMATCH", "경로의 projectId 와 본문의 projectId 가 다릅니다.")
    if document_hash(project.document.text) != project.document.hash:
        return _error(400, "HASH_MISMATCH", "document.hash 가 원문과 일치하지 않습니다.")

    db = request.app.state.db
    current = db.get_project_revision(project_id)
    # revision 검사: 클라이언트는 자신이 읽은 revision 을 보내고, 서버는 그것이 최신일 때만 +1 로 저장한다.
    if current is not None and project.revision != current:
        return _error(
            409,
            "REVISION_CONFLICT",
            f"프로젝트가 다른 곳에서 수정되었습니다 (서버 revision {current}, 요청 revision {project.revision}).",
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
        return _error(400, "BAD_JSON", "JSON 본문을 해석할 수 없습니다.")
    try:
        payload = SummariesRequest.model_validate(body)
    except ValidationError as error:
        return _validation_error(error)
    pipeline = request.app.state.pipeline
    try:
        if not request.app.state.settings.is_live:
            raise PipelineError("UNSUPPORTED_IN_MOCK", "mock 모드에서는 실제 요약을 만들 수 없습니다. live 모드에서 사용하세요.", status=501)
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
        return _error(400, "BAD_JSON", "JSON 본문을 해석할 수 없습니다.")
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
            results.append({"valid": False, "reason": "quote 또는 start/end 가 필요합니다."})
    return JSONResponse({"results": results})


routes = [
    Route("/api/health", health, methods=["GET"]),
    Route("/api/catalogs/issues", issue_catalog, methods=["GET"]),
    Route("/api/catalogs/schemes", scheme_catalog, methods=["GET"]),
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
