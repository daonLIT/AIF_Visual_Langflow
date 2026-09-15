# Langflow flow

| 파일 | 설명 |
| --- | --- |
| `original_langflow_260904h.json` | 원본 `TopDown_Judgment_to_AIF_3Issue_v8_ClaimScopeTuned` 의 로컬 참조 복사본. 입력 컴포넌트에 실제 판결문 예시가 들어 있어 **`.gitignore` 로 저장소에서 제외**됩니다. 자격증명(API 키)은 포함되어 있지 않습니다(Ollama `api_key` 는 빈 값). |
| `TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json` | 근거 인용 출력이 추가된 수정본. `make_evidence_flow.py` 로 원본에서 생성합니다. 샘플 판결문은 placeholder 로 교체되어 있습니다. |
| `make_evidence_flow.py` | 수정본 생성 스크립트 (프로젝트 루트에서 `python langflow/make_evidence_flow.py`). |
| `TopDown_Judgment_to_AIF_v11_Top3Issues.json` | 52개 세부 쟁점 중 최대 3개 자동 선택 · 쟁점별 I-node · 요약 · RA scheme · 결과 검증 flow. `make_v11_flow.py` 로 v9 에서 생성합니다. |
| `make_v11_flow.py` | v11 생성 스크립트. Langflow 설치본의 Python(lfx)으로 커스텀 컴포넌트 template 을 만들고 프롬프트를 실제 f-string 렌더링으로 검사합니다. 결과는 `components/_built_nodes.json` 에 캐시되어 Langflow 없이도 재생성(`--offline`)됩니다. |
| `components/*.py` | v11 커스텀 컴포넌트 코드. 백엔드 테스트(`tests/test_flow_components.py`)가 lfx 스텁으로 직접 실행해 검증합니다. |
| `tools/build_component_nodes.py` | Langflow Python 에서 실행되는 template 생성 보조 스크립트. |

## v11 구조 (계획서 5절 처리 순서)

```text
API Text Input ─▶ 0. Judgment Splitter ─┬▶ 1. Main Claim Prompt ─▶ 1. Main Claim LLM ─┐
 {case_id, judgment, issue_catalog(52),  │                                             │
  scheme_catalog, catalog versions}      ├▶ 2. Issue Selector (최대 3개) ◀─────────────┤
                                         ├▶ 3. Issue Branch Extractor ◀── selection ───┤
                                         └────────────▶ 4. AIF Graph Builder ◀─────────┘
                                                              └▶ 5. Node Summarizer ─▶ 6. Scheme Assigner ─▶ 7. Result Validator ─▶ Final AIF JSON
```

- **Issue Selector**: 판결문 전체와 52개 카탈로그(JSON lines)를 읽고 법원이 실제로 판단한 세부 쟁점을 **중복 없이 최대 3개** 고릅니다.
  항목마다 `issue_id`, 사건별 쟁점 문장, `selection_reason`, 원문 그대로의 `evidence_quote` 를 반환합니다. 근거 있는 항목이 없으면 0개와 사유.
  4개 이상·카탈로그 밖 ID·중복·빈 이유는 검증 실패로 보고 오류 내용을 알려 주며 제한된 횟수(`retries`)만 재시도하고, 끝내 실패하면 `status: invalid` 로 명시합니다.
  카탈로그의 비교·판단 기준은 분류 참고 정보이며 지시로 따르지 않도록 프롬프트에 적었습니다. 상위 쟁점군 8개 중에서 고르는 것이 아닙니다.
- **Issue Branch Extractor**: 선택된 쟁점 수만큼만(최대 3회) Ollama 를 호출해 상위/하위 I-node 본문과 근거 인용을 추출합니다.
  선택이 0개이거나 invalid 이면 건너뜁니다. 쟁점별 실패는 `status: failed` 로 남기고 조용히 잘라내지 않습니다.
- **AIF Graph Builder**: 선택 개수에 맞춰 ISSUE(`issueRef{issueId, instanceId, selectionReason}`) · I · RA 와 참조 ID 를 확정합니다.
  `no_issues` 는 그래프 없이 사유만, `invalid` 는 오류만 출력합니다. 이 단계에서는 요약·scheme 을 만들지 않습니다.
- **Node Summarizer**: I/ISSUE 본문을 묶어서 요약하고 `summary`, `summaryOrigin: ai`, `summaryStatus: current`, `summarySourceHash`(본문 FNV-1a 해시)를 붙입니다.
  요약하지 못한 노드는 채워 넣지 않고 `meta.summaries.missing` 에 보고합니다.
- **Scheme Assigner**: RA 마다 전제 노드 전체·결론 노드·근거를 보여 주고 허용된 scheme key 중 하나 또는 `unclassified` 를 고르게 합니다.
  응답은 스키마 검증만 하고 실행하지 않으며, 허용되지 않은 key·역할·노드 참조·질문 ID 는 오류로 남기고 미분류로 둡니다. `schemeApplication.origin: ai`, `status: suggested`.
  한 전제를 두 역할에 넣으면 오류로 알려 재시도하게 하고, 끝내 고치지 않으면 처음 역할만 남깁니다. 설명·CQ 답·대안 이유에 섞인 모델 입력용 별칭(R1, N2…)은
  그 그룹에 실제로 준 별칭만 지웁니다. 프롬프트는 구조·근거 규칙만 두고 법리 해석(어떤 scheme 이 법적으로 맞는지)은 넣지 않습니다.
- **Result Validator**: 구조, 세부 쟁점 ≤3·카탈로그·중복, RA 전제/결론, 바인딩 참조, 요약 해시를 확인해 `meta.validation` 에 기록합니다. 오류가 있으면 `status: invalid`.
- 중계 서버(`aif_adapter.py`)는 같은 제약을 다시 검증하고 노드 ID namespace 를 바꾸면서 `premiseBindings` / `conclusionNodeIds` / schemefulfillments·descriptor 항목의 nodeID 도 함께 바꿉니다.
- 커스텀 컴포넌트는 Langflow 의 Ollama 컴포넌트가 아니라 컴포넌트 안에서 Ollama `/api/chat`(`format: json`)을 직접 호출합니다. 모델·온도·컨텍스트·timeout 은 각 컴포넌트 필드입니다.
- 프롬프트 템플릿(Langflow f-string)의 JSON 예시는 `{{ }}` 로 이스케이프했습니다.
- **Langflow 1.11 실측**: API tweak 으로 넣은 JSON 문자열의 `\n` 이스케이프가 컴포넌트에는 실제 줄바꿈으로 전달됩니다.
  그래서 컴포넌트의 JSON 파싱은 문자열 안의 제어 문자를 허용(`strict=False`)합니다. 엄격하게 파싱하면 입력 전체가 판결문 평문으로 취급되어 카탈로그가 빈 값이 됩니다.

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
- Main Claim LLM 의 `timeout=0` 은 무제한을 뜻하므로 서버 `LANGFLOW_TIMEOUT_SECONDS`(기본 2000초)로 제한
- 커스텀 컴포넌트가 없는 Langflow 버전에서는 `lfx` import 가 실패할 수 있음 (1.11.0 에서 작성됨)
- 첫 실제 실행의 응답 envelope 를 `backend/fixtures/` 에 저장해 두면 adapter 회귀 테스트에 쓸 수 있습니다.
