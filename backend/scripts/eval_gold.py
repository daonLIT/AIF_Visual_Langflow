"""
사람이 만든 정답 그래프(eval/<caseId>_*.json)와 분석 결과를 비교한다 (표준 라이브러리만 사용).

scheme 은 비교하지 않는다(정답에 없고, 법리 해석 영역). 비교 항목:
- 쟁점: 정답 ISSUE 문장(카탈로그 세부 쟁점 이름) → 카탈로그 ID 집합과 선택 결과의 정밀도·재현율, 상위 쟁점군 일치
- I 노드 근거: 정답 I 노드는 판결문 원문을 그대로 옮긴 문장이다. 생성 I 노드의 근거 인용 위치와 겹치는 정도
- 주 주장: 정답의 최상위 I 노드(나가는 연결 없음)와 생성 주 주장 근거 위치가 겹치는지
- 구조: 정답 RA 수, 생성 그래프에서 ISSUE 에 붙은 RA 수 (정답은 ISSUE 를 RA 없이 연결한다)
"""
from __future__ import annotations

import json
import re
from pathlib import Path

OVERLAP = 0.5


def _issue_body(text: str) -> str:
    return re.sub(r"^\s*쟁점\s*\d*\s*[:：]\s*", "", text or "").strip()


def find_gold(gold_dir: Path, case_id: str) -> Path | None:
    matches = sorted(gold_dir.glob(f"{case_id}_*.json"))
    return matches[-1] if matches else None


def gold_issue_ids(gold: dict, catalog: dict) -> tuple[list[str], list[str]]:
    """정답 ISSUE 문장 → 카탈로그 ID (중복 제거, 순서 유지). 이름과 맞지 않는 노드(단락 제목 등)는 따로 돌려준다."""
    by_label: dict[str, list[str]] = {}
    for issue in catalog["issues"]:
        by_label.setdefault(issue["label"], []).append(issue["issueId"])
    ids: list[str] = []
    unmatched: list[str] = []
    for node in gold["AIF"]["nodes"]:
        if node.get("type") != "ISSUE":
            continue
        ref = (node.get("issueRef") or {}).get("issueId") if isinstance(node.get("issueRef"), dict) else None
        candidates = [ref] if ref else by_label.get(_issue_body(node.get("text")), [])
        if len(candidates) == 1:
            if candidates[0] not in ids:
                ids.append(candidates[0])
        else:
            unmatched.append(node.get("text") or "")
    return ids, unmatched


def _spans_of_texts(texts: list[str], judgment: str) -> tuple[list[tuple[int, int]], int]:
    spans, missing = [], 0
    for text in texts:
        start = judgment.find(text.strip())
        if start < 0:
            missing += 1
        else:
            spans.append((start, start + len(text.strip())))
    return spans, missing


def _overlap(a: tuple[int, int], b: tuple[int, int]) -> int:
    return max(0, min(a[1], b[1]) - max(a[0], b[0]))


def _covered(target: tuple[int, int], others: list[tuple[int, int]]) -> bool:
    length = max(1, target[1] - target[0])
    return sum(_overlap(target, other) for other in others) / length >= OVERLAP


def gold_metrics(record: dict, gold: dict, judgment: str, catalog: dict) -> dict:
    result = record.get("result") or {}
    graph = result.get("graph")
    gold_ids, gold_unmatched = gold_issue_ids(gold, catalog)
    categories = {i["issueId"]: i["categoryId"] for i in catalog["issues"]}
    gold_nodes = {n["nodeID"]: n for n in gold["AIF"]["nodes"]}
    gold_edges = [e for e in gold["AIF"]["edges"] if e.get("fromID") in gold_nodes and e.get("toID") in gold_nodes]
    gold_i_texts = [n["text"] for n in gold["AIF"]["nodes"] if n.get("type") == "I"]
    gold_spans, gold_missing = _spans_of_texts(gold_i_texts, judgment)
    outgoing = {e["fromID"] for e in gold_edges}
    gold_tops = [n["text"] for n in gold["AIF"]["nodes"] if n.get("type") == "I" and n["nodeID"] not in outgoing]
    top_spans, _ = _spans_of_texts(gold_tops, judgment)

    row = {
        "goldIssueIds": gold_ids,
        "goldIssueIdsCount": len(gold_ids),
        "goldIssueUnmatched": len(gold_unmatched),
        "goldI": len(gold_i_texts),
        "goldINotInText": gold_missing,
        "goldRa": sum(1 for n in gold["AIF"]["nodes"] if n.get("type") == "RA"),
        "goldDanglingEdges": len(gold["AIF"]["edges"]) - len(gold_edges),
    }
    if record.get("status") != "succeeded" or not graph:
        return row

    selected = [s.get("issueId") for s in ((result.get("summary") or {}).get("issueSelection") or {}).get("selected") or []]
    hits = [i for i in selected if i in gold_ids]
    gold_categories = {categories.get(i) for i in gold_ids}
    row.update(
        issueSelected=selected,
        issueSelectedCount=len(selected),
        issueHits=len(hits),
        issuePrecision=round(len(hits) / len(selected), 3) if selected else None,
        issueRecall=round(len(hits) / len(gold_ids), 3) if gold_ids else None,
        issueCategoryHits=sum(1 for i in selected if categories.get(i) in gold_categories),
    )

    nodes = {n["nodeID"]: n for n in graph["AIF"]["nodes"]}
    evidence_spans = []
    main_spans = []
    edges = graph["AIF"]["edges"]
    has_outgoing = {e["fromID"] for e in edges}
    for annotation in result.get("annotations") or []:
        if annotation.get("kind") != "node" or (annotation.get("currentValue") or {}).get("type") != "I":
            continue
        spans = [(e["start"], e["end"]) for e in annotation.get("evidence") or [] if isinstance(e.get("start"), int) and isinstance(e.get("end"), int)]
        evidence_spans.extend(spans)
        if annotation.get("nodeId") in nodes and annotation.get("nodeId") not in has_outgoing:
            main_spans.extend(spans)
    row.update(
        genIWithEvidence=len(evidence_spans),
        goldICovered=sum(1 for span in gold_spans if _covered(span, evidence_spans)),
        genEvidenceInGold=sum(1 for span in evidence_spans if _covered(span, gold_spans)),
        mainClaimMatchesGold=any(_overlap(a, b) > 0 for a in main_spans for b in top_spans) if main_spans and top_spans else None,
    )
    incoming: dict[str, list[str]] = {}
    for edge in edges:
        incoming.setdefault(edge["toID"], []).append(edge["fromID"])
    ra_touching_issue = 0
    for ra in (n for n in graph["AIF"]["nodes"] if n["type"] == "RA"):
        neighbours = incoming.get(ra["nodeID"], []) + [e["toID"] for e in edges if e["fromID"] == ra["nodeID"]]
        ra_touching_issue += any(nodes.get(n, {}).get("type") == "ISSUE" for n in neighbours)
    row["raTouchingIssue"] = ra_touching_issue
    return row


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
