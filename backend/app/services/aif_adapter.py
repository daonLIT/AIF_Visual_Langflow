"""
Langflow 응답(AIF/OVA JSON 문자열) -> 검증된 제안(proposal) 변환.

- importer 보다 엄격하게 검증한다. 문제가 있으면 조용히 건너뛰지 않고 InvalidResultError 를 낸다.
- 노드 ID 의 고정 접미사(`20260903190000`)를 실행별 namespace 로 바꾸고 AIF/OVA 참조를 일관되게 변환한다.
- 결과 `text` 를 사건 ID 가 아니라 실제 제출 원문으로 바꾼다.
- 근거 인용문(evidence)이 있으면 원문 위치를 확인하고, 없으면 노드 텍스트로 매칭을 시도하되 파생(derived)임을 표시한다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .evidence_matcher import DocumentMatcher

NODE_TYPES = {"I", "RA", "CA", "ISSUE"}
RULE_TYPES = {"RA", "CA"}
_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
_ID_PATTERN = re.compile(r"^(\d+)_(\d{14})$")


class InvalidResultError(ValueError):
    def __init__(self, message: str, details: list[str] | None = None):
        super().__init__(message)
        self.details = details or []


@dataclass
class Proposal:
    namespace: str
    graph: dict
    annotations: list[dict]
    summary: dict
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "namespace": self.namespace,
            "graph": self.graph,
            "annotations": self.annotations,
            "summary": self.summary,
            "warnings": self.warnings,
        }


def parse_json_text(text: str) -> dict:
    """외곽 코드 펜스만 제거하고 JSON 파서를 사용한다. eval 금지."""
    if not isinstance(text, str):
        raise InvalidResultError("결과가 문자열이 아닙니다.")
    stripped = text.strip()
    fence = _FENCE.match(stripped)
    if fence:
        stripped = fence.group(1)
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError as error:
        raise InvalidResultError(f"결과 JSON 파싱 실패: {error.msg} (line {error.lineno})") from error
    if not isinstance(parsed, dict):
        raise InvalidResultError("결과 JSON 의 최상위가 객체가 아닙니다.")
    return parsed


def validate_graph(raw: dict) -> list[str]:
    """구조 오류 목록을 돌려준다. 비어 있으면 유효."""
    errors: list[str] = []
    aif = raw.get("AIF")
    if not isinstance(aif, dict):
        return ["AIF 섹션이 없습니다."]
    nodes = aif.get("nodes")
    edges = aif.get("edges", [])
    if not isinstance(nodes, list) or not nodes:
        return ["AIF.nodes 가 비어 있거나 배열이 아닙니다."]
    if not isinstance(edges, list):
        return ["AIF.edges 가 배열이 아닙니다."]

    ids: set[str] = set()
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            errors.append(f"nodes[{index}] 가 객체가 아닙니다.")
            continue
        node_id = node.get("nodeID")
        if not isinstance(node_id, str) or not node_id:
            errors.append(f"nodes[{index}] 에 nodeID 가 없습니다.")
            continue
        if node_id in ids:
            errors.append(f"중복 nodeID: {node_id}")
        ids.add(node_id)
        if node.get("type") not in NODE_TYPES:
            errors.append(f"노드 {node_id} 의 type 이 허용값이 아닙니다: {node.get('type')!r}")
        if not isinstance(node.get("text"), str):
            errors.append(f"노드 {node_id} 의 text 가 문자열이 아닙니다.")
        elif node.get("type") in {"I", "ISSUE"} and not node["text"].strip():
            errors.append(f"노드 {node_id} 의 text 가 비어 있습니다.")
        evidence = node.get("evidence")
        if evidence is not None and not isinstance(evidence, list):
            errors.append(f"노드 {node_id} 의 evidence 가 배열이 아닙니다.")

    edge_ids: set[int] = set()
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            errors.append(f"edges[{index}] 가 객체가 아닙니다.")
            continue
        edge_id = edge.get("edgeID")
        if isinstance(edge_id, bool) or not isinstance(edge_id, int):
            errors.append(f"edges[{index}] 의 edgeID 가 정수가 아닙니다.")
        elif edge_id in edge_ids:
            errors.append(f"중복 edgeID: {edge_id}")
        else:
            edge_ids.add(edge_id)
        for key in ("fromID", "toID"):
            ref = edge.get(key)
            if not isinstance(ref, str) or ref not in ids:
                errors.append(f"edges[{index}] 의 {key}({ref!r}) 에 해당하는 노드가 없습니다.")
        if edge.get("fromID") == edge.get("toID"):
            errors.append(f"edges[{index}] 가 자기 자신을 가리킵니다.")

    ova = raw.get("OVA")
    if ova is not None:
        if not isinstance(ova, dict):
            errors.append("OVA 섹션이 객체가 아닙니다.")
        else:
            for index, ova_node in enumerate(ova.get("nodes") or []):
                if not isinstance(ova_node, dict) or ova_node.get("nodeID") not in ids:
                    errors.append(f"OVA.nodes[{index}] 가 존재하지 않는 AIF 노드를 참조합니다.")
            for index, ova_edge in enumerate(ova.get("edges") or []):
                if not isinstance(ova_edge, dict) or ova_edge.get("fromID") not in ids or ova_edge.get("toID") not in ids:
                    errors.append(f"OVA.edges[{index}] 가 존재하지 않는 AIF 노드를 참조합니다.")
    return errors


def make_namespace(now: datetime | None = None) -> str:
    """기존 노드 ID 형식 `{n}_{YYYYMMDDHHmmss}` 의 접미사로 쓸 실행별 namespace."""
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y%m%d%H%M%S")


def _rename(node_id: str, namespace: str, used: set[str]) -> str:
    match = _ID_PATTERN.match(node_id)
    base = match.group(1) if match else re.sub(r"[^0-9A-Za-z]+", "", node_id) or "n"
    candidate = f"{base}_{namespace}"
    counter = 0
    while candidate in used:
        counter += 1
        candidate = f"{base}x{counter}_{namespace}"
    used.add(candidate)
    return candidate


def _evidence_quotes(node: dict) -> list[str]:
    quotes: list[str] = []
    for item in node.get("evidence") or []:
        if isinstance(item, str):
            quotes.append(item)
        elif isinstance(item, dict) and isinstance(item.get("quote"), str):
            quotes.append(item["quote"])
    return [q for q in quotes if q.strip()]


def build_proposal(
    raw: dict,
    *,
    run_id: str,
    document_text: str,
    document_version: int,
    namespace: str,
    created_at: str,
) -> Proposal:
    errors = validate_graph(raw)
    if errors:
        raise InvalidResultError("Langflow 결과 그래프가 유효하지 않습니다.", errors)

    aif = raw["AIF"]
    ova = raw.get("OVA") if isinstance(raw.get("OVA"), dict) else {}
    warnings: list[str] = []

    used: set[str] = set()
    id_map: dict[str, str] = {}
    for node in aif["nodes"]:
        id_map[node["nodeID"]] = _rename(node["nodeID"], namespace, used)

    ova_by_id = {n["nodeID"]: n for n in (ova.get("nodes") or []) if isinstance(n, dict)}
    ova_edge_by_key = {
        (e["fromID"], e["toID"]): e for e in (ova.get("edges") or []) if isinstance(e, dict)
    }
    missing_positions = [n["nodeID"] for n in aif["nodes"] if n["nodeID"] not in ova_by_id]
    if missing_positions:
        warnings.append(f"OVA 좌표가 없는 노드 {len(missing_positions)}개는 기본 좌표(0,0)를 사용합니다.")

    matcher = DocumentMatcher(document_text)
    counts = {"exact": 0, "normalized": 0, "ambiguous": 0, "unmatched": 0, "none": 0}

    new_nodes: list[dict] = []
    new_ova_nodes: list[dict] = []
    annotations: list[dict] = []

    for node in aif["nodes"]:
        new_id = id_map[node["nodeID"]]
        node_type = node["type"]
        text = node["text"]
        clean = {k: v for k, v in node.items() if k not in {"nodeID", "text", "type", "evidence"}}
        new_nodes.append({**clean, "nodeID": new_id, "text": text, "type": node_type})

        ova_node = ova_by_id.get(node["nodeID"], {})
        x = ova_node.get("x") if isinstance(ova_node.get("x"), (int, float)) else 0
        y = ova_node.get("y") if isinstance(ova_node.get("y"), (int, float)) else 0
        new_ova_nodes.append(
            {
                **{k: v for k, v in ova_node.items() if k != "nodeID"},
                "nodeID": new_id,
                "visible": bool(ova_node.get("visible", True)),
                "x": x,
                "y": y,
                "timestamp": ova_node.get("timestamp", ""),
            }
        )

        evidence: list[dict] = []
        quotes = _evidence_quotes(node)
        derived = False
        if not quotes and node_type in {"I", "ISSUE"}:
            # 근거 인용이 없으면 노드 문장 자체가 원문에 있는지 확인만 한다(동일하다고 가정하지 않음).
            quotes = [text]
            derived = True
        for quote in quotes:
            result = matcher.match(quote)
            entry = result.to_dict(document_version)
            entry["derived"] = derived
            evidence.append(entry)
            counts[result.match] += 1
        if not quotes:
            counts["none"] += 1

        value = {"type": node_type, "text": text, "x": x, "y": y}
        annotations.append(
            {
                "id": f"{run_id}:node:{new_id}",
                "runId": run_id,
                "kind": "node",
                "nodeId": new_id,
                "origin": "rule" if node_type in RULE_TYPES else "ai",
                "status": "pending",
                "originalValue": value,
                "currentValue": dict(value),
                "evidence": evidence,
                "createdAt": created_at,
                "updatedAt": created_at,
            }
        )

    new_edges: list[dict] = []
    new_ova_edges: list[dict] = []
    for edge in aif["edges"]:
        source = id_map[edge["fromID"]]
        target = id_map[edge["toID"]]
        clean = {k: v for k, v in edge.items() if k not in {"edgeID", "fromID", "toID"}}
        new_edges.append({**clean, "edgeID": edge["edgeID"], "fromID": source, "toID": target})
        ova_edge = ova_edge_by_key.get((edge["fromID"], edge["toID"]), {})
        new_ova_edges.append(
            {
                **{k: v for k, v in ova_edge.items() if k not in {"fromID", "toID"}},
                "fromID": source,
                "toID": target,
                "visible": bool(ova_edge.get("visible", True)),
            }
        )
        edge_key = f"{run_id}:{edge['edgeID']}"
        value = {"source": source, "target": target, "proposedEdgeId": edge["edgeID"]}
        annotations.append(
            {
                "id": f"{run_id}:edge:{edge['edgeID']}",
                "runId": run_id,
                "kind": "edge",
                "edgeId": edge_key,
                "origin": "rule",
                "status": "pending",
                "originalValue": value,
                "currentValue": dict(value),
                "evidence": [],
                "createdAt": created_at,
                "updatedAt": created_at,
            }
        )

    graph = {
        **{k: v for k, v in raw.items() if k not in {"AIF", "OVA", "text"}},
        "AIF": {
            **{k: v for k, v in aif.items() if k not in {"nodes", "edges"}},
            "nodes": new_nodes,
            "edges": new_edges,
        },
        # 사건 ID 대신 제출 원문을 보존한다.
        "text": document_text,
        "OVA": {
            **{k: v for k, v in ova.items() if k not in {"nodes", "edges"}},
            "firstname": ova.get("firstname", "Anon"),
            "surname": ova.get("surname", "User"),
            "url": ova.get("url", ""),
            "nodes": new_ova_nodes,
            "edges": new_ova_edges,
        },
    }
    original_text = raw.get("text")
    if isinstance(original_text, str) and original_text.strip():
        graph.setdefault("meta", {})
        if isinstance(graph["meta"], dict):
            graph["meta"]["langflowText"] = original_text

    summary = {
        "nodeCount": len(new_nodes),
        "edgeCount": len(new_edges),
        "issueCount": sum(1 for n in new_nodes if n["type"] == "ISSUE"),
        "evidenceCounts": counts,
        "idMap": id_map,
    }
    return Proposal(namespace=namespace, graph=graph, annotations=annotations, summary=summary, warnings=warnings)
