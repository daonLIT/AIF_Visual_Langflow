"""Langflow Desktop 연동 API: 실행 컨텍스트(카탈로그) 조회와 분석 결과 게시."""
from __future__ import annotations

import json

from pydantic import ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..i18n import t
from ..schemas import LangflowResultPublish
from .api import _error, _validation_error, catalog_errors


async def langflow_context(request: Request) -> Response:
    context = request.app.state.publication.context()
    if context is None:
        return _error(503, "NO_CATALOG", t("api.no_catalogs_for_run"), catalog_errors(request))
    return JSONResponse(context)


async def _limited_body(request: Request, limit: int) -> bytes | None:
    """본문을 limit 바이트까지만 읽는다. 넘으면 None."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        return None
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


async def publish_langflow_result(request: Request) -> Response:
    settings = request.app.state.settings
    body = await _limited_body(request, settings.max_publish_bytes)
    if body is None:
        return _error(413, "TOO_LARGE", t("publish.too_large", max=f"{settings.max_publish_bytes:,}"))
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _error(400, "BAD_JSON", t("api.bad_json"))
    try:
        payload = LangflowResultPublish.model_validate(data)
    except ValidationError as error:
        return _validation_error(error)
    principal = request.state.principal
    outcome = request.app.state.publication.publish(principal.principal, payload)
    return JSONResponse(outcome.body, status_code=outcome.status)


routes = [
    Route("/api/integrations/langflow/context", langflow_context, methods=["GET"]),
    Route("/api/integrations/langflow/results", publish_langflow_result, methods=["POST"]),
]
