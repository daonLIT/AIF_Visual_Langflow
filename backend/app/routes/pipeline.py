"""
파이프라인 편집 API (우리 서버 API. Langflow 공식 경로와 구분). 브라우저는 Langflow 에 직접 접근하지 않는다.

    GET    /api/pipelines                      flow 목록 (실행용 스냅샷 제외)
    GET    /api/pipelines/{id}                 flow 조회 (비밀 값 마스킹, 실행 해시, 초안 차이)
    POST   /api/pipelines/{id}/clone           작업용 복제
    GET    /api/pipelines/{id}/draft           초안
    PUT    /api/pipelines/{id}/draft           초안 저장
    DELETE /api/pipelines/{id}/draft           초안 버리기
    POST   /api/pipelines/{id}/validate        검증
    POST   /api/pipelines/{id}/apply           Langflow 적용 (충돌 검사 → 백업 → PATCH → 재조회 확인 → 선택: 테스트 실행)
    POST   /api/pipelines/{id}/test            테스트 실행 (Langflow 에 저장된 flow)
    GET    /api/pipelines/{id}/versions        버전 기록
    POST   /api/pipelines/{id}/restore         이전 버전 복원
    GET    /api/connections/status             Langflow·분석 flow·Ollama·모델·카탈로그 실제 연결 확인
    GET    /api/pipeline-components/templates  추가 가능한 컴포넌트
    POST   /api/pipeline-components/rebuild    코드로 컴포넌트 입력·출력 재구성 (live)
    PUT    /api/pipeline-settings/analysis-flow 분석에 사용할 flow 지정
"""
from __future__ import annotations

import json
import logging

from pydantic import BaseModel, Field, ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..services.langflow_client import LangflowError
from ..services.pipeline.repository import PipelineError

logger = logging.getLogger("annotation.pipeline")


class TestRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200_000)
    documentId: str | None = Field(None, max_length=128)
    documentVersion: int = Field(1, ge=1)
    caseId: str | None = Field(None, max_length=128)


class FlowDataBody(BaseModel):
    data: dict
    baseUpdatedAt: str | None = None
    baseHash: str | None = Field(None, max_length=128)
    note: str | None = Field(None, max_length=500)
    name: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=2000)
    # 적용이 확인되면 이 원문으로 바로 테스트 실행한다.
    test: TestRequest | None = None


class ValidateBody(BaseModel):
    data: dict
    checkCode: bool = False


class CloneBody(BaseModel):
    name: str | None = Field(None, max_length=200)


class RestoreBody(BaseModel):
    versionId: str = Field(..., min_length=1, max_length=64)
    baseUpdatedAt: str | None = None
    baseHash: str | None = Field(None, max_length=128)


class RebuildBody(BaseModel):
    code: str = Field(..., min_length=1, max_length=500_000)
    frontendNode: dict | None = None


class AnalysisFlowBody(BaseModel):
    flowId: str | None = None


def _error(status: int, code: str, message: str, details: list | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "details": details or []}}, status_code=status)


async def _body(request: Request, model: type[BaseModel]):
    try:
        raw = await request.json()
    except json.JSONDecodeError:
        return None, _error(400, "BAD_JSON", "JSON 본문을 해석할 수 없습니다.")
    try:
        return model.model_validate(raw), None
    except ValidationError as error:
        details = [f"{'.'.join(str(p) for p in item['loc'])}: {item['msg']}" for item in error.errors()]
        return None, _error(422, "VALIDATION", "요청 본문이 올바르지 않습니다.", details)


def _handles_errors(handler):
    async def wrapped(request: Request) -> Response:
        try:
            return await handler(request)
        except PipelineError as error:
            return _error(error.status, error.code, str(error), error.details)
        except LangflowError as error:
            status = error.status if error.status in (401, 403, 404) else 502
            return _error(status, error.code, str(error))

    wrapped.__name__ = handler.__name__
    return wrapped


def _service(request: Request):
    return request.app.state.pipeline


async def _start_test(request: Request, flow_id: str, test: TestRequest) -> dict:
    from ..services.run_manager import document_hash

    record, _created = await request.app.state.runs.submit(
        text=test.text,
        document_id=test.documentId or f"pipeline-test-{document_hash(test.text)[:12]}",
        document_version=test.documentVersion,
        case_id=test.caseId,
        idempotency_key=None,
        flow_id=flow_id,
        purpose="pipeline-test",
    )
    return record


@_handles_errors
async def list_flows(request: Request) -> Response:
    return JSONResponse(await _service(request).list_flows())


@_handles_errors
async def get_flow(request: Request) -> Response:
    return JSONResponse(await _service(request).get_flow(request.path_params["flow_id"]))


@_handles_errors
async def clone_flow(request: Request) -> Response:
    body, error = await _body(request, CloneBody)
    if error:
        return error
    return JSONResponse(await _service(request).clone(request.path_params["flow_id"], body.name), status_code=201)


@_handles_errors
async def get_draft(request: Request) -> Response:
    draft = await _service(request).get_draft(request.path_params["flow_id"])
    if draft is None:
        return _error(404, "NOT_FOUND", "저장된 초안이 없습니다.")
    return JSONResponse(draft)


@_handles_errors
async def put_draft(request: Request) -> Response:
    body, error = await _body(request, FlowDataBody)
    if error:
        return error
    result = await _service(request).save_draft(request.path_params["flow_id"], body.data, body.baseUpdatedAt, body.note, base_hash=body.baseHash)
    return JSONResponse(result)


@_handles_errors
async def delete_draft(request: Request) -> Response:
    await _service(request).discard_draft(request.path_params["flow_id"])
    return JSONResponse({"ok": True})


@_handles_errors
async def validate_flow(request: Request) -> Response:
    body, error = await _body(request, ValidateBody)
    if error:
        return error
    return JSONResponse(await _service(request).validate(request.path_params.get("flow_id"), body.data, check_code=body.checkCode))


@_handles_errors
async def apply_flow(request: Request) -> Response:
    body, error = await _body(request, FlowDataBody)
    if error:
        return error
    flow_id = request.path_params["flow_id"]
    view = await _service(request).apply(
        flow_id,
        body.data,
        base_updated_at=body.baseUpdatedAt,
        base_hash=body.baseHash,
        note=body.note,
        name=body.name,
        description=body.description,
    )
    logger.info("pipeline flow %s applied (verified)", flow_id)
    if body.test is not None:
        view["testRun"] = await _start_test(request, flow_id, body.test)
    return JSONResponse(view)


@_handles_errors
async def test_flow(request: Request) -> Response:
    body, error = await _body(request, TestRequest)
    if error:
        return error
    flow_id = request.path_params["flow_id"]
    await _service(request).get_flow(flow_id)  # 존재 확인
    return JSONResponse(await _start_test(request, flow_id, body), status_code=202)


@_handles_errors
async def list_versions(request: Request) -> Response:
    return JSONResponse(await _service(request).list_versions(request.path_params["flow_id"]))


@_handles_errors
async def restore_version(request: Request) -> Response:
    body, error = await _body(request, RestoreBody)
    if error:
        return error
    view = await _service(request).restore_version(request.path_params["flow_id"], body.versionId, body.baseUpdatedAt, body.baseHash)
    return JSONResponse(view)


@_handles_errors
async def component_templates(request: Request) -> Response:
    return JSONResponse(await _service(request).component_templates(request.query_params.get("flowId")))


@_handles_errors
async def rebuild_component(request: Request) -> Response:
    body, error = await _body(request, RebuildBody)
    if error:
        return error
    return JSONResponse(await _service(request).rebuild_component(body.code, body.frontendNode))


@_handles_errors
async def set_analysis_flow(request: Request) -> Response:
    body, error = await _body(request, AnalysisFlowBody)
    if error:
        return error
    return JSONResponse(await _service(request).set_analysis_flow(body.flowId))


@_handles_errors
async def connection_status(request: Request) -> Response:
    return JSONResponse(await _service(request).connection_status())


routes = [
    Route("/api/connections/status", connection_status, methods=["GET"]),
    Route("/api/pipeline-components/templates", component_templates, methods=["GET"]),
    Route("/api/pipeline-components/rebuild", rebuild_component, methods=["POST"]),
    Route("/api/pipeline-settings/analysis-flow", set_analysis_flow, methods=["PUT"]),
    Route("/api/pipelines", list_flows, methods=["GET"]),
    Route("/api/pipelines/{flow_id}", get_flow, methods=["GET"]),
    Route("/api/pipelines/{flow_id}/clone", clone_flow, methods=["POST"]),
    Route("/api/pipelines/{flow_id}/draft", get_draft, methods=["GET"]),
    Route("/api/pipelines/{flow_id}/draft", put_draft, methods=["PUT"]),
    Route("/api/pipelines/{flow_id}/draft", delete_draft, methods=["DELETE"]),
    Route("/api/pipelines/{flow_id}/validate", validate_flow, methods=["POST"]),
    Route("/api/pipelines/{flow_id}/apply", apply_flow, methods=["POST"]),
    Route("/api/pipelines/{flow_id}/test", test_flow, methods=["POST"]),
    Route("/api/pipelines/{flow_id}/versions", list_versions, methods=["GET"]),
    Route("/api/pipelines/{flow_id}/restore", restore_version, methods=["POST"]),
]
