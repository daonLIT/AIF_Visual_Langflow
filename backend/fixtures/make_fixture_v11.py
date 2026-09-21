"""
v11 mock fixture 생성기.

v11 flow 의 실제 컴포넌트 코드(Splitter → Issue Selector → Branch Extractor → Graph Builder → Summarizer →
Scheme Assigner → Result Validator)를 lfx 스텁으로 실행하고, 모델 호출만 사람이 작성한 가상 응답으로 바꿔
샘플 판결문(packages/aif-workbench/fixtures/sample-case.json)에 대한 출력을 만든다.

실행 (backend 폴더에서): python fixtures/make_fixture_v11.py
출력: fixtures/langflow_run_response.sample.json

주의: 실제 Langflow/Ollama 응답이 아니다. 실서버 검증을 대체하지 않는다. 실제 응답은 LANGFLOW_CAPTURE_DIR 로 저장한다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))

from app.services.catalogs import IssueCatalog, SchemeCatalog  # noqa: E402
from fixtures.make_fixture import wrap_envelope  # noqa: E402
from tests.lfx_stub import Message, load_component  # noqa: E402

SAMPLE = ROOT.parent.parent / "packages" / "aif-workbench" / "fixtures" / "sample-case.json"
ISSUES = IssueCatalog.load(ROOT.parent / "catalog" / "issue_catalog.json")
SCHEMES = SchemeCatalog.load(ROOT.parent / "catalog" / "walton_schemes.json")

CLAIM = {
    "case_id": "SAMPLE-CASE",
    "main_claim": "피고인에 대한 강간의 공소사실은 합리적 의심의 여지 없이 증명되었다.",
    "evidence_quote": "피고인에 대한 강간의 공소사실은 합리적 의심의 여지 없이 증명되었다.",
}

# 첫 답은 일부러 4개·중복을 내서 검증·재시도 경로를 거치게 한다.
SELECTION_ATTEMPTS = [
    {
        "selected_issues": [
            {"issue_id": "ISS-007", "issue_text": "쟁점: 피해자 진술의 일관성", "selection_reason": "x", "evidence_quote": ""},
            {"issue_id": "ISS-007", "issue_text": "쟁점: 중복", "selection_reason": "x", "evidence_quote": ""},
            {"issue_id": "ISS-009", "issue_text": "쟁점: 번복", "selection_reason": "x", "evidence_quote": ""},
            {"issue_id": "ISS-028", "issue_text": "쟁점: 폭행 정도", "selection_reason": "x", "evidence_quote": ""},
        ],
        "no_issue_reason": "",
    },
    {
        "selected_issues": [
            {
                "issue_id": "ISS-007",
                "issue_text": "쟁점: 피해자 진술이 수사기관부터 법정까지 일관되고 구체적이어서 신빙성이 있는지",
                "selection_reason": "판결의 첫 번째 판단 근거로, 법원은 피해자 진술의 일관성·구체성을 들어 신빙성을 인정했다.",
                "evidence_quote": "피해자의 진술은 신빙성이 있다고 봄이 타당하다.",
            },
            {
                "issue_id": "ISS-009",
                "issue_text": "쟁점: 합의에 의한 성관계였다는 피고인 진술이 번복되어 믿기 어려운지",
                "selection_reason": "법원은 피고인 진술이 수사 초기와 법정에서 번복된 점을 들어 합의 주장을 배척했다.",
                "evidence_quote": "합의에 의한 성관계였다는 피고인의 주장은 받아들이지 아니한다.",
            },
            {
                "issue_id": "ISS-028",
                "issue_text": "쟁점: 피고인이 행사한 유형력이 피해자의 항거를 현저히 곤란하게 할 정도였는지",
                "selection_reason": "강간죄 성립의 핵심 요건으로, 법원은 유형력의 정도를 따로 판단했다.",
                "evidence_quote": "피고인이 행사한 유형력은 피해자의 항거를 현저히 곤란하게 하는 정도에 이르렀다고 인정된다.",
            },
        ],
        "no_issue_reason": "",
    },
]

BRANCHES = {
    "ISS-007": {
        "upper_i_node": {"text": "피해자의 진술은 신빙성이 있다고 봄이 타당하다.", "evidence_quote": "피해자의 진술은 신빙성이 있다고 봄이 타당하다."},
        "lower_i_nodes": [
            {
                "text": "피해자는 수사기관에서부터 이 법정에 이르기까지 일관되게 피고인으로부터 강간을 당하였다고 진술하고 있다.",
                "evidence_quote": "피해자는 수사기관에서부터 이 법정에 이르기까지 일관되게 피고인으로부터 강간을 당하였다고 진술하고 있다.",
            },
            {
                "text": "피해자의 진술은 일시ㆍ장소 및 행위의 태양에 관하여 구체적이고 세부적이며, 현장 사진 및 통화 내역 등 객관적 정황과도 모순되지 않는다.",
                "evidence_quote": "피해자의 진술은 일시ㆍ장소 및 행위의 태양에 관하여 구체적이고 세부적이며, 현장 사진 및 통화 내역 등 객관적 정황과도 모순되지 않는다.",
            },
            {
                "text": "피해자에 대한 경찰 진술조서의 기재와 이 법정에서의 증언 사이에 본질적인 차이를 발견할 수 없다.",
                "evidence_quote": "피해자에 대한 경찰 진술조서의 기재와 이 법정에서의 증언 사이에 본질적인 차이를 발견할 수 없는 점",
            },
        ],
    },
    "ISS-009": {
        "upper_i_node": {
            "text": "합의에 의한 성관계였다는 피고인의 주장은 받아들이지 아니한다.",
            "evidence_quote": "합의에 의한 성관계였다는 피고인의 주장은 받아들이지 아니한다.",
        },
        "lower_i_nodes": [
            {"text": "피고인의 진술은 수사 초기와 이 법정에서 그 내용이 번복되었다.", "evidence_quote": "피고인의 진술은 수사 초기와 이 법정에서 그 내용이 번복되었는바"},
            {"text": "피고인의 진술은 신빙성이 낮다.", "evidence_quote": "피고인의 진술은 신빙성이 낮다."},
        ],
    },
    "ISS-028": {
        "upper_i_node": {
            "text": "피고인이 행사한 유형력은 피해자의 항거를 현저히 곤란하게 하는 정도에 이르렀다고 인정된다.",
            "evidence_quote": "피고인이 행사한 유형력은 피해자의 항거를 현저히 곤란하게 하는 정도에 이르렀다고 인정된다.",
        },
        "lower_i_nodes": [
            {"text": "피고인은 피해자의 양팔을 붙잡아 침대에 눕혔다.", "evidence_quote": "피고인은 피해자의 양팔을 붙잡아 침대에 눕혔고"},
            {"text": "피해자는 피고인을 밀쳐내며 거부 의사를 표시하였으나 제압당하였다.", "evidence_quote": "피해자는 피고인을 밀쳐내며 거부 의사를 표시하였으나 제압당하였다."},
            {"text": "강간죄의 폭행은 상대방의 항거를 현저히 곤란하게 할 정도이면 족하다.", "evidence_quote": "강간죄의 폭행은 상대방의 항거를 현저히 곤란하게 할 정도이면 족한 것인바"},
        ],
    },
}

SUMMARIES = {
    CLAIM["main_claim"]: "강간 공소사실이 합리적 의심 없이 증명됨",
    SELECTION_ATTEMPTS[1]["selected_issues"][0]["issue_text"]: "피해자 진술의 일관성·구체성에 따른 신빙성",
    SELECTION_ATTEMPTS[1]["selected_issues"][1]["issue_text"]: "번복된 피고인 합의 주장의 신빙성",
    SELECTION_ATTEMPTS[1]["selected_issues"][2]["issue_text"]: "유형력이 항거를 현저히 곤란하게 했는지",
    "피해자의 진술은 신빙성이 있다고 봄이 타당하다.": "피해자 진술은 신빙성이 있음",
    "피해자는 수사기관에서부터 이 법정에 이르기까지 일관되게 피고인으로부터 강간을 당하였다고 진술하고 있다.": "피해자는 수사부터 법정까지 강간 피해를 일관되게 진술함",
    "피해자의 진술은 일시ㆍ장소 및 행위의 태양에 관하여 구체적이고 세부적이며, 현장 사진 및 통화 내역 등 객관적 정황과도 모순되지 않는다.": "피해자 진술은 구체적이고 객관적 정황과 모순되지 않음",
    "피해자에 대한 경찰 진술조서의 기재와 이 법정에서의 증언 사이에 본질적인 차이를 발견할 수 없다.": "경찰 조서와 법정 증언 사이에 본질적 차이가 없음",
    "합의에 의한 성관계였다는 피고인의 주장은 받아들이지 아니한다.": "합의였다는 피고인 주장은 받아들이지 않음",
    "피고인의 진술은 수사 초기와 이 법정에서 그 내용이 번복되었다.": "피고인 진술은 수사 초기와 법정에서 번복됨",
    "피고인의 진술은 신빙성이 낮다.": "피고인 진술은 신빙성이 낮음",
    "피고인이 행사한 유형력은 피해자의 항거를 현저히 곤란하게 하는 정도에 이르렀다고 인정된다.": "피고인의 유형력은 항거를 현저히 곤란하게 할 정도로 인정됨",
    "피고인은 피해자의 양팔을 붙잡아 침대에 눕혔다.": "피고인이 피해자 양팔을 붙잡아 침대에 눕힘",
    "피해자는 피고인을 밀쳐내며 거부 의사를 표시하였으나 제압당하였다.": "피해자는 밀쳐내며 거부했으나 제압당함",
    "강간죄의 폭행은 상대방의 항거를 현저히 곤란하게 할 정도이면 족하다.": "강간죄 폭행은 항거를 현저히 곤란하게 할 정도면 족함",
}


def cq(question_id, status, answer):
    return {"question_id": question_id, "status": status, "answer": answer}


# 그룹 순서(issue-1, 2, 3) × RA 순서(쟁점→주장, 상위→쟁점, 하위→상위)
SCHEME_ANSWERS = [
    [
        {"ra": "R1", "scheme_key": "witness_testimony", "rationale": "신빙성이 인정된 피해자 진술이 강간 공소사실을 뒷받침한다.",
         "premise_bindings": [{"role_id": "statement", "premises": ["N1"]}], "critical_question_responses": [cq("CQ1", "satisfied", "수사부터 법정까지 일관됨")],
         "alternatives": [{"scheme_key": "evidence_to_hypothesis", "rationale": "객관 정황과의 부합으로 공소사실을 검증한 것으로 볼 수도 있음"}]},
        {"ra": "R2", "scheme_key": "evidence_to_hypothesis", "rationale": "진술이 사실이라면 기대되는 정황이 확인되어 쟁점의 결론(신빙성 인정)을 뒷받침한다.",
         "premise_bindings": [{"role_id": "observation", "premises": ["N2"]}], "critical_question_responses": [], "alternatives": []},
        {"ra": "R3", "scheme_key": "sign", "rationale": "일관성·구체성·조서와 증언의 부합은 진술을 믿을 수 있다는 징표로 쓰였다.",
         "premise_bindings": [{"role_id": "specific", "premises": ["N3", "N4", "N5"]}],
         "critical_question_responses": [cq("CQ1", "satisfied", "현장 사진·통화 내역으로 확인됨"), cq("CQ2", "open", "")], "alternatives": []},
    ],
    [
        {"ra": "R1", "scheme_key": "best_explanation", "rationale": "합의라는 대안 설명이 배척되어 공소사실이 인정 사실을 가장 잘 설명한다.",
         "premise_bindings": [{"role_id": "explanation", "premises": ["N1"]}], "critical_question_responses": [], "alternatives": [{"scheme_key": "alternatives", "rationale": "합의라는 대안을 배제한 논증으로 볼 수도 있음"}]},
        {"ra": "R2", "scheme_key": "unclassified", "rationale": "상위 명제가 쟁점 명제를 사실상 다시 진술하는 관계라 별도 추론 방식으로 보기 어렵다.",
         "premise_bindings": [], "critical_question_responses": [], "alternatives": []},
        {"ra": "R3", "scheme_key": "inconsistent_commitment", "rationale": "수사 초기와 법정 진술이 번복되어 합의 주장을 신뢰하기 어렵다고 판단했다.",
         "premise_bindings": [{"role_id": "opposedCommitment", "premises": ["N3"]}], "critical_question_responses": [cq("CQ2", "open", "")], "alternatives": [{"scheme_key": "witness_testimony", "rationale": "피고인 진술의 신빙성 문제로 볼 수도 있음"}]},
    ],
    [
        {"ra": "R1", "scheme_key": "established_rule", "rationale": "폭행 요건이 충족되어 강간죄 성립 요건 중 하나가 인정된다.",
         "premise_bindings": [{"role_id": "applicability", "premises": ["N1"]}], "critical_question_responses": [], "alternatives": []},
        {"ra": "R2", "scheme_key": "established_rule", "rationale": "폭행의 판례 기준에 인정 사실을 적용했다.",
         "premise_bindings": [{"role_id": "applicability", "premises": ["N2"]}], "critical_question_responses": [], "alternatives": []},
        {"ra": "R3", "scheme_key": "verbal_classification", "rationale": "양팔을 붙잡아 제압한 행위를 항거를 현저히 곤란하게 하는 유형력으로 분류했다.",
         "premise_bindings": [{"role_id": "individual", "premises": ["N3", "N4"]}, {"role_id": "classification", "premises": ["N5"]}],
         "critical_question_responses": [cq("CQ1", "satisfied", "밀쳐냈으나 제압당한 사실이 인정됨")], "alternatives": []},
    ],
]


def model_payload(text: str) -> str:
    return json.dumps(
        {
            "case_id": "SAMPLE-CASE",
            "judgment": text,
            "issue_catalog": ISSUES.input_items(),
            "issue_catalog_version": ISSUES.version,
            "scheme_catalog": SCHEMES.input_items(),
            "scheme_catalog_version": SCHEMES.version,
        },
        ensure_ascii=False,
    )


def run_pipeline(judgment: str, *, selection_attempts=None, branches=None, scheme_answers=None) -> str:
    selection_attempts = list(selection_attempts if selection_attempts is not None else SELECTION_ATTEMPTS)
    branches = branches if branches is not None else BRANCHES
    scheme_answers = list(scheme_answers if scheme_answers is not None else SCHEME_ANSWERS)

    Splitter, _ = load_component("judgment_splitter.py", "JudgmentSplitter")
    Selector, _ = load_component("issue_selector.py", "IssueSelector")
    Extractor, _ = load_component("issue_branch_extractor.py", "IssueBranchExtractor")
    Builder, _ = load_component("aif_graph_builder.py", "TopDownAIFGraphBuilder")
    Summarizer, _ = load_component("node_summarizer.py", "NodeSummarizer")
    Assigner, _ = load_component("scheme_assigner.py", "SchemeAssigner")
    Validator, _ = load_component("result_validator.py", "ResultValidator")

    splitter = Splitter(payload=Message(model_payload(judgment)))
    model = dict(base_url="http://ollama.test", model_name="fixture", temperature=0.1, num_ctx=16384, timeout=0, system_message="")
    claim = Message(json.dumps(CLAIM, ensure_ascii=False))

    class FakeSelector(Selector):
        def call_model(self, messages):
            answer = selection_attempts.pop(0) if len(selection_attempts) > 1 else selection_attempts[0]
            return {"content": json.dumps(answer, ensure_ascii=False), "prompt_eval_count": 4000, "done_reason": "stop"}

    selection = FakeSelector(
        judgment=splitter.build_judgment(), issue_catalog=splitter.build_issue_catalog(), claim_json=claim,
        prompt_template="{max_issues}\n{main_claim}\n{issue_catalog}\n{judgment}", retries=2, **model,
    ).select()

    class FakeExtractor(Extractor):
        def call_model(self, prompt):
            issue_id = next(key for key in branches if f'"issue_id": "{key}"' in prompt)
            return {"content": json.dumps(branches[issue_id], ensure_ascii=False), "prompt_eval_count": 3000, "done_reason": "stop"}

    extracted = FakeExtractor(
        selection_json=selection, judgment=splitter.build_judgment(), claim_json=claim,
        prompt_template="{issue_json}\n{main_claim}\n{judgment}", retries=1, **model,
    ).extract()
    graph = Builder(claim_json=claim, selection_json=selection, branches_json=extracted, catalog_versions=splitter.build_catalog_versions()).assemble()

    class FakeSummarizer(Summarizer):
        def call_model(self, prompt):
            items = json.loads(prompt[prompt.index("["):])
            return json.dumps({"summaries": [{"node_id": i["node_id"], "summary": SUMMARIES[i["text"]]} for i in items if i["text"] in SUMMARIES]}, ensure_ascii=False)

    summarized = FakeSummarizer(graph_json=graph, prompt_template="{nodes_json}", batch_size=16, retries=1, **model).summarize()

    class FakeAssigner(Assigner):
        def call_model(self, messages):
            return json.dumps({"assignments": scheme_answers.pop(0)}, ensure_ascii=False)

    classified = FakeAssigner(
        graph_json=summarized, scheme_catalog=splitter.build_scheme_catalog(), prompt_template="{scheme_catalog}\n{ra_items_json}", retries=1, **model,
    ).assign()
    final = Validator(graph_json=classified, issue_catalog=splitter.build_issue_catalog(), scheme_catalog=splitter.build_scheme_catalog()).validate()
    return final.text


def main() -> None:
    judgment = json.loads(SAMPLE.read_text(encoding="utf-8"))["text"]
    for branch in BRANCHES.values():
        for prop in [branch["upper_i_node"], *branch["lower_i_nodes"]]:
            assert prop["evidence_quote"] in judgment, prop["evidence_quote"]
    text = run_pipeline(judgment)
    graph = json.loads(text)
    assert graph["status"] == "ok", graph.get("errors")
    out = ROOT / "langflow_run_response.sample.json"
    out.write_text(json.dumps(wrap_envelope(text), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out.name} ({len(graph['AIF']['nodes'])} nodes / {len(graph['AIF']['edges'])} edges, validation {graph['meta']['validation']})")


if __name__ == "__main__":
    main()
