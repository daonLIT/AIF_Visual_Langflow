"""
요청 시 I-node 요약 생성.

- 분석 flow 의 I-node Summarizer 컴포넌트와 같은 프롬프트·모델 설정으로 Ollama 를 호출한다(파이프라인 편집이 그대로 반영).
- 결과에는 요청 당시 본문 해시(textHash)를 함께 돌려준다. 프런트엔드는 해시가 현재 본문과 같고 사람이 쓴 요약이 아닐 때만 반영한다.
- mock 모드에서는 실제 요약을 만들 수 없으므로 명시적 오류를 낸다(가짜 문구를 채우지 않음).
"""
from __future__ import annotations

import json
import re

import httpx

from ..config import Settings
from .pipeline.repository import PipelineError
from .texthash import text_hash
from ..i18n import t

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
MAX_ITEMS = 40


async def generate_summaries(settings: Settings, config: dict, items: list[dict], http_transport: httpx.AsyncBaseTransport | None = None) -> dict:
    if not settings.is_live:
        raise PipelineError("UNSUPPORTED_IN_MOCK", t("summaries.unsupported_in_mock"), status=501)
    if not items:
        return {"summaries": [], "missing": [], "model": config.get("model")}
    if len(items) > MAX_ITEMS:
        raise PipelineError("TOO_MANY", t("summaries.too_many", max=MAX_ITEMS), status=400)
    template = str(config.get("promptTemplate") or "")
    if "{nodes_json}" not in template:
        raise PipelineError("BAD_PROMPT", t("summaries.bad_prompt"), status=409)
    payload_items = [{"node_id": item["nodeId"], "type": item.get("type") or "I", "text": item["text"]} for item in items]
    messages = []
    if str(config.get("systemMessage") or "").strip():
        messages.append({"role": "system", "content": config["systemMessage"]})
    messages.append({"role": "user", "content": template.replace("{nodes_json}", json.dumps(payload_items, ensure_ascii=False, indent=2))})
    timeout = int(config.get("timeout") or 0)
    try:
        async with httpx.AsyncClient(timeout=None if timeout <= 0 else float(timeout), transport=http_transport) as client:
            response = await client.post(
                f"{str(config.get('baseUrl')).rstrip('/')}/api/chat",
                json={
                    "model": config.get("model"),
                    "messages": messages,
                    "format": "json",
                    "stream": False,
                    "options": {"temperature": float(config.get("temperature") or 0), "num_ctx": int(config.get("numCtx") or 8192)},
                },
            )
    except httpx.HTTPError as error:
        raise PipelineError("OLLAMA", t("summaries.ollama_unreachable", name=error.__class__.__name__), status=502) from error
    if response.status_code >= 400:
        raise PipelineError("OLLAMA", t("summaries.ollama_error", status=response.status_code, body=response.text[:200]), status=502)
    content = (response.json().get("message") or {}).get("content") or ""
    match = _FENCE.match(content.strip())
    try:
        answer = json.loads(match.group(1) if match else content)
    except ValueError as error:
        raise PipelineError("BAD_ANSWER", t("summaries.bad_answer", error=error), status=502) from error
    by_id = {item["nodeId"]: item for item in items}
    summaries = []
    for entry in answer.get("summaries") or [] if isinstance(answer, dict) else []:
        if not isinstance(entry, dict):
            continue
        node_id = str(entry.get("node_id") or "")
        summary = str(entry.get("summary") or "").strip()
        if node_id in by_id and summary:
            summaries.append(
                {
                    "nodeId": node_id,
                    "summary": summary,
                    "summaryOrigin": "ai",
                    # 요청에 쓴 본문의 해시. 늦게 도착해도 본문이 바뀌었으면 반영하지 않게 한다.
                    "textHash": text_hash(by_id[node_id]["text"]),
                }
            )
    found = {s["nodeId"] for s in summaries}
    return {"summaries": summaries, "missing": [node_id for node_id in by_id if node_id not in found], "model": config.get("model")}
