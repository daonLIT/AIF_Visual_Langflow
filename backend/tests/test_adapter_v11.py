"""v11 결과 변환: 최대 3개 쟁점 제약, no_issues/invalid, 요약 상태, schemeApplication 참조 변환, schemefulfillments."""
import copy
import json
import unittest
from pathlib import Path

from app.services.aif_adapter import InvalidResultError, build_proposal, parse_json_text
from app.services.catalogs import IssueCatalog, SchemeCatalog
from app.services.langflow_client import extract_output_text

BACKEND = Path(__file__).resolve().parent.parent
FIXTURE = BACKEND / "fixtures" / "langflow_run_response.sample.json"
SAMPLE = BACKEND.parent / "frontend" / "public" / "sample" / "sample-case.json"
ISSUES = IssueCatalog.load(BACKEND / "catalog" / "issue_catalog.json")
SCHEMES = SchemeCatalog.load(BACKEND / "catalog" / "walton_schemes.json")
TEXT = json.loads(SAMPLE.read_text(encoding="utf-8"))["text"]
NS = "20260914010203"


def load_graph() -> dict:
    envelope = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return parse_json_text(extract_output_text(envelope, "ChatOutput-nL1VD")[0])


def build(graph, namespace=NS, schemes=SCHEMES):
    return build_proposal(
        graph, run_id="run11", document_text=TEXT, document_version=1, namespace=namespace, created_at="t",
        issue_catalog=ISSUES, scheme_catalog=schemes,
    )


class OutcomeTest(unittest.TestCase):
    def test_no_issues_has_no_graph(self):
        proposal = build({"status": "no_issues", "reason": "관련 판단 없음", "meta": {"selection": {"attempts": 1}}})
        self.assertEqual(proposal.outcome, "no_issues")
        self.assertIsNone(proposal.graph)
        self.assertEqual(proposal.annotations, [])
        self.assertEqual(proposal.summary["issueSelection"], {"status": "no_issues", "reason": "관련 판단 없음", "selected": [], "attempts": 1})

    def test_invalid_is_explicit_error(self):
        with self.assertRaises(InvalidResultError) as ctx:
            build({"status": "invalid", "errors": ["selected 4 issues"]})
        self.assertEqual(ctx.exception.code, "INVALID_SELECTION")
        self.assertEqual(ctx.exception.details, ["selected 4 issues"])

    def test_selection_constraints_are_enforced_by_server(self):
        graph = load_graph()
        issues = [n for n in graph["AIF"]["nodes"] if n["type"] == "ISSUE"]
        duplicate = copy.deepcopy(graph)
        [n for n in duplicate["AIF"]["nodes"] if n["type"] == "ISSUE"][1]["issueRef"]["issueId"] = issues[0]["issueRef"]["issueId"]
        unknown = copy.deepcopy(graph)
        [n for n in unknown["AIF"]["nodes"] if n["type"] == "ISSUE"][0]["issueRef"]["issueId"] = "ISS-999"
        too_many = copy.deepcopy(graph)
        too_many["AIF"]["nodes"].append({"nodeID": "99_20260903190000", "text": "쟁점: 넷째", "type": "ISSUE", "issueRef": {"issueId": "ISS-001"}})
        for broken, needle in ((duplicate, "중복"), (unknown, "ISS-999"), (too_many, "최대 3개")):
            with self.assertRaises(InvalidResultError) as ctx:
                build(broken)
            self.assertEqual(ctx.exception.code, "INVALID_SELECTION")
            self.assertTrue(any(needle in d for d in ctx.exception.details), ctx.exception.details)


class GraphTest(unittest.TestCase):
    def setUp(self):
        self.proposal = build(load_graph())
        self.nodes = {n["nodeID"]: n for n in self.proposal.graph["AIF"]["nodes"]}

    def test_issue_refs_selection_report(self):
        issues = [n for n in self.nodes.values() if n["type"] == "ISSUE"]
        self.assertEqual([n["issueRef"]["issueId"] for n in issues], ["ISS-007", "ISS-009", "ISS-028"])
        self.assertEqual(issues[0]["issueRef"]["categoryId"], "CAT-02")
        self.assertTrue(issues[0]["issueRef"]["selectionReason"])
        report = self.proposal.summary["issueSelection"]
        self.assertEqual((report["status"], report["attempts"]), ("ok", 2))
        self.assertEqual([s["evidenceStatus"] for s in report["selected"]], ["found", "found", "found"])
        self.assertEqual(report["selected"][0]["label"], "핵심 진술의 일관성")
        lower = next(n for n in self.nodes.values() if n["type"] == "I" and n.get("issueRefs"))
        self.assertEqual(set(lower["issueRefs"][0]), {"issueId", "instanceId"})

    def test_summary_fields_and_stale_detection(self):
        for node in self.nodes.values():
            if node["type"] in ("I", "ISSUE"):
                self.assertEqual((node["summaryOrigin"], node["summaryStatus"]), ("ai", "current"))
                self.assertNotEqual(node["summary"], node["text"])
        graph = load_graph()
        graph["AIF"]["nodes"][0]["text"] = graph["AIF"]["nodes"][0]["text"] + " (수정)"
        proposal = build(graph, namespace="20260914010204")
        self.assertEqual(proposal.graph["AIF"]["nodes"][0]["summaryStatus"], "stale")
        self.assertEqual(proposal.summary["summaryCounts"]["stale"], 1)

    def test_scheme_application_references_follow_namespace(self):
        edges = {(e["fromID"], e["toID"]) for e in self.proposal.graph["AIF"]["edges"]}
        ras = [n for n in self.nodes.values() if n["type"] == "RA"]
        self.assertEqual(len(ras), 9)
        for ra in ras:
            app = ra["schemeApplication"]
            for binding in app["premiseBindings"]:
                for node_id in binding["nodeIds"]:
                    self.assertTrue(node_id.endswith(NS))
                    self.assertIn((node_id, ra["nodeID"]), edges)
            for node_id in app["conclusionNodeIds"]:
                self.assertIn((ra["nodeID"], node_id), edges)
            self.assertNotIn("errors", app)
        keys = [ra["schemeApplication"]["schemeKey"] for ra in ras]
        self.assertIn("unclassified", keys)
        self.assertEqual(self.proposal.summary["schemeCounts"], {"classified": 8, "unclassified": 1, "custom": 0, "missing": 0, "withErrors": 0})
        by_node = {a["nodeId"]: a for a in self.proposal.annotations if a["kind"] == "node"}
        self.assertEqual(by_node[ras[0]["nodeID"]]["origin"], "rule")
        self.assertEqual(by_node[ras[0]["nodeID"]]["currentValue"]["schemeApplication"]["origin"], "ai")
        self.assertIsNot(by_node[ras[0]["nodeID"]]["originalValue"]["schemeApplication"], by_node[ras[0]["nodeID"]]["currentValue"]["schemeApplication"])

    def test_invalid_scheme_parts_are_errors_not_guesses(self):
        graph = load_graph()
        ra = next(n for n in graph["AIF"]["nodes"] if n["type"] == "RA")
        ra["schemeApplication"]["schemeKey"] = "made_up"
        ra["schemeApplication"]["premiseBindings"].append({"roleId": "statement", "nodeIds": ["999_20260903190000"]})
        second = [n for n in graph["AIF"]["nodes"] if n["type"] == "RA"][2]
        second["schemeApplication"]["premiseBindings"].append({"roleId": "not_a_role", "nodeIds": []})
        second["schemeApplication"]["criticalQuestionResponses"].append({"questionId": "CQ99", "status": "satisfied"})
        proposal = build(graph, namespace="20260914010205")
        ras = [n for n in proposal.graph["AIF"]["nodes"] if n["type"] == "RA"]
        self.assertEqual(ras[0]["schemeApplication"]["schemeKey"], "unclassified")
        self.assertTrue(ras[0]["schemeApplication"]["errors"])
        self.assertTrue(any("not_a_role" in e for e in ras[2]["schemeApplication"]["errors"]))
        self.assertTrue(any("CQ99" in e for e in ras[2]["schemeApplication"]["errors"]))

    def test_schemefulfillments_only_with_verified_mapping(self):
        self.assertEqual(self.proposal.graph["AIF"]["schemefulfillments"], [])
        graph = load_graph()
        graph["AIF"]["schemefulfillments"] = [{"nodeID": graph["AIF"]["nodes"][2]["nodeID"], "schemeID": 72}, {"nodeID": "ghost", "schemeID": 1}]
        mapped = copy.deepcopy(SCHEMES)
        mapped.by_key["best_explanation"]["aifdbSchemeId"] = 5
        proposal = build(graph, namespace="20260914010206", schemes=mapped)
        entries = proposal.graph["AIF"]["schemefulfillments"]
        self.assertIn({"nodeID": graph["AIF"]["nodes"][2]["nodeID"].split("_")[0] + "_20260914010206", "schemeID": 72}, entries)
        best = next(n for n in proposal.graph["AIF"]["nodes"] if n["type"] == "RA" and n["schemeApplication"]["schemeKey"] == "best_explanation")
        self.assertIn({"nodeID": best["nodeID"], "schemeID": 5}, entries)
        self.assertTrue(any("ghost" in w for w in proposal.warnings))

    def test_evidence_not_found_is_reported(self):
        graph = load_graph()
        issue = next(n for n in graph["AIF"]["nodes"] if n["type"] == "ISSUE")
        issue["evidence"] = [{"quote": "판결문에 없는 문장"}]
        proposal = build(graph, namespace="20260914010207")
        self.assertEqual(proposal.summary["issueSelection"]["selected"][0]["evidenceStatus"], "not_found")
        self.assertTrue(any("근거 없음/미검출" in w for w in proposal.warnings))

    def test_legacy_v10_scheme_is_converted(self):
        graph = load_graph()
        ra = next(n for n in graph["AIF"]["nodes"] if n["type"] == "RA")
        application = ra.pop("schemeApplication")
        premise = application["premiseBindings"][0]["nodeIds"][0]
        ra["scheme"] = {"schemeId": "other", "schemeName": "경험칙", "premises": [{"nodeId": premise, "role": None}], "conclusion": {"nodeId": application["conclusionNodeIds"][0]}, "criticalQuestions": []}
        proposal = build(graph, namespace="20260914010208")
        converted = next(n for n in proposal.graph["AIF"]["nodes"] if n["type"] == "RA")["schemeApplication"]
        self.assertEqual((converted["schemeKey"], converted["customSchemeName"]), ("custom", "경험칙"))
        self.assertEqual(len(converted["premiseBindings"][0]["nodeIds"]), 1)


class LiveCaptureTest(unittest.TestCase):
    """Langflow 1.11 + Ollama(gemma4:e4b-it-qat) 실제 실행 응답 (합성 판결문, 비밀 값 없음). 분류 품질이 아니라 계약을 검사한다."""

    def setUp(self):
        envelope = json.loads((BACKEND / "fixtures" / "langflow_run_response.live_v11.json").read_text(encoding="utf-8"))
        self.judgment = json.loads(envelope["outputs"][0]["inputs"]["input_value"], strict=False)["judgment"]
        self.raw = parse_json_text(extract_output_text(envelope, "ChatOutput-nL1VD")[0])

    def test_live_response_satisfies_contract(self):
        proposal = build_proposal(
            self.raw, run_id="live", document_text=self.judgment, document_version=1, namespace="20260914083306", created_at="t",
            issue_catalog=ISSUES, scheme_catalog=SCHEMES,
        )
        nodes = proposal.graph["AIF"]["nodes"]
        selection = proposal.summary["issueSelection"]
        self.assertEqual(proposal.outcome, "graph")
        self.assertTrue(1 <= len(selection["selected"]) <= 3)
        self.assertEqual(len({s["issueId"] for s in selection["selected"]}), len(selection["selected"]))
        self.assertTrue(all(ISSUES.is_active(s["issueId"]) and s["selectionReason"] for s in selection["selected"]))
        self.assertTrue(proposal.summary["validation"]["ok"])
        for node in nodes:
            if node["type"] in ("I", "ISSUE"):
                self.assertEqual(node["summaryStatus"], "current", node["nodeID"])
            if node["type"] == "RA":
                self.assertTrue(SCHEMES.is_valid_key(node["schemeApplication"]["schemeKey"]))
                self.assertNotIn("errors", node["schemeApplication"])
        self.assertEqual(proposal.graph["text"], self.judgment)


if __name__ == "__main__":
    unittest.main()
