"""
Langflow 응답(AIF/OVA JSON 문자열) -> 검증된 제안(proposal) 변환.

- importer 보다 엄격하게 검증한다. 문제가 있으면 조용히 건너뛰지 않고 InvalidResultError 를 낸다.
- 노드 ID 의 고정 접미사(`20260903190000`)를 실행별 namespace 로 바꾸고 AIF/OVA 참조를 일관되게 변환한다.
  schemeApplication 의 premiseBindings / conclusionNodeIds, AIF schemefulfillments·descriptor 항목의 nodeID 도
  같은 ID 표로 바꾼다(문자열 전체 치환은 하지 않는다).
- 결과 `text` 를 사건 ID 가 아니라 실제 제출 원문으로 바꾼다.
- 근거 인용문(evidence)이 있으면 원문 위치를 확인하고, 없으면 노드 텍스트로 매칭을 시도하되 파생(derived)임을 표시한다.
- v11 계약
  * status: ok | no_issues | invalid. no_issues 는 그래프 없이 사유만, invalid 는 명시적 오류.
  * ISSUE 는 MAX_SELECTED_ISSUES 이하, 카탈로그에 있는 issueId, 중복 없음. 어기면 검증 실패.
  * I/ISSUE summary 는 text 를 대체하지 않는다. summarySourceHash 가 현재 본문과 다르면 stale.
  * RA schemeApplication 은 허용된 scheme key 만. 잘못된 참조는 오류로 남기고 unclassified 로 둔다.
  * schemefulfillments 는 카탈로그에 검증된 외부 schemeID(aifdbSchemeId)가 있을 때만 만든다.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .catalogs import CUSTOM, MAX_SELECTED_ISSUES, UNCLASSIFIED, IssueCatalog, SchemeCatalog
from .evidence_matcher import DocumentMatcher
from .texthash import text_hash
from ..i18n import t

NODE_TYPES = {"I", "RA", "CA", "ISSUE"}
RULE_TYPES = {"RA", "CA"}
CQ_STATUSES = {"open", "satisfied", "challenged"}
SCHEME_STATUSES = {"suggested", "confirmed", "needs_review"}
_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
_ID_PATTERN = re.compile(r"^(\d+)_(\d{14})$")
_MANAGED_NODE_KEYS = {
    "nodeID", "text", "type", "evidence", "summary", "summaryOrigin", "summaryStatus", "summarySourceHash",
    "schemeApplication", "scheme", "issueRef", "issueRefs",
}
_FULFILLMENT_KEYS = ("schemefulfillments", "descriptorfulfillments", "cqdescriptorfulfillments")


class InvalidResultError(ValueError):
    def __init__(self, message: str, details: list[str] | None = None, code: str = "INVALID_RESULT"):
        super().__init__(message)
        self.details = details or []
        self.code = code


@dataclass
class Proposal:
    namespace: str
    graph: dict | None
    annotations: list[dict]
    summary: dict
    warnings: list[str] = field(default_factory=list)
    outcome: str = "graph"  # graph | no_issues

    def to_dict(self) -> dict:
        return {
            "outcome": self.outcome,
            "namespace": self.namespace,
            "graph": self.graph,
            "annotations": self.annotations,
            "summary": self.summary,
            "warnings": self.warnings,
        }


def parse_json_text(text: str) -> dict:
    """외곽 코드 펜스만 제거하고 JSON 파서를 사용한다. eval 금지."""
    if not isinstance(text, str):
        raise InvalidResultError(t("adapter.not_string"))
    stripped = text.strip()
    fence = _FENCE.match(stripped)
    if fence:
        stripped = fence.group(1)
    try:
        # 문자열 안의 실제 줄바꿈(Langflow 메시지 처리 과정에서 생길 수 있음)은 허용한다.
        parsed = json.loads(stripped, strict=False)
    except json.JSONDecodeError as error:
        raise InvalidResultError(t("adapter.json_parse_failed", message=error.msg, line=error.lineno)) from error
    if not isinstance(parsed, dict):
        raise InvalidResultError(t("adapter.json_not_object"))
    return parsed


def validate_graph(raw: dict) -> list[str]:
    """구조 오류 목록을 돌려준다. 비어 있으면 유효."""
    errors: list[str] = []
    aif = raw.get("AIF")
    if not isinstance(aif, dict):
        return [t("adapter.no_aif")]
    nodes = aif.get("nodes")
    edges = aif.get("edges", [])
    if not isinstance(nodes, list) or not nodes:
        return [t("adapter.nodes_empty")]
    if not isinstance(edges, list):
        return [t("adapter.edges_not_array")]

    ids: set[str] = set()
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            errors.append(t("adapter.node_not_object", index=index))
            continue
        node_id = node.get("nodeID")
        if not isinstance(node_id, str) or not node_id:
            errors.append(t("adapter.node_no_id", index=index))
            continue
        if node_id in ids:
            errors.append(t("adapter.duplicate_node_id", nodeId=node_id))
        ids.add(node_id)
        if node.get("type") not in NODE_TYPES:
            errors.append(t("adapter.bad_node_type", nodeId=node_id, type=repr(node.get("type"))))
        if not isinstance(node.get("text"), str):
            errors.append(t("adapter.text_not_string", nodeId=node_id))
        elif node.get("type") in {"I", "ISSUE"} and not node["text"].strip():
            errors.append(t("adapter.text_empty", nodeId=node_id))
        evidence = node.get("evidence")
        if evidence is not None and not isinstance(evidence, list):
            errors.append(t("adapter.evidence_not_array", nodeId=node_id))
        if node.get("summary") is not None and not isinstance(node.get("summary"), str):
            errors.append(t("adapter.summary_not_string", nodeId=node_id))
        for key in ("schemeApplication", "scheme", "issueRef"):
            if node.get(key) is not None and not isinstance(node.get(key), dict):
                errors.append(t("adapter.field_not_object", nodeId=node_id, field=key))
        if node.get("issueRefs") is not None and not isinstance(node.get("issueRefs"), list):
            errors.append(t("adapter.issue_refs_not_array", nodeId=node_id))

    edge_ids: set[int] = set()
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            errors.append(t("adapter.edge_not_object", index=index))
            continue
        edge_id = edge.get("edgeID")
        if isinstance(edge_id, bool) or not isinstance(edge_id, int):
            errors.append(t("adapter.edge_id_not_int", index=index))
        elif edge_id in edge_ids:
            errors.append(t("adapter.duplicate_edge_id", edgeId=edge_id))
        else:
            edge_ids.add(edge_id)
        for key in ("fromID", "toID"):
            ref = edge.get(key)
            if not isinstance(ref, str) or ref not in ids:
                errors.append(t("adapter.edge_bad_ref", index=index, field=key, ref=repr(ref)))
        if edge.get("fromID") == edge.get("toID"):
            errors.append(t("adapter.edge_self", index=index))

    ova = raw.get("OVA")
    if ova is not None:
        if not isinstance(ova, dict):
            errors.append(t("adapter.ova_not_object"))
        else:
            for index, ova_node in enumerate(ova.get("nodes") or []):
                if not isinstance(ova_node, dict) or ova_node.get("nodeID") not in ids:
                    errors.append(t("adapter.ova_node_bad_ref", index=index))
            for index, ova_edge in enumerate(ova.get("edges") or []):
                if not isinstance(ova_edge, dict) or ova_edge.get("fromID") not in ids or ova_edge.get("toID") not in ids:
                    errors.append(t("adapter.ova_edge_bad_ref", index=index))
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


def _clean_str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def legacy_scheme_to_application(scheme: dict) -> dict:
    """v10 결과의 `scheme` 필드를 schemeApplication 형태로 옮긴다."""
    key = _clean_str(scheme.get("schemeId"))
    bindings: dict[str | None, list[str]] = {}
    for premise in scheme.get("premises") or []:
        if isinstance(premise, dict) and isinstance(premise.get("nodeId"), str):
            bindings.setdefault(premise.get("role") or None, []).append(premise["nodeId"])
    conclusion = scheme.get("conclusion") if isinstance(scheme.get("conclusion"), dict) else {}
    return {
        "schemeKey": CUSTOM if key == "other" else (key or UNCLASSIFIED),
        "status": "suggested",
        "origin": "human" if scheme.get("source") == "human" else "ai",
        "rationale": _clean_str(scheme.get("rationale")),
        "premiseBindings": [{"roleId": role, "nodeIds": ids} for role, ids in bindings.items()],
        "conclusionNodeIds": [conclusion["nodeId"]] if isinstance(conclusion.get("nodeId"), str) else [],
        "criticalQuestionResponses": [
            {"questionId": q.get("id"), "status": q.get("status"), "answer": q.get("answer")}
            for q in scheme.get("criticalQuestions") or []
            if isinstance(q, dict)
        ],
        "notes": "",
        "customSchemeName": _clean_str(scheme.get("schemeName")) or None if key == "other" else None,
        "alternatives": [],
    }


def normalize_scheme_application(
    raw: dict,
    *,
    node_id: str,
    id_map: dict[str, str],
    incoming: set[str],
    outgoing: set[str],
    schemes: SchemeCatalog | None,
    warnings: list[str],
) -> dict:
    """RA 의 schemeApplication 을 정규화한다. 잘못된 부분은 오류로 기록하고 추측으로 채우지 않는다."""
    errors = [str(e) for e in raw.get("errors") or [] if isinstance(e, str)]
    key = _clean_str(raw.get("schemeKey")) or UNCLASSIFIED
    if schemes is not None and not schemes.is_valid_key(key):
        errors.append(t("adapter.scheme_key_not_allowed", key=key))
        warnings.append(t("adapter.scheme_key_unclassified", nodeId=node_id, key=key))
        key = UNCLASSIFIED
    roles = schemes.roles(key) if schemes is not None else set()
    questions = schemes.question_ids(key) if schemes is not None else set()

    bindings = []
    for binding in raw.get("premiseBindings") or []:
        if not isinstance(binding, dict):
            continue
        role = _clean_str(binding.get("roleId")) or None
        if role and roles and role not in roles:
            errors.append(t("adapter.role_not_in_scheme", key=key, role=role))
            continue
        node_ids = []
        for original in binding.get("nodeIds") or []:
            mapped = id_map.get(original) if isinstance(original, str) else None
            if mapped is None or mapped not in incoming:
                errors.append(t("adapter.premise_ref_bad", ref=repr(original)))
                continue
            node_ids.append(mapped)
        if node_ids:
            bindings.append({"roleId": role, "nodeIds": node_ids})

    conclusions = []
    for original in raw.get("conclusionNodeIds") or []:
        mapped = id_map.get(original) if isinstance(original, str) else None
        if mapped is None or mapped not in outgoing:
            errors.append(t("adapter.conclusion_ref_bad", ref=repr(original)))
            continue
        conclusions.append(mapped)

    responses = []
    for item in raw.get("criticalQuestionResponses") or []:
        if not isinstance(item, dict) or not _clean_str(item.get("questionId")):
            continue
        question_id = _clean_str(item.get("questionId"))
        if questions and question_id not in questions:
            errors.append(t("adapter.question_not_in_scheme", key=key, questionId=question_id))
            continue
        if key in (UNCLASSIFIED, CUSTOM) and schemes is not None:
            continue
        status = _clean_str(item.get("status")).lower()
        responses.append({"questionId": question_id, "status": status if status in CQ_STATUSES else "open", "answer": _clean_str(item.get("answer"))})

    alternatives = []
    for item in raw.get("alternatives") or []:
        if not isinstance(item, dict):
            continue
        alt = _clean_str(item.get("schemeKey"))
        if schemes is not None and (alt not in schemes.by_key or alt == key):
            continue
        alternatives.append({"schemeKey": alt, "rationale": _clean_str(item.get("rationale"))})

    status = _clean_str(raw.get("status"))
    version = raw.get("catalogVersion")
    result = {
        "schemeKey": key,
        "catalogVersion": version if isinstance(version, int) else (schemes.version if schemes else None),
        "status": status if status in SCHEME_STATUSES else "suggested",
        "origin": "human" if raw.get("origin") == "human" else "ai",
        "rationale": _clean_str(raw.get("rationale")),
        "premiseBindings": bindings,
        "conclusionNodeIds": conclusions,
        "criticalQuestionResponses": responses,
        "notes": _clean_str(raw.get("notes")),
        "customSchemeName": (_clean_str(raw.get("customSchemeName")) or None) if key == CUSTOM else None,
        "alternatives": alternatives,
    }
    reasons = [str(r) for r in raw.get("reviewReasons") or [] if isinstance(r, str)]
    if reasons:
        result["reviewReasons"] = reasons
    if errors:
        result["errors"] = errors
    return result


def _remap_fulfillments(section: dict, id_map: dict[str, str], warnings: list[str]) -> dict:
    remapped = {}
    for key in _FULFILLMENT_KEYS:
        entries = section.get(key)
        if not isinstance(entries, list):
            remapped[key] = []
            continue
        kept = []
        for entry in entries:
            if not isinstance(entry, dict) or "nodeID" not in entry:
                kept.append(entry)
                continue
            mapped = id_map.get(entry["nodeID"])
            if mapped is None:
                warnings.append(t("adapter.fulfillment_dropped", field=key, nodeId=repr(entry["nodeID"])))
                continue
            kept.append({**entry, "nodeID": mapped})
        remapped[key] = kept
    return remapped


def build_proposal(
    raw: dict,
    *,
    run_id: str,
    document_text: str,
    document_version: int,
    namespace: str,
    created_at: str,
    issue_catalog: IssueCatalog | None = None,
    scheme_catalog: SchemeCatalog | None = None,
) -> Proposal:
    meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
    status = raw.get("status")
    selection_meta = meta.get("selection") if isinstance(meta.get("selection"), dict) else {}

    if status == "invalid":
        details = [str(e) for e in (raw.get("errors") or selection_meta.get("errors") or []) if e]
        raise InvalidResultError(t("adapter.invalid_selection"), details, code="INVALID_SELECTION")
    if status == "no_issues":
        reason = _clean_str(raw.get("reason")) or selection_meta.get("noIssueReason") or ""
        summary = {
            "nodeCount": 0,
            "edgeCount": 0,
            "issueCount": 0,
            "evidenceCounts": {},
            "issueSelection": {"status": "no_issues", "reason": reason, "selected": [], "attempts": selection_meta.get("attempts")},
            "pipeline": meta.get("pipeline"),
        }
        warnings = [str(w) for w in selection_meta.get("warnings") or []]
        return Proposal(namespace=namespace, graph=None, annotations=[], summary=summary, warnings=warnings, outcome="no_issues")
    if status not in (None, "ok"):
        raise InvalidResultError(t("adapter.unknown_status", status=repr(status)))

    errors = validate_graph(raw)
    if errors:
        raise InvalidResultError(t("adapter.graph_invalid"), errors)

    aif = raw["AIF"]
    ova = raw.get("OVA") if isinstance(raw.get("OVA"), dict) else {}
    warnings: list[str] = []

    # 쟁점 선택 제약: 상한 이하, 카탈로그 ID, 중복 없음 (몇 개인지는 판결문이 정한다)
    issue_nodes_raw = [n for n in aif["nodes"] if n["type"] == "ISSUE"]
    constraint_errors = []
    if len(issue_nodes_raw) > MAX_SELECTED_ISSUES:
        constraint_errors.append(t("adapter.too_many_issues", count=len(issue_nodes_raw), max=MAX_SELECTED_ISSUES))
    seen_issue_ids: set[str] = set()
    for node in issue_nodes_raw:
        ref = node.get("issueRef") if isinstance(node.get("issueRef"), dict) else None
        if ref is None:
            continue
        issue_id = _clean_str(ref.get("issueId"))
        if issue_catalog is not None and not issue_catalog.is_active(issue_id):
            constraint_errors.append(t("adapter.issue_not_in_catalog", nodeId=node["nodeID"], issueId=issue_id))
        if issue_id in seen_issue_ids:
            constraint_errors.append(t("adapter.issue_duplicated", issueId=issue_id))
        seen_issue_ids.add(issue_id)
    if constraint_errors:
        raise InvalidResultError(t("adapter.selection_constraints", max=MAX_SELECTED_ISSUES), constraint_errors, code="INVALID_SELECTION")

    used: set[str] = set()
    id_map: dict[str, str] = {}
    for node in aif["nodes"]:
        id_map[node["nodeID"]] = _rename(node["nodeID"], namespace, used)

    incoming: dict[str, set[str]] = {}
    outgoing: dict[str, set[str]] = {}
    for edge in aif["edges"]:
        source, target = id_map[edge["fromID"]], id_map[edge["toID"]]
        incoming.setdefault(target, set()).add(source)
        outgoing.setdefault(source, set()).add(target)

    ova_by_id = {n["nodeID"]: n for n in (ova.get("nodes") or []) if isinstance(n, dict)}
    ova_edge_by_key = {(e["fromID"], e["toID"]): e for e in (ova.get("edges") or []) if isinstance(e, dict)}
    missing_positions = [n["nodeID"] for n in aif["nodes"] if n["nodeID"] not in ova_by_id]
    if missing_positions:
        warnings.append(t("adapter.missing_positions", count=len(missing_positions)))

    matcher = DocumentMatcher(document_text)
    counts = {"exact": 0, "normalized": 0, "ambiguous": 0, "unmatched": 0, "none": 0}
    scheme_counts = {"classified": 0, "unclassified": 0, "custom": 0, "missing": 0, "withErrors": 0}
    summary_counts = {"withSummary": 0, "withoutSummary": 0, "stale": 0}

    new_nodes: list[dict] = []
    new_ova_nodes: list[dict] = []
    annotations: list[dict] = []
    evidence_by_node: dict[str, list[dict]] = {}

    for node in aif["nodes"]:
        new_id = id_map[node["nodeID"]]
        node_type = node["type"]
        text = node["text"]
        clean = {k: v for k, v in node.items() if k not in _MANAGED_NODE_KEYS}
        extra: dict = {}

        if node_type in {"I", "ISSUE"}:
            summary = _clean_str(node.get("summary"))
            if summary:
                current_hash = text_hash(text)
                source_hash = node.get("summarySourceHash") if isinstance(node.get("summarySourceHash"), str) else current_hash
                extra.update(
                    {
                        "summary": summary,
                        "summaryOrigin": "human" if node.get("summaryOrigin") == "human" else "ai",
                        "summaryStatus": "current" if source_hash == current_hash else "stale",
                        "summarySourceHash": source_hash,
                    }
                )
                summary_counts["withSummary"] += 1
                if extra["summaryStatus"] == "stale":
                    summary_counts["stale"] += 1
            else:
                summary_counts["withoutSummary"] += 1
            refs = []
            for ref in node.get("issueRefs") or []:
                if isinstance(ref, dict) and (issue_catalog is None or issue_catalog.is_active(_clean_str(ref.get("issueId")))):
                    refs.append({"issueId": _clean_str(ref.get("issueId")), "instanceId": _clean_str(ref.get("instanceId")) or None})
            if refs:
                extra["issueRefs"] = refs
        if node_type == "ISSUE" and isinstance(node.get("issueRef"), dict):
            ref = node["issueRef"]
            issue_id = _clean_str(ref.get("issueId"))
            reference = issue_catalog.reference(issue_id) if issue_catalog else {"issueId": issue_id}
            extra["issueRef"] = {
                "issueId": issue_id,
                **({"categoryId": reference["categoryId"], "catalogVersion": reference["catalogVersion"]} if issue_catalog else {}),
                **({"instanceId": _clean_str(ref.get("instanceId"))} if _clean_str(ref.get("instanceId")) else {}),
                **({"selectionReason": _clean_str(ref.get("selectionReason"))} if _clean_str(ref.get("selectionReason")) else {}),
            }
        if node_type == "RA":
            source = node.get("schemeApplication")
            if not isinstance(source, dict) and isinstance(node.get("scheme"), dict):
                source = legacy_scheme_to_application(node["scheme"])
            if isinstance(source, dict):
                application = normalize_scheme_application(
                    source,
                    node_id=new_id,
                    id_map=id_map,
                    incoming=incoming.get(new_id, set()),
                    outgoing=outgoing.get(new_id, set()),
                    schemes=scheme_catalog,
                    warnings=warnings,
                )
                extra["schemeApplication"] = application
                bucket = {UNCLASSIFIED: "unclassified", CUSTOM: "custom"}.get(application["schemeKey"], "classified")
                scheme_counts[bucket] += 1
                if application.get("errors"):
                    scheme_counts["withErrors"] += 1
            else:
                scheme_counts["missing"] += 1
            refs = [
                {"issueId": _clean_str(r.get("issueId")), "instanceId": _clean_str(r.get("instanceId")) or None}
                for r in node.get("issueRefs") or []
                if isinstance(r, dict) and _clean_str(r.get("issueId"))
            ]
            if refs:
                extra["issueRefs"] = refs

        new_nodes.append({**clean, "nodeID": new_id, "text": text, "type": node_type, **extra})

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
        evidence_by_node[new_id] = evidence

        value = {"type": node_type, "text": text, "x": x, "y": y, **extra}
        annotations.append(
            {
                "id": f"{run_id}:node:{new_id}",
                "runId": run_id,
                "kind": "node",
                "nodeId": new_id,
                # RA/CA 구조는 builder 규칙으로 만들어진다. scheme 분류가 AI 제안이라는 사실은 schemeApplication.origin 에 있다.
                "origin": "rule" if node_type in RULE_TYPES else "ai",
                "status": "pending",
                "originalValue": value,
                "currentValue": json.loads(json.dumps(value)),
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
        value = {"source": source, "target": target, "proposedEdgeId": edge["edgeID"]}
        annotations.append(
            {
                "id": f"{run_id}:edge:{edge['edgeID']}",
                "runId": run_id,
                "kind": "edge",
                "edgeId": f"{run_id}:{edge['edgeID']}",
                "origin": "rule",
                "status": "pending",
                "originalValue": value,
                "currentValue": dict(value),
                "evidence": [],
                "createdAt": created_at,
                "updatedAt": created_at,
            }
        )

    fulfillments = _remap_fulfillments(aif, id_map, warnings)
    if scheme_catalog is not None:
        existing = {entry.get("nodeID") for entry in fulfillments["schemefulfillments"] if isinstance(entry, dict)}
        for node in new_nodes:
            application = node.get("schemeApplication") if node["type"] == "RA" else None
            external_id = scheme_catalog.aifdb_id(application["schemeKey"]) if application else None
            if external_id is not None and node["nodeID"] not in existing:
                fulfillments["schemefulfillments"].append({"nodeID": node["nodeID"], "schemeID": external_id})

    graph = {
        **{k: v for k, v in raw.items() if k not in {"AIF", "OVA", "text", "meta", "status", "errors"}},
        "AIF": {**{k: v for k, v in aif.items() if k not in {"nodes", "edges", *_FULFILLMENT_KEYS}}, "nodes": new_nodes, "edges": new_edges, **fulfillments},
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
    graph_meta = dict(meta)
    original_text = raw.get("text")
    if isinstance(original_text, str) and original_text.strip():
        graph_meta["langflowText"] = original_text
    if graph_meta:
        graph["meta"] = graph_meta

    # 선택 쟁점 보고: 근거가 없거나 가지 추출에 실패한 선택은 '근거 없음/미검출'로 표시한다.
    branch_by_instance = {b.get("instanceId"): b for b in meta.get("branches") or [] if isinstance(b, dict)}
    selected_report = []
    for node in new_nodes:
        if node["type"] != "ISSUE" or not node.get("issueRef"):
            continue
        ref = node["issueRef"]
        reference = issue_catalog.reference(ref["issueId"]) if issue_catalog else None
        evidence = evidence_by_node.get(node["nodeID"], [])
        grounded = any(e["match"] in ("exact", "normalized", "ambiguous") and not e.get("derived") for e in evidence)
        branch = branch_by_instance.get(ref.get("instanceId"), {})
        selected_report.append(
            {
                "issueId": ref["issueId"],
                "instanceId": ref.get("instanceId"),
                "label": reference["label"] if reference else None,
                "categoryName": reference["categoryName"] if reference else None,
                "selectionReason": ref.get("selectionReason"),
                "nodeId": node["nodeID"],
                "evidenceStatus": "found" if grounded else "not_found",
                "branchStatus": branch.get("status"),
                "branchError": branch.get("error"),
            }
        )
        if not grounded:
            warnings.append(t("adapter.issue_not_grounded", issueId=ref["issueId"]))

    for item in selection_meta.get("warnings") or []:
        warnings.append(t("adapter.selection_warning", item=item))
    for report in meta.get("branches") or []:
        if not isinstance(report, dict):
            continue
        label = report.get("issueId") or f"#{report.get('issueIndex')}"
        if report.get("status") not in (None, "ok"):
            warnings.append(
                t(
                    "adapter.branch_failed",
                    label=label,
                    status=report.get("status"),
                    error=report.get("error") or t("adapter.branch_unknown_error"),
                )
            )
        for item in report.get("warnings") or []:
            warnings.append(t("adapter.branch_warning", label=label, item=item))
    summaries_meta = meta.get("summaries") if isinstance(meta.get("summaries"), dict) else {}
    if summaries_meta.get("missing"):
        warnings.append(t("adapter.summaries_missing", count=len(summaries_meta["missing"])))
    for item in (meta.get("schemes") or {}).get("errors") or []:
        warnings.append(t("adapter.scheme_warning", item=item))
    for item in (meta.get("validation") or {}).get("warnings") or []:
        warnings.append(t("adapter.flow_validation", item=item))

    summary = {
        "nodeCount": len(new_nodes),
        "edgeCount": len(new_edges),
        "issueCount": len([n for n in new_nodes if n["type"] == "ISSUE"]),
        "evidenceCounts": counts,
        "schemeCounts": scheme_counts,
        "summaryCounts": summary_counts,
        "issueSelection": {
            "status": "ok" if selected_report else None,
            "selected": selected_report,
            "attempts": selection_meta.get("attempts"),
            "model": selection_meta.get("model"),
        }
        if selected_report or selection_meta
        else None,
        "validation": meta.get("validation"),
        "pipeline": meta.get("pipeline"),
        "idMap": id_map,
    }
    return Proposal(namespace=namespace, graph=graph, annotations=annotations, summary=summary, warnings=warnings)
