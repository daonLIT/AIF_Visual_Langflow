import asyncio
import json
import time
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.langflow_client import LangflowError, MockLangflowTransport
from app.services.run_manager import document_hash
from app.storage import Database

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "langflow_run_response.sample.json"
SAMPLE = Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "sample" / "sample-case.json"
TEXT = json.loads(SAMPLE.read_text(encoding="utf-8"))["text"]


class FailingTransport:
    def __init__(self, error: Exception):
        self.error = error

    async def run(self, judgment_text, case_id):
        raise self.error


class SlowTransport(MockLangflowTransport):
    def __init__(self, delay):
        super().__init__(FIXTURE, delay)


class BadOutputTransport:
    async def run(self, judgment_text, case_id):
        envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
        envelope["outputs"][0]["outputs"][0]["results"]["message"]["text"] = '{"AIF": {"nodes": []}}'
        return envelope


def make_client(transport=None, settings=None, db=None):
    settings = settings or Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0)
    app = create_app(settings, transport=transport, db=db or Database(":memory:"))
    return TestClient(app)


def wait_terminal(client, run_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        record = client.get(f"/api/analysis-runs/{run_id}").json()
        if record["status"] not in ("queued", "running"):
            return record
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def submit(client, **overrides):
    body = {"text": TEXT, "documentId": "doc1", "documentVersion": 1, "caseId": "SAMPLE"}
    body.update(overrides)
    return client.post("/api/analysis-runs", json=body)


class HealthTest(unittest.TestCase):
    def test_health_hides_secret(self):
        settings = Settings(langflow_mode="mock", langflow_api_key="super-secret", mock_fixture_path=FIXTURE)
        with make_client(settings=settings) as client:
            response = client.get("/api/health")
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("super-secret", response.text)
            self.assertTrue(response.json()["langflow"]["apiKeyConfigured"])


class RunLifecycleTest(unittest.TestCase):
    def test_mock_run_succeeds_and_preserves_text(self):
        with make_client() as client:
            response = submit(client)
            self.assertEqual(response.status_code, 202)
            record = wait_terminal(client, response.json()["runId"])
            self.assertEqual(record["status"], "succeeded", record.get("error"))
            self.assertEqual(record["documentHash"], document_hash(TEXT))
            result = record["result"]
            self.assertEqual(result["graph"]["text"], TEXT)
            self.assertEqual(result["summary"]["nodeCount"], 23)
            self.assertTrue(all(n["nodeID"].endswith(record["namespace"]) for n in result["graph"]["AIF"]["nodes"]))

    def test_validation_errors(self):
        with make_client() as client:
            self.assertEqual(submit(client, text="   ").status_code, 422)
            self.assertEqual(client.post("/api/analysis-runs", content=b"{bad", headers={"content-type": "application/json"}).status_code, 400)
            self.assertEqual(client.get("/api/analysis-runs/nope").status_code, 404)

    def test_idempotency_key_reuses_run(self):
        with make_client(transport=SlowTransport(0.5)) as client:
            first = submit(client, idempotencyKey="k1")
            second = submit(client, idempotencyKey="k1")
            self.assertEqual(first.status_code, 202)
            self.assertEqual(second.status_code, 200)
            self.assertEqual(first.json()["runId"], second.json()["runId"])
            wait_terminal(client, first.json()["runId"])

    def test_cancel_discards_late_result(self):
        with make_client(transport=SlowTransport(0.6)) as client:
            run_id = submit(client).json()["runId"]
            cancelled = client.post(f"/api/analysis-runs/{run_id}/cancel").json()
            self.assertEqual(cancelled["status"], "cancelled")
            time.sleep(0.9)
            record = client.get(f"/api/analysis-runs/{run_id}").json()
            self.assertEqual(record["status"], "cancelled")
            self.assertIsNone(record["result"])
            self.assertFalse(record["constraints"]["cancelStopsComputation"])

    def test_langflow_failures_are_reported(self):
        cases = [
            (LangflowError("AUTH", "auth failed", status=401), "AUTH"),
            (LangflowError("CONNECTION", "no server"), "CONNECTION"),
            (LangflowError("TIMEOUT", "timeout"), "TIMEOUT"),
        ]
        for error, code in cases:
            with make_client(transport=FailingTransport(error)) as client:
                run_id = submit(client).json()["runId"]
                record = wait_terminal(client, run_id)
                self.assertEqual(record["status"], "failed")
                self.assertEqual(record["error"]["code"], code)

    def test_invalid_graph_from_langflow_fails_run(self):
        with make_client(transport=BadOutputTransport()) as client:
            record = wait_terminal(client, submit(client).json()["runId"])
            self.assertEqual(record["status"], "failed")
            self.assertEqual(record["error"]["code"], "INVALID_RESULT")

    def test_restart_marks_running_as_interrupted(self):
        db = Database(":memory:")
        with make_client(transport=SlowTransport(5), db=db) as client:
            run_id = submit(client).json()["runId"]
            time.sleep(0.1)
            self.assertEqual(client.get(f"/api/analysis-runs/{run_id}").json()["status"], "running")
        # 같은 DB 로 서버를 다시 띄우면 진행 중이던 실행이 interrupted 로 복구된다.
        with make_client(transport=SlowTransport(5), db=db) as client:
            self.assertEqual(client.get(f"/api/analysis-runs/{run_id}").json()["status"], "interrupted")

    def test_concurrency_is_limited(self):
        settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0.3, max_concurrency=1)
        with make_client(settings=settings) as client:
            ids = [submit(client).json()["runId"] for _ in range(2)]
            time.sleep(0.1)
            statuses = sorted(client.get(f"/api/analysis-runs/{i}").json()["status"] for i in ids)
            self.assertEqual(statuses, ["queued", "running"])
            for i in ids:
                self.assertEqual(wait_terminal(client, i)["status"], "succeeded")


class ProjectTest(unittest.TestCase):
    def project(self, revision=0):
        return {
            "schemaVersion": 1,
            "projectId": "p1",
            "revision": revision,
            "title": "테스트",
            "document": {"id": "doc1", "text": TEXT, "hash": document_hash(TEXT), "version": 1},
            "acceptedGraph": {"AIF": {"nodes": [], "edges": []}, "text": TEXT, "OVA": {"nodes": [], "edges": []}},
            "analysisRuns": [],
            "annotations": [
                {
                    "id": "r:node:1",
                    "runId": "r",
                    "kind": "node",
                    "nodeId": "1_x",
                    "origin": "ai",
                    "status": "accepted",
                    "originalValue": {"type": "I", "text": "a"},
                    "currentValue": {"type": "I", "text": "a"},
                    "evidence": [{"quote": "a", "start": 0, "end": 1, "match": "exact", "documentVersion": 1}],
                    "createdAt": "t",
                    "updatedAt": "t",
                }
            ],
            "reviewEvents": [{"id": "e1", "type": "accept", "annotationId": "r:node:1", "at": "t"}],
        }

    def test_save_load_and_revision_conflict(self):
        with make_client() as client:
            saved = client.put("/api/projects/p1", json=self.project(0))
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["revision"], 1)
            loaded = client.get("/api/projects/p1").json()
            self.assertEqual(loaded["revision"], 1)
            self.assertEqual(loaded["annotations"][0]["status"], "accepted")
            self.assertEqual(loaded["document"]["text"], TEXT)
            conflict = client.put("/api/projects/p1", json=self.project(0))
            self.assertEqual(conflict.status_code, 409)
            ok = client.put("/api/projects/p1", json=self.project(1))
            self.assertEqual(ok.json()["revision"], 2)
            self.assertEqual(client.get("/api/projects").json()["projects"][0]["projectId"], "p1")

    def test_hash_and_id_checks(self):
        with make_client() as client:
            bad = self.project()
            bad["document"]["hash"] = "0" * 64
            self.assertEqual(client.put("/api/projects/p1", json=bad).status_code, 400)
            self.assertEqual(client.put("/api/projects/other", json=self.project()).status_code, 400)
            broken = self.project()
            broken["annotations"][0]["status"] = "weird"
            self.assertEqual(client.put("/api/projects/p1", json=broken).status_code, 422)
            self.assertEqual(client.get("/api/projects/missing").status_code, 404)


class EvidenceVerifyTest(unittest.TestCase):
    def test_verify(self):
        with make_client() as client:
            response = client.post(
                "/api/evidence/verify",
                json={"text": "가나다 😀 라마", "spans": [{"start": 0, "end": 3, "quote": "가나다"}, {"quote": "라마"}, {"start": 4, "end": 5}]},
            )
            results = response.json()["results"]
            self.assertTrue(results[0]["valid"])
            self.assertEqual(results[1]["match"], "exact")
            self.assertEqual(results[1]["start"], 7)  # 이모지(2 units) 뒤
            self.assertFalse(results[2]["valid"])  # surrogate pair 중간


if __name__ == "__main__":
    unittest.main()
