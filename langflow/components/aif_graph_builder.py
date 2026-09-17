from __future__ import annotations

import json
import re

from lfx.custom import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.message import Message

_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.I | re.S)
# 정답 그래프의 쟁점 수는 1~4개(평균 2.65)다. 상한 5에서는 4·5번째 쟁점의 적중이 낮아(정답 13건 1/12) 3으로 둔다.
# 몇 개를 고를지는 판결문이 정하고 이 값은 천장일 뿐이다.
MAX_SELECTED = 3


class TopDownAIFGraphBuilder(Component):
    display_name = "Top-Down AIF Graph Builder (v11)"
    description = (
        "Deterministically builds AIF/OVA JSON from the main claim, at most 3 automatically selected catalog "
        "issues and their extracted branches. Assigns node IDs and issue references. If no issue was selected it "
        "returns status no_issues without a graph; an invalid selection returns status invalid with errors."
    )
    icon = "Network"
    name = "TopDownAIFGraphBuilderV11"

    inputs = [
        MessageTextInput(name="claim_json", display_name="Main Claim JSON", required=True),
        MessageTextInput(name="selection_json", display_name="Selection JSON", required=True),
        MessageTextInput(name="branches_json", display_name="Branches JSON", required=True),
        MessageTextInput(name="catalog_versions", display_name="Catalog Versions", required=False),
    ]

    outputs = [Output(display_name="Graph JSON", name="graph_json", method="assemble")]

    SUFFIX = "20260903190000"  # 중계 서버가 실행별 namespace 로 다시 부여한다.

    @staticmethod
    def _text(value) -> str:
        text = getattr(value, "text", None)
        return str(text if text is not None else (value or ""))

    @classmethod
    def _parse(cls, value, label: str) -> dict:
        text = cls._text(value).strip()
        match = _FENCE.fullmatch(text)
        if match:
            text = match.group(1).strip()
        try:
            obj = json.loads(text, strict=False)
        except Exception as error:
            raise ValueError(f"{label} is not valid JSON: {error}") from error
        if not isinstance(obj, dict):
            raise ValueError(f"{label} must be a JSON object.")
        return obj

    @staticmethod
    def _clean(value) -> str:
        return str(value or "").strip()

    @staticmethod
    def _node(node_id: str, text: str, node_type: str, quote: str = "", **extra) -> dict:
        node = {"nodeID": node_id, "text": text, "type": node_type, **extra}
        if quote:
            node["evidence"] = [{"quote": quote}]
        return node

    def assemble(self) -> Message:
        claim = self._parse(self.claim_json, "Main Claim JSON")
        selection = self._parse(self.selection_json, "Selection JSON")
        branches_obj = self._parse(self.branches_json, "Branches JSON")
        try:
            versions = self._parse(getattr(self, "catalog_versions", "") or "{}", "Catalog Versions")
        except ValueError:
            versions = {}

        meta = {
            "pipeline": "v11-top3",
            "catalogVersions": {"issue": versions.get("issue"), "scheme": versions.get("scheme")},
            "selection": {
                "status": selection.get("status"),
                "attempts": selection.get("attempts"),
                "model": selection.get("model"),
                "warnings": selection.get("warnings") or [],
                "errors": selection.get("errors") or [],
                "noIssueReason": self._clean(selection.get("no_issue_reason")),
            },
        }
        status = selection.get("status")
        selected = selection.get("selected") if isinstance(selection.get("selected"), list) else []

        if status == "invalid" or len(selected) > MAX_SELECTED:
            errors = list(selection.get("errors") or [])
            if len(selected) > MAX_SELECTED:
                errors.append(f"selection has {len(selected)} issues; at most {MAX_SELECTED} are allowed")
            self.status = "invalid selection"
            return Message(text=json.dumps({"status": "invalid", "errors": errors, "meta": meta}, ensure_ascii=False, indent=2))
        if status == "no_issues" or not selected:
            # 쟁점 미검출: 가짜 그래프를 만들지 않는다.
            self.status = "no issues"
            return Message(
                text=json.dumps(
                    {"status": "no_issues", "reason": meta["selection"]["noIssueReason"], "meta": meta},
                    ensure_ascii=False,
                    indent=2,
                )
            )

        main_text = self._clean(claim.get("main_claim"))
        if not main_text:
            raise ValueError("main_claim is empty.")
        case_id = self._clean(claim.get("case_id"))
        branch_by_index = {
            b["issue_index"]: b for b in branches_obj.get("branches") or [] if isinstance(b, dict) and isinstance(b.get("issue_index"), int)
        }

        counter = 1

        def next_id() -> str:
            nonlocal counter
            value = f"{counter}_{self.SUFFIX}"
            counter += 1
            return value

        nodes: list[dict] = []
        edges: list[dict] = []
        layout: dict[str, tuple[int, int]] = {}
        branch_reports: list[dict] = []

        def add_edge(frm: str, to: str) -> None:
            edges.append({"edgeID": len(edges) + 1, "fromID": frm, "toID": to})

        main_id = next_id()
        nodes.append(self._node(main_id, main_text, "I", self._clean(claim.get("evidence_quote"))))
        spacing = 620
        center_x = int(420 + (len(selected) - 1) * spacing / 2)
        layout[main_id] = (center_x, 60)

        # 쟁점별 판단은 하나의 RA 로 모여 주 주장에 이른다 (판결문의 "사정들을 종합하여 보면").
        # 쟁점마다 따로 이으면 각 쟁점이 독립적으로 주 주장을 지지한다는 뜻이 되어 판결 구조와 다르다.
        aggregation_id = next_id()
        aggregation_refs: list[dict] = []
        nodes.append(self._node(aggregation_id, "RA", "RA", issueRefs=aggregation_refs))
        layout[aggregation_id] = (center_x, 155)
        add_edge(aggregation_id, main_id)

        for position, item in enumerate(selected, start=1):
            issue_id = self._clean(item.get("issue_id"))
            instance_id = f"issue-{position}"
            membership = [{"issueId": issue_id, "instanceId": instance_id}]
            x = 420 + (position - 1) * spacing

            issue_node_id = next_id()
            nodes.append(
                self._node(
                    issue_node_id,
                    self._clean(item.get("issue_text")),
                    "ISSUE",
                    self._clean(item.get("evidence_quote")),
                    issueRef={"issueId": issue_id, "instanceId": instance_id, "selectionReason": self._clean(item.get("selection_reason"))},
                )
            )
            layout[issue_node_id] = (x, 250)
            aggregation_refs.extend(membership)
            add_edge(issue_node_id, aggregation_id)

            branch = branch_by_index.get(position)
            report = {
                "issueIndex": position,
                "issueId": issue_id,
                "instanceId": instance_id,
                "status": branch.get("status") if branch else "missing",
                "error": (branch or {}).get("error") or (None if branch else "no branch output"),
                "warnings": list((branch or {}).get("warnings") or []),
            }
            branch_reports.append(report)
            if report["status"] != "ok":
                continue

            upper = branch.get("upper_i_node") or {}
            lowers = [l for l in branch.get("lower_i_nodes") or [] if self._clean(l.get("text")) and self._clean(l.get("text")) != main_text]
            seen: set[str] = set()
            unique = []
            for lower in lowers:
                text = self._clean(lower.get("text"))
                if text not in seen:
                    unique.append(lower)
                    seen.add(text)
            if not self._clean(upper.get("text")) or not unique:
                report["status"] = "failed"
                report["error"] = "branch has no usable upper or lower I-nodes"
                continue

            upper_id = next_id()
            ra_upper = next_id()
            ra_lower = next_id()
            nodes.append(self._node(upper_id, self._clean(upper.get("text")), "I", self._clean(upper.get("evidence_quote")), issueRefs=membership))
            nodes.append(self._node(ra_upper, "RA", "RA", issueRefs=membership))
            nodes.append(self._node(ra_lower, "RA", "RA", issueRefs=membership))
            layout[upper_id] = (x, 440)
            layout[ra_upper] = (x, 345)
            layout[ra_lower] = (x, 565)
            y = 760
            for lower in unique:
                lower_id = next_id()
                nodes.append(self._node(lower_id, self._clean(lower.get("text")), "I", self._clean(lower.get("evidence_quote")), issueRefs=membership))
                layout[lower_id] = (x, y)
                y += 125
                add_edge(lower_id, ra_lower)
            add_edge(ra_lower, upper_id)
            add_edge(upper_id, ra_upper)
            add_edge(ra_upper, issue_node_id)

        meta["branches"] = branch_reports
        graph = {
            "status": "ok",
            "AIF": {
                "nodes": nodes,
                "edges": edges,
                # 검증된 외부 scheme ID 대응이 없으므로 schemefulfillments 는 만들지 않는다.
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
            "meta": meta,
        }
        ok = sum(1 for r in branch_reports if r["status"] == "ok")
        self.status = f"{len(nodes)} nodes / {len(edges)} edges / {ok} of {len(branch_reports)} branches"
        return Message(text=json.dumps(graph, ensure_ascii=False, indent=2))
