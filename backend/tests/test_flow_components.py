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


def item(issue_id, reason="이유", text="쟁점: x", quote=None):
    # 쟁점마다 다른 대목을 근거로 든다. 같은 quote 를 쓰면 한 근거를 쪼갠 것으로 보아 거절된다.
    return {"issue_id": issue_id, "issue_text": text, "selection_reason": reason, "evidence_quote": quote or f"q-{issue_id}"}


class SelectorTest(unittest.TestCase):
    def test_valid_selection_one_to_max(self):
        """쟁점 수는 고정이 아니다. 1개부터 상한까지 그대로 받는다."""
        for count in range(1, 4):
            selector, calls = make_selector([{"selected_issues": [item(f"ISS-00{i}") for i in range(1, count + 1)]}])
            out = json.loads(selector.select().text)
            self.assertEqual((out["status"], len(out["selected"]), out["attempts"]), ("ok", count, 1))
            self.assertIn("3|결론|", calls[0][-1]["content"])

    def test_same_ground_split_across_issues_is_rejected(self):
        """두 쟁점이 같은 대목을 근거로 들면 수를 채우려 쪼갠 것으로 보고 다시 묻는다."""
        bad = {"selected_issues": [item("ISS-001", quote="같은 대목"), item("ISS-002", quote="같은 대목")]}
        good = {"selected_issues": [item("ISS-001")]}
        selector, calls = make_selector([bad, good])
        out = json.loads(selector.select().text)
        self.assertEqual((out["status"], len(out["selected"])), ("ok", 1))
        feedback = calls[1][-1]["content"]
        self.assertIn("grounded in the same quote", feedback)
        self.assertIn("Do not add issues to reach the maximum", feedback)

    def test_zero_needs_reason(self):
        selector, _ = make_selector([{"selected_issues": [], "no_issue_reason": "관련 판단 없음"}])
        out = json.loads(selector.select().text)
        self.assertEqual((out["status"], out["no_issue_reason"]), ("no_issues", "관련 판단 없음"))
        selector, calls = make_selector([{"selected_issues": []}], retries=1)
        out = json.loads(selector.select().text)
        self.assertEqual(out["status"], "invalid")
        self.assertEqual(len(calls), 2)

    def test_violations_retry_with_feedback_then_succeed(self):
        bad = {"selected_issues": [item(f"ISS-00{i}") for i in range(1, 5)] + [item("ISS-001"), item("ISS-999")]}
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

    def test_rejects_more_than_the_cap(self):
        # 상한까지는 그대로 처리하고, 넘으면 거절한다.
        out = self.run_extractor({"status": "ok", "selected": [item(f"ISS-00{i}") for i in range(1, 4)]}, {})
        self.assertEqual(out["summary"]["selected"], 3)
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
        self.assertEqual(self.build({"status": "ok", "selected": [item(f"ISS-00{i}") for i in range(1, 4)]})["status"], "ok")
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
        # 주 주장 1 + 쟁점 종합 RA 1 + ISSUE 2 + (성공한 가지: upper·RA 2개) 3 + lower 2.
        # 실패한 쟁점 2 는 ISSUE 만 남고, 쟁점 종합 RA 에는 그대로 이어진다.
        self.assertEqual(len(nodes), 1 + 1 + 2 + 3 + 2)
        aggregation = [n for n in nodes if n["type"] == "RA" and len(n.get("issueRefs") or []) == 2]
        self.assertEqual(len(aggregation), 1)
        incoming = [e["fromID"] for e in out["AIF"]["edges"] if e["toID"] == aggregation[0]["nodeID"]]
        self.assertEqual([n["nodeID"] for n in issues], incoming)
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
        # 쟁점에 닿는 RA 는 구조로 정해지므로 모델의 답과 무관하게 항상 쟁점 관계 scheme 이다.
        # 쟁점 종합 RA 는 쟁점 수와 무관하게 하나다 (수렴).
        self.assertEqual(keys.get("issue_aggregation"), 1)
        self.assertEqual(keys.get("issue_resolution"), 3)
        # 실질 추론(ra_lower)만 모델이 분류한다. 예전에 미분류였던 것은 쟁점 관계 RA 였다.
        self.assertIsNone(keys.get("unclassified"))
        self.assertEqual(graph["meta"]["schemes"]["errors"], [])

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

    @staticmethod
    def _ra_role(graph: dict, ra: dict) -> str:
        """RA 가 그래프에서 어느 자리인지. ra_claim(쟁점→주장) · ra_upper(→쟁점) · ra_lower(실질 추론)."""
        nodes = {n["nodeID"]: n for n in graph["AIF"]["nodes"]}
        sources = {nodes[e["fromID"]]["type"] for e in graph["AIF"]["edges"] if e["toID"] == ra["nodeID"]}
        targets = {nodes[e["toID"]]["type"] for e in graph["AIF"]["edges"] if e["fromID"] == ra["nodeID"]}
        if "ISSUE" in sources:
            return "ra_claim"
        return "ra_upper" if "ISSUE" in targets else "ra_lower"

    def test_issue_facing_ras_are_assigned_from_structure(self):
        """쟁점에 닿는 RA 는 모델을 부르지 않고 구조로 정한다. 모델이 답을 안 줘도 미분류가 되지 않는다."""
        graph = json.loads(run_pipeline(SAMPLE_TEXT))
        for node in graph["AIF"]["nodes"]:
            node.pop("schemeApplication", None)
        splitter = Splitter(payload=Message(json.dumps({"judgment": "x", "scheme_catalog": [
            {"schemeKey": "issue_resolution", "premiseRoles": [{"roleId": "finding"}], "criticalQuestions": [{"id": "CQ1"}, {"id": "CQ2"}]},
            {"schemeKey": "issue_aggregation", "premiseRoles": [{"roleId": "issueFinding"}], "criticalQuestions": [{"id": "CQ1"}]},
        ]})))

        class Silent(Assigner):
            def call_model(self, messages):
                return json.dumps({"assignments": []})

        out = json.loads(
            Silent(graph_json=Message(json.dumps(graph, ensure_ascii=False)), scheme_catalog=splitter.build_scheme_catalog(),
                   prompt_template="{scheme_catalog}{ra_items_json}", retries=0, **MODEL).assign().text
        )
        by_role: dict[str, list[dict]] = {}
        for ra in (n for n in out["AIF"]["nodes"] if n["type"] == "RA"):
            by_role.setdefault(self._ra_role(out, ra), []).append(ra["schemeApplication"])
        # 쟁점 종합 RA 는 쟁점 전부를 전제로 받는 하나뿐이다.
        self.assertEqual([a["schemeKey"] for a in by_role["ra_claim"]], ["issue_aggregation"])
        self.assertEqual([b["roleId"] for b in by_role["ra_claim"][0]["premiseBindings"]], ["issueFinding"])
        self.assertEqual(len(by_role["ra_claim"][0]["premiseBindings"][0]["nodeIds"]), 3)
        self.assertEqual([a["schemeKey"] for a in by_role["ra_upper"]], ["issue_resolution"] * 3)
        # 모델이 침묵한 실질 추론만 미분류로 남는다.
        self.assertEqual([a["schemeKey"] for a in by_role["ra_lower"]], ["unclassified"] * 3)
        upper = by_role["ra_upper"][0]
        self.assertEqual([b["roleId"] for b in upper["premiseBindings"]], ["finding"])
        self.assertEqual([r["questionId"] for r in upper["criticalQuestionResponses"]], ["CQ1", "CQ2"])
        self.assertTrue(all(r["status"] == "open" and r["answer"] == "" for r in upper["criticalQuestionResponses"]))
        self.assertNotIn("errors", upper)
        self.assertTrue(upper["rationale"])
        self.assertEqual(upper["alternatives"], [])

    def test_structural_scheme_keys_cannot_be_chosen_by_the_model(self):
        """모델이 쟁점 관계 key 를 답해도 받지 않는다 (구조로만 정해지는 key)."""
        catalog = {"issue_resolution": {"premiseRoles": [{"roleId": "finding"}], "criticalQuestions": [{"id": "CQ1"}]}}
        alias = {"ra": {"nodeID": "ra"}, "premises": {"N1": "a"}, "conclusions": ["c"]}
        application, errors = Assigner.validate_assignment({"scheme_key": "issue_resolution"}, alias, catalog)
        self.assertEqual(application["schemeKey"], "unclassified")
        self.assertEqual(errors, ["scheme_key 'issue_resolution' is assigned by graph structure only and cannot be chosen"])

    def test_scheme_assigner_validation(self):
        graph = json.loads(run_pipeline(SAMPLE_TEXT))
        for node in graph["AIF"]["nodes"]:
            node.pop("schemeApplication", None)
        # 쟁점마다 그룹이 따로 돌고, 이제 그룹에 남는 RA 는 실질 추론 하나(R1)뿐이다.
        # 그룹1: 끝까지 잘못된 답 / 그룹2: 올바른 key 에 잘못된 CQ·대안 / 그룹3: 답 없음
        answers = [
            [{"ra": "R1", "scheme_key": "made_up", "premise_bindings": [{"role_id": "x", "premises": ["N9"]}]}],
            [{"ra": "R1", "scheme_key": "made_up", "premise_bindings": [{"role_id": "x", "premises": ["N9"]}]}],
            [{"ra": "R1", "scheme_key": "sign", "premise_bindings": [{"role_id": "specific", "premises": ["N1"]}],
              "critical_question_responses": [{"question_id": "CQ9", "status": "satisfied"}], "alternatives": [{"scheme_key": "nope"}]}],
            [],
            [],
        ]
        splitter = Splitter(payload=Message(json.dumps({"judgment": "x", "scheme_catalog": [
            {"schemeKey": "sign", "premiseRoles": [{"roleId": "specific"}], "criticalQuestions": [{"id": "CQ1"}]},
            {"schemeKey": "issue_resolution", "premiseRoles": [{"roleId": "finding"}], "criticalQuestions": [{"id": "CQ1"}]},
            {"schemeKey": "issue_aggregation", "premiseRoles": [{"roleId": "issueFinding"}], "criticalQuestions": [{"id": "CQ1"}]},
        ]})))
        seen_catalogs = []

        class Fake(Assigner):
            def call_model(self, messages):
                seen_catalogs.append(messages[-1]["content"])
                index = min(len(seen_catalogs) - 1, len(answers) - 1)
                return json.dumps({"assignments": answers[index]})

        out = json.loads(
            Fake(graph_json=Message(json.dumps(graph, ensure_ascii=False)), scheme_catalog=splitter.build_scheme_catalog(),
                 prompt_template="{scheme_catalog}{ra_items_json}", retries=1, **MODEL).assign().text
        )
        # 쟁점 관계 scheme 은 모델에게 보이지 않는다 (고를 수 없도록).
        self.assertTrue(seen_catalogs)
        for prompt in seen_catalogs:
            self.assertNotIn('"schemeKey": "issue_resolution"', prompt)
            self.assertNotIn('"schemeKey": "issue_aggregation"', prompt)
        # 실질 추론 RA(쟁점 노드에 닿지 않는 것)만 모델의 답을 받는다.
        ras = [n for n in out["AIF"]["nodes"] if n["type"] == "RA"]
        inferences = [n for n in ras if self._ra_role(out, n) == "ra_lower"]
        self.assertEqual([self._ra_role(out, n) for n in ras].count("ra_lower"), 3)
        first, second, third = (n["schemeApplication"] for n in inferences)
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
