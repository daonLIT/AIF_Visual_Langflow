# backend — Langflow 중계 서버

```text
app/main.py                    Starlette 앱, lifespan(재시작 복구), CORS, .env 로딩
app/config.py                  환경변수 설정 (비밀값은 응답·로그에 노출하지 않음)
app/routes/api.py              /api/health, /api/analysis-runs, /api/projects, /api/evidence/verify
app/services/langflow_client.py  run 요청(tweaks 로 커스텀 입력), envelope 에서 출력 컴포넌트 Message 추출, mock transport
app/services/aif_adapter.py    엄격 검증 → 실행별 namespace ID 변환 → 원문 보존 → annotation 제안 생성
app/services/evidence_matcher.py  인용문 원문 매칭 (exact / normalized / ambiguous / unmatched), UTF-16 인덱스
app/services/textindex.py      code point ↔ UTF-16 code unit 변환
app/services/run_manager.py    실행 상태(queued/running/succeeded/failed/cancelled/interrupted), 동시성, 중복 키, 취소
app/storage/db.py              SQLite (analysis_runs, projects)
app/schemas/models.py          pydantic 요청/응답/프로젝트 스키마
fixtures/                      mock 응답 fixture + 생성 스크립트
tests/                         unittest (pytest 호환)
```

실행: `uvicorn app.main:app --host 127.0.0.1 --port 8000`
테스트: `python run_tests.py` 또는 `pytest`

## API

| 메서드 / 경로 | 동작 |
| --- | --- |
| `GET /api/health` | 서버·Langflow 설정 상태(키 값은 노출하지 않음) |
| `POST /api/analysis-runs` | `{text, documentId, documentVersion, caseId?, idempotencyKey?}` → `202` + run 기록. 같은 키는 `200` 으로 기존 실행 반환 |
| `GET /api/analysis-runs/{runId}` | 상태 및 결과(`result.graph`, `result.annotations`, `result.summary`) |
| `POST /api/analysis-runs/{runId}/cancel` | 로컬 취소. 이후 도착한 응답은 반영하지 않음 |
| `GET /api/projects` / `GET /api/projects/{id}` | 저장된 프로젝트 목록 / 불러오기 |
| `PUT /api/projects/{id}` | 프로젝트 저장. 본문 `revision` 이 서버와 다르면 `409` |
| `POST /api/evidence/verify` | 수동 범위/인용문 재검증 |

오류 응답: `{"error": {"code", "message", "details": []}}`. 실행 실패 코드: `AUTH`, `CONNECTION`, `TIMEOUT`, `FLOW_NOT_FOUND`, `HTTP`,
`BAD_ENVELOPE`, `OUTPUT_COMPONENT_NOT_FOUND`, `INVALID_RESULT`, `INTERRUPTED`, `CANCELLED`, `NOT_CONFIGURED`.
