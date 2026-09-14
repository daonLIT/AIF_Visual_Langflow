import json
import unittest
from pathlib import Path

from app.config import Settings
from app.services.aif_adapter import InvalidResultError, build_proposal, parse_json_text, validate_graph
from app.services.langflow_client import LangflowError, RunInput, build_run_payload, extract_output_text

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "langflow_run_response.sample.json"
# v9 flow(근거 인용·요약·스킴 없음) 응답: 이전 형식도 계속 받아들이는지 확인한다.
FIXTURE_V9 = Path(__file__).resolve().parent.parent / "fixtures" / "langflow_run_response.v9.sample.json"
SAMPLE = Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "sample" / "sample-case.json"


def load_graph(fixture: Path = FIXTURE_V9) -> dict:
    envelope = json.loads(fixture.read_text(encoding="utf-8"))
    text, _ = extract_output_text(envelope, "ChatOutput-nL1VD")
    return parse_json_text(text)


class ParseTest(unittest.TestCase):
    def test_strips_outer_fence_only(self):
        parsed = parse_json_text('```json\n{"a": "```inner```"}\n```')
        self.assertEqual(parsed["a"], "```inner```")

    def test_invalid_json(self):
        with self.assertRaises(InvalidResultError):
            parse_json_text("{not json")

    def test_non_object(self):
        with self.assertRaises(InvalidResultError):
            parse_json_text("[1,2]")


class ValidateTest(unittest.TestCase):
    def test_fixture_graph_is_valid(self):
        self.assertEqual(validate_graph(load_graph()), [])

    def test_missing_fields_duplicates_and_dangling_refs(self):
        graph = load_graph()
        graph["AIF"]["nodes"].append({"nodeID": "1_20260903190000", "text": "dup", "type": "I"})
        graph["AIF"]["nodes"].append({"nodeID": "bad", "text": "", "type": "I"})
        graph["AIF"]["nodes"].append({"nodeID": "weird", "text": "x", "type": "MA"})
        graph["AIF"]["edges"].append({"edgeID": 1, "fromID": "1_20260903190000", "toID": "ghost"})
        graph["AIF"]["edges"].append({"edgeID": "2", "fromID": "bad", "toID": "bad"})
        errors = validate_graph(graph)
        joined = "\n".join(errors)
        self.assertIn("중복 nodeID", joined)
        self.assertIn("비어 있습니다", joined)
        self.assertIn("허용값이 아닙니다", joined)
        self.assertIn("ghost", joined)
        self.assertIn("중복 edgeID", joined)
        self.assertIn("정수가 아닙니다", joined)
        self.assertIn("자기 자신", joined)

    def test_build_rejects_invalid(self):
        graph = load_graph()
        del graph["AIF"]["nodes"][0]["type"]
        with self.assertRaises(InvalidResultError) as ctx:
            build_proposal(graph, run_id="r", document_text="x", document_version=1, namespace="20260911000000", created_at="t")
        self.assertTrue(ctx.exception.details)


class BuildProposalTest(unittest.TestCase):
    def setUp(self):
        self.text = json.loads(SAMPLE.read_text(encoding="utf-8"))["text"]
        self.graph = load_graph()
        self.proposal = build_proposal(
            self.graph, run_id="run1", document_text=self.text, document_version=2, namespace="20260911123456", created_at="t"
        )

    def test_ids_are_namespaced_consistently(self):
        graph = self.proposal.graph
        ids = {n["nodeID"] for n in graph["AIF"]["nodes"]}
        self.assertTrue(all(i.endswith("_20260911123456") for i in ids))
        self.assertEqual(len(ids), 23)
        for edge in graph["AIF"]["edges"]:
            self.assertIn(edge["fromID"], ids)
            self.assertIn(edge["toID"], ids)
        for ova_node in graph["OVA"]["nodes"]:
            self.assertIn(ova_node["nodeID"], ids)
        for ova_edge in graph["OVA"]["edges"]:
            self.assertIn(ova_edge["fromID"], ids)
            self.assertIn(ova_edge["toID"], ids)

    def test_text_is_submitted_document_not_case_id(self):
        self.assertEqual(self.proposal.graph["text"], self.text)
        self.assertEqual(self.proposal.graph["meta"]["langflowText"], "SAMPLE-CASE")

    def test_annotations_cover_nodes_and_edges(self):
        nodes = [a for a in self.proposal.annotations if a["kind"] == "node"]
        edges = [a for a in self.proposal.annotations if a["kind"] == "edge"]
        self.assertEqual(len(nodes), 23)
        self.assertEqual(len(edges), 22)
        self.assertTrue(all(a["status"] == "pending" for a in self.proposal.annotations))
        ra = [a for a in nodes if a["currentValue"]["type"] == "RA"]
        self.assertTrue(all(a["origin"] == "rule" for a in ra))
        self.assertTrue(all(a["origin"] == "rule" for a in edges))
        self.assertTrue(all(a["origin"] == "ai" for a in nodes if a["currentValue"]["type"] != "RA"))

    def test_evidence_is_matched_and_marked_derived_without_quotes(self):
        counts = self.proposal.summary["evidenceCounts"]
        self.assertGreater(counts["exact"], 0)
        self.assertGreater(counts["unmatched"], 0)
        ai_nodes = [a for a in self.proposal.annotations if a["origin"] == "ai"]
        for annotation in ai_nodes:
            self.assertEqual(len(annotation["evidence"]), 1)
            self.assertTrue(annotation["evidence"][0]["derived"])
            self.assertEqual(annotation["evidence"][0]["documentVersion"], 2)

    def test_explicit_evidence_quotes_are_used(self):
        graph = load_graph()
        graph["AIF"]["nodes"][0]["evidence"] = [{"quote": "이에 주문과 같이 판결한다."}, "없는 문장"]
        proposal = build_proposal(graph, run_id="r2", document_text=self.text, document_version=1, namespace="20260911000001", created_at="t")
        first = proposal.annotations[0]
        self.assertEqual([e["match"] for e in first["evidence"]], ["exact", "unmatched"])
        self.assertFalse(first["evidence"][0]["derived"])
        self.assertNotIn("evidence", proposal.graph["AIF"]["nodes"][0])

    def test_two_runs_do_not_collide(self):
        other = build_proposal(self.graph, run_id="run2", document_text=self.text, document_version=2, namespace="20260911123457", created_at="t")
        a = {n["nodeID"] for n in self.proposal.graph["AIF"]["nodes"]}
        b = {n["nodeID"] for n in other.graph["AIF"]["nodes"]}
        self.assertTrue(a.isdisjoint(b))
        self.assertTrue({x["id"] for x in self.proposal.annotations}.isdisjoint({x["id"] for x in other.annotations}))


class EnvelopeTest(unittest.TestCase):
    def test_extracts_named_component_only(self):
        envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
        text, session = extract_output_text(envelope, "ChatOutput-nL1VD")
        self.assertTrue(text.strip().startswith("{"))
        self.assertEqual(session, "mock-session")
        with self.assertRaises(LangflowError) as ctx:
            extract_output_text(envelope, "ChatOutput-other")
        self.assertEqual(ctx.exception.code, "OUTPUT_COMPONENT_NOT_FOUND")

    def test_alternative_envelope_shapes(self):
        base = {"outputs": [{"outputs": [{"component_id": "C", "results": {"message": {"data": {"text": "hello"}}}}]}]}
        self.assertEqual(extract_output_text(base, "C")[0], "hello")
        alt = {"outputs": [{"outputs": [{"component_id": "C", "messages": [{"message": "hi"}]}]}]}
        self.assertEqual(extract_output_text(alt, "C")[0], "hi")
        with self.assertRaises(LangflowError):
            extract_output_text({"outputs": "nope"}, "C")

    def test_payload_uses_tweaks_for_custom_input(self):
        settings = Settings(langflow_mode="live", langflow_flow_id="f", langflow_api_key="secret")
        catalog = [{"issueId": "ISS-001", "categoryName": "군", "label": "항목", "criteria": "기준"}]
        payload = build_run_payload(settings, RunInput("원문 텍스트\n둘째 줄", "CASE1", catalog))
        tweak = json.loads(payload["tweaks"]["CustomComponent-k5fj9"]["value"])
        self.assertEqual(tweak["judgment"], "원문 텍스트\n둘째 줄")
        self.assertEqual(tweak["case_id"], "CASE1")
        self.assertEqual(tweak["issue_catalog"], catalog)
        self.assertEqual(payload["output_component"], "ChatOutput-nL1VD")
        self.assertNotIn("secret", json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
