"""파이프라인 편집: flow 모델 검증, 비밀값 처리, 적용·재조회 확인·복원, 실행 버전 고정, Langflow REST 어댑터, 라우트."""
import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")  # app.main import 전에: 실제 .env 를 읽지 않음

import asyncio
import copy
import json
import unittest
from pathlib import Path

import httpx
from starlette.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.langflow_client import LangflowError
from app.services.pipeline.flow_model import (
    SECRET_SENTINEL,
    default_prompt_field,
    execution_hash,
    make_edge,
    mask_secrets,
    model_settings,
    parse_handle,
    prompt_variables,
    resolve_relay,
    restore_secrets,
    validate_flow_data,
)
from app.services.pipeline.repository import LangflowFlowRepository, LocalFlowRepository, PipelineError
from app.services.pipeline.service import PipelineService, diff_flow_data
from app.storage import Database

PROJECT = Path(__file__).resolve().parent.parent.parent
V11 = PROJECT / "langflow" / "TopDown_Judgment_to_AIF_v11_Top3Issues.json"
FIXTURE = PROJECT / "backend" / "fixtures" / "langflow_run_response.sample.json"
INPUT_ID, OUTPUT_ID = "CustomComponent-k5fj9", "ChatOutput-nL1VD"
CLAIM_PROMPT = "Prompt Template-8w7OV"
LLM = "ext:ollama:ChatOllamaComponent@official-pQanT"
SELECTOR = "CustomComponent-Sel11"


def flow_file() -> dict:
    return json.loads(V11.read_text(encoding="utf-8"))


def node(data: dict, node_id: str) -> dict:
    return next(n for n in data["nodes"] if n["id"] == node_id)


def validate(data, input_id=INPUT_ID, output_id=OUTPUT_ID):
    return validate_flow_data(data, input_component_id=input_id, output_component_id=output_id)


def codes(issues, level="error"):
    return sorted({i["code"] for i in issues if i["level"] == level})


def run(coro):
    return asyncio.run(coro)


class FlowModelTest(unittest.TestCase):
    def test_v11_flow_is_valid_and_handles_round_trip(self):
        data = flow_file()["data"]
        self.assertEqual(codes(validate(data)), [])
        for edge in data["edges"]:
            self.assertEqual(parse_handle(edge["sourceHandle"]), edge["data"]["sourceHandle"])
            rebuilt = make_edge(node(data, edge["source"]), edge["data"]["sourceHandle"]["name"], node(data, edge["target"]), edge["data"]["targetHandle"]["fieldName"])
            self.assertEqual((rebuilt["sourceHandle"], rebuilt["targetHandle"]), (edge["sourceHandle"], edge["targetHandle"]))
        models = model_settings(data)
        self.assertEqual(len(models), 5)
        self.assertTrue(all("model_name" in m for m in models))

    def test_prompt_variable_rules_match_langflow(self):
        self.assertEqual(prompt_variables("A {judgment} B {{literal}} {claim}"), (["judgment", "claim"], None))
        for broken in ('{"text": 1}', "unbalanced {", "{1abc}", "{template}"):
            self.assertIsNotNone(prompt_variables(broken)[1], broken)

    def test_detects_broken_edges_types_and_prompt_fields(self):
        data = copy.deepcopy(flow_file()["data"])
        node(data, CLAIM_PROMPT)["data"]["node"]["template"]["template"]["value"] += "\n{new_var}"
        duplicate = copy.deepcopy(data["edges"][0])
        duplicate["id"] = "dup"
        data["edges"].append(duplicate)
        bad_type = make_edge(node(data, LLM), "text_output", node(data, OUTPUT_ID), "input_value")
        bad_type["id"] = "bad-type"
        node(data, OUTPUT_ID)["data"]["node"]["template"]["input_value"]["input_types"] = ["DataFrame"]
        data["edges"].append(bad_type)
        data["edges"].append({"id": "ghost", "source": "nope", "target": OUTPUT_ID, "sourceHandle": "{}", "targetHandle": "{}"})
        issues = validate(data)
        self.assertEqual(codes(issues), ["EDGE_ENDPOINT", "EDGE_TYPE", "FIELD_MULTI_EDGE", "PROMPT_FIELD_MISSING"])
        self.assertIn("EDGE_HANDLE_STALE", codes(issues, "warning"))

    def test_cycle_run_path_and_relay(self):
        data = copy.deepcopy(flow_file()["data"])
        data["edges"] = [e for e in data["edges"] if e["target"] != OUTPUT_ID]
        self.assertIn("RUN_PATH", codes(validate(data)))
        back = make_edge(node(data, LLM), "text_output", node(data, CLAIM_PROMPT), "judgment")
        data["edges"] = [e for e in data["edges"] if not (e["target"] == CLAIM_PROMPT and e["data"]["targetHandle"]["fieldName"] == "judgment")]
        data["edges"].append(back)
        data["nodes"] = [n for n in data["nodes"] if n["id"] != OUTPUT_ID]
        self.assertEqual(codes(validate(data)), ["CYCLE", "RELAY_OUTPUT"])

    def test_relay_ids_resolve_per_flow(self):
        data = flow_file()["data"]
        relay = resolve_relay(data, "CustomComponent-old", "ChatOutput-old")
        self.assertEqual((relay["inputComponentId"], relay["outputComponentId"]), (INPUT_ID, OUTPUT_ID))
        issues = validate(data, "CustomComponent-old", "ChatOutput-old")
        self.assertEqual(codes(issues), [])
        self.assertIn("RELAY_AUTO", codes(issues, "warning"))
        ambiguous = copy.deepcopy(data)
        extra = copy.deepcopy(node(ambiguous, OUTPUT_ID))
        extra["id"] = extra["data"]["id"] = "ChatOutput-second"
        ambiguous["nodes"].append(extra)
        messages = {i["code"]: i["message"] for i in validate(ambiguous, INPUT_ID, "ChatOutput-old") if i["level"] == "error"}
        self.assertIn("ChatOutput-second", messages["RELAY_OUTPUT"])

    def test_execution_hash_ignores_position_and_internal_keys(self):
        data = copy.deepcopy(flow_file()["data"])
        base = execution_hash(data)
        node(data, LLM)["position"] = {"x": 1, "y": 2}
        node(data, OUTPUT_ID)["data"]["node"]["template"]["_frontend_node_flow_id"] = {"value": "other-flow"}
        self.assertEqual(execution_hash(data), base)
        node(data, LLM)["data"]["node"]["template"]["temperature"]["value"] = 0.9
        self.assertNotEqual(execution_hash(data), base)
        diff = diff_flow_data(flow_file()["data"], data)
        self.assertEqual((diff["nodesChanged"], diff["sameExecution"]), ([LLM], False))

    def test_secret_mask_and_restore(self):
        data = copy.deepcopy(flow_file()["data"])
        node(data, LLM)["data"]["node"]["template"]["api_key"]["value"] = "real-key"
        masked, paths = mask_secrets(data)
        self.assertEqual(paths, [{"nodeId": LLM, "field": "api_key"}])
        self.assertNotIn("real-key", json.dumps(masked))
        restored, warnings = restore_secrets(masked, data)
        self.assertEqual((node(restored, LLM)["data"]["node"]["template"]["api_key"]["value"], warnings), ("real-key", []))
        clone = copy.deepcopy(node(masked, LLM))
        clone["id"] = clone["data"]["id"] = "new-llm"
        masked["nodes"].append(clone)
        restored, warnings = restore_secrets(masked, data)
        self.assertEqual(node(restored, "new-llm")["data"]["node"]["template"]["api_key"]["value"], "")
        self.assertEqual(len(warnings), 1)
        self.assertEqual(default_prompt_field("claim")["input_types"], ["Message"])


def local_service(production=None):
    db = Database(":memory:")
    settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_flow_files=(V11,), langflow_flow_id=production or "")
    return PipelineService(settings, db, LocalFlowRepository(db, (V11,))), db


class LocalPipelineServiceTest(unittest.TestCase):
    def setUp(self):
        self.flow_id = flow_file()["id"]
        self.service, self.db = local_service(production=self.flow_id)

    def test_list_get_and_production_protection(self):
        listing = run(self.service.list_flows())
        self.assertTrue(listing["flows"][0]["isProduction"])
        view = run(self.service.get_flow(self.flow_id))
        self.assertEqual(view["summary"]["nodeCount"], 11)
        self.assertEqual(len(view["hash"]), 64)
        self.assertEqual(view["relay"]["inputComponentId"], INPUT_ID)
        with self.assertRaises(PipelineError) as ctx:
            run(self.service.apply(self.flow_id, view["data"], base_updated_at=view["flow"]["updatedAt"], note=None))
        self.assertEqual(ctx.exception.code, "PRODUCTION_PROTECTED")

    def test_clone_draft_apply_verify_versions_restore(self):
        clone = run(self.service.clone(self.flow_id, "작업본"))
        clone_id = clone["flow"]["id"]
        self.assertTrue(clone["flow"]["isWorkingCopy"])
        self.assertEqual(clone["hash"], run(self.service.get_flow(self.flow_id))["hash"])

        data = copy.deepcopy(clone["data"])
        node(data, SELECTOR)["data"]["node"]["template"]["temperature"]["value"] = 0.3
        draft = run(self.service.save_draft(clone_id, data, clone["flow"]["updatedAt"], "온도", base_hash=clone["hash"]))
        self.assertEqual([i for i in draft["issues"] if i["level"] == "error"], [])
        reopened = run(self.service.get_flow(clone_id))
        self.assertEqual(reopened["draft"]["diff"]["nodesChanged"], [SELECTOR])
        self.assertFalse(reopened["draft"]["remoteChangedSinceDraft"])

        with self.assertRaises(PipelineError) as ctx:
            run(self.service.apply(clone_id, data, base_updated_at=None, base_hash="0" * 64, note=None))
        self.assertEqual(ctx.exception.code, "CONFLICT")

        applied = run(self.service.apply(clone_id, data, base_updated_at=clone["flow"]["updatedAt"], base_hash=clone["hash"], note="온도 0.3"))
        self.assertTrue(applied["applied"]["verified"])
        self.assertEqual(applied["applied"]["expectedHash"], applied["hash"])
        self.assertIsNone(run(self.service.get_draft(clone_id)))
        versions = run(self.service.list_versions(clone_id))["versions"]
        self.assertEqual(sorted(v["kind"] for v in versions), ["applied", "backup", "cloned"])
        self.assertTrue(all(v["dataHash"] for v in versions))

        backup = next(v for v in versions if v["kind"] == "backup")
        restored = run(self.service.restore_version(clone_id, backup["versionId"], applied["flow"]["updatedAt"], applied["hash"]))
        self.assertEqual(node(restored["data"], SELECTOR)["data"]["node"]["template"]["temperature"]["value"], 0.1)
        original = run(self.service.get_flow(self.flow_id))
        self.assertEqual(node(original["data"], SELECTOR)["data"]["node"]["template"]["temperature"]["value"], 0.1)

    def test_apply_not_verified_is_not_success(self):
        clone = run(self.service.clone(self.flow_id, None))
        repo = self.service.repo
        original_update = repo.update_flow

        async def lossy_update(flow_id, payload):
            payload = copy.deepcopy(payload)
            node(payload["data"], SELECTOR)["data"]["node"]["template"]["temperature"]["value"] = 0.1  # 저장 중 값이 사라진 상황
            return await original_update(flow_id, payload)

        repo.update_flow = lossy_update
        data = copy.deepcopy(clone["data"])
        node(data, SELECTOR)["data"]["node"]["template"]["temperature"]["value"] = 0.7
        with self.assertRaises(PipelineError) as ctx:
            run(self.service.apply(clone["flow"]["id"], data, base_updated_at=clone["flow"]["updatedAt"], note=None))
        self.assertEqual(ctx.exception.code, "APPLY_NOT_VERIFIED")
        kinds = [v["kind"] for v in run(self.service.list_versions(clone["flow"]["id"]))["versions"]]
        self.assertIn("applied-unverified", kinds)

    def test_validation_errors_block_apply(self):
        clone = run(self.service.clone(self.flow_id, None))
        data = copy.deepcopy(clone["data"])
        data["edges"].append({"id": "x", "source": "nope", "target": OUTPUT_ID, "sourceHandle": "{}", "targetHandle": "{}"})
        with self.assertRaises(PipelineError) as ctx:
            run(self.service.apply(clone["flow"]["id"], data, base_updated_at=clone["flow"]["updatedAt"], note=None))
        self.assertEqual(ctx.exception.code, "VALIDATION")

    def test_mock_pin_and_templates(self):
        pinned = run(self.service.pin_run_flow(self.flow_id))
        self.assertEqual((pinned["mock"], pinned["snapshot"], pinned["runFlowId"]), (True, False, self.flow_id))
        self.assertEqual(pinned["relay"]["outputComponentId"], OUTPUT_ID)
        kinds = {t["kind"] for t in run(self.service.component_templates(self.flow_id))["templates"]}
        self.assertTrue({"prompt", "llm", "custom", "output"} <= kinds)
        with self.assertRaises(PipelineError):
            run(self.service.rebuild_component("class X: pass", None))


class FakeLangflow:
    """Langflow 1.11 flows API 의 필요한 부분만 흉내 내는 httpx MockTransport 핸들러."""

    def __init__(self):
        flow = flow_file()
        node(flow["data"], LLM)["data"]["node"]["template"]["api_key"]["value"] = "remote-secret"
        flow["updated_at"] = "2026-09-14T00:00:00"
        flow["folder_id"] = "f1"
        self.flows = {flow["id"]: flow}
        self.requests: list[httpx.Request] = []
        self.snapshots: list[str] = []
        self.counter = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("x-api-key") != "k":
            return httpx.Response(403, json={"detail": "Invalid API key"})
        path = request.url.path
        if request.method == "GET" and path == "/api/v1/flows/":
            return httpx.Response(200, json=[{k: v for k, v in f.items() if k != "data"} for f in self.flows.values()])
        if path.startswith("/api/v1/flows/") and path.endswith("/versions/") and request.method == "POST":
            self.snapshots.append(json.loads(request.content)["description"])
            return httpx.Response(201, json={"id": "v1"})
        if path.startswith("/api/v1/flows/"):
            flow_id = path.split("/")[4]
            if request.method == "POST" and flow_id == "":
                self.counter += 1
                new = {**json.loads(request.content), "id": f"00000000-0000-0000-0000-{self.counter:012d}", "updated_at": f"2026-09-14T01:00:{self.counter:02d}"}
                self.flows[new["id"]] = new
                return httpx.Response(201, json=new)
            flow = self.flows.get(flow_id)
            if flow is None:
                return httpx.Response(404, json={"detail": "Flow not found"})
            if request.method == "GET":
                return httpx.Response(200, json=flow)
            if request.method == "PATCH":
                flow.update({k: v for k, v in json.loads(request.content).items() if v is not None})
                self.counter += 1
                flow["updated_at"] = f"2026-09-14T02:00:{self.counter:02d}"
                return httpx.Response(200, json=flow)
        if path == "/api/v1/version":
            return httpx.Response(200, json={"version": "1.11.0"})
        if path == "/api/v1/custom_component":
            return httpx.Response(200, json={"data": {"template": {"api_key": {"password": True, "value": "leak"}}, "outputs": []}, "type": "X"})
        return httpx.Response(404, json={"detail": "unknown"})


class LiveRepositoryTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeLangflow()
        self.production = next(iter(self.fake.flows))
        # .env 의 출력 ID 가 flow 와 다른 상황(Langflow 가 가져오면서 ID 를 바꾼 경우)
        self.settings = Settings(
            langflow_mode="live", langflow_base_url="http://langflow.test", langflow_api_key="k", langflow_flow_id=self.production,
            langflow_output_component_id="ChatOutput-renamed",
        )
        self.repo = LangflowFlowRepository(self.settings, http_transport=httpx.MockTransport(self.fake.handler))
        self.service = PipelineService(self.settings, Database(":memory:"), self.repo)

    def test_clone_apply_reread_and_secret(self):
        view = run(self.service.get_flow(self.production))
        self.assertNotIn("remote-secret", json.dumps(view))
        self.assertEqual(view["relay"]["outputComponentId"], OUTPUT_ID)
        self.assertTrue(view["relay"]["notes"])

        clone = run(self.service.clone(self.production, "작업본"))
        clone_id = clone["flow"]["id"]
        self.assertIn("aif-working-copy", self.fake.flows[clone_id]["tags"])
        self.assertEqual(node(self.fake.flows[clone_id]["data"], LLM)["data"]["node"]["template"]["api_key"]["value"], "remote-secret")

        data = copy.deepcopy(clone["data"])
        node(data, CLAIM_PROMPT)["data"]["node"]["template"]["template"]["value"] += "\n추가 지시"
        applied = run(self.service.apply(clone_id, data, base_updated_at=clone["flow"]["updatedAt"], base_hash=clone["hash"], note="프롬프트"))
        patched = next(r for r in self.fake.requests if r.method == "PATCH")
        self.assertEqual(set(json.loads(patched.content)), {"data"})
        self.assertNotIn(SECRET_SENTINEL, patched.content.decode("utf-8"))
        after = self.fake.requests[self.fake.requests.index(patched) + 1 :]
        self.assertTrue(any(r.method == "GET" and clone_id in str(r.url) for r in after), "적용 뒤 Langflow 에서 다시 읽어야 한다")
        self.assertTrue(applied["applied"]["verified"])
        self.assertTrue(self.fake.snapshots)
        self.assertTrue(all(self.production not in str(r.url) for r in self.fake.requests if r.method == "PATCH"))

    def test_run_snapshot_pinning(self):
        pinned = run(self.service.pin_run_flow(self.production))
        self.assertTrue(pinned["snapshot"])
        snapshot_id = pinned["runFlowId"]
        self.assertNotEqual(snapshot_id, self.production)
        self.assertIn("aif-run-snapshot", self.fake.flows[snapshot_id]["tags"])
        self.assertEqual(pinned["relay"]["outputComponentId"], OUTPUT_ID)
        self.assertEqual(len(pinned["models"]), 5)
        self.assertEqual(run(self.service.pin_run_flow(self.production))["runFlowId"], snapshot_id)  # 같은 해시면 재사용
        node(self.fake.flows[self.production]["data"], LLM)["data"]["node"]["template"]["temperature"]["value"] = 0.5
        changed = run(self.service.pin_run_flow(self.production))
        self.assertNotEqual(changed["runFlowId"], snapshot_id)  # 내용이 바뀌면 새 스냅샷
        listing = run(self.service.list_flows())
        self.assertEqual(listing["hiddenRunSnapshots"], 2)
        self.assertTrue(all(not f["isRunSnapshot"] for f in listing["flows"]))
        self.settings.langflow_flow_id = ""  # 프로덕션 보호가 아니라 스냅샷 보호로 막히는지 확인
        with self.assertRaises(PipelineError) as ctx:
            run(self.service.apply(snapshot_id, self.fake.flows[snapshot_id]["data"], base_updated_at=None, note=None))
        self.assertEqual(ctx.exception.code, "SNAPSHOT_PROTECTED")

    def test_conflict_auth_and_not_found(self):
        clone = run(self.service.clone(self.production, None))
        self.fake.flows[clone["flow"]["id"]]["updated_at"] = "changed elsewhere"
        with self.assertRaises(PipelineError) as ctx:
            run(self.service.apply(clone["flow"]["id"], clone["data"], base_updated_at=clone["flow"]["updatedAt"], note=None))
        self.assertEqual(ctx.exception.code, "CONFLICT")
        with self.assertRaises(LangflowError) as ctx:
            run(self.repo.get_flow("missing"))
        self.assertEqual(ctx.exception.code, "FLOW_NOT_FOUND")
        bad = LangflowFlowRepository(
            Settings(langflow_mode="live", langflow_base_url="http://langflow.test", langflow_api_key="wrong"),
            http_transport=httpx.MockTransport(self.fake.handler),
        )
        with self.assertRaises(LangflowError) as ctx:
            run(bad.list_flows())
        self.assertEqual(ctx.exception.code, "AUTH")
        result = run(self.service.rebuild_component("code", None))
        self.assertEqual(result["node"]["template"]["api_key"]["value"], SECRET_SENTINEL)


class PipelineApiTest(unittest.TestCase):
    def test_routes_round_trip_in_mock_mode(self):
        flow_id = flow_file()["id"]
        settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0, mock_flow_files=(V11,), langflow_flow_id=flow_id)
        text = json.loads((PROJECT / "frontend" / "public" / "sample" / "sample-case.json").read_text(encoding="utf-8"))["text"]
        with TestClient(create_app(settings, db=Database(":memory:"))) as client:
            self.assertEqual(client.get("/api/pipelines").json()["productionFlowId"], flow_id)
            view = client.get(f"/api/pipelines/{flow_id}").json()
            self.assertEqual(client.post(f"/api/pipelines/{flow_id}/apply", json={"data": view["data"]}).status_code, 409)
            clone = client.post(f"/api/pipelines/{flow_id}/clone", json={"name": "작업본"}).json()
            clone_id = clone["flow"]["id"]
            body = {"data": clone["data"], "baseUpdatedAt": clone["flow"]["updatedAt"], "baseHash": clone["hash"]}
            self.assertEqual(client.put(f"/api/pipelines/{clone_id}/draft", json=body).status_code, 200)
            self.assertEqual(client.get(f"/api/pipelines/{clone_id}/draft").json()["baseHash"], clone["hash"])
            self.assertEqual(client.post(f"/api/pipelines/{clone_id}/validate", json={"data": clone["data"]}).json()["errorCount"], 0)
            applied = client.post(f"/api/pipelines/{clone_id}/apply", json={**body, "note": "n", "test": {"text": text}})
            self.assertEqual(applied.status_code, 200, applied.text)
            self.assertTrue(applied.json()["applied"]["verified"])
            test_run = applied.json()["testRun"]
            self.assertEqual((test_run["flowId"], test_run["purpose"]), (clone_id, "pipeline-test"))
            versions = client.get(f"/api/pipelines/{clone_id}/versions").json()["versions"]
            backup = next(v for v in versions if v["kind"] == "backup")
            fresh = client.get(f"/api/pipelines/{clone_id}").json()
            restored = client.post(
                f"/api/pipelines/{clone_id}/restore",
                json={"versionId": backup["versionId"], "baseUpdatedAt": fresh["flow"]["updatedAt"], "baseHash": fresh["hash"]},
            )
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertEqual(client.post(f"/api/pipelines/{clone_id}/test", json={"text": text}).status_code, 202)
            self.assertEqual(client.put("/api/pipeline-settings/analysis-flow", json={"flowId": clone_id}).json()["analysisFlowId"], clone_id)
            self.assertEqual(client.post("/api/pipeline-components/rebuild", json={"code": "x"}).status_code, 501)
            status = client.get("/api/connections/status").json()
            names = {c["name"] for c in status["checks"]}
            self.assertTrue({"langflow", "analysis_flow", "flow_contract", "ollama", "catalogs"} <= names, names)


if __name__ == "__main__":
    unittest.main()
