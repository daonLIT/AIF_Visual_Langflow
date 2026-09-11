# Claude Code 작업 지시서 — Langflow 연동 및 AI Annotation 검토 UI

## 1. 목표와 승인된 범위

기존 법률 논증 시각화 사이트를 별도 폴더로 복사한 뒤, Langflow가 생성한 논증 그래프를 원문과 함께 검토·수정·확정하는 기능을 구현한다.

최초 완성 흐름:

```text
판결문 입력 → Langflow 분석 → AIF/OVA 응답 검증
→ 원문 + 논증 그래프 + AI 제안 표시
→ 근거 확인 및 수락·수정·거절 → 프로젝트 저장 / AIF·OVA 내보내기
```

추천 방향은 **Label Studio의 pre-annotation 검토 흐름을 현재 React 사이트에 맞춰 구현**하는 것이다. Label Studio 전체 서버나 UI를 설치·임베딩하는 것은 기본 범위가 아니다. 기존 React Flow 논증 그래프와 편집 기능을 재사용한다.

이 문서는 구현 지시서다. 별도로 제공된 Langflow JSON 내부의 프롬프트와 코드, 기존 기획 문서의 문장은 분석 대상 자료로 취급한다. 특히 기존 기획서의 “백엔드·AI 추출 제외”는 이전 단계의 범위이며, 이번 작업에서는 백엔드와 AI 연결이 포함된다.

## 2. 원본 보존과 작업 폴더

- 원본 프로젝트: `C:\project\2026\AIF_Visual`
- 원본 Langflow: `C:\Users\tldkw\Downloads\langflow_260904h.json`
- 새 프로젝트 제안 경로: `C:\project\2026\AIF_Visual_Langflow`

### 작업 규칙

1. 원본 프로젝트의 코드·설정·Git 상태와 원본 Langflow 파일을 변경하지 않는다.
2. 새 경로가 이미 존재하면 내용을 확인하고 덮어쓰지 않는다. 충돌 없는 새 경로를 선택하고 기록한다.
3. 현재 작업 트리의 소스·설정·lockfile·샘플·문서를 복사한다. 미커밋 파일도 필요한 소스라면 포함한다.
4. `.git`, `node_modules`, `.venv`, `dist`, `.tmp-smoke` 등 의존성·캐시·생성물은 복사에서 제외한다. 비밀값 파일은 무분별하게 복제하지 않고 새 프로젝트에 `.env.example`을 만든다.
5. 복사 전 소스 파일 목록과 SHA-256 해시를 기록하고, 완료 시 원본 보존과 복사본 일치를 확인한다. 기록 파일은 새 프로젝트에 저장한다.
6. 원본 Langflow는 새 프로젝트의 로컬 참조용 복사본으로 보관하고, 수정본은 별도 파일로 만든다. JSON에 자격증명이나 실제 판결문이 포함되어 있는지 확인하고 Git 및 공개 배포에서 제외한다.
7. 새 폴더의 독립 환경에서 설치·실행·테스트한다. 새 Git 저장소가 필요하면 해당 폴더에만 초기화하며, 원본 저장소에 커밋하지 않는다.
8. 실행 환경의 파일 쓰기 권한이 새 폴더를 허용하지 않으면 필요한 권한만 요청한다. 권한 제한을 우회해 원본 내부에 구현하지 않는다.

현재 요청으로 작성된 이 계획 문서 외에 기존 애플리케이션 파일은 수정되지 않았다.

## 3. 사전 분석 결과

아래는 2026-09-11 소스 및 JSON 정적 분석 결과다. 구현 시작 시 실제 파일과 설치 버전을 다시 확인한다. 실제 Langflow 서버 연결, 모델 실행, 응답 시간, 추출 품질은 아직 검증하지 않았다.

### 기존 프런트엔드

- React 19, TypeScript, Vite
- `@xyflow/react` 기반 논증 그래프
- Zustand 상태 관리, ELK 자동 배치
- 노드 타입: `I`, `RA`, `CA`, `ISSUE`
- AIF/OVA 가져오기·내보내기 및 미지 필드 보존
- 원문 검색, 문장 선택으로 I 노드 생성, 쟁점별 탐색
- 노드·엣지 편집, 구조 검증, undo/redo
- 백엔드·DB 없음

주요 재사용 파일(원본 프로젝트 기준):

```text
frontend/src/App.tsx
frontend/src/store/graphStore.ts
frontend/src/types/argument.ts
frontend/src/types/rawJson.ts
frontend/src/io/importAifOva.ts
frontend/src/io/exportAifOva.ts
frontend/src/validation/graphValidator.ts
frontend/src/components/JudgmentPanel/JudgmentPanel.tsx
frontend/src/components/Graph/ArgumentGraph.tsx
frontend/scripts/smokeTest.ts
```

기존 importer는 일부 잘못된 노드를 건너뛰거나 타입을 정규화한다. 따라서 AI 응답 검증은 importer 호출 전에 엄격하게 수행하여 잘못된 결과를 조용히 확정하지 않는다.

### Langflow 구조

- Flow 이름: `TopDown_Judgment_to_AIF_3Issue_v8_ClaimScopeTuned`
- JSON에 기록된 Flow ID: `8d8dfc1c-70f9-48c4-ae0c-1f9fd5e6531d`
- 노드 13개, 연결 20개
- 커스텀 입력: `CustomComponent-k5fj9`, 필드 `value`
- 그래프 조립: `CustomComponent-Ljw10`
- 최종 Chat Output: `ChatOutput-nL1VD`
- Ollama 호출 컴포넌트 5개, 파일에 기록된 모델명 `gemma4:e4b-it-qat`

```text
Judgment JSON Input
  → Main Claim LLM
  → Issue Decomposer LLM
  → Issue 1 / 2 / 3 I-node LLM
  → Top-Down AIF Graph Builder
  → Final AIF JSON
```

주의: 재가져오기 후 Flow ID가 바뀔 수 있다. 파일에 기록된 값이 실제 서버에서 유효하다고 가정하지 않는다. 컴포넌트 확장과 모델 설치 여부도 확인한다.

### 확인된 보완점

| 현재 상태 | 구현 방침 |
| --- | --- |
| 일반 Chat Input이 아닌 커스텀 입력 | `tweaks`의 컴포넌트 `value` 필드로 입력 전달 |
| 출력 `text`가 사건 ID 또는 기본 문구 | 제출 원문을 서버가 보존하고 화면·저장 데이터에 사용 |
| 노드 ID 날짜 접미사 `20260903190000` 고정 | 실행별 namespace 적용, AIF/OVA와 참조를 일관되게 변환 |
| 쟁점 정확히 3개를 요구 | 최초 연결에서는 유지하고 UI·README에 제약 명시 |
| 원문 위치·근거 인용 정보 없음 | 수정 flow에 근거 정보를 추가하고 서버에서 위치 검증 |
| RA는 코드의 고정 규칙으로 생성 | `rule` 출처로 기록하고 관계 검토 지원 |
| CA 자동 생성 없음 | 수동 편집 지원 유지, 자동 생성은 후속 범위 |
| LLM 설정에 timeout 0 기록 | 실제 의미 확인 후 서버에 명시적인 실행 제한 설정 |

## 4. UI 참고 자료와 도입 결정

### 채택: Label Studio 방식

모델 결과를 사람이 검토·수정하는 pre-annotation 패턴을 적용한다. AI 초안과 확정 annotation을 분리하고, 원문 근거와 그래프를 함께 보여준다.

- 저장소: https://github.com/HumanSignal/label-studio
- pre-annotation 자료: https://github.com/HumanSignal/label-studio/blob/develop/docs/source/guide/troubleshooting.md

### 보조 참고

- doccano: 간단한 텍스트 범위 선택·라벨 편집 UI
  - https://github.com/doccano/doccano
  - https://doccano.github.io/doccano/advanced/auto_labelling_config/
- INCEpTION: 원문에 연결된 추천 annotation 검토 방식
  - https://github.com/inception-project/inception

위 제품 전체를 의존성으로 추가하지 않는다. 실제 외부 코드나 자산을 재사용한다면 선택한 버전의 파일별 라이선스 및 고지 요구사항을 확인하고 출처를 남긴다. 공개판과 유료판의 기능을 혼동하지 않는다.

## 5. 권장 아키텍처

```text
React UI
  ↕ 같은 출처의 /api (개발 중 Vite proxy)
FastAPI 중계 서버
  ↕ 인증된 Langflow API
Langflow → Ollama
```

### 서버 책임

- Langflow 주소·API 키·Flow ID를 환경변수로 관리한다. 브라우저 번들에 비밀값을 넣지 않는다.
- 원문, 요청 ID, 문서 버전을 저장하여 결과가 어떤 입력에서 생성되었는지 추적한다.
- Langflow 호출·상태 관리·응답 파싱·스키마 검증·ID 변환을 담당한다.
- 실행 및 검토 데이터는 로컬 SQLite에 보존하는 구성을 기본으로 한다. 브라우저 프로젝트 파일 내보내기도 지원한다.
- 판결문 본문·API 키를 일반 로그에 기록하지 않는다. 필요한 진단은 실행 ID와 오류 코드 중심으로 남긴다.
- 초기 서비스는 로컬 실행 기준이다. 로그인·협업·외부 공개 배포는 범위에 포함하지 않는다.

### API 초안

| 메서드 / 경로 | 동작 |
| --- | --- |
| `GET /api/health` | 중계 서버 상태 |
| `POST /api/analysis-runs` | 판결문·문서 버전 제출, `202`와 run ID 반환 |
| `GET /api/analysis-runs/{runId}` | queued/running/succeeded/failed/cancelled 및 결과 조회 |
| `POST /api/analysis-runs/{runId}/cancel` | 로컬 실행 취소 및 이후 응답 반영 차단 |
| `PUT /api/projects/{projectId}` | 검토 상태를 포함한 프로젝트 저장, revision 검사 |
| `GET /api/projects/{projectId}` | 저장한 프로젝트 불러오기 |

중복 요청 키를 지원해 더블클릭으로 동일한 분석이 중복 실행되지 않게 한다. 초기에는 실행 동시성을 제한해 Ollama 자원 경합을 방지한다. 서버 재시작 시 진행 중이던 실행은 중단 상태로 복구한다. 로컬 취소가 Langflow/Ollama 계산 중단까지 보장하지 않는 경우 UI와 README에 정확히 표시한다.

### Langflow 호출

공식 문서: https://docs.langflow.org/concepts-publish

우선 설치 버전의 API 문서 또는 Langflow가 생성한 API 예제로 확인한다. v1 run endpoint를 초기 기준으로 사용하되, 실제 호환성을 검증한다.

```text
POST {LANGFLOW_BASE_URL}/api/v1/run/{LANGFLOW_FLOW_ID}
x-api-key: 서버 환경변수 값
```

입력 매핑의 핵심:

```json
{
  "output_type": "chat",
  "tweaks": {
    "CustomComponent-k5fj9": {
      "value": "사용자가 제출한 판결문 원문"
    }
  }
}
```

이 예시는 입력 매핑 설명용이다. `input_type`, `input_value`, 출력 선택 등 나머지 필드의 필요 여부는 설치 버전의 실행 예제에서 확인한다. `input_value`만 전달하고 커스텀 입력이 바뀔 것으로 가정하지 않는다.

최종 출력 컴포넌트를 명시적으로 식별해 Message의 JSON을 파싱한다. 임의의 첫 번째 텍스트 응답을 결과로 선택하지 않는다. 실제 응답 fixture를 확보하고 버전별 envelope 차이를 adapter에서 처리한다. 코드 펜스가 허용되는 경우 외곽 펜스만 제거하고 JSON 파서를 사용한다. `eval`은 사용하지 않는다.

단계별 이벤트가 제공되지 않으면 UI에는 “분석 중”과 경과 시간을 보여준다. 완료율이나 개별 LLM 단계 진행도를 임의로 만들어 표시하지 않는다.

## 6. Annotation 데이터 계약

기존 AIF/OVA 구조와 노드 타입은 유지한다. 검토 데이터는 명시적 버전이 있는 프로젝트 형식으로 저장하고, 기존 AIF/OVA 내보내기를 별도로 제공한다.

권장 프로젝트 구조:

```text
schemaVersion
projectId / revision
document: id, text, hash, version
acceptedGraph: AIF/OVA 호환 그래프
analysisRuns: 실행 정보 및 원본 제안
annotations: 제안·근거·검토 상태
reviewEvents: 사용자 변경 이력
```

Annotation 필드:

- `id`, `runId`, `nodeId` 또는 `edgeId`
- `origin`: `ai | rule | human`
- `status`: `pending | accepted | modified | rejected`
- `originalValue`, `currentValue`
- `evidence[]`: 원문 `quote`, `start`, `end`, 문서 버전, 매칭 상태
- `createdAt`, `updatedAt`

근거 범위는 반개구간 `[start, end)`으로 정의한다. UI와 서버의 문자열 인덱스 차이를 방지하기 위해 **UTF-16 code unit 기준**으로 통일하고 Python 변환 함수를 둔다. 한국어뿐 아니라 이모지·결합 문자도 테스트한다.

- 원문은 줄바꿈·공백을 포함해 그대로 보존한다.
- LLM에는 정확한 근거 인용문을 요청하고 서버에서 실제 위치를 확인한다.
- 위치가 하나로 확정되지 않으면 자동 확정하지 않고 `ambiguous` 또는 `unmatched`로 표시한다.
- 노드의 요약 문장 자체가 원문과 동일하다고 가정하지 않는다.
- 여러 근거 범위를 허용한다. 모든 RA/ISSUE 노드에 단일 원문 span을 강제하지 않는다.
- 원문이 수정되면 문서 버전을 올리고 이전 근거 연결을 재검토 대상으로 전환한다.
- 현재 flow에는 신뢰도 점수가 없으므로 임의의 백분율을 표시하지 않는다.

처음에는 기존 flow 결과로 최소 연결을 완성하고, 이후 복제 flow의 prompt와 builder 양쪽을 함께 바꿔 근거 필드를 보존한다. 하위 노드를 문자열에서 객체로 바꾸면 builder도 이에 맞춰 수정해야 한다.

## 7. UI 요구사항

```text
[판결문 입력] [AI 분석] [실행 상태] [프로젝트 저장] [AIF/OVA 내보내기]

┌─────────────────┬────────────────────┬─────────────────┐
│ 판결문 원문      │ 논증 그래프         │ AI 제안 검토     │
│ 검색·범위 선택   │ 기존 편집 기능      │ 미검토 필터      │
│ 근거 하이라이트  │ 초안/확정 표시      │ 근거 인용문      │
│ 수동 근거 연결   │ 쟁점별 탐색         │ 수락·수정·거절   │
└─────────────────┴────────────────────┴─────────────────┘
```

### 필수 동작

1. TXT 업로드 또는 붙여넣기로 판결문을 입력한다. 기존 AIF/OVA 불러오기 기능도 유지한다.
2. 분석 결과는 초안 레이어에 표시하고 기존 확정 그래프를 자동으로 덮어쓰지 않는다.
3. 제안 카드·노드·원문 근거 선택을 양방향으로 동기화한다.
4. 상태는 색뿐 아니라 텍스트 배지로도 구분한다.
5. 검토 패널에서 수락·수정 후 수락·거절·미검토 복귀를 제공한다.
6. 노드와 관계의 의존성을 함께 검토한다. 엣지 수락 시 양 끝 노드가 유효해야 하며, 필요한 RA와 전제가 없는 불완전 구조는 경고한다.
7. 전체 수락은 그래프 검증 결과와 근거 미확인 항목을 확인한 뒤 수행할 수 있게 한다.
8. 원문 드래그로 만든 수동 노드는 텍스트뿐 아니라 실제 선택 범위도 저장한다.
9. 검토 변경과 그래프 변경의 undo/redo를 일관되게 처리한다.
10. 창 너비가 좁으면 검토 패널을 접거나 탭으로 전환한다. 키보드 접근과 포커스 표시를 제공한다.

### 재분석과 데이터 보존

- 기존 사람 편집은 유지하고 새 run을 별도 제안으로 만든다.
- 같은 원문이라도 실행 ID를 구분한다.
- 원문·그래프가 바뀐 뒤 도착한 이전 응답은 현재 결과에 자동 반영하지 않는다.
- 최초 버전에서는 전체 재분석과 명시적 비교·반영을 지원한다. 쟁점 하나만 재실행하는 기능은 후속 범위다.
- 확정 결과 내보내기에 거절·미검토 제안이 섞이지 않게 한다.
- AIF/OVA 내보내기 시 원래 미지 필드를 보존하고, 프로젝트 저장에는 검토 이력까지 포함한다.

## 8. 권장 새 프로젝트 구조

```text
AIF_Visual_Langflow/
  frontend/                  # 기존 프런트엔드 복사본
    src/api/
    src/components/Analysis/
    src/components/Annotation/
    src/types/annotation.ts
    src/store/annotationStore.ts
  backend/
    app/
      main.py
      routes/
      services/langflow_client.py
      services/aif_adapter.py
      services/evidence_matcher.py
      schemas/
      storage/
    tests/
    pyproject.toml
  langflow/
    README.md
    # 원본 참조본 및 수정본은 민감정보 확인 후 관리
  docs/
    implementation-plan.md
    source-manifest.json
    verification.md
  .env.example
  .gitignore
  README.md
```

구조는 구현 중 조정할 수 있지만, 서버 통신·응답 변환·근거 매칭을 UI 컴포넌트에서 분리한다. 기존 graphStore와 annotationStore를 나눌 경우 저장·undo 단위를 중앙 action으로 묶어 불일치를 방지한다.

## 9. 단계별 구현 및 완료 기준

### 단계 1 — 복사와 기준선

- 원본 파일 해시와 Git 상태 기록, 새 폴더 복사.
- 새 폴더에서 기존 build·lint·smoke 실행.
- 기존 오류가 있으면 새 변경으로 발생한 오류와 구분해 기록.

완료 기준: 기존 사이트가 새 폴더에서 동작하고 원본 파일이 변경되지 않았다.

### 단계 2 — 최소 Langflow 연결

- FastAPI, 환경변수 예시, Vite proxy 구현.
- API 요청 및 응답 adapter, 실행 상태, 오류 UI 구현.
- 원문 보존과 실행별 ID 변환 구현.
- 실제 Langflow 응답 fixture를 확보하고 기존 그래프로 표시.

완료 기준: 판결문 1건을 실제 Langflow에 보내 그래프를 표시한다. 실서버 정보가 없으면 mock 검증과 실제 검증 미완료를 명확히 구분한다.

### 단계 3 — 근거 annotation

- 복제 flow에 근거 인용문 출력 추가.
- 서버 원문 매칭 및 범위 검증 구현.
- 원문 하이라이트와 그래프 선택 연결.

완료 기준: 근거가 있는 제안은 해당 위치로 이동하고, 불명확한 근거는 확인 필요 상태로 남는다.

### 단계 4 — 검토와 저장

- 수락·수정·거절, 필터, 의존 관계 검증 구현.
- SQLite 저장, 프로젝트 파일 저장·불러오기, AIF/OVA export 구현.
- undo/redo 및 재분석 시 사람 수정 보존 구현.

완료 기준: 새로고침과 프로젝트 재불러오기 후 원문·그래프·검토 상태·이력이 유지된다.

### 단계 5 — 최종 검증과 전달

- 기존 검사와 추가 통합 테스트 실행.
- 브라우저에서 실제 UI 흐름과 좁은 화면 확인.
- README에 설치·실행·환경변수·Langflow 가져오기·알려진 제약 기록.
- 원본 해시 비교 결과와 실제 검증 범위를 전달.

## 10. 필수 검증 시나리오

- 기존 샘플 AIF/OVA import → 편집 → export → reimport.
- 커스텀 입력 tweak에 실제 제출 원문이 전달되는지 확인.
- 결과 `text`에 사건 ID가 아닌 원문이 유지되는지 확인.
- 두 실행 결과 병합 시 노드·엣지·OVA 참조 충돌 없음.
- 잘못된 JSON, 누락 필드, 중복 ID, 존재하지 않는 노드 참조 차단.
- Langflow 인증 실패·서버 연결 실패·타임아웃 시 사용자 편집 유지.
- 중복 제출, 취소 후 늦은 응답, 원문 수정 후 이전 응답 처리.
- 동일 문장이 여러 번 나오는 원문, 줄바꿈, 한국어, 이모지 범위 매칭.
- 거절한 제안은 확정 export에서 제외, 필요한 관계 없이 수락할 때 검증 동작.
- 수락·수정·거절의 undo/redo 및 저장 후 재불러오기 일치.
- 브라우저 번들과 로그에 API 키가 포함되지 않음.
- 원본 프로젝트와 원본 Langflow 파일 해시 유지.

기존 프런트엔드 검사 명령:

```bash
npm run build
npm run lint
npm run smoke
```

서버는 의미 있는 adapter·근거 매칭·실행 상태·저장 왕복 테스트를 추가한다. mock 테스트 통과만으로 실제 Langflow 연동 완료라고 보고하지 않는다.

## 11. 후속 범위

- 쟁점 수 가변화 및 쟁점별 재실행
- CA 자동 추출
- 논증 스킴·Walton·Critical Questions
- PDF/OCR annotation
- 로그인·다중 사용자·협업
- 외부 서비스 배포
- 검토 데이터를 이용한 모델 재학습

## 12. 작업 시작 시 필요한 환경 정보

우선 로컬 설정과 사용 가능한 실행 환경에서 확인한다. 확인할 수 없으면 다음 값만 사용자에게 요청하고, 독립적으로 가능한 구현·mock 검증은 진행한다.

- Langflow 실행 주소 및 설치 버전
- 복제 flow를 가져온 뒤의 실제 Flow ID
- API 키 설정 방식: 서버 환경변수 또는 로컬 비밀값 파일 사용
- Ollama 접근 가능 여부와 필요한 모델 설치 여부

비밀키를 채팅에 붙여 넣도록 요구하지 않는다. 기존 원본을 수정하거나 공개 배포하는 것은 이 지시서의 승인 범위가 아니다.

## 13. Claude Code 최종 보고 형식

1. 실제 생성한 새 프로젝트 경로
2. 구현된 기능과 실행 방법
3. 실제 Langflow 연동 성공 여부 및 사용한 환경
4. 통과한 검사와 미검증 항목
5. 원본 보존 확인 결과
6. 남아 있는 제약 또는 사용자가 설정할 값

전체 계획을 다시 설명하는 것으로 작업을 끝내지 말고, 환경이 허용하는 범위에서 구현과 검증을 완료한다. 환경 정보가 없어 실서버 검증을 못 한 경우 그 경계를 정확히 보고한다.
