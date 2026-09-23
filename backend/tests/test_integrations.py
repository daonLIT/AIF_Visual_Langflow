import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")

import copy
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

from app.auth import hash_token
from app.config import Settings
from app.main import create_app
from app.schemas import LangflowResultPublish
from app.storage import Database

BACKEND = Path(__file__).resolve().parent.parent
FIXTURE = BACKEND / "fixtures" / "langflow_run_response.sample.json"
LIVE = json.loads((BACKEND / "fixtures" / "langflow_run_response.live_v11.json").read_text(encoding="utf-8"))
LIVE_RESULT = json.loads(LIVE["outputs"][0]["outputs"][0]["results"]["message"]["text"], strict=False)
LIVE_TEXT = json.loads(LIVE["outputs"][0]["inputs"]["input_value"], strict=False)["judgment"]


def make_app(settings=None, db=None):
    settings = settings or Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0)
    return create_app(settings, db=db or Database(":memory:"))


def catalogs_of(client) -> dict:
    context = client.get("/api/integrations/langflow/context").json()
    return {
        "issueCatalogVersion": context["issueCatalogVersion"],
        "issueCatalogSha256": context["issueCatalogSha256"],
        "schemeCatalogVersion": context["schemeCatalogVersion"],
        "schemeCatalogSha256": context["schemeCatalogSha256"],
    }


def body(catalogs, run_id="run-0001-abcdef", result=None, text=LIVE_TEXT, **document):
    return {
        "schemaVersion": 1,
        "externalRunId": run_id,
        "source": {"kind": "langflow-desktop", "flowId": "flow-1", "flowName": "AIF Desktop", "models": ["gemma4:26b"]},
        "document": {"text": text, "caseId": "CASE-1", "title": "사건 1", **document},
        "catalogs": catalogs,
        "result": copy.deepcopy(result if result is not None else LIVE_RESULT),
    }


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(make_app())
        self.client.__enter__()
        self.catalogs = catalogs_of(self.client)

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def post(self, payload):
        return self.client.post("/api/integrations/langflow/results", json=payload)

    def test_context_has_catalogs_and_versions(self):
        context = self.client.get("/api/integrations/langflow/context").json()
        self.assertEqual(context["schemaVersion"], 1)
        self.assertEqual(len(context["issueCatalog"]), 52)
        self.assertTrue(context["schemeCatalog"])
        self.assertEqual(len(context["issueCatalogSha256"]), 64)

    def test_publish_creates_reviewable_project(self):
        response = self.post(body(self.catalogs))
        self.assertEqual(response.status_code, 201, response.text)
        saved = response.json()
        self.assertEqual(saved["status"], "saved")
        self.assertEqual(saved["revision"], 1)
        self.assertFalse(saved["duplicate"])
        self.assertEqual(saved["outcome"], "graph")
        self.assertIsNone(saved["viewerUrl"])  # 공개 사이트 주소를 설정하지 않았다

        project = self.client.get(f"/api/projects/{saved['projectId']}").json()
        self.assertEqual(project["document"]["text"], LIVE_TEXT)
        self.assertEqual(project["title"], "사건 1")
        # AI 제안은 확정 그래프가 아니라 미검토 annotation 으로만 들어간다.
        self.assertEqual(project["acceptedGraph"]["AIF"]["nodes"], [])
        self.assertTrue(project["annotations"])
        self.assertTrue(all(a["status"] == "pending" for a in project["annotations"]))
        run = project["analysisRuns"][0]
        self.assertEqual(run["runId"], saved["runId"])
        self.assertTrue(run["imported"])
        self.assertEqual(run["source"]["kind"], "langflow-desktop")
        self.assertEqual(run["pipeline"]["models"], ["gemma4:26b"])
        # 모르는 값은 채워 넣지 않는다
        self.assertNotIn("flowHash", run["pipeline"])

        record = self.client.get(f"/api/analysis-runs/{saved['runId']}").json()
        self.assertEqual(record["mode"], "external")
        self.assertEqual(record["externalRunId"], "run-0001-abcdef")

        listed = self.client.get("/api/projects").json()["projects"]
        self.assertEqual(listed[0]["projectId"], saved["projectId"])
        self.assertEqual(listed[0]["caseId"], "CASE-1")
        self.assertEqual(listed[0]["source"], "langflow-desktop")

        # 화면이 저장하는 경로(PUT)로 그대로 다시 저장할 수 있다.
        put = self.client.put(f"/api/projects/{saved['projectId']}", json=project)
        self.assertEqual(put.status_code, 200, put.text)
        self.assertEqual(put.json()["revision"], 2)

    def test_same_request_returns_existing_ids(self):
        first = self.post(body(self.catalogs)).json()
        again = self.post(body(self.catalogs))
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.json()["duplicate"])
        self.assertEqual(again.json()["projectId"], first["projectId"])
        self.assertEqual(again.json()["runId"], first["runId"])
        self.assertEqual(len(self.client.get("/api/projects").json()["projects"]), 1)

    def test_resend_does_not_overwrite_human_edits(self):
        first = self.post(body(self.catalogs)).json()
        project = self.client.get(f"/api/projects/{first['projectId']}").json()
        project["title"] = "사람이 고친 제목"
        self.assertEqual(self.client.put(f"/api/projects/{first['projectId']}", json=project).status_code, 200)
        again = self.post(body(self.catalogs)).json()
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["revision"], 2)
        self.assertEqual(self.client.get(f"/api/projects/{first['projectId']}").json()["title"], "사람이 고친 제목")

    def test_same_run_id_with_different_content_is_409(self):
        self.post(body(self.catalogs))
        changed = self.post(body(self.catalogs, title="다른 제목"))
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(changed.json()["error"]["code"], "EXTERNAL_RUN_CONFLICT")

    def test_new_run_id_is_a_separate_project(self):
        first = self.post(body(self.catalogs)).json()
        second = self.post(body(self.catalogs, run_id="run-0002-abcdef")).json()
        self.assertNotEqual(first["projectId"], second["projectId"])
        self.assertNotEqual(first["runId"], second["runId"])

    def test_no_issues_is_saved_with_reason(self):
        result = {"status": "no_issues", "reason": "판단한 세부 쟁점 없음", "meta": {}}
        response = self.post(body(self.catalogs, result=result))
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["outcome"], "no_issues")
        project = self.client.get(f"/api/projects/{response.json()['projectId']}").json()
        self.assertEqual(project["annotations"], [])
        self.assertFalse(project["analysisRuns"][0]["imported"])
        self.assertEqual(project["analysisRuns"][0]["summary"]["issueSelection"]["reason"], "판단한 세부 쟁점 없음")

    def test_invalid_result_is_not_saved(self):
        result = {"status": "invalid", "errors": ["ISSUE issueId 'X' is not in the issue catalog"], "meta": {}}
        response = self.post(body(self.catalogs, result=result))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get("/api/projects").json()["projects"], [])
        # 같은 실행 ID 로 고친 결과를 다시 보낼 수 있다(invalid 는 매핑을 남기지 않는다).
        self.assertEqual(self.post(body(self.catalogs)).status_code, 201)

    def test_broken_graph_reference_is_422(self):
        result = copy.deepcopy(LIVE_RESULT)
        result["AIF"]["edges"].append({"edgeID": 999, "fromID": "missing", "toID": result["AIF"]["nodes"][0]["nodeID"]})
        response = self.post(body(self.catalogs, result=result))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get("/api/projects").json()["projects"], [])

    def test_catalog_mismatch_is_409(self):
        catalogs = dict(self.catalogs, issueCatalogSha256="0" * 64)
        response = self.post(body(catalogs))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "CATALOG_MISMATCH")

    def test_empty_text_and_bad_run_id_are_422(self):
        self.assertEqual(self.post(body(self.catalogs, text="   ")).status_code, 422)
        self.assertEqual(self.post(body(self.catalogs, run_id="x")).status_code, 422)

    def test_too_many_nodes_is_422(self):
        result = copy.deepcopy(LIVE_RESULT)
        result["AIF"]["nodes"] = [{"nodeID": f"n{i}", "text": "t", "type": "I"} for i in range(2001)]
        self.assertEqual(self.post(body(self.catalogs, result=result)).status_code, 422)


class PublishLimitsTest(unittest.TestCase):
    def test_body_over_limit_is_413(self):
        settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0, max_publish_bytes=1000)
        with TestClient(make_app(settings)) as client:
            catalogs = catalogs_of(client)
            response = client.post("/api/integrations/langflow/results", json=body(catalogs))
            self.assertEqual(response.status_code, 413)


class PublishConcurrencyTest(unittest.TestCase):
    def test_parallel_duplicates_create_one_project(self):
        db = Database(":memory:")
        app = make_app(db=db)
        with TestClient(app) as client:
            payload = LangflowResultPublish.model_validate(body(catalogs_of(client)))
        service = app.state.publication
        results = []
        barrier = threading.Barrier(6)

        def worker():
            barrier.wait()
            results.append(service.publish("desktop", payload))

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(r.status for r in results), [200] * 5 + [201])
        self.assertEqual(len({r.body["projectId"] for r in results}), 1)
        self.assertEqual(db.list_projects()[1], 1)

    def test_failure_mid_transaction_leaves_nothing(self):
        db = Database(":memory:")
        app = make_app(db=db)
        with TestClient(app) as client:
            payload = LangflowResultPublish.model_validate(body(catalogs_of(client)))
        fixed = mock.Mock(hex="f" * 32)
        # 같은 ID 의 프로젝트가 이미 있으면 프로젝트 INSERT 에서 실패한다(실행 기록 INSERT 다음 단계).
        db.save_project("project-" + "f" * 16, 1, "t", {"projectId": "project-" + "f" * 16})
        with mock.patch("app.services.publication.uuid.uuid4", return_value=fixed):
            with self.assertRaises(sqlite3.IntegrityError):
                app.state.publication.publish("desktop", payload)
        self.assertIsNone(db.get_run("f" * 12))
        self.assertIsNone(db.find_publication("desktop", payload.externalRunId))
        # 원인이 없어지면 같은 요청이 정상 저장된다.
        self.assertEqual(app.state.publication.publish("desktop", payload).status, 201)


class TokenAuthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tokens = Path(self.tmp.name) / "tokens.json"
        self.write_tokens(
            [
                {"id": "pub", "principal": "desktop", "scopes": ["catalog:read", "results:publish"], "sha256": hash_token("pub-secret")},
                {"id": "rev", "principal": "owner", "scopes": ["catalog:read", "projects:read", "projects:write"], "sha256": hash_token("rev-secret")},
                {"id": "old", "principal": "desktop", "scopes": ["results:publish"], "sha256": hash_token("old-secret"), "disabled": True},
            ]
        )
        settings = Settings(
            langflow_mode="mock",
            mock_fixture_path=FIXTURE,
            mock_delay_seconds=0,
            auth_mode="token",
            api_tokens_path=self.tokens,
            public_site_url="https://aif.example.org",
        )
        self.client = TestClient(make_app(settings))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def write_tokens(self, entries):
        self.tokens.write_text(json.dumps({"tokens": entries}), encoding="utf-8")

    @staticmethod
    def auth(token):
        return {"Authorization": f"Bearer {token}"}

    def test_anonymous_requests_are_rejected(self):
        for method, path in [("GET", "/api/projects"), ("GET", "/api/projects/x"), ("PUT", "/api/projects/x"),
                             ("POST", "/api/integrations/langflow/results"), ("GET", "/api/integrations/langflow/context"),
                             ("GET", "/api/catalogs/issues"), ("GET", "/api/pipelines"), ("POST", "/api/analysis-runs"),
                             ("GET", "/api/unknown")]:
            response = self.client.request(method, path)
            self.assertEqual(response.status_code, 401, f"{method} {path}")
        health = self.client.get("/api/health").json()
        self.assertEqual(set(health), {"status", "time", "authMode"})

    def test_scopes_are_enforced(self):
        self.assertEqual(self.client.get("/api/integrations/langflow/context", headers=self.auth("pub-secret")).status_code, 200)
        self.assertEqual(self.client.get("/api/projects", headers=self.auth("pub-secret")).status_code, 403)
        self.assertEqual(self.client.get("/api/projects", headers=self.auth("rev-secret")).status_code, 200)
        self.assertEqual(self.client.post("/api/integrations/langflow/results", headers=self.auth("rev-secret"), json={}).status_code, 403)
        self.assertEqual(self.client.get("/api/pipelines", headers=self.auth("rev-secret")).status_code, 403)
        self.assertEqual(self.client.get("/api/projects", headers=self.auth("wrong")).status_code, 401)
        self.assertEqual(self.client.get("/api/projects", headers=self.auth("old-secret")).status_code, 401)

    def test_publish_with_token_then_review(self):
        context = self.client.get("/api/integrations/langflow/context", headers=self.auth("pub-secret")).json()
        catalogs = {k: context[k] for k in ("issueCatalogVersion", "issueCatalogSha256", "schemeCatalogVersion", "schemeCatalogSha256")}
        saved = self.client.post("/api/integrations/langflow/results", headers=self.auth("pub-secret"), json=body(catalogs))
        self.assertEqual(saved.status_code, 201, saved.text)
        project_id = saved.json()["projectId"]
        self.assertEqual(saved.json()["viewerUrl"], f"https://aif.example.org/?projectId={project_id}")
        project = self.client.get(f"/api/projects/{project_id}", headers=self.auth("rev-secret"))
        self.assertEqual(project.status_code, 200)
        self.assertEqual(project.json()["analysisRuns"][0]["source"]["kind"], "langflow-desktop")

    def test_token_rotation_keeps_principal(self):
        context = self.client.get("/api/integrations/langflow/context", headers=self.auth("pub-secret")).json()
        catalogs = {k: context[k] for k in ("issueCatalogVersion", "issueCatalogSha256", "schemeCatalogVersion", "schemeCatalogSha256")}
        first = self.client.post("/api/integrations/langflow/results", headers=self.auth("pub-secret"), json=body(catalogs)).json()
        # 새 토큰을 같은 principal 로 추가하고 옛 토큰을 끈다. 서버 재시작 없이 반영된다.
        self.write_tokens(
            [
                {"id": "pub", "principal": "desktop", "scopes": ["results:publish"], "sha256": hash_token("pub-secret"), "disabled": True},
                {"id": "pub2", "principal": "desktop", "scopes": ["catalog:read", "results:publish"], "sha256": hash_token("pub-secret-2")},
            ]
        )
        os.utime(self.tokens, (os.path.getmtime(self.tokens) + 5, os.path.getmtime(self.tokens) + 5))
        self.assertEqual(self.client.get("/api/integrations/langflow/context", headers=self.auth("pub-secret")).status_code, 401)
        again = self.client.post("/api/integrations/langflow/results", headers=self.auth("pub-secret-2"), json=body(catalogs))
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["projectId"], first["projectId"])


class MigrationTest(unittest.TestCase):
    def test_v3_database_is_migrated_with_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "annotation.sqlite3"
            conn = sqlite3.connect(path)
            from app.storage.db import LATEST_SCHEMA, MIGRATIONS

            for version, _label, script in MIGRATIONS[:3]:
                for statement in [p.strip() for p in script.split(";") if p.strip()]:
                    conn.execute(statement)
            conn.execute("PRAGMA user_version = 3")
            conn.execute("INSERT INTO projects(project_id, revision, updated_at, document) VALUES ('p1', 4, 't', '{\"projectId\": \"p1\"}')")
            conn.commit()
            conn.close()

            db = Database(path)
            self.assertEqual(db.schema_version(), LATEST_SCHEMA)
            self.assertIsNotNone(db.backup_path)
            self.assertTrue(Path(db.backup_path).exists())
            self.assertEqual(db.get_project_revision("p1"), 4)
            self.assertIsNone(db.find_publication("x", "y"))
            db.close()


if __name__ == "__main__":
    unittest.main()
