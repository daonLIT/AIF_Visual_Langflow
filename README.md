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
langflow/   원본 참조본(저장소 제외) · 근거 출력이 추가된 수정 flow (v9)
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

`backend/.env` 가 있으면 서버가 시작할 때 읽습니다(이미 설정된 환경변수는 덮어쓰지 않음).

### 2. 프런트엔드 (Node 22)

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173  (/api 는 Vite proxy 로 127.0.0.1:8000 에 전달)
```

백엔드 포트를 바꿨다면 `VITE_API_TARGET=http://127.0.0.1:포트 npm run dev` 로 지정합니다.

## 환경변수 (`backend/.env`)

| 이름 | 설명 |
| --- | --- |
| `LANGFLOW_MODE` | `mock`(기본) 또는 `live`. mock 은 `backend/fixtures/langflow_run_response.sample.json` 을 돌려줍니다. |
| `LANGFLOW_BASE_URL` | Langflow 주소 (예: `http://localhost:7860`) |
| `LANGFLOW_FLOW_ID` | 복제 flow 를 가져온 뒤 Langflow 화면/API 예제에서 확인한 **실제** Flow ID. JSON 파일의 ID 를 그대로 쓰지 마세요. |
| `LANGFLOW_API_KEY` | Langflow API 키. 서버에만 두고 브라우저·채팅에 넣지 않습니다. |
| `LANGFLOW_INPUT_COMPONENT_ID` | 커스텀 입력 컴포넌트 ID (기본 `CustomComponent-k5fj9`) |
| `LANGFLOW_OUTPUT_COMPONENT_ID` | 최종 Chat Output ID (기본 `ChatOutput-nL1VD`) |
| `LANGFLOW_TIMEOUT_SECONDS` | 서버 측 실행 제한(초). flow 의 Ollama `timeout=0` 은 무제한이므로 여기서 제한합니다. |
| `ANALYSIS_MAX_CONCURRENCY` | 동시 실행 수 (기본 1) |
| `DATABASE_PATH` | SQLite 경로 (기본 `backend/data/annotation.sqlite3`) |

## Langflow 가져오기

1. Langflow(1.11 기준) 화면에서 `langflow/TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json` 을 import 합니다.
2. Ollama 가 실행 중이고 `gemma4:e4b-it-qat` 모델이 설치되어 있는지 확인합니다 (5개 LLM 컴포넌트 공통).
3. 가져온 flow 의 실제 Flow ID 를 `LANGFLOW_FLOW_ID` 에 넣고 `LANGFLOW_MODE=live` 로 바꿉니다.
4. `GET /api/health` 로 `flowIdConfigured`, `apiKeyConfigured` 가 true 인지 확인합니다.

중계 서버는 `POST {LANGFLOW_BASE_URL}/api/v1/run/{FLOW_ID}` 에 다음을 보냅니다.

```json
{
  "input_type": "chat", "output_type": "chat",
  "input_value": "{\"case_id\": \"...\", \"judgment\": \"원문\"}",
  "output_component": "ChatOutput-nL1VD",
  "tweaks": { "CustomComponent-k5fj9": { "value": "{\"case_id\": \"...\", \"judgment\": \"원문\"}" } }
}
```

원본 flow(v8)도 그대로 동작합니다(근거 인용 없이 노드 문장으로 원문 위치를 찾고 `문장 매칭` 으로 표시). 자세한 내용은 `langflow/README.md`.

## 사용 흐름

1. **판결문 입력** — TXT 업로드 또는 붙여넣기. 줄바꿈·공백은 그대로 보존됩니다.
2. **AI 분석** — 상태(대기/분석 중/완료/실패)와 경과 시간을 표시합니다. 단계별 진행률은 flow 가 제공하지 않으므로 표시하지 않습니다. 취소는 서버의 대기·반영을 멈추지만 Langflow/Ollama 계산까지 중단하지는 못합니다.
3. **검토** — 오른쪽 패널의 제안 카드(AI/규칙/사람 · 미검토/수락/수정 수락/거절 텍스트 배지). 카드 ↔ 그래프 노드 ↔ 원문 근거가 양방향으로 동기화됩니다.
   - 수락 / 수정 후 수락 / 거절 / 미검토로 되돌리기
   - 관계(엣지)는 양 끝 노드가 확정되어야 수락됩니다. “노드와 함께 수락” 으로 의존 제안을 같이 처리합니다.
   - 근거: 원문 일치 / 공백 차이 일치 / 위치 불명확(후보 선택) / 원문에 없음 / 수동 지정 / 재검토 필요. 원문을 드래그해 “이 제안의 근거로 연결”.
   - “미검토 전체 수락…” 은 구조 검증 예상과 근거 미확인 수를 보여준 뒤 실행됩니다.
4. **저장** — 프로젝트 메뉴 → 서버에 저장(revision 검사) / 파일로 저장 / 열기. **AIF/OVA 내보내기** 는 확정 그래프만 포함합니다.
5. **재분석** — 기존 편집은 유지되고 새 실행은 별도 제안으로 들어옵니다. 원문이 바뀐 뒤 도착한 결과는 자동 반영되지 않고 “제안으로 불러오기” 로만 반영됩니다.

키보드: `Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y` undo·redo(그래프 편집과 검토 변경 공통), `Esc` 선택 해제, 카드·근거 하이라이트는 Tab 으로 이동 가능. 창 너비 1100px 미만에서는 [판결문 | 그래프 | 검토] 탭으로 전환됩니다.

## 검사

```bash
cd backend && python run_tests.py         # 또는 pytest
cd frontend && npm run check              # build + lint + smoke + smoke:annotation + smoke:store
```

## 데이터 형식

프로젝트 파일(`*.project.json`, `schemaVersion: 1`):

```text
projectId / revision / title
document: { id, text, hash(sha256), version, caseId }
acceptedGraph: AIF/OVA (확정 항목만, 미지 필드 보존)
analysisRuns[]: 실행 기록 (runId, status, documentHash, namespace, mode, error, summary)
annotations[]: { id, runId, kind, nodeId|edgeId, origin(ai|rule|human), status(pending|accepted|modified|rejected),
                 originalValue, currentValue, evidence[{quote,start,end,match,documentVersion}], createdAt, updatedAt }
reviewEvents[]: 사용자 변경 이력
```

근거 범위는 반개구간 `[start, end)`, **UTF-16 code unit** 기준입니다(서버는 `textindex.py` 로 변환).

## 알려진 제약

- flow 는 쟁점을 정확히 3개로 요구합니다. 쟁점 수가 다르면 실패하거나 합쳐질 수 있습니다(가변화는 후속 범위).
- CA(반박) 노드는 자동 생성되지 않습니다. 수동 편집으로 추가하세요.
- 신뢰도 점수가 없으므로 백분율을 표시하지 않습니다.
- 취소는 로컬 취소입니다(Langflow/Ollama 계산은 계속될 수 있음).
- 서버 재시작 시 진행 중이던 실행은 `interrupted` 로 표시됩니다.
- 원문 교체를 undo 하면 텍스트와 근거는 되돌아가지만 문서 버전 번호는 유지됩니다.
- 로그인·협업·외부 배포는 범위 밖입니다. CORS 는 `localhost:5173` 만 허용합니다.
- 실제 Langflow/Ollama 연동은 아직 검증되지 않았습니다(`docs/verification.md`).
