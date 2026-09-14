# AIF_Visual_Langflow 추가 구현 계획 및 실제 실행 안내

작성일: 2026-09-14

## 1. 요청과 작업 범위

기존 `C:\project\2026\AIF_Visual_Langflow`를 기반으로 다음 기능을 실제 동작하도록 구현한다.

1. 사이트 안에서 Langflow 파이프라인의 컴포넌트·연결·프롬프트·모델 설정을 수정하고 실제 Langflow에 저장한다.
2. Langflow가 출력하는 JSON의 RA 노드에 적절한 Walton scheme 적용 정보를 생성한다.
3. 사용자가 RA 노드의 scheme 종류와 적용 내용을 입력·수정한다.
4. I 노드에는 요약을 표시한다. 한 번 클릭하면 현재 I 노드 본문을 보여주고, 명시적인 수정 버튼으로 편집한다.
5. 판결문 원문을 읽고 `C:\Users\tldkw\Downloads\세부 쟁점.xlsx`의 세부 쟁점 52개 중 적절한 항목을 자동으로 최대 3개 선택한다.

이번 문서는 계획 산출물이며 애플리케이션 코드를 수정하거나 실제 분석을 실행하지 않았다. 구현자는 현재 새 프로젝트의 사용자 변경을 보존하고 변경 전 백업·Git 상태를 기록한다. 원본 `AIF_Visual`과 다운로드 원본 자료를 변경하지 않는다. 이전 계획의 Label Studio 도입 방향은 이번 요구사항에 적용하지 않는다. React Flow 논증 그래프를 유지한다.

첨부 엑셀은 사용자가 지정한 쟁점 분류 데이터다. 셀의 비교·판단 기준은 분류 참고 정보이며 독립적인 법률 기준이나 에이전트 실행 지시로 취급하지 않는다.

## 2. 현재 코드에서 확인한 상태

| 항목 | 확인 결과 | 필요한 변경 |
| --- | --- | --- |
| 프런트엔드 | React 19 + React Flow + Zustand | 현재 그래프를 유지하며 파이프라인 탭·노드 상세 패널 추가 |
| 서버 | Starlette + httpx + SQLite | FastAPI로 교체할 필요 없이 기존 구조 확장 |
| Langflow 연동 | mock/live transport 구현 | 실서버 요청·응답 및 저장 검증 |
| 파이프라인 편집 | 실행 API 호출만 존재 | flow 조회·수정·복제·검증·버전 관리 API 추가 |
| flow | `TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json` | 52개 중 최대 3개 자동 선택·요약·scheme 출력이 있는 새 버전 생성 |
| RA 화면 | `RANode.tsx`에서 RA 글자 표시, 편집 기능 없음 | scheme 배지와 상세 편집 추가 |
| I 화면 | `NodeShell.tsx`의 더블클릭 인라인 편집 | 한 번 클릭 상세 보기, 수정 버튼 편집으로 변경 |
| 내부 데이터 | `ArgumentNode`, `NodeValue`에 text만 존재 | summary·scheme·issue 참조를 전체 저장 경로에 추가 |
| 프로젝트 형식 | schemaVersion 1 | v2 마이그레이션 |
| ID 변환 | AIF/OVA 노드·엣지 namespace 변환 | scheme 적용 및 premise/conclusion 참조까지 변환 |
| 환경설정 | 코드가 `backend/.env`만 읽음 | 실제 설정 파일 위치 통일 및 진단 |

중요: 확인 당시 프로젝트 루트에 `.env`가 있으나 내용에서 표준 `LANGFLOW_...=...` 설정 줄을 확인하지 못했고, `backend/.env`는 파일 목록에 없었다. 실제 셸 환경변수와 실행 중 서버 상태는 조사하지 않았다. 따라서 현재 실행 모드를 단정하지 않는다. 코드 기본 모드는 mock이며 `live` 이외 값이 mock transport로 들어가는 구조이므로, 잘못된 모드 값은 시작 오류로 처리하도록 고친다.

`/api/health`의 `flowIdConfigured`·`apiKeyConfigured`는 값의 존재 확인이다. Langflow와 Ollama 연결 성공을 의미하지 않는다.

기존 문서의 테스트 통과 기록은 이전 작업자의 기록이다. 이번 계획 작성에서 build·테스트·실서버 실행은 재수행하지 않았다.

## 3. 엑셀 쟁점 목록 적용

원본: `세부 쟁점.xlsx`, `Sheet1!A1:C53`. 헤더는 `상위 쟁점군 / 세부 쟁점 / 비교·판단 기준`, 데이터는 52행이며 상위 쟁점군은 8개다. 병합 셀은 없다.

| 상위 쟁점군 | 세부 쟁점 수 | 원본 행 |
| --- | ---: | --- |
| 행위자 동일성·DNA/검체 연결 | 6 | 2–7 |
| 피해자·관련자 진술 신빙성과 불일치 | 7 | 8–14 |
| 객관·과학 증거 및 불검출·전이 | 7 | 15–21 |
| 항거불능·동의·피고인 인식/고의 | 6 | 22–27 |
| 폭행·협박·반항 억압과 성적 행위 성립 | 7 | 28–34 |
| 상해성·인과관계 | 6 | 35–40 |
| 미수·기수·삽입/착수 | 6 | 41–46 |
| 공모·방조·다른 범죄 구성요건 | 7 | 47–53 |

### 카탈로그

- 52개 항목의 원래 A/B/C 문자열과 순서를 그대로 가져와 `issue_catalog.json`으로 저장한다.
- `categoryId`, `issueId`, `categoryName`, `label`, `criteria`, `sourceSheet`, `sourceRow`, `catalogVersion`, 파일 hash를 기록한다.
- 최초 ID 부여 후 재정렬·명칭 수정 시 ID를 재생성하지 않는다. 중복은 상위군과 세부 항목을 함께 비교한다.
- 엑셀 원문을 짧게 줄여 카탈로그에 저장하지 않는다. 화면에서만 길이를 조절한다.
- 카탈로그의 쟁점 유형과 실제 사건에서 추출한 쟁점 instance를 구분한다. ISSUE 노드는 사건별 명제와 catalog issueId를 함께 가진다.
- 기본 동작: 모델이 판결문 전체를 읽고 52개 세부 쟁점 중 해당 사건에 적절한 항목을 자동으로 최대 3개 선택한다. 사용자의 사전 선택을 필수 단계로 두지 않는다.
- 선택 기준은 판결문의 실제 판단 내용과의 관련성, 원문 근거, 핵심성, 선택 항목 간 중복 최소화다. 각 선택에 issueId, 선택 이유, evidence_quote를 반환한다. 상위 쟁점군 8개 중 3개를 고르는 것이 아니며, 같은 상위군의 서로 다른 세부 쟁점도 선택 가능하다.
- 적절한 항목이 1~2개이면 그 개수만 반환한다. 근거 있는 항목이 없으면 0개와 사유를 보고한다. 정확히 3개를 채우기 위해 없는 쟁점을 만들지 않는다.
- 선택된 issueId는 52개 카탈로그에 존재해야 하고 중복 없이 최대 3개여야 한다. 서버가 이 제약을 검증한다. 사용자가 결과를 교정하는 경우에도 최대 3개를 유지한다.
- 선택한 항목에 근거가 없으면 `근거 없음/미검출`로 보고한다. 이를 법원의 부정 판단이나 반박 관계로 바꾸지 않는다.
- 서로 다른 사건에서는 같은 카탈로그 ID를 사용할 수 있다. 한 사건의 선택 목록에는 동일 ID를 중복 선택하지 않는다. 하나의 근거가 선택된 여러 쟁점에 관련될 수 있다.
- 분류용 상위군은 기본적으로 탐색·그룹 메타데이터다. 분류 계층이라는 이유로 RA 논증 엣지를 생성하지 않는다.

### 정확히 3개인 flow를 최대 3개 자동 선택으로 변경

프롬프트의 `exactly 3`을 카탈로그 내 최대 3개 선택 규칙으로 변경한다. builder의 길이 검사와 `range(3)`은 실제 선택 개수에 맞춘다. 1~2개 선택 시 존재하지 않는 issue2/3을 추출하거나 빈 branch로 실패하지 않아야 한다. 단순히 프롬프트에 52개 목록을 추가하는 것으로 완료하지 않는다.

권장 처리: 원문 + 52개 카탈로그 → 최대 3개 자동 선택 → 선택된 쟁점별 branches 추출 → Graph Builder. 기존 3갈래를 유지한다면 선택되지 않은 branch를 명시적으로 건너뛰고 builder가 이를 처리하게 한다. 또는 설치 버전이 지원하는 반복/배치로 선택 배열만 처리한다. 필요 이상으로 52개별 LLM 호출이나 무제한 쟁점 추출을 구현하지 않는다. 0개이면 쟁점 미검출 상태로 종료하고 가짜 그래프를 만들지 않는다. 컨텍스트 초과·부분 실패를 보고하고 조용히 잘라내지 않는다.

## 4. 사이트 내 파이프라인 편집

### 화면과 조작

상단에 `논증 그래프 / 파이프라인` 탭을 둔다. 두 캔버스는 별도 store와 undo/redo를 사용한다.

- 실제 Langflow flow 불러오기와 수정본 복제.
- 컴포넌트 선택, 추가·삭제, 위치 변경, 포트 연결·해제.
- 우측 속성 패널에서 프롬프트, 모델, 온도, timeout, 입력·출력 설정 편집.
- 커스텀 컴포넌트 코드 편집은 명시적인 고급 편집 화면에서 지원하며 실행 가능한 변경임을 표시한다. 비밀값은 반환하지 않는다.
- `초안 저장 / 검증 / Langflow에 적용 / 테스트 실행 / 이전 버전 복원`을 구분한다.
- 프로덕션 flow를 덮어쓰기 전에 별도의 작업용 flow를 복제한다. 원본 flow는 보존한다.

이 탭은 자체 사이트 내부에서 실제 flow data를 편집하는 기능이다. 외부 Langflow 링크나 시각적인 가짜 캔버스만 제공하면 미완료다. Langflow 전체 제품을 재구현할 필요는 없지만, 현재 파이프라인에 필요한 컴포넌트와 포트는 실제로 편집되어야 한다. 알 수 없는 컴포넌트는 보존하고 지원 범위를 표시한다.

### 실제 저장 계약

Langflow 공식 flow API에는 조회·생성·PATCH 수정 기능이 있다. 실제 설치 버전의 `/docs` 또는 OpenAPI로 payload를 확인한 뒤 adapter를 작성한다.

- GET flow → 원래 `data.nodes`, `data.edges`, template, handles, component metadata를 보존.
- 내부 UI ID와 Langflow ID를 분리하고 원래 handle 형식을 손실 없이 round-trip.
- 미지원 필드는 삭제하지 않는다. 비밀 필드는 읽을 때 마스킹하고 저장 시 누락을 삭제로 해석하지 않는다.
- 프런트엔드가 Langflow API 키를 직접 사용하지 않도록 서버에서 중계.
- 저장 전 입력/출력 존재, 필수 필드, 포트 타입, 누락 참조와 실행 경로 검증.
- 수정 baseline hash/updated_at과 서버 최신값을 비교해 외부 Langflow 편집 충돌을 감지.
- 적용 후 Langflow에서 다시 읽어 값이 저장됐는지 확인하고, 그 flow를 실제 테스트 실행.
- 매 실행에 `pipelineVersion`, `flowId`, flow hash, 모델 설정, issueCatalogVersion, schemeCatalogVersion을 고정해 기록.
- 실행 중 flow를 수정해도 진행 중 요청에 섞이지 않도록 버전별 실행용 복제 flow 또는 검증된 불변 snapshot 실행 방식 사용.
- 저장 실패·검증 실패를 성공으로 표시하지 않는다. 브라우저 새로고침 후에도 초안/적용 버전 차이가 유지되어야 한다.

백엔드 신규 API 제안(우리 서버 API이며 Langflow 공식 경로와 구분):

```text
GET    /api/pipelines
GET    /api/pipelines/{id}
POST   /api/pipelines/{id}/clone
PUT    /api/pipelines/{id}/draft
POST   /api/pipelines/{id}/validate
POST   /api/pipelines/{id}/apply
POST   /api/pipelines/{id}/test
POST   /api/pipelines/{id}/restore
GET    /api/connections/status
```

## 5. Walton schemes 자동 생성 및 RA 편집

### 의미와 분류 원칙

쟁점은 무엇을 판단하는지, scheme은 전제에서 결론으로 어떻게 추론하는지를 나타낸다. 엑셀에는 scheme 정의가 없으므로 엑셀 분류와 Walton scheme을 일대일로 고정하지 않는다.

- 검증 가능한 출처·버전이 있는 Walton scheme 카탈로그를 준비한다. 명칭, 설명, 전제 역할, 결론 역할, critical questions를 저장한다.
- 전문가 의견, 증언, 징후, 인과관계 등의 후보는 실제 catalog 정의를 확인한 뒤 등록한다. 번역명과 원어 이름을 함께 저장한다.
- RA의 입력 전제 전체와 출력 결론, 관련 원문 근거를 바탕으로 분류한다. 요약만으로 판단하지 않는다.
- 예: 의료자료가 있다는 이유만으로 전문가 의견 scheme으로 지정하지 않는다. 실제 추론이 전문가 주장에 의존하는지 검토해야 한다.
- 적절한 scheme이 없으면 `unclassified`를 반환한다. 모든 RA에 임의의 Walton 이름을 강제하지 않는다.
- RA 구조가 규칙으로 생성된 사실과 scheme 분류가 AI 제안이라는 사실을 별도로 기록한다.

### Langflow 처리 순서

```text
판결문 + 52개 쟁점 카탈로그 + 카탈로그 버전
 → 원문 기반 세부 쟁점 자동 선택 (중복 없이 최대 3개)
 → 쟁점별 I-node 본문·근거 추출
 → 선택 개수에 맞는 Graph Builder (최대 3개 쟁점, I/RA/ISSUE 및 참조 ID 확정)
 → I-node Summary 단계
 → RA Scheme Assignment 단계
 → 구조·카탈로그·참조 검증
 → Final AIF JSON
```

AI에는 허용된 scheme ID 목록을 전달하고 결과를 스키마 검증한다. 응답을 Python `eval` 등으로 실행하지 않는다. 잘못된 ID·전제 참조는 오류 또는 미분류로 남긴다. 재시도는 제한한다. 중간 부분 결과는 완료 결과와 구분한다.

### 저장 구조 제안

RA의 `type: "RA"`와 기존 text를 유지한다. 아래는 **프로젝트 확장 스키마**이며 AIF 표준 필드라고 주장하지 않는다.

```json
{
  "nodeID": "ra-1",
  "type": "RA",
  "text": "RA",
  "schemeApplication": {
    "schemeKey": "catalog-defined-key",
    "catalogVersion": "v1",
    "status": "suggested",
    "origin": "ai",
    "rationale": "이 전제들에서 결론을 도출하는 방식에 대한 설명",
    "premiseBindings": [{"roleId": "catalog-role", "nodeIds": ["i-1", "i-2"]}],
    "conclusionNodeIds": ["i-3"],
    "criticalQuestionResponses": [],
    "notes": "",
    "customSchemeName": null
  }
}
```

- 초기에는 RA당 주 scheme 하나와 대안 후보 목록을 지원한다. 복합 추론을 자동으로 하나의 scheme에 억지로 맞추지 않는다.
- `notes`에 사용자가 scheme 적용 내용을 자유롭게 쓸 수 있도록 한다. 직접 작성한 비표준 scheme은 `custom`으로 구분한다.
- 자유 설명, 전제 역할별 노드 연결, 결론, critical questions 응답은 별도 필드로 저장한다.
- AIF `schemefulfillments`에는 검증된 외부 schemeID mapping이 있는 경우에만 `{nodeID, schemeID}`를 생성한다. 숫자 ID를 추측하지 않는다.
- 기존 외부 schemefulfillments는 보존하고 알려진 매핑을 사용해 내부 모델로 가져온다. 불명확한 항목을 덮어쓰지 않는다.
- 현재 adapter는 AIF의 기타 필드를 그대로 복사하므로 schemefulfillments의 nodeID는 자동 재매핑되지 않는다. namespace 변환 시 여기를 반드시 보완한다.
- premiseBindings/conclusionNodeIds, 관련 descriptor 참조까지 검증된 schema에 따라 변환한다. 임의 문자열 전체 치환은 금지한다.

### RA 상세 화면

RA에 `RA · scheme 짧은 이름`을 표시한다. 클릭하면 scheme 선택기, 정의, 전제·결론, 적용 이유, 자유 메모, 검토 상태가 열린다. `수정 → 저장/취소`를 제공하고 AI 원안과 사용자 수정 이력을 보존한다. 수동 생성 RA도 같은 기능을 사용한다.

RA의 전제·결론 엣지 또는 연결 I 본문이 바뀌면 기존 scheme을 지우지 말고 `재검토 필요`로 표시한다. 재분류는 사용자 수정본을 자동 덮어쓰지 않는다.

## 6. I-node 요약 표시·본문 보기·편집

사용자의 “원문(현재의 I node)”은 우선 **현재 저장된 I 노드 text 전체**로 해석한다. 판결문 전체 원본과는 구분한다.

- `text`: 현재 노드 본문. 기존 값을 그대로 이관한다.
- `summary`: 캔버스에 보여줄 짧은 요약. text를 덮어쓰지 않는다.
- `evidence`: 판결문 원본 인용과 위치. 본문과 별도로 보존한다.
- `summaryOrigin`, `summaryStatus`, `summarySourceHash`: 생성 출처와 본문 변경 여부를 추적한다.

동작:

1. 캔버스에는 summary를 표시한다. 부정·주체·조건·불확실성을 보존한 1문장 요약을 기본으로 하며 임의 절단을 AI 요약이라 표시하지 않는다.
2. 한 번 클릭 또는 키보드 Enter로 상세 패널을 열어 현재 text 전체를 보여준다. 관련 판결문 인용도 별도 영역에서 볼 수 있다.
3. 상세 패널의 `수정` 버튼을 누르면 본문과 요약을 편집한다. 저장/취소를 명시하고 blur로 자동 확정하지 않는다.
4. 기존 더블클릭 인라인 편집은 I 노드에서 제거한다. 드래그·연결·다중 선택과 상세 열기가 충돌하지 않게 한다.
5. 본문을 수정해도 판결문 전체는 바뀌지 않는다. 근거 연결과 해당 RA scheme을 재검토 대상으로 표시한다.
6. 본문 변경 시 기존 요약은 stale로 표시하고 재생성 또는 수동 편집할 수 있게 한다. 늦게 도착한 AI 요약이 최신 본문·수동 요약을 덮어쓰지 않는다.
7. summary가 없는 기존 파일은 기존 본문을 임시 표시한다. mock 문구를 채우지 않는다. 요청 시 실제 요약을 생성한다.
8. 확정 노드와 초안 노드 모두 같은 동작을 제공하고 수락·거절·undo/redo와 연동한다.

예시 확장:

```json
{
  "nodeID": "i-1",
  "type": "I",
  "text": "기존 I 노드에 저장된 전체 본문",
  "summary": "본문의 의미를 보존한 짧은 요약",
  "summaryStatus": "current",
  "issueRefs": [{"issueId": "stable-catalog-id", "instanceId": "case-issue-id"}]
}
```

## 7. 코드 변경 범위와 저장 일관성

| 위치 | 변경 |
| --- | --- |
| `frontend/src/types/argument.ts`, `annotation.ts`, `rawJson.ts` | 요약·scheme·쟁점·pipeline version 타입 |
| `frontend/src/components/Graph/nodes/INode.tsx`, `NodeShell.tsx`, `RANode.tsx` | 요약 표시, 더블클릭 변경, RA 배지 |
| `frontend/src/components/Graph/ArgumentGraph.tsx` | 선택 및 노드 데이터 전달 |
| 신규 `NodeDetails/`, `Pipeline/`, `Issues/` 컴포넌트 | 본문·scheme 편집, pipeline editor, 쟁점 선택 |
| `graphStore.ts`, `annotationStore.ts`, `reviewLogic.ts` | 새 필드의 초안/확정 동기화와 undo/redo |
| `io/importAifOva.ts`, `exportAifOva.ts` | 확장 필드 및 schemefulfillments 왕복 |
| `backend/app/schemas/models.py`, `services/aif_adapter.py` | 검증·전달·참조 ID 변환 |
| `services/langflow_client.py`, `run_manager.py` | 버전별 flow 실행, 선택 쟁점, summary/scheme 결과 |
| 신규 pipeline routes/services와 `storage/db.py` | flow 관리·버전 저장·충돌 검사 |
| `langflow/` | 52개 중 최대 3개 자동 선택 + summary + scheme flow 새 버전 |
| 신규 `catalogs/` | 52개 쟁점과 출처 있는 scheme 정의 |

특히 NodeValue가 현재 text/type/x/y만 가지므로, raw AIF 필드 추가만으로 끝내지 않는다. adapter → annotation originalValue/currentValue → 수락 그래프 → 저장 → export 전체 경로에서 보존한다.

- 프로젝트 schemaVersion 2 도입, 기존 v1을 읽을 때 summary 없음·scheme 미지정·pipeline version 불명으로 이관한다.
- 기존 프로젝트 파일과 DB를 백업한다. SQLite migration을 명시적으로 실행하고 사용자 그래프를 재생성하지 않는다.
- AIF export에서 `text`는 전체 본문이며 summary는 추가 필드다. 미검토/거절 노드의 schemefulfillments가 확정 export에 남지 않게 한다.
- 프로젝트 파일에는 쟁점·scheme catalog 버전/필요 snapshot과 실행 버전을 저장하되 API 키는 저장하지 않는다.

## 8. 구현 순서와 완료 판정

1. **기준선과 실제 연결**: 현재 프로젝트 검사를 실행하고, 기존 v9 flow를 live로 1회 실행해 response fixture를 확보한다. 입력에 따라 결과가 달라지는지 확인한다.
2. **카탈로그·데이터 계약**: 엑셀 52행 원문 보존, stable ID, scheme catalog, schema v2 및 migration 구현.
3. **I/RA 편집 UI**: summary/본문 분리 및 scheme 수동 편집을 실제 저장·재불러오기까지 연결.
4. **Langflow 출력 확장**: 원문에서 52개 중 최대 3개 쟁점 자동 선택, 요약, RA scheme 생성. 실제 모델 출력에 새 필드가 존재해야 한다.
5. **사이트 내 pipeline 편집**: 실제 flow 조회·수정·적용·재조회·실행. 동일 UI에서 노드/연결 변경까지 확인.
6. **통합 검증**: 입력 → 선택 쟁점 → 수정한 pipeline → live 출력 → 노드 수정 → 저장 → export → reimport 전체 확인.

mock 테스트만으로 완료라고 보고하지 않는다. 실제 연결 정보가 없으면 가능한 구현과 자동 검사는 진행하고, 실서버 검증 미완료를 구분해 전달한다. 스텁 타입검사만으로 프런트엔드 빌드 성공을 대신하지 않는다.

필수 테스트:

- 엑셀 8개 군/52개 항목, A/B/C 문자열 및 출처 행 일치.
- 0개·1개·2개·3개 선택 처리. 4개 이상 반환, 카탈로그 밖 ID, 중복 ID는 검증 실패로 처리하고 제한된 재시도 또는 명시적 오류를 제공. 근거 없는 선택 항목을 꾸며내지 않음.
- RA scheme 허용 ID, 전제/결론 역할 및 실제 연결 유효성.
- namespace 변환 후 schemefulfillments 및 모든 새 참조가 새 ID를 가리킴.
- summary가 text를 대체하지 않고 저장/수락/undo/export 후 유지됨.
- 본문 수정 후 stale 처리, 사용자 요약·scheme 재분석 덮어쓰기 방지.
- 파이프라인 프롬프트/모델/연결 수정이 실제 Langflow 재조회에 반영됨.
- 외부 동시 편집 충돌, 적용 실패, 이전 버전 복원, 실행 중 버전 불변성.
- v1 프로젝트 로드 및 v2 저장, 기존 미지 AIF 필드 보존.
- `npm run check`, `python run_tests.py`, 브라우저 실제 조작 검사.

## 9. 사용자가 준비할 것: 현재 버전을 실제로 실행하기

아래는 현재 코드 기준 Windows PowerShell 절차다. 기존 파일·환경이 있으면 새로 만들거나 덮어쓰기 전에 내용을 확인한다. 이 절차는 기존 분석을 live로 바꾸는 것이며 아직 미구현인 네 가지 기능을 자동으로 추가하지 않는다.

### A. Langflow와 Ollama

1. Langflow를 실행하고 접속 주소와 실제 버전을 확인한다. 기존 문서의 1.11은 작성 기준일 뿐 현재 설치 상태를 뜻하지 않는다.
2. Ollama가 실행 중이고 flow에 설정할 모델이 설치되어 있는지 `ollama list`로 확인한다. 파일의 모델명이 실제 존재한다고 가정하지 않는다. 없으면 사용 가능한 모델을 선택해 모든 해당 LLM 컴포넌트에 일관되게 설정한다.
3. Langflow에서 `C:\project\2026\AIF_Visual_Langflow\langflow\TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json`을 가져온다.
4. 각 LLM의 Ollama URL을 Langflow 실행 환경에서 접근 가능한 주소로 설정한다. Langflow가 Docker 안에서 실행되면 localhost는 Windows 호스트가 아니라 컨테이너이므로 주소를 구분한다.
5. Langflow 자체에서 테스트 판결문을 실행해 최종 출력이 JSON인지 확인한다. 커스텀 컴포넌트의 lfx import 오류나 모델 오류를 먼저 해결한다.
6. Share/API access 예제에서 실제 Flow ID, 입력/출력 컴포넌트 ID, 인증 방법을 확인한다. API 키는 로컬 설정 파일에만 기록한다.

### B. 서버 설정 위치

코드는 `C:\project\2026\AIF_Visual_Langflow\backend\.env`를 읽는다. 루트 `.env`만 편집하면 반영되지 않는다. backend/.env가 없을 때만 다음을 실행한다.

```powershell
Set-Location C:\project\2026\AIF_Visual_Langflow
Copy-Item -LiteralPath .env.example -Destination backend/.env
```

`backend/.env`에 다음 값을 설정한다(꺾쇠 항목은 실제 값으로 교체).

```dotenv
LANGFLOW_MODE=live
LANGFLOW_BASE_URL=http://localhost:7860
LANGFLOW_FLOW_ID=<가져온 flow의 실제 ID>
LANGFLOW_API_KEY=<필요한 API 키>
LANGFLOW_INPUT_COMPONENT_ID=CustomComponent-k5fj9
LANGFLOW_OUTPUT_COMPONENT_ID=ChatOutput-nL1VD
LANGFLOW_TIMEOUT_SECONDS=900
ANALYSIS_MAX_CONCURRENCY=1
```

주소·컴포넌트 ID는 실제 값이 다르면 바꾼다. 기존 셸의 환경변수가 .env보다 우선하므로 `LANGFLOW_MODE=mock` 등이 셸에 남아 있지 않은지 확인한다. 설정 변경 후 백엔드를 재시작한다.

### C. 백엔드 실행

Python 3.11 이상을 준비한다. 전용 .venv가 없다면 생성하고, 이미 있으면 재사용한다.

```powershell
Set-Location C:\project\2026\AIF_Visual_Langflow\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### D. 프런트엔드 실행 (다른 터미널)

프로젝트 문서 기준 Node 22를 준비하고 패키지의 실제 engine 요구사항도 확인한다.

```powershell
Set-Location C:\project\2026\AIF_Visual_Langflow\frontend
npm install
npm run check
npm run dev
```

터미널에 표시된 주소로 접속한다. 기본은 `http://localhost:5173`이다.

### E. mock이 아닌지 확인

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

- `langflowMode`가 live인지 확인한다. 설정 여부 true만으로 연결 성공이라고 판단하지 않는다.
- 사이트에서 테스트 판결문으로 분석을 실행하고, Langflow 실행 기록에 해당 요청이 실제로 나타나는지 확인한다.
- 서로 다른 두 입력에 각각 맞는 결과가 나오는지 확인한다.
- 오류가 나면 인증, Flow ID, 컴포넌트 ID, 모델, 응답 envelope 순으로 확인한다. 성공한 실제 응답은 민감정보를 제거한 fixture로 남긴다.

## 10. 사용자가 정하면 좋은 항목과 구현자 책임

### 사용자

- Langflow 실행 주소·버전·실제 flow ID를 준비한다. API 키는 채팅에 보내지 않는다.
- 사용할 Ollama 모델 또는 다른 LLM을 정하고 실제 구동 가능한 환경을 준비한다.
- 테스트 판결문 1–2건과 원하는 쟁점/RA scheme 예시를 제공하면 분류 품질 검증에 도움이 된다.
- 연구에서 쓰는 Walton scheme 목록·번역·기준 버전이 있으면 제공한다. 없으면 구현자가 출처 있는 초안 카탈로그를 만들되 검토 전 최종 기준이라고 표현하지 않는다.

### 구현자

- 엑셀 변환, flow 개편, API 추가, 프런트엔드 수정, AIF 변환과 모든 테스트를 수행한다.
- 사용자에게 JSON/코드를 수동으로 수정하게 하는 것으로 기능 구현을 대신하지 않는다.
- 실제 연결 성공과 분류 품질은 분리해 보고한다. JSON이 정상 출력된다고 scheme 분류가 정확한 것은 아니다.
- 완료 보고에 생성 flow 파일, 수정 파일, 실행 절차, 검사 결과, 실제 live 검증 결과, 남은 제약을 포함한다.

## 11. 참고 근거

- Langflow flow 관리 API(버전별 차이 확인 필요): https://docs.langflow.org/1.8.0/api-flows
- Langflow 실행 API: https://docs.langflow.org/api-flows-run
- AIFdb scheme 및 schemefulfillment 설명: https://www.arg.tech/index.php/research/aifbdb-user-guide/
- Walton schemes의 AIF 표현 연구: https://arg.tech/people/chris/publications/2007/cmna2007-rahwan.pdf
- 원본 쟁점 데이터: `C:\Users\tldkw\Downloads\세부 쟁점.xlsx`, `Sheet1!A1:C53`

외부 문서는 프로토콜과 개념의 근거다. 실행 환경의 API 및 실제 AIF/OVA fixture를 확인한 뒤 구현한다.
