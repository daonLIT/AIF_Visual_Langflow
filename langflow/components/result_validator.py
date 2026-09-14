from __future__ import annotations

import json
import re

from lfx.custom import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.message import Message

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
MAX_SELECTED = 3
RESERVED = ("unclassified", "custom")


def text_hash(text: str) -> str:
    value = 0xCBF29CE484222325
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"fnv1a64:{value:016x}"


class ResultValidator(Component):
    display_name = "AIF Result Validator"
    description = (
        "Validation stage before the final output: graph structure, at most 3 distinct catalog issues, issue IDs "
        "in the catalog, scheme keys, premise/conclusion references of every scheme application and summary hashes. "
        "Structural or catalog violations set status to invalid with the reasons; nothing is silently repaired."
    )
    icon = "ShieldCheck"
    name = "ResultValidator"

    inputs = [
        MessageTextInput(name="graph_json", display_name="Graph JSON", required=True),
        MessageTextInput(name="issue_catalog", display_name="Issue Catalog (JSON lines)", required=True),
        MessageTextInput(name="scheme_catalog", display_name="Scheme Catalog (JSON lines)", required=True),
    ]

    outputs = [Output(display_name="Final AIF JSON", name="final_graph", method="validate")]

    @staticmethod
    def _text(value) -> str:
        text = getattr(value, "text", None)
        return str(text if text is not None else (value or ""))

    @staticmethod
    def _lines(text: str, key: str) -> dict[str, dict]:
        result = {}
        for line in str(text or "").splitlines():
            try:
                item = json.loads(line, strict=False)
            except ValueError:
                continue
            if isinstance(item, dict) and item.get(key):
                result[str(item[key])] = item
        return result

    @staticmethod
    def check(graph: dict, issue_ids: set[str], schemes: dict[str, dict]) -> tuple[list[str], list[str]]:
        errors: list[str] = []
        warnings: list[str] = []
        aif = graph.get("AIF") or {}
        nodes = aif.get("nodes") or []
        edges = aif.get("edges") or []
        ids = [n.get("nodeID") for n in nodes]
        if len(ids) != len(set(ids)):
            errors.append("duplicate nodeID")
        idset = set(ids)
        incoming: dict[str, set[str]] = {}
        outgoing: dict[str, set[str]] = {}
        for edge in edges:
            if edge.get("fromID") not in idset or edge.get("toID") not in idset:
                errors.append(f"edge {edge.get('edgeID')} references a missing node")
                continue
            incoming.setdefault(edge["toID"], set()).add(edge["fromID"])
            outgoing.setdefault(edge["fromID"], set()).add(edge["toID"])

        selected = [n.get("issueRef", {}).get("issueId") for n in nodes if n.get("type") == "ISSUE"]
        if len(selected) > MAX_SELECTED:
            errors.append(f"{len(selected)} ISSUE nodes; at most {MAX_SELECTED} are allowed")
        if len(selected) != len(set(selected)):
            errors.append("the same catalog issue is selected more than once")
        for issue_id in selected:
            if issue_id not in issue_ids:
                errors.append(f"ISSUE issueId {issue_id!r} is not in the issue catalog")

        for node in nodes:
            node_id = node.get("nodeID")
            if node.get("type") in ("I", "ISSUE"):
                if node.get("summary") and node.get("summarySourceHash") != text_hash(node.get("text") or ""):
                    warnings.append(f"{node_id}: summarySourceHash does not match the text")
                if not node.get("summary"):
                    warnings.append(f"{node_id}: no summary")
            if node.get("type") != "RA":
                continue
            if not incoming.get(node_id) or not outgoing.get(node_id):
                errors.append(f"RA {node_id} needs at least one premise and one conclusion")
            application = node.get("schemeApplication")
            if not isinstance(application, dict):
                warnings.append(f"RA {node_id}: no scheme application")
                continue
            key = application.get("schemeKey")
            if key not in schemes and key not in RESERVED:
                warnings.append(f"RA {node_id}: scheme key {key!r} is not allowed")
            for binding in application.get("premiseBindings") or []:
                for ref in binding.get("nodeIds") or []:
                    if ref not in incoming.get(node_id, set()):
                        warnings.append(f"RA {node_id}: premise binding {ref} is not an incoming node")
            for ref in application.get("conclusionNodeIds") or []:
                if ref not in outgoing.get(node_id, set()):
                    warnings.append(f"RA {node_id}: conclusion {ref} is not an outgoing node")
            for error in application.get("errors") or []:
                warnings.append(f"RA {node_id}: {error}")
        return errors, warnings

    def validate(self) -> Message:
        text = self._text(self.graph_json).strip()
        match = _FENCE.match(text)
        graph = json.loads(match.group(1) if match else text, strict=False)
        meta = graph.setdefault("meta", {})
        if graph.get("status") != "ok":
            meta["validation"] = {"ok": graph.get("status") == "no_issues", "errors": graph.get("errors") or [], "warnings": []}
            self.status = f"passed through: {graph.get('status')}"
            return Message(text=json.dumps(graph, ensure_ascii=False, indent=2))
        errors, warnings = self.check(
            graph,
            set(self._lines(self._text(self.issue_catalog), "issue_id")),
            self._lines(self._text(self.scheme_catalog), "schemeKey"),
        )
        meta["validation"] = {"ok": not errors, "errors": errors, "warnings": warnings}
        if errors:
            graph["status"] = "invalid"
            graph["errors"] = errors
        self.status = f"{'invalid' if errors else 'ok'}: {len(errors)} errors / {len(warnings)} warnings"
        return Message(text=json.dumps(graph, ensure_ascii=False, indent=2))
