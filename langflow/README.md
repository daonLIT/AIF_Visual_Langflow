# Langflow flow

| 파일 | 설명 |
| --- | --- |
| `original_langflow_260904h.json` | 원본 `TopDown_Judgment_to_AIF_3Issue_v8_ClaimScopeTuned` 의 로컬 참조 복사본. 입력 컴포넌트에 실제 판결문 예시가 들어 있어 **`.gitignore` 로 저장소에서 제외**됩니다. 자격증명(API 키)은 포함되어 있지 않습니다(Ollama `api_key` 는 빈 값). |
| `TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json` | 근거 인용 출력이 추가된 수정본. `make_evidence_flow.py` 로 원본에서 생성합니다. 샘플 판결문은 placeholder 로 교체되어 있습니다. |
| `make_evidence_flow.py` | 수정본 생성 스크립트 (프로젝트 루트에서 `python langflow/make_evidence_flow.py`). |

## v9 변경 내용

1. **프롬프트** — Main Claim, Issues, 3개의 I-node 프롬프트가 각 명제마다 원문에서 그대로 복사한 `evidence_quote` 를 함께 내도록 요구합니다.
   - Main Claim: `{case_id, main_claim, evidence_quote}`
   - Issues: `issues[].{issue_no, text, evidence_quote}`
   - I-node: `upper_i_node` / `lower_i_nodes[]` 항목이 `{text, evidence_quote}` 객체
2. **Graph Builder** — 문자열(v8)과 객체(v9) 입력을 모두 받아 AIF 노드에 `evidence: [{"quote": "..."}]` 를 붙입니다. 하위 노드가 문자열에서 객체로 바뀌었으므로 builder 도 함께 수정되어 있습니다.
3. 프롬프트 안의 예시 문장(실제 사건 문장)을 중립적인 예시로 교체했습니다.
4. flow id / name / description / tags 갱신. 컴포넌트 ID(`CustomComponent-k5fj9`, `ChatOutput-nL1VD`)는 유지되어 중계 서버 기본 설정과 맞습니다.

노드 ID 접미사(`20260903190000`)는 builder 에 그대로 두고 **중계 서버가 실행별 namespace 로 다시 부여**합니다.
결과 `text` 의 사건 ID 도 서버가 제출 원문으로 바꿉니다.

## 가져오기 뒤 확인할 것

- 가져온 flow 의 실제 Flow ID (파일의 ID 와 다를 수 있음) → `LANGFLOW_FLOW_ID`
- Ollama 주소(`http://localhost:11434`)와 모델 `gemma4:e4b-it-qat` 설치 여부
- 5개 LLM 컴포넌트의 `timeout=0` 은 무제한을 뜻하므로 서버 `LANGFLOW_TIMEOUT_SECONDS` 로 제한
- 커스텀 컴포넌트가 없는 Langflow 버전에서는 `lfx` import 가 실패할 수 있음 (1.11.0 에서 작성됨)
- 첫 실제 실행의 응답 envelope 를 `backend/fixtures/` 에 저장해 두면 adapter 회귀 테스트에 쓸 수 있습니다.
