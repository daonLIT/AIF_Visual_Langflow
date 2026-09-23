# backend — Langflow 중계 서버

```text
app/main.py                    Starlette 앱, lifespan(재시작 복구), CORS, Accept-Language, .env 로딩
app/config.py                  환경변수 설정 (비밀값은 응답·로그에 노출하지 않음)
app/i18n.py                    사용자에게 보이는 메시지의 한국어/영어 (로그는 번역하지 않음)
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

## 메시지 언어 (한국어 / English)

오류·경고처럼 **사용자에게 보이는 문구**는 요청의 `Accept-Language` 로 정해진다. 지원은 `ko` / `en` 이고, 없거나 모르는 값이면 한국어다
(프런트엔드는 화면 언어를 그대로 보낸다). 로그·DB 마이그레이션 설명처럼 운영자만 보는 문구는 번역하지 않는다.

- 문구는 `app/i18n.py` 의 `MESSAGES` 에 ko/en 쌍으로 두고 `t("key", 자리표시자=값)` 으로 만든다. 키는 위치 인자라 `key=` 같은 이름과 겹치지 않는다.
- 언어는 contextvar 로 흐른다. 분석 실행 task 는 **시작한 요청**의 언어를 물려받고, 그때 만들어진 문구가 DB 에 그대로 남는다
  (나중에 다른 언어로 조회해도 다시 만들지 않는다).
- 서버 시작 때 생기는 카탈로그 오류는 언어를 모르므로 `Msg` 로 담아 두고 응답할 때 만든다.

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
| `POST /api/catalogs/schemes/custom` | 그래프 화면에서 직접 만든 scheme 을 목록에 추가 → `201` + `{schemeKey, catalog}` |
| `PUT /api/catalogs/schemes/custom/{schemeKey}` | 그 scheme 의 정의(이름·설명·전제 역할을 함께) 또는 `enabledForAi`·`retired` 만 변경 |
| `GET /api/integrations/langflow/context` | Desktop Flow 실행 시작 때 읽는 쟁점·스킴 카탈로그(Flow 입력 형식)와 버전·sha256 |
| `POST /api/integrations/langflow/results` | Desktop Flow 결과 게시. 아래 "외부 결과 게시" 참고 |

오류 응답: `{"error": {"code", "message", "details": []}}`. 실행 실패 코드: `AUTH`, `CONNECTION`, `TIMEOUT`, `FLOW_NOT_FOUND`, `HTTP`,
`BAD_ENVELOPE`, `OUTPUT_COMPONENT_NOT_FOUND`, `INVALID_RESULT`, `INTERRUPTED`, `CANCELLED`, `NOT_CONFIGURED`.


### 사용자가 만든 scheme

- 정본 카탈로그 파일(`catalog/walton_schemes.json`)은 바꾸지 않는다. 사용자가 만든 scheme 은 DB `custom_schemes`(마이그레이션 v6)에 따로 두고,
  카탈로그를 읽는 모든 곳이 `merged_scheme_catalog()` 로 둘을 합쳐 본다.
- key 는 서버가 `custom-<hex8>` 로 발급한다. 정본 key 와 겹치지 않고, 카탈로그 버전 이행(`migrations`)도 이 key 를 건드리지 않는다.
- `schemeCatalogVersion` 과 `sha256` 은 정본 파일 값 그대로다. scheme 을 하나 만들었다고 버전이 오르면 기존 그래프가 모두 이행 대상이 되고 게시 대조도 깨진다.
- `enabledForAi` 가 꺼졌거나 `retired` 인 scheme 은 Flow 로 보내는 목록에서 빠지지만, 과거 그래프의 이름 표시를 위해 카탈로그에는 남는다. 지우는 기능은 없다(폐기만).
- 받는 값은 이름·설명·전제 역할뿐이다. 비판적 질문은 비어 있고 결론 역할은 서버 기본값으로 채운다.

## 인증 (`AIF_AUTH_MODE`)

- `off`(기본): 로컬 개발용. 모든 요청을 `local-dev` 주체로 보고 모든 권한을 준다.
- `token`: `/api/health` 를 뺀 모든 `/api` 요청에 `Authorization: Bearer <토큰>` 이 필요하다. 없거나 틀리면 `401 AUTH_REQUIRED`, 권한이 없으면 `403 FORBIDDEN`.
  인증 없이 보는 `/api/health` 는 `{status, time, authMode}` 만 돌려준다.
- 토큰 파일(`AIF_API_TOKENS_FILE`)에는 sha256 만 둔다. 파일을 고치면 서버 재시작 없이 다음 요청부터 반영된다.

| 권한 | 경로 |
| --- | --- |
| `catalog:read` | `GET /api/catalogs/*`, `GET /api/integrations/langflow/context` |
| `catalog:write` | `POST /api/catalogs/schemes/custom`, `PUT /api/catalogs/schemes/custom/{schemeKey}` (그래프 화면에서 직접 만든 scheme) |
| `results:publish` | `POST /api/integrations/langflow/results` |
| `projects:read` | `GET /api/projects`, `GET /api/projects/{id}`, `POST /api/evidence/verify` |
| `projects:write` | `PUT /api/projects/{id}` |
| `analysis:run` | `/api/analysis-runs*`, `POST /api/summaries` |
| `pipeline:admin` | `/api/pipelines*`, `/api/pipeline-*`, `/api/connections*` |
| `admin` | 모든 경로. 표에 없는 `/api` 경로는 `admin` 만 (기본 거부) |

```bash
python scripts/manage_tokens.py create --id desktop-publish --principal langflow-desktop --preset publish   # Flow 게시용
python scripts/manage_tokens.py create --id desktop-review  --principal owner            --preset review    # Desktop 검토 화면용
python scripts/manage_tokens.py list
python scripts/manage_tokens.py disable --id desktop-publish
```

토큰 원문은 만들 때 한 번만 출력된다. 키 교체는 같은 `principal` 로 새 토큰을 만들고 Desktop 셸 설정을 바꾼 뒤 옛 토큰을 `disable` 한다.
`principal` 이 같으면 교체 전후의 게시 재전송도 같은 결과로 묶인다.

### 브라우저 로그인 (세션 쿠키)

| 메서드 / 경로 | 동작 |
| --- | --- |
| `POST /api/auth/login` | `{username, password}` → 세션 쿠키 `aif_session`(HttpOnly, SameSite=Strict, https 면 Secure) + `{user, scopes, csrfToken}` |
| `GET /api/auth/session` | 로그인 상태와 CSRF 토큰(새로고침 뒤 다시 받음). 없으면 401. `AIF_AUTH_MODE=off` 면 `local-dev` |
| `POST /api/auth/logout` | 세션 삭제, 쿠키 지움 |

- 쿠키로 인증한 요청이 GET·HEAD 가 아니면 `X-CSRF-Token` 이 세션의 CSRF 토큰과 같아야 한다(아니면 `403 CSRF_FAILED`). 토큰(Bearer) 요청은 CSRF 대상이 아니다.
- 세션은 DB(`auth_sessions`, 마이그레이션 v5)에 쿠키 값의 sha256 만 둔다. 유효 시간 `AIF_SESSION_TTL_HOURS`(기본 12).
- 계정 파일(`AIF_USERS_FILE`)에는 scrypt 해시만 둔다. 계정을 끄면 이미 발급한 세션도 다음 요청부터 막힌다.
- 같은 사용자 이름·주소로 10분 안에 5번 틀리면 `429 LOGIN_LOCKED`(서버 메모리, 단일 프로세스 기준). 없는 계정도 같은 시간이 걸리게 비교한다.
- `AIF_COOKIE_SECURE`: `auto`(https 요청이나 `X-Forwarded-Proto: https` 일 때 Secure) | `true` | `false`.
- 초기 운영은 단일 팀 모델이다. 로그인한 계정은 권한 안에서 모든 프로젝트를 본다(프로젝트별 소유권은 없음).

```bash
python scripts/manage_users.py create --username owner --principal owner --preset review   # 비밀번호는 입력창으로 받는다(10자 이상)
python scripts/manage_users.py password --username owner
python scripts/manage_users.py list
python scripts/manage_users.py disable --username owner
```

## 외부 결과 게시 (Langflow Desktop → 중앙 서버)

`POST /api/integrations/langflow/results` (권한 `results:publish`)

```json
{
  "schemaVersion": 1,
  "externalRunId": "lfd-<uuid>",
  "source": {"kind": "langflow-desktop", "flowId": "…", "flowName": "…", "componentVersion": "aif-publish/1"},
  "document": {"text": "판결문 원문", "caseId": "선택", "title": "선택"},
  "catalogs": {"issueCatalogVersion": 1, "issueCatalogSha256": "…", "schemeCatalogVersion": 3, "schemeCatalogSha256": "…"},
  "result": {"status": "ok | no_issues", "AIF": {"…": "Result Validator 의 최종 AIF JSON 그대로"}}
}
```

| 응답 | 조건 |
| --- | --- |
| `201` `{projectId, runId, revision: 1, status: "saved", outcome, viewerUrl, duplicate: false, externalRunId}` | 새로 저장 |
| `200` (같은 모양, `duplicate: true`, 지금 revision) | 같은 주체·같은 `externalRunId`·같은 내용의 재전송. 프로젝트는 건드리지 않는다(사람이 고친 내용 보존) |
| `409 EXTERNAL_RUN_CONFLICT` | 같은 `externalRunId` 로 다른 내용 |
| `409 CATALOG_MISMATCH` | 실행 때 카탈로그 버전·해시가 서버 현재 카탈로그와 다름(과거 카탈로그 스냅샷은 보관하지 않는다) |
| `413 TOO_LARGE` | 본문이 `AIF_MAX_PUBLISH_BYTES` 초과 |
| `422` | 요청 형식·빈 원문·그래프 규모(노드 2000/엣지 4000) 초과, `invalid` 결과, 잘못된 그래프 참조, 쟁점 제약 위반. 저장하지 않는다 |
| `401` / `403` | 인증 없음 / 권한 없음 |

- 분석은 Desktop 에서 끝났다. 서버는 Langflow 를 다시 부르지 않고 기존 어댑터로 검증·ID namespace·원문 근거 매칭·미검토 annotation 을 만든다.
- AI 제안은 `acceptedGraph` 에 넣지 않는다(빈 그래프 + 미검토 annotation). `no_issues` 는 빈 그래프와 사유로 저장한다.
- 중복 판정: (토큰의 `principal`, `externalRunId`) 에 DB 기본 키, 정규화한 요청(sha256)을 보관한다. 동시에 같은 요청이 와도 프로젝트는 하나다.
- 실행 기록·프로젝트·게시 매핑은 한 트랜잭션(`BEGIN IMMEDIATE`)으로 저장한다. 중간에 실패하면 아무것도 남지 않는다.
- 실행 기록에는 받은 출처 정보(`source`)만 남긴다. 알 수 없는 Flow 해시·모델 설정은 채워 넣지 않는다.
- DB 마이그레이션 v4 가 `external_publications` 표를 만든다(기존 DB 는 먼저 백업).
