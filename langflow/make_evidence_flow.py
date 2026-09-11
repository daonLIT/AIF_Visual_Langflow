"""
원본 flow(v8)에서 근거 인용(evidence) 출력을 추가한 수정본(v9)을 생성한다.

실행: python langflow/make_evidence_flow.py  (프로젝트 루트에서)
입력: langflow/original_langflow_260904h.json (원본 참조본, 저장소 제외)
출력: langflow/TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json

변경 내용
1. 입력 컴포넌트의 샘플 판결문을 placeholder 로 교체 (실제 판결문을 파일에 남기지 않음)
2. 프롬프트: 노드 문장마다 원문에서 그대로 복사한 evidence_quote 를 함께 요구
   - Main Claim: {case_id, main_claim, evidence_quote}
   - Issues: issues[].{issue_no, text, evidence_quote}
   - I-node: upper_i_node / lower_i_nodes 항목이 {text, evidence_quote} 객체
3. Graph Builder: 문자열/객체 입력을 모두 받아 AIF 노드에 evidence: [{"quote": ...}] 를 붙임
4. flow id / name / description 갱신. 컴포넌트 ID(CustomComponent-k5fj9, ChatOutput-nL1VD)는 유지.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "original_langflow_260904h.json"
TARGET = ROOT / "TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json"

PLACEHOLDER_INPUT = json.dumps(
    {"case_id": "CASE_ID", "judgment": "판결문 원문. 중계 서버가 tweaks 로 이 값을 덮어쓴다."},
    ensure_ascii=False,
    indent=2,
)

EVIDENCE_RULES = """
# Evidence rules (mandatory)
- For every proposition you output, also output `evidence_quote`: a passage copied VERBATIM from the judgment
  (same characters, spacing and punctuation) that grounds the proposition. Do not paraphrase inside evidence_quote.
- The quote must be a single contiguous passage. Prefer the shortest sentence or clause that fully supports the proposition.
- If the proposition itself is a verbatim sentence, evidence_quote may equal the proposition text.
- Never invent a quote. If no verbatim passage exists, set evidence_quote to an empty string.
"""

MAIN_CLAIM_OUTPUT_OLD = """10. The JSON object must contain exactly:
    - case_id
    - main_claim"""
MAIN_CLAIM_OUTPUT_NEW = """10. The JSON object must contain exactly:
    - case_id
    - main_claim
    - evidence_quote  (verbatim passage from the judgment that states the main claim)
""" + EVIDENCE_RULES

ISSUES_OUTPUT_OLD = """14. Each issue object must contain:
    - issue_no
    - text"""
ISSUES_OUTPUT_NEW = """14. Each issue object must contain:
    - issue_no
    - text
    - evidence_quote  (verbatim passage from the judgment where the court addresses this ground)
""" + EVIDENCE_RULES

INODE_OUTPUT_OLD = """2. The JSON object must contain exactly:
   - issue_no
   - issue_text
   - upper_i_node
   - lower_i_nodes
3. lower_i_nodes must be an array of complete proposition strings."""
INODE_OUTPUT_NEW = """2. The JSON object must contain exactly:
   - issue_no
   - issue_text
   - upper_i_node
   - lower_i_nodes
3. upper_i_node must be an object: {"text": <complete proposition>, "evidence_quote": <verbatim passage>}
4. lower_i_nodes must be an array of objects, each {"text": <complete proposition>, "evidence_quote": <verbatim passage>}.
""" + EVIDENCE_RULES

EXAMPLE_OLD = '"피고인의 정액과 피해자의 DNA가 혼합되어 검출되었다"'
EXAMPLE_NEW = '"현장에서 수거된 물건에서 갑의 지문과 을의 지문이 함께 검출되었다"'

BUILDER_CODE = r'''from __future__ import annotations

import json
import re

from lfx.custom import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.message import Message


class TopDownAIFGraphBuilder(Component):
    display_name = "Top-Down AIF Graph Builder (evidence)"
    description = "Deterministically builds AIF/OVA JSON from Main Claim, 3 Issues, and issue-conditioned upper/lower I-node JSON. Keeps evidence quotes on each node."
    icon = "Network"
    name = "TopDownAIFGraphBuilderEvidence"

    inputs = [
        MessageTextInput(name="claim_json", display_name="Main Claim JSON", required=True),
        MessageTextInput(name="issues_json", display_name="Issues JSON", required=True),
        MessageTextInput(name="issue1_json", display_name="Issue 1 I-node JSON", required=True),
        MessageTextInput(name="issue2_json", display_name="Issue 2 I-node JSON", required=True),
        MessageTextInput(name="issue3_json", display_name="Issue 3 I-node JSON", required=True),
    ]

    outputs = [
        Output(display_name="Final AIF JSON", name="graph_json", method="assemble")
    ]

    @staticmethod
    def _text(value) -> str:
        text = getattr(value, "text", None)
        return str(text if text is not None else (value or ""))

    @classmethod
    def _parse(cls, value, label: str) -> dict:
        text = cls._text(value).strip()
        m = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.I | re.S)
        if m:
            text = m.group(1).strip()
        try:
            obj = json.loads(text)
        except Exception as e:
            raise ValueError(f"{label} is not valid JSON: {e}") from e
        if not isinstance(obj, dict):
            raise ValueError(f"{label} must be a JSON object.")
        return obj

    @staticmethod
    def _clean_text(value, label: str) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValueError(f"{label} is empty.")
        return text

    @classmethod
    def _proposition(cls, value, label: str) -> tuple[str, list[str]]:
        """문자열(v8) 또는 {"text", "evidence_quote"} 객체(v9)를 (text, quotes) 로 정규화한다."""
        if isinstance(value, dict):
            text = cls._clean_text(value.get("text"), f"{label} text")
            quotes = value.get("evidence_quote")
            if isinstance(quotes, str):
                quotes = [quotes]
            elif not isinstance(quotes, list):
                quotes = []
            quotes = [str(q).strip() for q in quotes if str(q or "").strip()]
            return text, quotes
        return cls._clean_text(value, label), []

    @staticmethod
    def _node(node_id: str, text: str, node_type: str, quotes: list[str] | None = None) -> dict:
        node = {"nodeID": node_id, "text": text, "type": node_type}
        if quotes:
            node["evidence"] = [{"quote": q} for q in quotes]
        return node

    def assemble(self) -> Message:
        claim = self._parse(self.claim_json, "Main Claim JSON")
        issues = self._parse(self.issues_json, "Issues JSON")
        branches = [
            self._parse(self.issue1_json, "Issue 1 JSON"),
            self._parse(self.issue2_json, "Issue 2 JSON"),
            self._parse(self.issue3_json, "Issue 3 JSON"),
        ]

        main_claim = self._clean_text(claim.get("main_claim"), "main_claim")
        main_quotes = [q for q in [str(claim.get("evidence_quote") or "").strip()] if q]
        case_id = str(claim.get("case_id") or issues.get("case_id") or "").strip()

        issue_items = issues.get("issues")
        if not isinstance(issue_items, list) or len(issue_items) != 3:
            raise ValueError("Issues JSON must contain exactly 3 issue objects.")

        issue_texts = []
        issue_quotes = []
        for idx, item in enumerate(issue_items, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"Issue {idx} must be an object.")
            issue_texts.append(self._clean_text(item.get("text"), f"issue {idx} text"))
            quote = str(item.get("evidence_quote") or "").strip()
            issue_quotes.append([quote] if quote else [])

        parsed_branches = []
        for idx, branch in enumerate(branches, start=1):
            upper, upper_quotes = self._proposition(branch.get("upper_i_node"), f"issue {idx} upper_i_node")
            lowers = branch.get("lower_i_nodes")
            if not isinstance(lowers, list) or len(lowers) == 0:
                raise ValueError(f"Issue {idx} lower_i_nodes must be a non-empty array.")
            lower_items = [self._proposition(x, f"issue {idx} lower_i_node") for x in lowers]

            # Safety against duplicated Main Claim in lower nodes.
            lower_items = [x for x in lower_items if x[0] != main_claim]
            if not lower_items:
                raise ValueError(f"Issue {idx} has no lower I-nodes after removing duplicated Main Claim.")

            # Prevent exact duplicate lower nodes while preserving order.
            deduped = []
            seen = set()
            for text, quotes in lower_items:
                if text not in seen:
                    deduped.append((text, quotes))
                    seen.add(text)

            parsed_branches.append({"upper": upper, "upper_quotes": upper_quotes, "lowers": deduped})

        # 노드 ID 접미사는 중계 서버가 실행별 namespace 로 다시 부여한다.
        suffix = "20260903190000"
        counter = 1
        def next_id():
            nonlocal counter
            value = f"{counter}_{suffix}"
            counter += 1
            return value

        aif_nodes = []
        aif_edges = []
        edge_id = 1

        def add_edge(frm: str, to: str):
            nonlocal edge_id
            aif_edges.append({"edgeID": edge_id, "fromID": frm, "toID": to})
            edge_id += 1

        main_id = next_id()
        aif_nodes.append(self._node(main_id, main_claim, "I", main_quotes))

        layout = {main_id: (1000, 60)}
        branch_x = [420, 1000, 1580]

        for bidx in range(3):
            x = branch_x[bidx]
            branch = parsed_branches[bidx]

            issue_id = next_id()
            upper_id = next_id()
            ra_upper_issue_id = next_id()
            ra_lower_upper_id = next_id()

            aif_nodes.append(self._node(issue_id, issue_texts[bidx], "ISSUE", issue_quotes[bidx]))
            aif_nodes.append(self._node(upper_id, branch["upper"], "I", branch["upper_quotes"]))
            aif_nodes.append(self._node(ra_upper_issue_id, "RA", "RA"))
            aif_nodes.append(self._node(ra_lower_upper_id, "RA", "RA"))

            layout[issue_id] = (x, 250)
            layout[ra_upper_issue_id] = (x, 345)
            layout[upper_id] = (x, 440)
            layout[ra_lower_upper_id] = (x, 565)

            lower_ids = []
            y = 760
            for lower_text, lower_quotes in branch["lowers"]:
                lower_id = next_id()
                lower_ids.append(lower_id)
                aif_nodes.append(self._node(lower_id, lower_text, "I", lower_quotes))
                layout[lower_id] = (x, y)
                y += 125

            ra_issue_claim_id = next_id()
            aif_nodes.append(self._node(ra_issue_claim_id, "RA", "RA"))
            layout[ra_issue_claim_id] = (x, 155)

            for lower_id in lower_ids:
                add_edge(lower_id, ra_lower_upper_id)
            add_edge(ra_lower_upper_id, upper_id)
            add_edge(upper_id, ra_upper_issue_id)
            add_edge(ra_upper_issue_id, issue_id)
            add_edge(issue_id, ra_issue_claim_id)
            add_edge(ra_issue_claim_id, main_id)

        ova_nodes = []
        for node in aif_nodes:
            x, y = layout[node["nodeID"]]
            ova_nodes.append({"nodeID": node["nodeID"], "visible": True, "x": x, "y": y, "timestamp": ""})

        ova_edges = [{"fromID": e["fromID"], "toID": e["toID"], "visible": True} for e in aif_edges]

        graph = {
            "AIF": {
                "nodes": aif_nodes,
                "edges": aif_edges,
                "schemefulfillments": [],
                "participants": [],
                "locutions": [],
                "descriptorfulfillments": [],
                "cqdescriptorfulfillments": [],
            },
            "text": case_id if case_id else "Top-down judgment AIF graph",
            "OVA": {"firstname": "Anon", "surname": "User", "url": "", "nodes": ova_nodes, "edges": ova_edges},
        }

        text = json.dumps(graph, ensure_ascii=False, indent=2)
        msg = Message(text=text)
        self.status = f"{len(aif_nodes)} nodes / {len(aif_edges)} edges"
        return msg
'''


def _replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label}: 원본 프롬프트에서 예상한 문구를 찾지 못했습니다. 원본 flow 가 바뀌었는지 확인하세요.")
    return text.replace(old, new, 1)


def main() -> None:
    flow = json.loads(SOURCE.read_text(encoding="utf-8"))
    nodes = {n["id"]: n for n in flow["data"]["nodes"]}

    # 1) 입력 placeholder
    nodes["CustomComponent-k5fj9"]["data"]["node"]["template"]["value"]["value"] = PLACEHOLDER_INPUT

    # 2) 프롬프트
    def prompt_of(node_id: str) -> dict:
        return nodes[node_id]["data"]["node"]["template"]["template"]

    prompt_of("Prompt Template-8w7OV")["value"] = _replace_once(
        prompt_of("Prompt Template-8w7OV")["value"], MAIN_CLAIM_OUTPUT_OLD, MAIN_CLAIM_OUTPUT_NEW, "Main Claim"
    )
    prompt_of("Prompt Template-TbYU5")["value"] = _replace_once(
        prompt_of("Prompt Template-TbYU5")["value"], ISSUES_OUTPUT_OLD, ISSUES_OUTPUT_NEW, "Issues"
    )
    for node_id in ("Prompt Template-s9yHj", "Prompt Template-fzDzv", "Prompt Template-iDlrU"):
        prompt_of(node_id)["value"] = _replace_once(prompt_of(node_id)["value"], INODE_OUTPUT_OLD, INODE_OUTPUT_NEW, node_id)
        # 프롬프트 안의 예시 문장이 실제 사건 문장이므로 중립적인 예시로 바꾼다.
        prompt_of(node_id)["value"] = _replace_once(
            prompt_of(node_id)["value"], EXAMPLE_OLD, EXAMPLE_NEW, f"{node_id} example"
        )

    # 3) builder
    builder = nodes["CustomComponent-Ljw10"]["data"]["node"]
    builder["template"]["code"]["value"] = BUILDER_CODE
    builder["display_name"] = "Top-Down AIF Graph Builder (evidence)"
    builder["description"] = "v9: keeps evidence quotes on each AIF node."

    # 4) 메타데이터
    new_id = str(uuid.uuid4())
    flow["id"] = new_id
    flow["name"] = "TopDown_Judgment_to_AIF_3Issue_v9_Evidence"
    flow["description"] = (
        "v9 (evidence): v8 + verbatim evidence_quote for main claim, issues and every I-node; "
        "graph builder emits AIF node.evidence[]. Node ID suffix is re-namespaced by the relay server."
    )
    flow["tags"] = list(flow.get("tags") or []) + ["evidence", "v9"]
    for node in flow["data"]["nodes"]:
        template = node["data"]["node"].get("template", {})
        for key in ("_frontend_node_flow_id",):
            if key in template:
                template[key] = new_id

    TARGET.write_text(json.dumps(flow, ensure_ascii=False, indent=2), encoding="utf-8")
    text = TARGET.read_text(encoding="utf-8")
    assert "판시 범죄사실" not in text and "서울원스톱지원센터" not in text, "수정본에 판결문 텍스트가 남아 있습니다."
    print(f"wrote {TARGET.name} (flow id {new_id})")


if __name__ == "__main__":
    main()
