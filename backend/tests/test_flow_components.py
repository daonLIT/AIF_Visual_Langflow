"""v11 flow 커스텀 컴포넌트 로직 검증 (lfx 스텁 사용). 모델 호출만 가짜로 바꾼다."""
import json
import unittest

from fixtures.make_fixture_v11 import BRANCHES, SCHEME_ANSWERS, SELECTION_ATTEMPTS, SUMMARIES, run_pipeline
from tests.lfx_stub import Message, load_component
from app.services.texthash import text_hash

Selector, _ = load_component("issue_selector.py", "IssueSelector")
Extractor, _ = load_component("issue_branch_extractor.py", "IssueBranchExtractor")
Builder, _ = load_component("aif_graph_builder.py", "TopDownAIFGraphBuilder")
Summarizer, summarizer_module = load_component("node_summarizer.py", "NodeSummarizer")
Assigner, _ = load_component("scheme_assigner.py", "SchemeAssigner")
Validator, _ = load_component("result_validator.py", "ResultValidator")
Splitter, _ = load_component("judgment_splitter.py", "JudgmentSplitter")

import pathlib  # noqa: E402

SAMPLE_TEXT = json.loads((pathlib.Path(__file__).resolve().parents[2] / "frontend" / "public" / "sample" / "sample-case.json").read_text(encoding="utf-8"))["text"]
CATALOG_LINES = "\n".join(json.dumps({"issue_id": f"ISS-00{i}"}) for i in range(1, 10))
MODEL = dict(base_url="http://x", model_name="m", temperature=0.1, num_ctx=4096, timeout=0, system_message="")


def make_selector(answers, retries=2):
    calls = []

    class Fake(Selector):
        def call_model(self, messages):
            calls.append(messages)
            answer = answers.pop(0) if len(answers) > 1 else answers[0]
            if isinstance(answer, Exception):
                raise answer
            return {"content": answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False), "prompt_eval_count": 100}

    selector = Fake(
        judgment=Message("판결문"), issue_catalog=Message(CATALOG_LINES), claim_json=Message('{"main_claim": "결론"}'),
        prompt_template="{max_issues}|{main_claim}|{issue_catalog}|{judgment}", retries=retries, **MODEL,
    )
    return selector, calls


def item(issue_id, reason="이유", text="쟁점: x"):
    return {"issue_id": issue_id, "issue_text": text, "selection_reason": reason, "evidence_quote": "q"}


class SelectorTest(unittest.TestCase):
    def test_valid_selection_one_to_three(self):
        for count in (1, 2, 3):
            selector, calls = make_selector([{"selected_issues": [item(f"ISS-00{i}") for i in range(1, count + 1)]}])
            out = json.loads(selector.select().text)
            self.assertEqual((out["status"], len(out["selected"]), out["attempts"]), ("ok", count, 1))
            self.assertIn("3|결론|", calls[0][-1]["content"])

    def test_zero_needs_reason(self):
        selector, _ = make_selector([{"selected_issues": [], "no_issue_reason": "관련 판단 없음"}])
        out = json.loads(selector.select().text)
        self.assertEqual((out["status"], out["no_issue_reason"]), ("no_issues", "관련 판단 없음"))
        selector, calls = make_selector([{"selected_issues": []}], retries=1)
        out = json.loads(selector.select().text)
        self.assertEqual(out["status"], "invalid")
        self.assertEqual(len(calls), 2)

    def test_violations_retry_with_feedback_then_succeed(self):
        bad = {"selected_issues": [item("ISS-001"), item("ISS-001"), item("ISS-999"), item("ISS-002"), item("ISS-003")]}
        good = {"selected_issues": [item("ISS-001"), item("ISS-002")]}
        selector, calls = make_selector([bad, good])
        out = json.loads(selector.select().text)
        self.assertEqual((out["status"], out["attempts"]), ("ok", 2))
        feedback = calls[1][-1]["content"]
        self.assertIn("at most 3", feedback)
        self.assertIn("not in the issue catalog", feedback)
        self.assertIn("more than once", feedback)

    def test_invalid_after_retries_is_explicit(self):
        selector, calls = make_selector(["not json", {"selected_issues": [item("ISS-001", reason="")]}], retries=2)
        out = json.loads(selector.select().text)
        self.assertEqual(out["status"], "invalid")
        self.assertTrue(out["errors"])
        self.assertEqual(len(calls), 3)

    def test_connection_error_is_retried(self):
        selector, calls = make_selector([ConnectionError("down"), {"selected_issues": [item("ISS-001")]}])
        self.assertEqual(json.loads(selector.select().text)["status"], "ok")
        self.assertEqual(len(calls), 2)


class ExtractorTest(unittest.TestCase):
    def run_extractor(self, selection, responses):
        class Fake(Extractor):
            def call_model(self, prompt):
                key = next(k for k in responses if f'"issue_id": "{k}"' in prompt)
                value = responses[key]
                if isinstance(value, Exception):
                    raise value
                return {"content": json.dumps(value, ensure_ascii=False), "prompt_eval_count": 4096, "done_reason": "length"}

        return json.loads(
            Fake(selection_json=Message(json.dumps(selection)), judgment=Message("J {x}"), claim_json=Message('{"main_claim": "c"}'),
                 prompt_template="{issue_json}|{main_claim}|{judgment}", retries=0, **MODEL).extract().text
        )

    def test_skips_when_selection_not_ok(self):
        out = self.run_extractor({"status": "no_issues", "selected": []}, {})
        self.assertEqual((out["status"], out["branches"]), ("skipped", []))

    def test_rejects_more_than_three(self):
        with self.assertRaises(ValueError):
            self.run_extractor({"status": "ok", "selected": [item(f"ISS-00{i}") for i in range(1, 5)]}, {})

    def test_branch_ok_failed_and_warnings(self):
        out = self.run_extractor(
            {"status": "ok", "selected": [item("ISS-001"), item("ISS-002")]},
            {"ISS-001": BRANCHES["ISS-007"], "ISS-002": {"upper_i_node": {"text": "x"}, "lower_i_nodes": []}},
        )
        first, second = out["branches"]
        self.assertEqual(first["status"], "ok")
        self.assertTrue(any(w.startswith("context_limit") for w in first["warnings"]))
        self.assertEqual(second["status"], "failed")
        self.assertNotIn("summary", json.dumps(first))


class BuilderTest(unittest.TestCase):
    def build(self, selection, branches=()):
        return json.loads(
            Builder(
                claim_json=Message('{"case_id": "C", "main_claim": "결론이다.", "evidence_quote": "결론이다."}'),
                selection_json=Message(json.dumps(selection, ensure_ascii=False)),
                branches_json=Message(json.dumps({"branches": list(branches)}, ensure_ascii=False)),
                catalog_versions=Message('{"issue": 1, "scheme": 2}'),
            ).assemble().text
        )

    def test_no_issues_makes_no_graph(self):
        out = self.build({"status": "no_issues", "selected": [], "no_issue_reason": "없음"})
        self.assertEqual(out["status"], "no_issues")
        self.assertEqual(out["reason"], "없음")
        self.assertNotIn("AIF", out)

    def test_invalid_selection_is_reported(self):
        out = self.build({"status": "invalid", "selected": [], "errors": ["bad"]})
        self.assertEqual((out["status"], out["errors"]), ("invalid", ["bad"]))
        out = self.build({"status": "ok", "selected": [item(f"ISS-00{i}") for i in range(1, 5)]})
        self.assertEqual(out["status"], "invalid")

    def test_graph_with_failed_branch_keeps_issue(self):
        branch = {"issue_index": 1, "status": "ok", **BRANCHES["ISS-009"]}
        out = self.build(
            {"status": "ok", "selected": [item("ISS-009", reason="번복"), item("ISS-001")]},
            [branch, {"issue_index": 2, "status": "failed", "error": "boom"}],
        )
        self.assertEqual(out["status"], "ok")
        nodes = out["AIF"]["nodes"]
        issues = [n for n in nodes if n["type"] == "ISSUE"]
        self.assertEqual([n["issueRef"]["issueId"] for n in issues], ["ISS-009", "ISS-001"])
        self.assertEqual(issues[0]["issueRef"]["selectionReason"], "번복")
        self.assertEqual(out["AIF"]["schemefulfillments"], [])
        # 쟁점 2 는 ISSUE + RA 만 남는다.
        self.assertEqual(len(nodes), 1 + 2 * 2 + 3 + 2)
        self.assertEqual(out["meta"]["branches"][1]["status"], "failed")
        self.assertTrue(all(n.get("issueRefs") for n in nodes if n["type"] in ("I", "RA") and n["nodeID"] != nodes[0]["nodeID"]))


class StagesTest(unittest.TestCase):
    def test_full_pipeline_fixture(self):
        graph = json.loads(run_pipeline(SAMPLE_TEXT))
        self.assertEqual(graph["status"], "ok")
        self.assertEqual(graph["meta"]["selection"]["attempts"], 2)
        self.assertEqual(graph["meta"]["validation"], {"ok": True, "errors": [], "warnings": []})
        for node in graph["AIF"]["nodes"]:
            if node["type"] in ("I", "ISSUE"):
                self.assertEqual(node["summary"], SUMMARIES[node["text"]])
                self.assertEqual(node["summarySourceHash"], text_hash(node["text"]))
                self.assertEqual(node["summarySourceHash"], summarizer_module.text_hash(node["text"]))
            if node["type"] == "RA":
                app = node["schemeApplication"]
                self.assertEqual((app["status"], app["origin"], app["catalogVersion"]), ("suggested", "ai", 3))
        keys = graph["meta"]["schemes"]["keys"]
        self.assertEqual(keys.get("unclassified"), 1)

    def test_summarizer_reports_missing_and_never_fills(self):
        graph = json.loads(
            Builder(
                claim_json=Message('{"main_claim": "결론이다."}'),
                selection_json=Message(json.dumps({"status": "ok", "selected": [item("ISS-007")]})),
                branches_json=Message(json.dumps({"branches": [{"issue_index": 1, "status": "ok", **BRANCHES["ISS-007"]}]}, ensure_ascii=False)),
            ).assemble().text
        )

        class Fake(Summarizer):
            def call_model(self, prompt):
                items = json.loads(prompt[prompt.index("["):])
                return json.dumps({"summaries": [{"node_id": items[0]["node_id"], "summary": "하나만"}, {"node_id": "ghost", "summary": "x"}]})

        out = json.loads(Fake(graph_json=Message(json.dumps(graph, ensure_ascii=False)), prompt_template="{nodes_json}", batch_size=50, retries=0, **MODEL).summarize().text)
        with_summary = [n for n in out["AIF"]["nodes"] if n.get("summary")]
        self.assertEqual(len(with_summary), 1)
        self.assertEqual(len(out["meta"]["summaries"]["missing"]), 5)

    def test_scheme_assigner_validation(self):
        graph = json.loads(run_pipeline(SAMPLE_TEXT))
        for node in graph["AIF"]["nodes"]:
            node.pop("schemeApplication", None)
        bad = [
            [
                {"ra": "R1", "scheme_key": "made_up", "premise_bindings": [{"role_id": "x", "premises": ["N9"]}]},
                {"ra": "R2", "scheme_key": "sign", "premise_bindings": [{"role_id": "specific", "premises": ["N2"]}],
                 "critical_question_responses": [{"question_id": "CQ9", "status": "satisfied"}], "alternatives": [{"scheme_key": "nope"}]},
            ]
        ] * 6
        splitter = Splitter(payload=Message(json.dumps({"judgment": "x", "scheme_catalog": [{"schemeKey": "sign", "premiseRoles": [{"roleId": "specific"}], "criticalQuestions": [{"id": "CQ1"}]}]})))

        class Fake(Assigner):
            def call_model(self, messages):
                return json.dumps({"assignments": bad[0]})

        out = json.loads(
            Fake(graph_json=Message(json.dumps(graph, ensure_ascii=False)), scheme_catalog=splitter.build_scheme_catalog(),
                 prompt_template="{scheme_catalog}{ra_items_json}", retries=1, **MODEL).assign().text
        )
        ras = [n for n in out["AIF"]["nodes"] if n["type"] == "RA"]
        first, second, third = ras[0]["schemeApplication"], ras[1]["schemeApplication"], ras[2]["schemeApplication"]
        self.assertEqual(first["schemeKey"], "unclassified")
        self.assertTrue(first["errors"])
        self.assertEqual(second["schemeKey"], "sign")
        self.assertEqual(second["criticalQuestionResponses"], [])
        self.assertEqual(second["alternatives"], [])
        self.assertEqual(third["schemeKey"], "unclassified")
        self.assertIn("no valid assignment returned", third["errors"])
        self.assertTrue(out["meta"]["schemes"]["errors"])

    def test_scheme_assigner_binding_rules_and_alias_text(self):
        catalog = {
            "ignorance": {"premiseRoles": [{"roleId": "wouldBeKnown"}, {"roleId": "notKnown"}], "criticalQuestions": [{"id": "CQ1"}]},
        }
        alias = {"ra": {"nodeID": "ra"}, "premises": {"N1": "issue-node", "N2": "fact-a", "N3": "fact-b"}, "conclusions": ["c"]}
        raw = {
            "scheme_key": "ignorance",
            "rationale": "사실(N2, N3)을 종합하면 전제 N3의 내용처럼 알려지지 않았다. N95 마스크 기록(N9)은 별개다.",
            "premise_bindings": [
                {"role_id": "wouldBeKnown", "premises": ["N1", "N2"]},
                {"role_id": "notKnown", "premises": ["N2", "N3", "N3"]},
            ],
            "critical_question_responses": [{"question_id": "CQ1", "status": "satisfied", "answer": "N2와 N3를 보면 조사가 이루어졌다."}],
        }
        application, errors = Assigner.validate_assignment(raw, alias, catalog, {"R1", "N1", "N2", "N3"})
        # 한 전제는 처음 역할에만 남기고 오류로 알린다 (같은 역할 안의 중복은 조용히 합친다).
        self.assertEqual(
            application["premiseBindings"],
            [{"roleId": "wouldBeKnown", "nodeIds": ["issue-node", "fact-a"]}, {"roleId": "notKnown", "nodeIds": ["fact-b"]}],
        )
        self.assertEqual(errors, ["premise N2 is bound to more than one role (wouldBeKnown, notKnown); bind each premise to at most one role"])
        # 이 그룹에 준 별칭만 지우고, 판결문 표기(N95)나 모르는 별칭(N9)은 남긴다.
        self.assertEqual(application["rationale"], "사실을 종합하면 전제의 내용처럼 알려지지 않았다. N95 마스크 기록(N9)은 별개다.")
        self.assertEqual(application["criticalQuestionResponses"][0]["answer"], "해당 전제를 보면 조사가 이루어졌다.")

    def test_validator_flags_constraint_violations(self):
        graph = json.loads(run_pipeline(SAMPLE_TEXT))
        issue_nodes = [n for n in graph["AIF"]["nodes"] if n["type"] == "ISSUE"]
        issue_nodes[1]["issueRef"]["issueId"] = issue_nodes[0]["issueRef"]["issueId"]
        issue_nodes[0]["text"] = "본문이 바뀜"
        splitter = Splitter(payload=Message(json.dumps({"judgment": "x", "issue_catalog": [{"issueId": "ISS-007"}, {"issueId": "ISS-009"}, {"issueId": "ISS-028"}]})))
        out = json.loads(Validator(graph_json=Message(json.dumps(graph, ensure_ascii=False)), issue_catalog=splitter.build_issue_catalog(), scheme_catalog=Message("")).validate().text)
        self.assertEqual(out["status"], "invalid")
        self.assertIn("the same catalog issue is selected more than once", out["errors"])
        self.assertTrue(any("summarySourceHash" in w for w in out["meta"]["validation"]["warnings"]))


class SplitterTest(unittest.TestCase):
    def test_outputs(self):
        payload = {"case_id": "C", "judgment": "원문\n  줄", "issue_catalog": [{"issueId": "ISS-001", "label": "항목"}], "issue_catalog_version": 1,
                   "scheme_catalog": [{"schemeKey": "sign"}], "scheme_catalog_version": 2}
        splitter = Splitter(payload=Message(json.dumps(payload, ensure_ascii=False)))
        self.assertEqual(splitter.build_judgment().text, "원문\n  줄")
        self.assertEqual(json.loads(splitter.build_issue_catalog().text)["issue_id"], "ISS-001")
        self.assertEqual(json.loads(splitter.build_scheme_catalog().text)["schemeKey"], "sign")
        self.assertEqual(json.loads(splitter.build_catalog_versions().text), {"issue": 1, "scheme": 2})
        self.assertEqual(Splitter(payload=Message("{plain")).build_judgment().text, "{plain")

    def test_langflow_unescaped_newlines_are_accepted(self):
        # 실제 Langflow 1.11 실행에서 tweak 값의 \n 이스케이프가 실제 줄바꿈으로 바뀌어 전달됐다(엄격한 파싱이면 카탈로그가 빈 값이 됨).
        payload = {"judgment": "1. 사실\n2. 판단", "issue_catalog": [{"issueId": f"ISS-{i:03d}"} for i in range(1, 53)]}
        mangled = json.dumps(payload, ensure_ascii=False).replace("\\n", "\n")
        self.assertIn("\n", mangled)
        splitter = Splitter(payload=Message(mangled))
        self.assertEqual(len(splitter.build_issue_catalog().text.splitlines()), 52)
        self.assertEqual(splitter.build_judgment().text, "1. 사실\n2. 판단")



if __name__ == "__main__":
    unittest.main()
