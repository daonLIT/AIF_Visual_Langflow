"""
분석 실행(run) 상태 관리.

- 상태: queued -> running -> succeeded | failed | cancelled ; 서버 재시작 시 진행 중이던 실행은 interrupted.
- 동시 실행 수는 세마포어로 제한한다(Ollama 자원 경합 방지).
- 중복 요청 키(idempotencyKey)가 같으면 새 실행을 만들지 않고 기존 실행을 돌려준다.
- 로컬 취소는 서버의 대기/응답 반영을 멈출 뿐 Langflow/Ollama 계산 자체를 중단하지 못할 수 있다.
- 로그에는 원문·API 키를 남기지 않는다.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from datetime import datetime, timezone

from ..config import Settings
from ..storage import Database
from .aif_adapter import InvalidResultError, build_proposal, make_namespace, parse_json_text
from .langflow_client import LangflowClient, LangflowError

logger = logging.getLogger("annotation.runs")

ACTIVE_STATUSES = ("queued", "running")
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled", "interrupted")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def document_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class RunManager:
    def __init__(self, settings: Settings, db: Database, client: LangflowClient):
        self.settings = settings
        self.db = db
        self.client = client
        self._semaphore = asyncio.Semaphore(max(1, settings.max_concurrency))
        self._tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    # ---- lifecycle ----
    def recover_interrupted(self) -> int:
        """서버 재시작 시 진행 중이던 실행을 interrupted 로 표시한다."""
        count = 0
        for record in self.db.list_runs(ACTIVE_STATUSES, limit=1000):
            record["status"] = "interrupted"
            record["updatedAt"] = now_iso()
            record["finishedAt"] = record["updatedAt"]
            record["error"] = {
                "code": "INTERRUPTED",
                "message": "서버가 재시작되어 실행이 중단되었습니다. 다시 분석하세요.",
                "details": [],
            }
            self.db.save_run(record, self.db.get_run_document(record["runId"]) or "", None)
            count += 1
        if count:
            logger.warning("recovered %d interrupted run(s)", count)
        return count

    async def shutdown(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    # ---- API ----
    def public_record(self, record: dict) -> dict:
        return record

    async def submit(
        self,
        *,
        text: str,
        document_id: str,
        document_version: int,
        case_id: str | None,
        idempotency_key: str | None,
    ) -> tuple[dict, bool]:
        """(record, created) 를 돌려준다. created=False 면 중복 키로 기존 실행을 재사용한 것."""
        async with self._lock:
            if idempotency_key:
                existing = self.db.find_run_by_idempotency(idempotency_key)
                if existing and existing["status"] not in ("failed", "cancelled", "interrupted"):
                    return existing, False

            created_at = now_iso()
            namespace = make_namespace()
            bump = 0
            while self.db.namespace_exists(namespace):
                # 같은 초에 만들어진 실행과 ID 접미사가 겹치지 않도록 밀어낸다.
                bump += 1
                namespace = make_namespace(datetime.now(timezone.utc).replace(microsecond=0) + _seconds(bump))

            record = {
                "runId": uuid.uuid4().hex[:12],
                "status": "queued",
                "createdAt": created_at,
                "updatedAt": created_at,
                "startedAt": None,
                "finishedAt": None,
                "documentId": document_id,
                "documentVersion": document_version,
                "documentHash": document_hash(text),
                "documentLength": len(text),
                "caseId": case_id or "",
                "mode": self.settings.langflow_mode,
                "namespace": namespace,
                "flowId": self.settings.langflow_flow_id or None,
                "outputComponentId": self.settings.langflow_output_component_id,
                "cancelRequested": False,
                "error": None,
                "result": None,
                "langflow": None,
                "constraints": {
                    "issueCount": 3,
                    "cancelStopsComputation": False,
                },
            }
            self.db.save_run(record, text, idempotency_key)
            task = asyncio.create_task(self._execute(record["runId"]))
            self._tasks[record["runId"]] = task
            task.add_done_callback(lambda _t, rid=record["runId"]: self._tasks.pop(rid, None))
            logger.info("run %s queued (mode=%s, length=%d)", record["runId"], record["mode"], len(text))
            return record, True

    def get(self, run_id: str) -> dict | None:
        return self.db.get_run(run_id)

    async def cancel(self, run_id: str) -> dict | None:
        record = self.db.get_run(run_id)
        if record is None:
            return None
        if record["status"] in TERMINAL_STATUSES:
            return record
        record["cancelRequested"] = True
        record["status"] = "cancelled"
        record["updatedAt"] = now_iso()
        record["finishedAt"] = record["updatedAt"]
        record["error"] = {
            "code": "CANCELLED",
            "message": "사용자가 취소했습니다. Langflow/Ollama 계산은 계속 진행 중일 수 있습니다.",
            "details": [],
        }
        self._save(record)
        task = self._tasks.get(run_id)
        if task:
            task.cancel()
        logger.info("run %s cancelled", run_id)
        return record

    # ---- internals ----
    def _save(self, record: dict) -> None:
        self.db.save_run(record, self.db.get_run_document(record["runId"]) or "", None)

    async def _execute(self, run_id: str) -> None:
        try:
            async with self._semaphore:
                record = self.db.get_run(run_id)
                if record is None or record["status"] != "queued":
                    return
                record["status"] = "running"
                record["startedAt"] = now_iso()
                record["updatedAt"] = record["startedAt"]
                self._save(record)
                text = self.db.get_run_document(run_id) or ""

                try:
                    result = await asyncio.wait_for(
                        self.client.analyze(text, record.get("caseId") or None),
                        timeout=self.settings.langflow_timeout_seconds + 5,
                    )
                except asyncio.TimeoutError:
                    raise LangflowError("TIMEOUT", "서버 실행 제한 시간을 초과했습니다.")

                # 늦게 도착한 응답: 이미 취소되었으면 반영하지 않는다.
                current = self.db.get_run(run_id)
                if current is None or current["status"] != "running" or current.get("cancelRequested"):
                    logger.info("run %s finished after cancel; result discarded", run_id)
                    return

                parsed = parse_json_text(result.output_text)
                proposal = build_proposal(
                    parsed,
                    run_id=run_id,
                    document_text=text,
                    document_version=int(current["documentVersion"]),
                    namespace=current["namespace"],
                    created_at=now_iso(),
                )
                current["status"] = "succeeded"
                current["result"] = proposal.to_dict()
                current["langflow"] = {
                    "sessionId": result.session_id,
                    "outputComponentId": result.component_id,
                    "flowId": self.settings.langflow_flow_id or None,
                }
                current["finishedAt"] = now_iso()
                current["updatedAt"] = current["finishedAt"]
                self._save(current)
                logger.info(
                    "run %s succeeded (%d nodes / %d edges)",
                    run_id,
                    proposal.summary["nodeCount"],
                    proposal.summary["edgeCount"],
                )
        except asyncio.CancelledError:
            # cancel() 이 이미 상태를 기록했다.
            return
        except (LangflowError, InvalidResultError) as error:
            self._fail(run_id, getattr(error, "code", "INVALID_RESULT"), str(error), getattr(error, "details", []))
        except Exception as error:  # noqa: BLE001 - 알 수 없는 오류도 실행 실패로 기록한다.
            logger.exception("run %s failed unexpectedly", run_id)
            self._fail(run_id, "INTERNAL", f"예상하지 못한 오류: {error.__class__.__name__}", [])

    def _fail(self, run_id: str, code: str, message: str, details: list[str]) -> None:
        record = self.db.get_run(run_id)
        if record is None or record["status"] in TERMINAL_STATUSES:
            return
        record["status"] = "failed"
        record["error"] = {"code": code, "message": message, "details": list(details)[:50]}
        record["finishedAt"] = now_iso()
        record["updatedAt"] = record["finishedAt"]
        self._save(record)
        logger.warning("run %s failed: %s", run_id, code)


def _seconds(n: int):
    from datetime import timedelta

    return timedelta(seconds=n)
