"""
mock fixture 생성기.

Langflow 의 Top-Down AIF Graph Builder(v8) 와 같은 규칙으로 샘플 판결문(packages/aif-workbench/fixtures/sample-case.json 의 text)
에 대한 AIF/OVA 그래프를 만들고, Langflow v1 run 응답 envelope 로 감싼다.
실행: python fixtures/make_fixture.py  (backend 폴더에서)

주의: 이 fixture 는 실제 Langflow/Ollama 응답이 아니다. 실서버 검증을 대체하지 않는다.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SAMPLE = ROOT.parent.parent / "packages" / "aif-workbench" / "fixtures" / "sample-case.json"

MAIN_CLAIM = "피고인에 대한 강간의 공소사실은 합리적 의심의 여지 없이 증명되었다."

ISSUES = [
    "쟁점 1: 피해자 진술의 일관성ㆍ구체성과 신빙성",
    "쟁점 2: 성관계 직후 메시지ㆍ통화ㆍ신고 정황의 의미",
    "쟁점 3: 피고인 진술 및 피해자의 사후 행동에 관한 반대 주장 평가",
]

BRANCHES = [
    {
        "upper": "피해자의 진술은 신빙성이 있다고 봄이 타당하다.",
        "lowers": [
            "피해자는 수사기관에서부터 이 법정에 이르기까지 일관되게 피고인으로부터 강간을 당하였다고 진술하고 있다.",
            "피해자의 진술은 일시ㆍ장소 및 행위의 태양에 관하여 구체적이고 세부적이며, 현장 사진 및 통화 내역 등 객관적 정황과도 모순되지 않는다.",
            "피해자에 대한 경찰 진술조서의 기재와 이 법정에서의 증언 사이에 본질적인 차이를 발견할 수 없다.",
        ],
    },
    {
        "upper": "이 사건에서 나타난 사후 정황은 피해자 진술에 부합하는 것으로 평가된다.",
        "lowers": [
            "피해자는 성관계 직후 지인에게 피해 사실을 알리는 메시지를 보냈고, 사건 당일 새벽 112에 피해 사실을 신고하였다.",
            "피해자와 지인 사이의 메신저 대화 내역 및 112 신고 접수 내역과 신고 녹음 파일은 위 각 사실을 뒷받침한다.",
        ],
    },
    {
        "upper": "합의에 의한 성관계였다는 피고인의 주장은 받아들이지 아니한다.",
        "lowers": [
            "피고인의 진술은 수사 초기와 이 법정에서 그 내용이 번복되었다.",
            "피고인의 진술은 신빙성이 낮다.",
        ],
    },
]


def build_graph(case_id: str, suffix: str = "20260903190000") -> dict:
    counter = 1

    def next_id() -> str:
        nonlocal counter
        value = f"{counter}_{suffix}"
        counter += 1
        return value

    nodes, edges = [], []
    edge_id = 1

    def node(node_id: str, text: str, node_type: str) -> None:
        nodes.append({"nodeID": node_id, "text": text, "type": node_type})

    def edge(frm: str, to: str) -> None:
        nonlocal edge_id
        edges.append({"edgeID": edge_id, "fromID": frm, "toID": to})
        edge_id += 1

    main_id = next_id()
    node(main_id, MAIN_CLAIM, "I")
    layout = {main_id: (1000, 60)}
    branch_x = [420, 1000, 1580]

    for bidx in range(3):
        x = branch_x[bidx]
        issue_id, upper_id = next_id(), next_id()
        ra_upper_issue_id, ra_lower_upper_id = next_id(), next_id()
        node(issue_id, ISSUES[bidx], "ISSUE")
        node(upper_id, BRANCHES[bidx]["upper"], "I")
        node(ra_upper_issue_id, "RA", "RA")
        node(ra_lower_upper_id, "RA", "RA")
        layout[issue_id] = (x, 250)
        layout[ra_upper_issue_id] = (x, 345)
        layout[upper_id] = (x, 440)
        layout[ra_lower_upper_id] = (x, 565)
        lower_ids = []
        y = 760
        for lower in BRANCHES[bidx]["lowers"]:
            lid = next_id()
            lower_ids.append(lid)
            node(lid, lower, "I")
            layout[lid] = (x, y)
            y += 125
        ra_issue_claim_id = next_id()
        node(ra_issue_claim_id, "RA", "RA")
        layout[ra_issue_claim_id] = (x, 155)
        for lid in lower_ids:
            edge(lid, ra_lower_upper_id)
        edge(ra_lower_upper_id, upper_id)
        edge(upper_id, ra_upper_issue_id)
        edge(ra_upper_issue_id, issue_id)
        edge(issue_id, ra_issue_claim_id)
        edge(ra_issue_claim_id, main_id)

    return {
        "AIF": {
            "nodes": nodes,
            "edges": edges,
            "schemefulfillments": [],
            "participants": [],
            "locutions": [],
            "descriptorfulfillments": [],
            "cqdescriptorfulfillments": [],
        },
        "text": case_id if case_id else "Top-down judgment AIF graph",
        "OVA": {
            "firstname": "Anon",
            "surname": "User",
            "url": "",
            "nodes": [
                {"nodeID": n["nodeID"], "visible": True, "x": layout[n["nodeID"]][0], "y": layout[n["nodeID"]][1], "timestamp": ""}
                for n in nodes
            ],
            "edges": [{"fromID": e["fromID"], "toID": e["toID"], "visible": True} for e in edges],
        },
    }


def wrap_envelope(text: str, component_id: str = "ChatOutput-nL1VD", session_id: str = "mock-session") -> dict:
    """Langflow 1.x `POST /api/v1/run/{flow_id}` 응답 형태."""
    message = {
        "text": text,
        "sender": "Machine",
        "sender_name": "AI",
        "session_id": session_id,
        "files": [],
        "timestamp": "2026-09-11 00:00:00 UTC",
        "flow_id": "00000000-0000-0000-0000-000000000000",
        "properties": {"source": {"id": "CustomComponent-Ljw10", "display_name": "Top-Down AIF Graph Builder"}},
    }
    return {
        "session_id": session_id,
        "outputs": [
            {
                "inputs": {"input_value": "{\"case_id\": \"SAMPLE\", \"judgment\": \"...\"}"},
                "outputs": [
                    {
                        "results": {"message": message},
                        "artifacts": {"message": text, "sender": "Machine", "sender_name": "AI", "type": "object"},
                        "outputs": {"message": {"message": message, "type": "message"}},
                        "logs": {"message": []},
                        "messages": [
                            {
                                "message": text,
                                "sender": "Machine",
                                "sender_name": "AI",
                                "session_id": session_id,
                                "component_id": component_id,
                                "files": [],
                                "type": "message",
                            }
                        ],
                        "component_display_name": "Final AIF JSON",
                        "component_id": component_id,
                        "used_frozen_result": False,
                    }
                ],
            }
        ],
    }


def main() -> None:
    graph = build_graph("SAMPLE-CASE")
    # 실제 flow 의 Chat Output 은 builder 가 만든 JSON 문자열을 그대로 전달한다.
    text = json.dumps(graph, ensure_ascii=False, indent=2)
    envelope = wrap_envelope(text)
    out = ROOT / "langflow_run_response.sample.json"
    out.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out} ({len(graph['AIF']['nodes'])} nodes / {len(graph['AIF']['edges'])} edges)")


if __name__ == "__main__":
    main()
