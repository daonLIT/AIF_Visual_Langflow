# AIF_Visual_Langflow — Langflow 연동 · AI Annotation 검토

기존 법률 논증 시각화 사이트(`AIF_Visual`)를 복사한 뒤, Langflow 가 생성한 논증 그래프를 원문과 함께
검토·수정·확정하는 기능을 추가한 프로젝트입니다. 원본 프로젝트와 원본 Langflow 파일은 변경하지 않습니다.

```text
판결문 입력 → Langflow 분석(중계 서버) → AIF/OVA 응답 검증·ID 변환·근거 매칭
→ 원문 + 논증 그래프(초안 레이어) + AI 제안 카드
→ 근거 확인 · 수락 / 수정 후 수락 / 거절 → 프로젝트 저장(SQLite·파일) / AIF·OVA 내보내기
```

## 구성

```text
frontend/   React 19 + Vite + @xyflow/react (기존 뷰어 + 검토 UI)
backend/    Starlette 중계 서버 (Langflow 호출, 응답 검증, 근거 매칭, SQLite 저장)
langflow/   원본 참조본(저장소 제외) · v9 근거 flow · v11 최대 3개 세부 쟁점 자동 선택 flow
docs/       구현 계획서 사본, 원본 해시 목록, 검증 기록
.env.example
```

> 계획서에서는 FastAPI 를 권장했지만 구현 환경에서 패키지 설치가 막혀 있어 FastAPI 의 기반인 **Starlette** 로 구현했습니다.
> API 경로·동작은 계획서와 같고, FastAPI 로 바꾸려면 `backend/app/routes/api.py` 의 라우트 등록만 옮기면 됩니다.

## 설치

### 1. 백엔드 (Python 3.11+)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt  # starlette uvicorn httpx pydantic
pip install pytest               # 선택
copy ..\.env.example .env        # 값 편집 (아래 "환경변수")
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

서버는 시작할 때 `backend/.env` → 프로젝트 루트 `.env` 순서로 읽습니다. 먼저 읽은 값과 셸 환경변수가 우선하며,
어떤 파일에서 어떤 키를 읽었는지는 `GET /api/health` 의 `langflow.envFiles` 에 값 없이 표시됩니다.
`LANGFLOW_MODE` 가 `mock` / `live` 가 아니면 조용히 mock 으로 떨어지지 않고 **시작 오류**로 멈춥니다.

### 2. 프런트엔드 (Node 22)

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173  (/api 는 Vite proxy 로 127.0.0.1:8000 에 전달)
```

백엔드 포트를 바꿨다면 `VITE_API_TARGET=http://127.0.0.1:포트 npm run dev` 로 지정합니다.

## 환경변수 (`backend/.env` 또는 루트 `.env`)

| 이름 | 설명 |
| --- | --- |
| `LANGFLOW_MODE` | `mock`(기본) 또는 `live`. mock 은 `backend/fixtures/langflow_run_response.sample.json` 을 돌려줍니다. |
| `LANGFLOW_BASE_URL` | Langflow 주소 (예: `http://localhost:7860`) |
| `LANGFLOW_FLOW_ID` | 복제 flow 를 가져온 뒤 Langflow 화면/API 예제에서 확인한 **실제** Flow ID. JSON 파일의 ID 를 그대로 쓰지 마세요. |
| `LANGFLOW_API_KEY` | Langflow API 키. 서버에만 두고 브라우저·채팅에 넣지 않습니다. |
| `LANGFLOW_INPUT_COMPONENT_ID` | 커스텀 입력 컴포넌트 ID (기본 `CustomComponent-k5fj9`). 실행할 flow 에 이 ID 가 없으면 서버가 flow 마다 유일한 후보를 찾아 쓰고 경고합니다. |
| `LANGFLOW_OUTPUT_COMPONENT_ID` | 최종 Chat Output ID (기본 `ChatOutput-nL1VD`) |
| `LANGFLOW_TIMEOUT_SECONDS` | 서버 측 실행 제한(초, 기본 2000). flow 의 Ollama `timeout=0` 은 무제한이므로 여기서 제한합니다. |
| `ANALYSIS_MAX_CONCURRENCY` | 동시 실행 수 (기본 1) |
| `DATABASE_PATH` | SQLite 경로 (기본 `backend/data/annotation.sqlite3`) |
| `ISSUE_CATALOG_PATH` | 쟁점 카탈로그 (기본 `backend/catalog/issue_catalog.json`) |
| `SCHEME_CATALOG_PATH` | Walton 스킴 카탈로그 (기본 `backend/catalog/walton_schemes.json`) |
| `LANGFLOW_MOCK_FLOW_FILES` | mock 모드 파이프라인 편집이 SQLite 에 복제해 쓰는 flow 파일 (기본 v11 flow) |
| `RUN_SNAPSHOT_FLOWS` | live 실행을 flow 해시별 실행용 스냅샷 flow 로 할지 (기본 `true`). 실행 중 flow 를 고쳐도 진행 중 요청에 섞이지 않습니다. |
| `LANGFLOW_CAPTURE_DIR` | 지정하면 live 응답 envelope 를 이 폴더에 저장 (fixture 확보용, 판결문 원문 포함) |

`/api/health` 의 `flowIdConfigured`·`apiKeyConfigured` 는 값이 있는지만 뜻합니다. 실제 연결은 파이프라인 탭의 **[연결 확인]**
(`GET /api/connections/status`)으로 Langflow 응답·분석 flow 검증·v11 처리 단계 존재·Ollama 모델 설치·카탈로그를 확인합니다.

## v2 추가 기능 요약 (계획서 전체본 기준)

| 기능 | 위치 | 내용 |
| --- | --- | --- |
| 쟁점 카탈로그 | `backend/catalog/issue_catalog.json` | `세부 쟁점.xlsx` 52개 항목(8개 상위군)을 문자열 그대로 변환. ID 는 재정렬·재가져오기에도 유지 |
| 세부 쟁점 자동 선택 | v11 flow · 검토 패널 “세부 쟁점 자동 선택” | 사용자가 미리 고르지 않습니다. 모델이 판결문을 읽고 52개 중 **중복 없이 최대 3개**를 선택 이유·근거 인용과 함께 고릅니다. 0개면 그래프 없이 사유만 보고, 4개 이상·카탈로그 밖 ID·중복은 제한된 재시도 후 명시적 오류(`INVALID_SELECTION`) |
| v11 flow | `langflow/TopDown_Judgment_to_AIF_v11_Top3Issues.json` | Main Claim → 쟁점 선택 → 쟁점별 I-node 추출 → Graph Builder → I-node Summary → RA Scheme Assignment → 결과 검증 → Final AIF JSON |
| I 노드 요약 | 그래프 노드 · 상세 패널 | 노드에는 요약(`summary`), 클릭/Enter 로 본문·근거 보기, [수정] 버튼으로만 편집(저장/취소). 본문을 고치면 요약은 “본문 변경됨(stale)”, 근거와 연결 RA scheme 은 재검토 대상. [AI 요약 생성]은 요청 뒤 본문·요약이 바뀐 노드에 결과를 덮어쓰지 않음 |
| Walton scheme | RA 노드 `RA · 짧은 이름` | `schemeApplication`: scheme 선택(미분류·직접 작성 포함), 정의, 전제 역할별 노드, 결론, 적용 이유, 비판적 질문, 메모, 검토 상태(제안/확정/재검토 필요), 대안 후보, AI 원안·수정 이력. RA 연결이나 연결 노드 본문이 바뀌면 지우지 않고 “재검토 필요” |
| 파이프라인 편집 | 상단 [파이프라인] 탭 | 실제 flow data 의 컴포넌트·연결·프롬프트·모델 설정 편집 → 초안 자동 저장(새로고침 후에도 유지, 적용본과의 차이 표시) → 검증 → Langflow 적용(충돌 검사·백업·**재조회 확인**) → 테스트 실행 → 버전 복원 |
| 실행 버전 고정 | 실행 기록 `pipeline` · `catalogs` | 실행마다 flow ID·이름·실행 해시·모델 설정·입출력 컴포넌트·카탈로그 버전을 기록하고, live 에서는 해시별 실행용 스냅샷 flow 로 실행 |
| 프로젝트 v2 | `*.project.json` | `schemaVersion: 2`. v1 파일과 v10 시절 `scheme` 필드는 불러올 때 자동 변환. 저장 시 카탈로그 버전 기록 |
| DB 마이그레이션 | `backend/data/annotation.sqlite3` | `PRAGMA user_version` 기반 명시적 마이그레이션. 올리기 전에 `annotation.sqlite3.backup-v{이전}-{시각}` 백업 |

쟁점 카탈로그를 다시 만들 때(엑셀이 바뀐 경우):

```bash
cd backend
python scripts/import_issue_catalog.py "C:\Users\...\세부 쟁점.xlsx"
# 명칭만 바꾼 항목의 ID 를 이어받으려면: --rename "옛 상위군|옛 항목=>새 상위군|새 항목"
```

엑셀의 비교·판단 기준은 분류 참고 정보로만 쓰며, 법률 기준이나 실행 지시로 취급하지 않습니다.

## Langflow 가져오기

1. Langflow(1.11 기준) 화면 또는 API 로 `langflow/TopDown_Judgment_to_AIF_v11_Top3Issues.json` 을 가져옵니다
   (이전 3쟁점 flow 는 `..._3Issue_v9_Evidence.json`).
2. Ollama 가 실행 중이고 `gemma4:e4b-it-qat` 모델이 설치되어 있는지 확인합니다 (Main Claim LLM + 쟁점 선택·가지 추출·요약·scheme 컴포넌트 공통).
3. 가져온 flow 의 실제 Flow ID 를 `LANGFLOW_FLOW_ID` 에 넣고 `LANGFLOW_MODE=live` 로 바꿉니다.
   Langflow 화면에서 가져오면 컴포넌트 ID 가 새로 붙는 경우가 있습니다(API 로 가져오면 유지). 서버는 flow 마다 입력·출력 컴포넌트를 확인해
   설정 ID 가 없으면 유일한 후보를 쓰고 경고하며, 후보가 여럿이면 [검증]·[연결 확인]이 후보 ID 를 알려 줍니다.
   이 flow 는 **프로덕션**으로 보호되어 파이프라인 탭에서 직접 적용할 수 없습니다. [작업용 복제] 후 편집·적용하고, [분석에 사용]으로 분석 flow 를 바꿀 수 있습니다.
4. 파이프라인 탭의 [연결 확인]에서 langflow · analysis_flow · flow_contract(v11 단계) · ollama · ollama_models · catalogs 가 모두 정상인지 확인합니다.
   설정 값이 있다는 것과 실제 연결 성공은 다릅니다.

중계 서버는 실행에 고정한 flow(live 에서는 실행용 스냅샷)의 `POST {LANGFLOW_BASE_URL}/api/v1/run/{FLOW_ID}` 에 다음을 보냅니다.

```json
{
  "input_type": "chat", "output_type": "chat",
  "input_value": "{\"case_id\": \"...\", \"judgment\": \"원문\", \"issue_catalog\": [52개], \"scheme_catalog\": [...], \"catalog_versions\": {...}}",
  "output_component": "ChatOutput-nL1VD",
  "tweaks": { "CustomComponent-k5fj9": { "value": "(input_value 와 같은 JSON)" } }
}
```

자세한 flow 구조는 `langflow/README.md`.

## 사용 흐름

1. **판결문 입력** — TXT 업로드 또는 붙여넣기. 줄바꿈·공백은 그대로 보존됩니다.
2. **AI 분석** — 바로 실행됩니다(쟁점을 미리 고르지 않음). 결과가 오면 검토 패널의 “세부 쟁점 자동 선택”에 선택된 최대 3개 쟁점,
   선택 이유, 근거 인용 확인 여부(근거 없음/미검출은 법원의 부정 판단이 아님), 가지 추출 실패, scheme 분류 수, 실행 버전이 표시됩니다.
   근거 있는 쟁점이 없으면 그래프를 만들지 않고 사유를 알립니다. 실행 상태(대기/분석 중/완료/실패)와 경과 시간을 표시합니다. 단계별 진행률은 flow 가 제공하지 않으므로 표시하지 않습니다. 취소는 서버의 대기·반영을 멈추지만 Langflow/Ollama 계산까지 중단하지는 못합니다.
3. **검토** — 오른쪽 패널의 제안 카드(AI/규칙/사람 · 미검토/수락/수정 수락/거절 텍스트 배지). 카드 ↔ 그래프 노드 ↔ 원문 근거가 양방향으로 동기화됩니다.
   - 수락 / 수정 후 수락 / 거절 / 미검토로 되돌리기
   - 관계(엣지)는 양 끝 노드가 확정되어야 수락됩니다. “노드와 함께 수락” 으로 의존 제안을 같이 처리합니다.
   - 근거: 원문 일치 / 공백 차이 일치 / 위치 불명확(후보 선택) / 원문에 없음 / 수동 지정 / 재검토 필요. 원문을 드래그해 “이 제안의 근거로 연결”.
   - “미검토 전체 수락…” 은 구조 검증 예상과 근거 미확인 수를 보여준 뒤 실행됩니다.
4. **저장** — 프로젝트 메뉴 → 서버에 저장(revision 검사) / 파일로 저장 / 열기. **AIF/OVA 내보내기** 는 확정 그래프만 포함합니다.
5. **노드 상세** — 노드를 한 번 클릭하거나 포커스 후 Enter 를 누르면 오른쪽 상세 패널에 본문·요약·근거(I/ISSUE) 또는 scheme(RA)이 보입니다.
   편집은 [수정] 버튼으로만 하고 저장/취소로 끝냅니다(blur 자동 확정·더블클릭 인라인 편집 없음). 초안 제안을 고치면 미검토 상태가 유지되고,
   확정 노드를 고치면 원안과 달라진 경우 “수정 수락”이 됩니다. ISSUE 의 세부 쟁점 선택지는 확정 그래프에서 중복 없이 최대 3개가 되도록 제한됩니다.
6. **파이프라인 탭** — flow 선택 → (프로덕션이면) 작업용 복제 → 컴포넌트 추가·삭제·이동, 포트 연결·해제, 프롬프트·모델·필드 편집,
   (고급) 커스텀 컴포넌트 코드 편집 → 초안 자동 저장(Ctrl+S 즉시 저장) → [Langflow 에 적용…](메모, 적용 확인 뒤 테스트 실행 선택) → 버전 기록에서 복원.
   편집을 시작한 뒤 Langflow 에서 flow 가 바뀌었으면(updated_at·실행 해시) 적용하지 않고 충돌로 알립니다. 적용 후 다시 읽은 내용이 다르면 성공으로 표시하지 않습니다.
   비밀 필드 값은 브라우저로 오지 않고, 적용 시 서버가 현재 Langflow 값으로 채웁니다. 논증 그래프와 별도의 undo/redo 를 씁니다.
7. **재분석** — 기존 편집은 유지되고 새 실행은 별도 제안으로 들어옵니다. 원문이 바뀐 뒤 도착한 결과는 자동 반영되지 않고 “제안으로 불러오기” 로만 반영됩니다.

키보드: `Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y` undo·redo(그래프 편집과 검토 변경 공통), `Esc` 선택 해제, 카드·근거 하이라이트는 Tab 으로 이동 가능. 창 너비 1100px 미만에서는 [판결문 | 그래프 | 검토] 탭으로 전환됩니다.

## 검사

```bash
cd backend && python run_tests.py         # 또는 pytest
cd frontend && npm run check              # build + lint + smoke + smoke:annotation + smoke:store + smoke:v2
python langflow/make_v11_flow.py          # v11 flow 재생성 (Langflow 설치본의 lfx 로 컴포넌트 template 생성·프롬프트 렌더 확인, --offline 가능)
cd backend && python fixtures/make_fixture_v11.py   # v11 mock 응답 재생성 (실제 컴포넌트 코드 + 가짜 모델 응답)
```

## 데이터 형식

프로젝트 파일(`*.project.json`, `schemaVersion: 2` — v1 은 불러올 때 자동 변환):

```text
projectId / revision / title
document: { id, text, hash(sha256), version, caseId }
acceptedGraph: AIF/OVA (확정 항목만, 미지 필드 보존)
analysisRuns[]: 실행 기록 (runId, status, documentHash, namespace, mode, error, summary)
annotations[]: { id, runId, kind, nodeId|edgeId, origin(ai|rule|human), status(pending|accepted|modified|rejected),
                 originalValue, currentValue, evidence[{quote,start,end,match,documentVersion}], createdAt, updatedAt }
reviewEvents[]: 사용자 변경 이력
catalogs: { issueCatalogVersion, issueCatalogSha256, schemeCatalogVersion }   (저장 시점)
analysisRuns[].catalogs / pipeline: 실행별 카탈로그 버전과 고정된 flow(해시·모델·입출력·스냅샷)

노드 값(originalValue/currentValue, acceptedGraph 의 AIF 노드)에 v2 에서 추가된 선택 필드 (프로젝트 확장 스키마, AIF 표준 아님):
  summary, summaryOrigin(ai|human), summaryStatus(current|stale), summarySourceHash(fnv1a64 본문 해시)   (I/ISSUE)
  issueRef: { issueId, categoryId, catalogVersion, instanceId, selectionReason }   (ISSUE)
  issueRefs: [{ issueId, instanceId }]                                             (I/RA)
  schemeApplication: { schemeKey(카탈로그 key | unclassified | custom), catalogVersion, status(suggested|confirmed|needs_review),
                       origin(ai|human), rationale, premiseBindings[{roleId, nodeIds}], conclusionNodeIds,
                       criticalQuestionResponses[{questionId, status, answer}], notes, customSchemeName, alternatives,
                       reviewReasons?, errors?, history? }   (RA)
evidence[].reviewReason: 노드 본문 수정 후 근거 재검토 필요 사유

AIF.schemefulfillments 는 scheme 카탈로그에 검증된 외부 schemeID(aifdbSchemeId)가 있을 때만 만들고(현재 카탈로그는 모두 null → 생성 안 함),
기존 외부 항목은 노드가 확정 그래프에 남아 있는 한 보존합니다(namespace 변환 시 nodeID 도 변환).
```

근거 범위는 반개구간 `[start, end)`, **UTF-16 code unit** 기준입니다(서버는 `textindex.py` 로 변환).

## 알려진 제약

- v9 flow 는 쟁점을 정확히 3개로 요구합니다. v9 의 I-node 프롬프트 3개는 JSON 예시에 단일 중괄호를 써서
  Langflow 가 `{"text"}` 를 변수로 해석하므로 실제 실행 시 실패할 가능성이 큽니다(파이프라인 검증이 오류로 표시).
- v11 의 쟁점 선택·가지 추출·요약·scheme 컴포넌트는 Langflow 의 Ollama 컴포넌트가 아니라 컴포넌트 안에서 Ollama `/api/chat` 을 직접 호출합니다.
  모델·온도·컨텍스트·timeout 은 각 컴포넌트의 필드로 편집합니다.
- Walton scheme 카탈로그(v3)는 사용자가 지정한 10개입니다: Witness Testimony, Evidence to a Hypothesis, Sign, Inconsistent Commitment,
  Alternatives, Effect to Cause, Best Explanation, Ignorance, Verbal Classification, an Established Rule.
  형식·비판적 질문은 공개 자료(Walton, Reed & Macagno 2008 기반 CQ 템플릿, Carneades walton.yml)와 대조했고 번역은 구현자가 했습니다.
  Inconsistent Commitment · Effect to Cause · Best Explanation 은 공개 자료에서 원문을 찾지 못해 `verification: needs-book-check`(원서 대조 필요)로 표시되어 있습니다.
  scheme 마다 `sourceNote` 에 출처가 있고 RA 상세 패널의 [출처]에서 볼 수 있습니다.
- 이전 카탈로그(v2)로 저장된 RA scheme 은 `backend/catalog/scheme_catalog_migrations.json` 대응표로 프로젝트·JSON 을 불러올 때 v3 로 옮깁니다.
  서버가 시작할 때 대응표의 대상 key·역할·CQ 가 v3 에 있는지 검사하고 `/api/catalogs/schemes` 의 `migrations` 로 내보냅니다.
  자동으로 확정하지 않습니다. key 를 바꾸거나(`lack_of_evidence`→`ignorance`, `abduction`→`best_explanation`) 미분류로 돌리거나 옮기지 못한 역할·CQ 응답이 있으면
  "재검토 필요"로 표시하고, 원래 key·역할 배정·CQ 응답은 RA 상세의 수정 이력(카탈로그 전환)에 남깁니다. 과거 실행 기록은 바꾸지 않습니다.
- JSON 이 정상 출력되는 것과 쟁점 선택·scheme 분류가 정확한 것은 별개입니다. 분류 품질은 사람이 검토해야 합니다.
- 파이프라인 탭의 코드 재구성·코드 검사와 AI 요약 생성은 live 모드에서만 됩니다(mock 은 로컬 SQLite 사본 편집, 요약은 501).
- CA(반박) 노드는 자동 생성되지 않습니다. 수동 편집으로 추가하세요.
- 신뢰도 점수가 없으므로 백분율을 표시하지 않습니다.
- 취소는 로컬 취소입니다(Langflow/Ollama 계산은 계속될 수 있음).
- 서버 재시작 시 진행 중이던 실행은 `interrupted` 로 표시됩니다.
- 원문 교체를 undo 하면 텍스트와 근거는 되돌아가지만 문서 버전 번호는 유지됩니다.
- 로그인·협업·외부 배포는 범위 밖입니다. CORS 는 `localhost:5173` 만 허용합니다.
