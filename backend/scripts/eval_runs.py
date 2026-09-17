"""
평가 세트 판결문을 실행 중인 중계 서버로 한 건씩 분석하고, 실행 기록과 구조 지표를 저장한다.

실행 (backend 폴더에서, 서버가 켜져 있어야 함):
    python scripts/eval_runs.py --label prod-2026-09-15
    python scripts/eval_runs.py --label test --flow-id <작업용 flow ID> --limit 2
    python scripts/eval_runs.py --label all-2026-09-16 --set all
    python scripts/eval_runs.py --label short100 --set all --max-length 5000 --limit 100

평가 세트 (all): gold21 을 먼저 돌리고, judgment/ 의 나머지를 고정 시드로 섞은 순서로 이어서 돌린다.
중간에 끊겨도 앞부분이 길이에 치우치지 않은 표본이 되게 하려는 것이다.
--max-length 를 주면 그보다 긴 판결문은 두 세트 모두에서 뺀 뒤 --limit 을 적용한다.

평가 세트 (gold21): eval/ 에 정답 그래프가 있는 사건 전부 + judgment/ 에서 가장 긴 판결문 1건(시간·컨텍스트 한계 확인용).
사건 ID 목록은 저장소에 두지 않고 실행할 때 두 폴더에서 만든다 (둘 다 .gitignore 대상).
정답이 있는 사건은 eval_gold.py 로 쟁점·근거·주 주장·구조를 정답과 비교한다.

출력: test_outputs/eval/<label>/
    runs/<caseId>.json   실행 기록 전체 (판결문 원문·그래프 포함)
    summary.json         건별 지표와 합계
    summary.md           표
이미 성공한 사건은 건너뛰므로, 중간에 멈춰도 같은 label 로 다시 실행하면 이어서 한다.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import httpx

BACKEND = Path(__file__).resolve().parent.parent
PROJECT = BACKEND.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_gold import find_gold, gold_metrics, load_json  # noqa: E402
from eval_metrics import aggregate, graph_metrics  # noqa: E402

JUDGMENTS = PROJECT / "judgment"
GOLD = PROJECT / "eval"
OUTPUT_ROOT = PROJECT / "test_outputs" / "eval"


def load_case(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"id": data["id"], "judgment": data["judgment"], "file": path.name}


def gold21() -> list[dict]:
    case_ids = sorted({path.name.split("_")[0] for path in GOLD.glob("CASE*.json")})
    if not case_ids:
        raise SystemExit(f"{GOLD} 에 정답 그래프가 없습니다.")
    cases = [load_case(JUDGMENTS / f"{case_id}_plain.json") for case_id in case_ids]
    longest = max((load_case(p) for p in JUDGMENTS.glob("*.json")), key=lambda c: len(c["judgment"]))
    if longest["id"] not in {c["id"] for c in cases}:
        cases.append({**longest, "note": "longest"})
    return cases


def all_cases() -> list[dict]:
    cases = gold21()
    seen = {c["id"] for c in cases}
    rest = [load_case(p) for p in sorted(JUDGMENTS.glob("*.json"))]
    rest = [c for c in rest if c["id"] not in seen]
    random.Random(0).shuffle(rest)
    return cases + rest


def wait_reachable(url: str, what: str, interval: float = 60.0) -> None:
    """밤새 돌릴 때 SSH 터널·중계 서버가 잠깐 끊겨도 실패를 쌓지 않고 돌아올 때까지 기다린다."""
    announced = False
    while True:
        try:
            httpx.get(url, timeout=10)
            if announced:
                print(f"{time.strftime('%H:%M:%S')} {what} 복구", flush=True)
            return
        except httpx.TransportError:
            if not announced:
                print(f"{time.strftime('%H:%M:%S')} {what} 응답 없음 — {interval:.0f}초 간격으로 기다림 ({url})", flush=True)
                announced = True
            time.sleep(interval)


def wait_run(client: httpx.Client, run_id: str, poll: float) -> dict:
    while True:
        try:
            record = client.get(f"/api/analysis-runs/{run_id}").json()
        except httpx.TransportError:
            wait_reachable(str(client.base_url) + "/api/pipelines", "중계 서버")
            continue
        if record.get("status") not in ("queued", "running"):
            return record
        time.sleep(poll)


def _pair(row: dict, a: str, b: str) -> str:
    return f"{row.get(a)}/{row.get(b)}" if a in row else "-"


def write_summary(out: Path, rows: list[dict], meta: dict) -> None:
    total = aggregate(rows)
    (out / "summary.json").write_text(json.dumps({"meta": meta, "total": total, "cases": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    columns = [
        "사건", "길이", "초", "쟁점 적중/선택/정답", "쟁점=이름", "근거없음", "I", "제목형", "정답I 덮음", "근거→정답", "주주장",
        "RA(정답)", "쟁점RA", "미분류", "여러역할", "역할채움", "별칭", "임의이름", "검증",
    ]
    lines = [f"# 평가 {meta['label']}", "", f"flow `{meta.get('flowId')}` · {meta.get('startedAt')}", "",
             "| " + " | ".join(columns) + " |", "|" + "---|" * len(columns)]
    for r in rows:
        if "ra" not in r:
            cells = [r["caseId"][-10:], str(r.get("documentLength")), f"{r.get('status')}/{r.get('outcome')} {r.get('seconds')}"] + [""] * (len(columns) - 3)
        else:
            cells = [
                r["caseId"][-10:], str(r["documentLength"]), str(r["seconds"]),
                f"{r.get('issueHits', '-')}/{r['issues']}/{r.get('goldIssueIdsCount', '-')}", str(r["issueTextLabelOnly"]), str(r["issueEvidenceNotFound"]),
                str(r["iNodes"]), str(r["headingLikeINodes"]), _pair(r, "goldICovered", "goldI"), _pair(r, "genEvidenceInGold", "genIWithEvidence"),
                str(r.get("mainClaimMatchesGold", "-")), f"{r['ra']}({r.get('goldRa', '-')})", str(r.get("raTouchingIssue", "-")), str(r["unclassified"]),
                str(r["raMultiRole"]), f"{r['roleFilled']}/{r['roleSlots']}", str(r["aliasLeaks"]), str(r["labelLikeLeaks"]),
                "ok" if r["validationOk"] else "NG",
            ]
        lines.append("| " + " | ".join(cells) + " |")
    t = total
    lines += [
        "",
        f"합계: 성공 {t['succeeded']}/{t['cases']} · 실패 {t['failed']} · 그래프 없음 {t['noGraph']} · 총 {t['secondsTotal']}초(최장 {t['secondsMax']}초)",
        f"쟁점 {t['issues']} (이름뿐 {t['issueTextLabelOnly']}, 근거 없음 {t['issueEvidenceNotFound']}, 가지 실패 {t['branchFailed']}) · "
        f"I {t['iNodes']} (제목형 {t['headingLikeINodes']}) · RA {t['ra']} (정답 {t['goldRa']}, 쟁점에 붙은 RA {t['raTouchingIssue']}, 미분류 {t['unclassified']}, "
        f"여러 역할 {t['raMultiRole']}, 역할 {t['roleFilled']}/{t['roleSlots']}, 별칭 {t['aliasLeaks']}, 임의 이름 {t['labelLikeLeaks']}) · "
        f"검증 오류 {t['validationErrors']} · 경고 {t['warnings']}",
        f"정답 비교: 쟁점 적중 {t['issueHits']} / 선택 {t['issueSelectedCount']} / 정답 {t['goldIssueIdsCount']} · "
        f"정답 I 덮음 {t['goldICovered']}/{t['goldI']} · 생성 근거 중 정답과 겹침 {t['genEvidenceInGold']}/{t['genIWithEvidence']} · "
        f"주 주장 일치 {t['mainClaimMatchesGold']}건",
    ]
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--flow-id", default=None, help="생략하면 서버의 분석 flow")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--poll", type=float, default=20.0)
    parser.add_argument("--set", choices=["gold21", "all"], default="gold21")
    parser.add_argument("--max-length", type=int, default=None, help="이 글자 수보다 긴 판결문은 뺀다")
    parser.add_argument("--ollama-url", default="http://localhost:11434", help="실행 전 응답을 확인할 Ollama 주소 (SSH 터널)")
    parser.add_argument("--retries", type=int, default=2, help="실행 실패 직후 Ollama 가 끊겨 있었으면 복구 뒤 다시 시도하는 횟수")
    args = parser.parse_args()

    cases = all_cases() if args.set == "all" else gold21()
    if args.max_length:
        cases = [c for c in cases if len(c["judgment"]) <= args.max_length]
    cases = cases[: args.limit]
    out = OUTPUT_ROOT / args.label
    (out / "runs").mkdir(parents=True, exist_ok=True)
    issue_catalog = json.loads((BACKEND / "catalog" / "issue_catalog.json").read_text(encoding="utf-8"))
    scheme_catalog = json.loads((BACKEND / "catalog" / "walton_schemes.json").read_text(encoding="utf-8"))
    issue_labels = {i["issueId"]: i["label"] for i in issue_catalog["issues"]}
    scheme_roles = {s["schemeKey"]: [r["roleId"] for r in s["premiseRoles"]] for s in scheme_catalog["schemes"]}

    client = httpx.Client(base_url=args.base_url, timeout=60)
    flow_id = args.flow_id or client.get("/api/pipelines").json().get("analysisFlowId")
    meta = {"label": args.label, "flowId": flow_id, "startedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "set": args.set, "caseCount": len(cases)}
    rows: list[dict] = []
    for index, case in enumerate(cases, start=1):
        path = out / "runs" / f"{case['id']}.json"
        record = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        attempt = 0
        while record is None or record.get("status") != "succeeded":
            wait_reachable(args.ollama_url + "/api/version", "Ollama")
            wait_reachable(args.base_url + "/api/pipelines", "중계 서버")
            try:
                response = client.post(
                    "/api/analysis-runs",
                    json={"text": case["judgment"], "documentId": case["id"], "documentVersion": 1, "flowId": flow_id, "purpose": "analysis"},
                )
                response.raise_for_status()
                record = wait_run(client, response.json()["runId"], args.poll)
            except httpx.TransportError:
                continue
            path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
            if record.get("status") == "succeeded" or attempt >= args.retries:
                break
            try:
                httpx.get(args.ollama_url + "/api/version", timeout=10)
                break  # Ollama 는 살아 있었다 → 연결 문제가 아닌 실패이므로 재시도하지 않는다
            except httpx.TransportError:
                attempt += 1
                print(f"{time.strftime('%H:%M:%S')} {case['id']} 실패 중 Ollama 끊김 → 복구 뒤 재시도 {attempt}/{args.retries}", flush=True)
        row = graph_metrics(record, issue_labels, scheme_roles)
        gold_path = find_gold(GOLD, case["id"])
        if gold_path:
            row.update(gold_metrics(record, load_json(gold_path), case["judgment"], issue_catalog))
        rows.append(row)
        print(f"[{index}/{len(cases)}] {case['id']} len={len(case['judgment'])} status={row['status']} sec={row.get('seconds')} "
              f"ra={row.get('ra')} unclassified={row.get('unclassified')}", flush=True)
        write_summary(out, rows, meta)
    print(json.dumps(aggregate(rows), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
