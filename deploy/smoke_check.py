"""
배포한 중앙 서버 점검(HTTPS 앞단 포함). 원문·토큰은 출력하지 않는다.

    python deploy/smoke_check.py --base https://aif.example.org --user owner --password-file pw.txt --publish-token-file pub.tok
    python deploy/smoke_check.py --base https://localhost:8443 --insecure ...   # Caddy 내부 CA(로컬 시험)

확인: 보안 헤더·HSTS, 익명 401, 로그인 쿠키(HttpOnly·Secure·SameSite), CSRF, 게시(201)·재전송(200), 조회, 저장(revision +1), 로그아웃.
게시에는 저장소의 실제 v11 실행 결과 fixture 를 쓰고 사건번호 SMOKE-<시각> 으로 표시한다(운영 DB 에 점검 프로젝트가 하나 남는다).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parent.parent


def check(ok: bool, label: str, detail: str = "") -> bool:
    print(f"{'ok  ' if ok else 'FAIL'} {label}{(' — ' + detail) if detail else ''}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--password-file", type=Path, required=True)
    parser.add_argument("--publish-token-file", type=Path, required=True)
    parser.add_argument("--insecure", action="store_true", help="인증서 검사 끔(로컬 시험 전용)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    password = args.password_file.read_text(encoding="utf-8").strip()
    token = args.publish_token_file.read_text(encoding="utf-8").strip()
    base = args.base.rstrip("/")
    results = []
    with httpx.Client(base_url=base, verify=not args.insecure, timeout=30, follow_redirects=False) as web:
        index = web.get("/")
        headers = index.headers
        results.append(check(index.status_code == 200 and "aif-root" in index.text, "웹 첫 화면", str(index.status_code)))
        results.append(check("max-age" in headers.get("strict-transport-security", ""), "HSTS"))
        results.append(check("frame-ancestors 'none'" in headers.get("content-security-policy", ""), "CSP"))
        results.append(check(web.get("/api/projects").status_code == 401, "익명 목록 401"))

        login = web.post("/api/auth/login", json={"username": args.user, "password": password})
        cookie = login.headers.get("set-cookie", "")
        results.append(check(login.status_code == 200, "로그인", str(login.status_code)))
        results.append(check(all(flag in cookie for flag in ("HttpOnly", "Secure", "SameSite=strict")), "세션 쿠키 속성"))
        csrf = login.json().get("csrfToken") if login.status_code == 200 else None

        live = json.loads((REPO / "backend" / "fixtures" / "langflow_run_response.live_v11.json").read_text(encoding="utf-8"))
        auth = {"Authorization": f"Bearer {token}"}
        context = httpx.get(f"{base}/api/integrations/langflow/context", headers=auth, verify=not args.insecure).json()
        stamp = time.strftime("%Y%m%d%H%M%S")
        body = {
            "schemaVersion": 1,
            "externalRunId": f"smoke-{stamp}-0001",
            "source": {"kind": "langflow-desktop", "componentVersion": "smoke-check"},
            "document": {
                "text": json.loads(live["outputs"][0]["inputs"]["input_value"], strict=False)["judgment"],
                "caseId": f"SMOKE-{stamp}",
                "title": f"배포 점검 {stamp}",
            },
            "catalogs": {k: context[k] for k in ("issueCatalogVersion", "issueCatalogSha256", "schemeCatalogVersion", "schemeCatalogSha256")},
            "result": json.loads(live["outputs"][0]["outputs"][0]["results"]["message"]["text"], strict=False),
        }
        first = httpx.post(f"{base}/api/integrations/langflow/results", json=body, headers=auth, verify=not args.insecure)
        again = httpx.post(f"{base}/api/integrations/langflow/results", json=body, headers=auth, verify=not args.insecure)
        results.append(check(first.status_code == 201, "게시 201", str(first.status_code)))
        results.append(check(again.status_code == 200 and again.json().get("duplicate") is True, "재전송 200(같은 결과)"))
        project_id = first.json().get("projectId")
        viewer = first.json().get("viewerUrl") or ""
        results.append(check(viewer.startswith(base.replace(":8443", "")) or viewer.startswith("https://"), "viewerUrl", viewer))

        project = web.get(f"/api/projects/{project_id}")
        results.append(check(project.status_code == 200, "쿠키로 조회"))
        document = project.json()
        results.append(check(web.put(f"/api/projects/{project_id}", json=document).status_code == 403, "CSRF 없는 저장 403"))
        saved = web.put(f"/api/projects/{project_id}", json=document, headers={"X-CSRF-Token": csrf or ""})
        results.append(check(saved.status_code == 200 and saved.json().get("revision") == document["revision"] + 1, "저장 revision +1", str(saved.status_code)))
        results.append(check(web.get("/api/pipelines").status_code in (403, 404), "파이프라인 경로 닫힘"))
        web.post("/api/auth/logout")
        results.append(check(web.get("/api/projects").status_code == 401, "로그아웃 뒤 401"))
    print(f"{sum(results)}/{len(results)} 통과")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
