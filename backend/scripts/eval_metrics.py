"""
분석 실행 기록(analysis_runs.record) 하나에서 그래프 구조 지표를 계산한다 (표준 라이브러리만 사용).

분류가 법리적으로 맞는지는 판단하지 않는다. 형식·근거·구조만 센다.
- 쟁점: 선택 수, 카탈로그 ID, 쟁점 문장이 카탈로그 이름뿐인지, 근거 인용 검출 여부
- I 노드: 명제가 아닌 제목형 문장 수
- RA: 미분류, 한 노드를 여러 역할에 묶은 RA, 역할 채움, 별칭(R1·N2)·임의 이름(C2 등) 노출
- 실행: 상태, 소요 시간, 검증 결과, 근거 일치 수, 요약 누락
"""
from __future__ import annotations

import re
from datetime import datetime

ALIAS = re.compile(r"(?<![A-Za-z0-9])[RN]\d{1,2}(?![A-Za-z0-9])")
# 모델이 스스로 붙인 짧은 이름 (C2, P3 …). 비판적 질문 번호(CQ1)와 사건 ID(ISS-005)는 제외한다.
LABEL_LIKE = re.compile(r"(?<![A-Za-z0-9-])(?!CQ\d)(?![RN]\d)[A-Z]{1,2}\d{1,2}(?![A-Za-z0-9])")
# 문장으로 끝나는지: 마침표, 서술형 어미, 또는 판결문이 명제를 나열할 때 쓰는 "…한 점/사실/취지" 로 끝나면 명제로 본다.
SENTENCE_END = re.compile(r"(?:[.。!?]|다|음|함|됨|임|있음|없음|점|사실|것|취지|하나|하고|하며|였고|으며)[\"'”’)\]]*\s*$")
# 제목형은 짧다 ("…정황의 의미", "피해자 진술의 신빙성"). 긴 문장은 어미가 달라도 제목으로 세지 않는다.
HEADING_MAX_LENGTH = 40


def _seconds(record: dict) -> int | None:
    try:
        started = datetime.fromisoformat(record["startedAt"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(record["finishedAt"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
    return int((finished - started).total_seconds())


def _issue_body(text: str) -> str:
    return re.sub(r"^\s*쟁점\s*\d*\s*[:：]\s*", "", text or "").strip()


def is_heading_like(text: str) -> bool:
    """명제(문장)가 아니라 제목처럼 끝나는 노드 본문인지."""
    stripped = (text or "").strip()
    return bool(stripped) and len(stripped) <= HEADING_MAX_LENGTH and not SENTENCE_END.search(stripped)


def graph_metrics(record: dict, issue_labels: dict[str, str], scheme_roles: dict[str, list[str]]) -> dict:
    result = record.get("result") or {}
    base = {
        "runId": record.get("runId"),
        "caseId": record.get("documentId"),
        "status": record.get("status"),
        "outcome": result.get("outcome"),
        "seconds": _seconds(record),
        "documentLength": record.get("documentLength"),
        "error": (record.get("error") or {}).get("code") if isinstance(record.get("error"), dict) else record.get("error"),
        "flowHash": ((record.get("pipeline") or {}).get("flowHash") or "")[:12],
    }
    graph = result.get("graph")
    if record.get("status") != "succeeded" or not graph:
        return base

    nodes = {n["nodeID"]: n for n in graph["AIF"]["nodes"]}
    summary = result.get("summary") or {}
    selection = summary.get("issueSelection") or {}

    issues = [n for n in graph["AIF"]["nodes"] if n["type"] == "ISSUE"]
    issue_ids = [(n.get("issueRef") or {}).get("issueId") for n in issues]
    label_only = [
        n["nodeID"] for n in issues if _issue_body(n["text"]) == (issue_labels.get((n.get("issueRef") or {}).get("issueId")) or "\0")
    ]
    i_nodes = [n for n in graph["AIF"]["nodes"] if n["type"] == "I"]
    headings = [n["text"] for n in i_nodes if is_heading_like(n["text"])]

    ras = [n for n in graph["AIF"]["nodes"] if n["type"] == "RA"]
    keys: dict[str, int] = {}
    alias_leaks = label_leaks = multi_role = role_slots = role_filled = 0
    for ra in ras:
        app = ra.get("schemeApplication") or {}
        key = app.get("schemeKey") or "missing"
        keys[key] = keys.get(key, 0) + 1
        texts = [app.get("rationale") or ""]
        texts += [r.get("answer") or "" for r in app.get("criticalQuestionResponses") or []]
        texts += [a.get("rationale") or "" for a in app.get("alternatives") or []]
        alias_leaks += sum(len(ALIAS.findall(t)) for t in texts)
        label_leaks += sum(len(LABEL_LIKE.findall(t)) for t in texts)
        bound: dict[str, set] = {}
        for binding in app.get("premiseBindings") or []:
            for node_id in binding.get("nodeIds") or []:
                bound.setdefault(node_id, set()).add(binding.get("roleId"))
        multi_role += any(len(roles) > 1 for roles in bound.values())
        if key in scheme_roles:
            role_slots += len(scheme_roles[key])
            role_filled += sum(
                1 for role in scheme_roles[key] if any(b.get("roleId") == role and b.get("nodeIds") for b in app.get("premiseBindings") or [])
            )

    validation = (graph.get("meta") or {}).get("validation") or summary.get("validation") or {}
    return {
        **base,
        "nodes": len(nodes),
        "issues": len(issues),
        "issueIds": issue_ids,
        "issueTextLabelOnly": len(label_only),
        "issueEvidenceNotFound": sum(1 for s in selection.get("selected") or [] if s.get("evidenceStatus") != "found"),
        "branchFailed": sum(1 for s in selection.get("selected") or [] if s.get("branchStatus") not in (None, "ok")),
        "iNodes": len(i_nodes),
        "headingLikeINodes": len(headings),
        "headingExamples": headings[:3],
        "ra": len(ras),
        "unclassified": keys.get("unclassified", 0),
        "schemeKeys": keys,
        "raMultiRole": multi_role,
        "roleSlots": role_slots,
        "roleFilled": role_filled,
        "aliasLeaks": alias_leaks,
        "labelLikeLeaks": label_leaks,
        "evidence": summary.get("evidenceCounts") or {},
        "summariesMissing": (summary.get("summaryCounts") or {}).get("withoutSummary"),
        "validationOk": validation.get("ok"),
        "validationErrors": len(validation.get("errors") or []),
        "warnings": len(result.get("warnings") or []),
    }


SUM_KEYS = (
    "issues", "issueTextLabelOnly", "issueEvidenceNotFound", "branchFailed", "iNodes", "headingLikeINodes", "ra", "unclassified",
    "raMultiRole", "roleSlots", "roleFilled", "aliasLeaks", "labelLikeLeaks", "validationErrors", "warnings",
    "goldIssueIdsCount", "issueHits", "issueSelectedCount", "goldI", "goldICovered", "genIWithEvidence", "genEvidenceInGold", "goldRa", "raTouchingIssue",
    "mainClaimMatchesGold",
)


def aggregate(rows: list[dict]) -> dict:
    done = [r for r in rows if r.get("status") == "succeeded" and "ra" in r]
    totals = {key: sum(r.get(key) or 0 for r in done) for key in SUM_KEYS}
    seconds = [r["seconds"] for r in rows if r.get("seconds") is not None]
    return {
        "cases": len(rows),
        "succeeded": len(done),
        "failed": [r.get("caseId") for r in rows if r.get("status") != "succeeded"],
        "noGraph": [r.get("caseId") for r in rows if r.get("status") == "succeeded" and "ra" not in r],
        "secondsTotal": sum(seconds),
        "secondsMax": max(seconds) if seconds else None,
        **totals,
    }
