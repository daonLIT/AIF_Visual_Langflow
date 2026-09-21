import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")  # app.main import 전에: 실제 .env 를 읽지 않음

import asyncio
import json
import time
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from app.config import ConfigError, Settings, load_dotenv_files
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

    async def run(self, run_input):
        raise self.error


class SlowTransport(MockLangflowTransport):
    def __init__(self, delay):
        super().__init__(FIXTURE, delay)


class BadOutputTransport:
    async def run(self, run_input):
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
            self.assertEqual(response.json()["catalogs"]["issueCatalogVersion"], 1)


class ConfigTest(unittest.TestCase):
    def test_invalid_mode_is_a_startup_error(self):
        with self.assertRaises(ConfigError):
            Settings(langflow_mode="Live ")  # 공백·대소문자 정규화는 load 경로에서만 한다
        with self.assertRaises(ConfigError):
            Settings(langflow_mode="production")

    def test_env_files_are_read_in_order_without_overwriting(self):
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            first, second = Path(tmp) / "backend.env", Path(tmp) / "root.env"
            first.write_text("AIF_TEST_A=from-backend\n", encoding="utf-8")
            second.write_text("﻿# comment\nAIF_TEST_A=from-root\nAIF_TEST_B='quoted'\n", encoding="utf-8")
            os.environ.pop("AIF_TEST_A", None)
            os.environ.pop("AIF_TEST_B", None)
            try:
                report = load_dotenv_files((first, second, Path(tmp) / "missing.env"))
                self.assertEqual(os.environ["AIF_TEST_A"], "from-backend")
                self.assertEqual(os.environ["AIF_TEST_B"], "quoted")
                self.assertEqual([r["exists"] for r in report], [True, True, False])
                self.assertEqual(report[1]["applied"], ["AIF_TEST_B"])
                self.assertNotIn("from-root", json.dumps(report))
            finally:
                os.environ.pop("AIF_TEST_A", None)
                os.environ.pop("AIF_TEST_B", None)


class CatalogApiTest(unittest.TestCase):
    def test_catalog_endpoints(self):
        with make_client() as client:
            issues = client.get("/api/catalogs/issues").json()
            self.assertEqual(len(issues["issues"]), 52)
            schemes = client.get("/api/catalogs/schemes").json()
            self.assertIn("witness_testimony", {s["schemeKey"] for s in schemes["schemes"]})
            self.assertEqual([(m["fromVersion"], m["toVersion"]) for m in schemes["migrations"]], [(2, 3)])

    def test_run_records_catalog_versions_and_selection(self):
        with make_client() as client:
            record = wait_terminal(client, submit(client).json()["runId"])
            self.assertEqual(record["catalogs"]["issueCatalogVersion"], 1)
            self.assertEqual(record["catalogs"]["schemeCatalogVersion"], 3)
            self.assertEqual(record["constraints"]["maxSelectedIssues"], 3)
            self.assertTrue(record["pipeline"]["mock"])
            selection = record["result"]["summary"]["issueSelection"]
            self.assertEqual([s["issueId"] for s in selection["selected"]], ["ISS-007", "ISS-009", "ISS-028"])

    def test_no_issues_and_invalid_selection_runs(self):
        class NoIssues:
            async def run(self, run_input):
                envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
                envelope["outputs"][0]["outputs"][0]["results"]["message"]["text"] = json.dumps({"status": "no_issues", "reason": "관련 판단 없음"})
                return envelope

        class Invalid:
            async def run(self, run_input):
                envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
                envelope["outputs"][0]["outputs"][0]["results"]["message"]["text"] = json.dumps({"status": "invalid", "errors": ["selected 5 issues"]})
                return envelope

        with make_client(transport=NoIssues()) as client:
            record = wait_terminal(client, submit(client).json()["runId"])
            self.assertEqual(record["status"], "succeeded")
            self.assertEqual(record["result"]["outcome"], "no_issues")
            self.assertIsNone(record["result"]["graph"])
        with make_client(transport=Invalid()) as client:
            record = wait_terminal(client, submit(client).json()["runId"])
            self.assertEqual((record["status"], record["error"]["code"]), ("failed", "INVALID_SELECTION"))
            self.assertEqual(record["error"]["details"], ["selected 5 issues"])

    def test_summaries_are_not_faked_in_mock(self):
        with make_client() as client:
            response = client.post("/api/summaries", json={"items": [{"nodeId": "n1", "text": "본문"}]})
            self.assertEqual(response.status_code, 501)
            self.assertEqual(response.json()["error"]["code"], "UNSUPPORTED_IN_MOCK")


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
            self.assertEqual(result["summary"]["nodeCount"], 24)
            self.assertEqual(result["summary"]["issueCount"], 3)
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
            # v1 파일은 v2 로 저장된다.
            self.assertEqual(loaded["schemaVersion"], 2)
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


class LanguageTest(unittest.TestCase):
    """Accept-Language 로 오류 문구 언어가 정해진다 (지원: ko, en · 기본 ko)."""

    def test_error_messages_follow_accept_language(self):
        with make_client() as client:
            korean = client.get("/api/analysis-runs/missing").json()["error"]["message"]
            english = client.get("/api/analysis-runs/missing", headers={"Accept-Language": "en"}).json()["error"]["message"]
            self.assertEqual(korean, "실행을 찾을 수 없습니다.")
            self.assertEqual(english, "The run was not found.")

    def test_unknown_language_falls_back_to_korean(self):
        with make_client() as client:
            for header in ("fr", "", "en;q=0"):
                message = client.get("/api/analysis-runs/missing", headers={"Accept-Language": header}).json()["error"]["message"]
                self.assertEqual(message, "실행을 찾을 수 없습니다.")

    def test_quality_values_pick_the_best_supported_language(self):
        with make_client() as client:
            message = client.get(
                "/api/analysis-runs/missing", headers={"Accept-Language": "fr-CA,fr;q=0.9,en-US;q=0.8,ko;q=0.5"}
            ).json()["error"]["message"]
            self.assertEqual(message, "The run was not found.")

    def test_run_failure_message_uses_the_language_of_the_request_that_started_it(self):
        # 실행 task 는 시작 요청의 컨텍스트를 물려받는다. 기록된 문구는 나중에 다시 만들지 않는다.
        with make_client(transport=BadOutputTransport()) as client:
            body = {"text": TEXT, "documentId": "doc1", "documentVersion": 1, "caseId": "SAMPLE"}
            run_id = client.post("/api/analysis-runs", json=body, headers={"Accept-Language": "en"}).json()["runId"]
            record = wait_terminal(client, run_id)
            self.assertEqual(record["error"]["message"], "The graph in the Langflow result is not valid.")
            again = client.get(f"/api/analysis-runs/{run_id}").json()
            self.assertEqual(again["error"]["message"], record["error"]["message"])


if __name__ == "__main__":
    unittest.main()
