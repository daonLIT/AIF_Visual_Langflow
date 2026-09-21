"""Desktop Flow 의 실행 컨텍스트·게시 컴포넌트를 실제 중계 서버 앱에 붙여 계약을 검증한다(lfx 스텁)."""
import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
from starlette.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.storage import Database
from tests.lfx_stub import Message, load_component
from tests.test_integrations import FIXTURE, LIVE_RESULT, LIVE_TEXT

RunContext, context_module = load_component("aif_run_context.py", "AIFRunContext")
Publish, publish_module = load_component("aif_publish.py", "AIFPublish")
Splitter, _ = load_component("judgment_splitter.py", "JudgmentSplitter")

BASE = "http://aif.test"


class ServerBridge:
    """컴포넌트의 httpx.get/post 를 TestClient 로 돌린다."""

    def __init__(self, client: TestClient):
        self.client = client
        self.posts = 0
        self.fail_next = 0

    def _path(self, url: str) -> str:
        assert url.startswith(BASE), url
        return url[len(BASE):]

    def get(self, url, headers=None, timeout=None):
        return self.client.get(self._path(url), headers=headers)

    def post(self, url, json=None, headers=None, timeout=None):
        self.posts += 1
        if self.fail_next:
            self.fail_next -= 1
            raise httpx.ConnectError("offline")
        return self.client.post(self._path(url), json=json, headers=headers)


class DesktopFlowContractTest(unittest.TestCase):
    def setUp(self):
        settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0)
        self.client = TestClient(create_app(settings, db=Database(":memory:")))
        self.client.__enter__()
        self.bridge = ServerBridge(self.client)
        self.tmp = tempfile.TemporaryDirectory()
        self.outbox = Path(self.tmp.name) / "outbox"
        self.env = mock.patch.dict(os.environ, {"AIF_API_BASE": BASE, "AIF_PUBLISH_TOKEN": "", "AIF_OUTBOX_DIR": str(self.outbox)})
        self.env.start()
        self.patches = [
            mock.patch.object(context_module.httpx, "get", self.bridge.get),
            mock.patch.object(publish_module.httpx, "post", self.bridge.post),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.env.stop()
        self.tmp.cleanup()
        self.client.__exit__(None, None, None)

    def make_context(self, text=LIVE_TEXT, **values):
        return RunContext(judgment=Message(text), case_id="CASE-9", title="제목", api_base="", timeout=5, **values)

    def make_publish(self, context_text, result=None):
        publish = Publish(
            final_graph=Message(json.dumps(result if result is not None else LIVE_RESULT, ensure_ascii=False)),
            run_context=Message(context_text),
            retries=2,
            timeout=5,
        )
        publish.sleep = lambda seconds: None
        return publish

    @staticmethod
    def summary(message: Message) -> dict:
        return json.loads(message.text.split("```json", 1)[1].rsplit("```", 1)[0])

    def test_context_feeds_the_existing_splitter_with_server_catalogues(self):
        component = self.make_context(text="1. 사실\n  2. 판단")
        payload = component.build_payload()
        context = json.loads(component.build_context().text)
        splitter = Splitter(payload=payload)
        self.assertEqual(splitter.build_judgment().text, "1. 사실\n  2. 판단")
        self.assertEqual(len(splitter.build_issue_catalog().text.splitlines()), 52)
        self.assertTrue(splitter.build_scheme_catalog().text)
        # 두 출력이 같은 실행 ID·카탈로그를 쓴다.
        self.assertEqual(component.build_context().text, component.build_context().text)
        self.assertTrue(context["externalRunId"].startswith("lfd-"))
        self.assertEqual(len(context["catalogs"]["issueCatalogSha256"]), 64)
        self.assertNotIn("token", json.dumps(context).lower())
        # 새 실행(새 컴포넌트 빌드)은 새 ID
        self.assertNotEqual(context["externalRunId"], json.loads(self.make_context().build_context().text)["externalRunId"])

    def test_catalogue_failure_stops_the_run(self):
        with mock.patch.object(context_module.httpx, "get", side_effect=httpx.ConnectError("down")):
            with self.assertRaises(ValueError):
                self.make_context().build_payload()
        with mock.patch.dict(os.environ, {"AIF_API_BASE": ""}):
            with self.assertRaises(ValueError):
                self.make_context().build_payload()
        with self.assertRaises(ValueError):
            self.make_context(text="  ").build_payload()

    def test_publish_saves_then_resend_is_duplicate(self):
        context = self.make_context().build_context().text
        first = self.summary(self.make_publish(context).publish())
        self.assertEqual(first["publishStatus"], "saved")
        self.assertFalse(first["duplicate"])
        self.assertTrue(first["projectId"].startswith("project-"))
        self.assertEqual(list(self.outbox.glob("*.json")), [])  # 성공하면 outbox 에서 지운다
        # 게시만 다시 실행: 같은 실행 ID → 같은 프로젝트
        again = self.summary(self.make_publish(context).publish())
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["projectId"], first["projectId"])
        project = self.client.get(f"/api/projects/{first['projectId']}").json()
        self.assertEqual(project["document"]["caseId"], "CASE-9")
        self.assertEqual(project["analysisRuns"][0]["source"]["componentVersion"], "aif-publish/1")

    def test_network_failure_keeps_outbox_and_retries_are_limited(self):
        context = self.make_context().build_context().text
        self.bridge.fail_next = 10
        message = self.make_publish(context).publish()
        out = self.summary(message)
        self.assertEqual(out["publishStatus"], "failed")
        self.assertTrue(out["retryable"])
        self.assertEqual(self.bridge.posts, 3)  # retries=2 → 3번
        pending = list(self.outbox.glob("*.json"))
        self.assertEqual(len(pending), 1)
        stored = json.loads(pending[0].read_text(encoding="utf-8"))
        self.assertNotIn("Authorization", json.dumps(stored))
        # 재시작 뒤 셸이 outbox 본문을 그대로 보내면 저장된다(셸과 같은 요청).
        response = self.client.post("/api/integrations/langflow/results", json=stored["body"])
        self.assertEqual(response.status_code, 201)

    def test_transient_failure_then_success(self):
        context = self.make_context().build_context().text
        self.bridge.fail_next = 1
        out = self.summary(self.make_publish(context).publish())
        self.assertEqual(out["publishStatus"], "saved")
        self.assertEqual(self.bridge.posts, 2)

    def test_conflict_moves_to_failed_without_retry(self):
        context = json.loads(self.make_context().build_context().text)
        self.make_publish(json.dumps(context)).publish()
        context["document"]["title"] = "다른 제목"
        out = self.summary(self.make_publish(json.dumps(context)).publish())
        self.assertEqual((out["publishStatus"], out["httpStatus"], out["code"]), ("failed", 409, "EXTERNAL_RUN_CONFLICT"))
        self.assertFalse(out["retryable"])
        self.assertEqual(len(list((self.outbox / "failed").glob("*.json"))), 1)

    def test_invalid_analysis_is_not_published(self):
        context = self.make_context().build_context().text
        result = {"status": "invalid", "errors": ["duplicate nodeID"]}
        message = self.make_publish(context, result=result).publish()
        out = self.summary(message)
        self.assertEqual((out["analysisStatus"], out["publishStatus"]), ("invalid", "skipped"))
        self.assertEqual(self.bridge.posts, 0)
        self.assertIn("duplicate nodeID", message.text)

    def test_link_points_to_this_run_only(self):
        context = self.make_context().build_context().text
        message = self.make_publish(context).publish()
        project_id = self.summary(message)["projectId"]
        self.assertIn(f"](/aif/projects/{project_id})", message.text)


if __name__ == "__main__":
    unittest.main()
