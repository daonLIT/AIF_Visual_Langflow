# 검증 기록 (2026-09-11)

구현·검증은 Anthropic 클라우드 작업 환경(Linux, Python 3.11, Node 22)에서 수행했고, 결과물은 사용자 PC 의
`C:\project\2026\AIF_Visual_Langflow` 로 복사했습니다. 이 환경에서는 `registry.npmjs.org`, `pypi.org` 접근이
네트워크 정책(403)으로 막혀 있어 **npm/pip 설치가 불가능**했습니다. 그에 따라 검증 범위가 아래처럼 나뉩니다.

## 1. 클라우드에서 통과한 검사

| 검사 | 결과 |
| --- | --- |
| `backend/run_tests.py` (unittest 36개) | 통과. 근거 매칭(한국어·이모지·결합문자·줄바꿈·중복 문장), adapter 검증(잘못된 JSON·누락 필드·중복 ID·존재하지 않는 참조 차단), envelope 추출(출력 컴포넌트 지정, 다른 형태), tweaks 입력 매핑, 실행 상태(성공·중복 키·취소 후 늦은 응답 폐기·인증/연결/타임아웃 실패·잘못된 결과·재시작 복구·동시성 제한), 프로젝트 저장/불러오기·revision 충돌·hash 검사, 응답에 API 키 미포함 |
| 실제 `uvicorn` 기동 후 `POST /api/analysis-runs` → 폴링 → `succeeded` (mock) | 통과. 노드 23 / 엣지 22, ID namespace 부여, `text` 에 제출 원문 보존, 서버 로그에 판결문 텍스트 없음 |
| Langflow v9 수정본 생성 (`langflow/make_evidence_flow.py`) + builder 코드 로컬 실행(lfx 스텁) | 통과. 문자열/객체 입력 모두 처리, `evidence` 출력, 서버 adapter 검증 통과, 수정본에 판결문 텍스트 없음 |
| 프런트엔드 타입검사 (전역 TypeScript 6.0 + 최소 스텁: react / @xyflow/react / zustand / elkjs) | 통과 (`tsc --noEmit`). 단, `@types/react` 가 없어 이벤트 핸들러 인자 타입은 검사되지 않음 |
| `scripts/annotationSmoke.ts` (검토 순수 로직, 43개 확인) | 통과. 근거 매칭, 제안 불러오기·중복 거부, 엣지 의존성, 수정 후 수락, 연쇄 거절, 미검토 복귀, 전체 수락 미리보기, export 에 미검토·거절 제외, 재import 왕복, 원문 변경 시 재매칭, 하이라이트 분할 |
| `scripts/storeSmoke.ts` (스토어 통합, zustand/elkjs 런타임 shim) | 통과. 수락 → undo → redo, 그래프 편집(텍스트 수정·삭제)이 검토 상태에 반영 + undo, 사람 노드의 선택 범위 저장, 프로젝트 파일 왕복(원문·그래프·검토 상태·이력·문서 버전 유지), 원문 교체 시 문서 버전 증가·근거 stale |

## 2. 사용자 PC 에서 실행해야 하는 검사 (클라우드에서 미실행)

```bash
cd frontend && npm install && npm run check     # build + lint + smoke + smoke:annotation + smoke:store
cd backend && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && python run_tests.py
```

- `npm run build` / `npm run lint` — 기준선(복사 직후)과 변경 후 모두 미실행. 실제 `@types/react` 와 ESLint(react-hooks v7) 규칙으로 처음 확인되는 것이므로, 오류가 나오면 새 코드 원인인지 확인이 필요합니다.
- 브라우저 UI 흐름(판결문 입력 → 분석 → 카드/노드/원문 동기화 → 수락·수정·거절 → 저장 → 새로고침 후 불러오기), 좁은 화면 탭 전환, 키보드 포커스 — 미확인.
- 기존 샘플 AIF/OVA import → 편집 → export → reimport (`npm run smoke`) — 로직은 바뀌지 않았지만 새 폴더에서 재실행 필요.

## 3. 실제 Langflow 연동 — 미검증

사용자 지시에 따라 mock 으로 진행했습니다. 실서버 검증에 필요한 값: Langflow 주소·버전, 가져온 v9 flow 의 실제 Flow ID,
API 키(`backend/.env`), Ollama 와 `gemma4:e4b-it-qat` 설치 여부. `LANGFLOW_MODE=live` 로 바꾼 뒤 판결문 1건으로
`succeeded` 가 나오는지, 응답 envelope 가 `extract_output_text` 가 처리하는 형태인지 확인해야 합니다. 첫 실제 응답은
`backend/fixtures/` 에 저장해 회귀 테스트에 쓰는 것을 권장합니다. 실제 모델의 근거 인용 품질·응답 시간도 미검증입니다.

## 4. 원본 보존

- `docs/source-manifest.json` — 복사 전 원본 40개 파일의 SHA-256. 복사 완료 후 원본을 다시 읽어 해시가 같은지 확인했습니다(결과는 최종 보고 참고).
- 원본 프로젝트(`C:\project\2026\AIF_Visual`)에는 이번 작업으로 어떤 파일도 쓰지 않았습니다. 원본 Langflow JSON 은 참조본으로만 복사했습니다.
- 새 프로젝트에는 Git 저장소를 초기화하지 않았습니다(필요하면 새 폴더에서만 `git init`).

## 5. 계획서 대비 차이

| 항목 | 상태 |
| --- | --- |
| FastAPI | Starlette 로 구현(설치 불가). 라우트·동작 동일 |
| 단계 1 기준선 build/lint/smoke | 클라우드에서 미실행 → 사용자 PC |
| 실서버 fixture | mock fixture 는 builder 규칙으로 생성한 합성 응답. 실제 응답 fixture 는 아직 없음 |
| 쟁점별 재실행, CA 자동 추출, 쟁점 수 가변화 | 후속 범위 그대로 |

---

# v2 검증 기록 (2026-09-14, 브랜치 feature/langflow-v2)

작업 계획: `claude_code_langflow_v2_implementation_plan.md` (파일이 4절 중간에서 끝나 있어, 스킴·I 노드·검증 절은 1절 범위와 2절 표를 기준으로 구현).

## 변경 전 기준선 (commit b971be4)

| 검사 | 결과 |
| --- | --- |
| backend `python run_tests.py` | 36개 통과 |
| frontend `npm run build` | 통과 |
| frontend `npm run lint` | 기존 오류 3개 (storeSmoke 미사용 변수, AnalysisStatus `Date.now` purity, JudgmentInputDialog 보이지 않는 문자) |
| frontend smoke / smoke:annotation / smoke:store | 통과 |

## 변경 후

| 검사 | 결과 |
| --- | --- |
| backend `python run_tests.py` | 81개 통과 (카탈로그 변환·ID 유지, flow 컴포넌트 로직, v10 adapter, 파이프라인 모델·적용·복원·비밀값·Langflow REST 가짜 서버, 설정·범위 검증) |
| frontend `npm run check` | build · lint(기존 3개 포함 0개) · smoke · smoke:annotation · smoke:store · smoke:v2(49개 확인) 통과 |
| `python langflow/make_v10_flow.py` | Langflow 1.11 설치본 lfx 로 컴포넌트 template 생성, 두 프롬프트의 변수 추출·f-string 렌더 성공. `--offline` 재생성 결과 동일 |
| mock 서버 실제 기동 + Vite 프록시 경유 API | 범위 3개 분석(검출 2 / 미검출 1), 파이프라인 복제 → 검증 → 적용(temperature 0.1→0.25) → 백업 버전 복원(0.1), 연결 확인(Langflow mock·Ollama 응답) |
| 브라우저(Chrome) 조작 | 분석 범위 대화상자, 요약 노드·스킴 배지, 노드 클릭 상세·[수정] 편집, RA 스킴 변경 저장, 파이프라인 탭 flow 열기·프롬프트 변수 추가·서버 검증. 콘솔 오류 없음. 발견한 표시 문제(상세 패널 겹침, 주 버튼 hover, 캔버스 컨트롤 버튼, 스킴 변경 시 CQ 답 유지, fixture 쟁점 ID 한 칸 어긋남)는 수정 후 재확인 |

## 실제 Langflow 연동 (2026-09-14, Langflow Desktop 1.11.0 + Ollama gemma4:e4b-it-qat)

| 확인 | 결과 |
| --- | --- |
| 가져온 v10 flow 검증 | 가져오면서 컴포넌트 ID 가 바뀜(`CustomComponent-k5fj9`→`CustomComponent-uSeaI`, `ChatOutput-nL1VD`→`ChatOutput-GMRiP`). `.env` 의 두 ID 를 바꾼 뒤 검증 오류 0. 이후 검증 메시지가 후보 ID 를 안내하도록 수정 |
| 분석 실행 (프로덕션 flow, 샘플 판결문 1,424자, 52개 범위) | 성공, 약 10분. 노드 40 / 관계 39 / 쟁점 5(ISS-007·009·015·027·028), 근거 인용 25개 모두 원문 일치, 요약 25/25, 스킴 15/15, 경고 없음 |
| 프로덕션 보호 | 적용 요청 409 `PRODUCTION_PROTECTED`, 프로덕션 `updated_at` 변화 없음 |
| 작업용 복제 → 검증 → 적용 | 복제 flow 생성, 적용 후 Langflow API 로 변경 확인, Langflow 버전 스냅샷 v1 생성, 오래된 기준 시점 적용은 409 `CONFLICT` |
| 컴포넌트 재구성 `/api/v1/custom_component` | 성공 (Judgment Splitter 출력 3개 재생성) |
| 컴포넌트 목록 `/api/v1/all` | Prompt Template, Chat Input/Output, Text Input/Output, Custom Component 수신 |
| 백업 버전 복원 | Langflow 에서 원래 값으로 되돌아감 확인 |
| 적용·복원을 거친 작업용 flow 로 테스트 실행 | 성공, 약 7분. 노드 31 / 쟁점 4, 스킴 12(기타 2), 근거 원문 일치 15 / 원문에 없음 4 |
| 연결 확인 | Langflow 1.11.0 응답, 분석 flow 검증 오류 0, Ollama 모델 7개 |

관찰(코드 문제 아님): 두 실행 모두 주 주장으로 "피고인을 징역 3년에 처한다."(주문)를 골랐고, 폭행 관련 쟁점이 ISS-027 과 ISS-028 로 겹쳐 나왔습니다.
Main Claim·Issue Detector 프롬프트 조정 대상입니다. 짧은 샘플도 7~10분이 걸려, 긴 판결문은 `LANGFLOW_TIMEOUT_SECONDS=900` 을 넘을 수 있습니다.

## 아직 확인하지 않은 것

- 긴 실제 판결문에서의 소요 시간·컨텍스트 한계(`context_limit` 경고) 동작.
- 브라우저에서 live 모드로 [Langflow 에 적용] 버튼을 누르는 전체 조작(같은 API 는 위에서 확인).
- 발견 사항: v9 flow 의 I-node 프롬프트 3개는 단일 중괄호 JSON 예시 때문에 Langflow 가 `{"text"}` 를 변수로 해석합니다(실행 시 실패 가능).

---

# 계획서 전체본 기준 재작업 검증 (2026-09-14)

사용자가 계획서 전체본(363줄)을 저장한 뒤 그 내용대로 다시 구현했습니다. 위 v10 기록은 이전 계약(사용자 사전 범위 선택, `scheme` 필드) 기준이며,
이번 재작업으로 **쟁점 자동 선택(최대 3개) · `schemeApplication` · 요약 메타 · 파이프라인 재조회 확인·실행 버전 고정** 계약으로 바뀌었습니다.

## 자동 검사

| 검사 | 결과 |
| --- | --- |
| backend `python run_tests.py` | 94개 통과 (0~3개 선택·4개/카탈로그 밖/중복 거부·재시도, 요약 stale, scheme 참조 검증·namespace 변환·schemefulfillments 규칙, DB 마이그레이션·백업, 적용 재조회 불일치 `APPLY_NOT_VERIFIED`, 해시 충돌, 실행용 스냅샷 고정, 실제 live 응답 fixture 계약) |
| frontend `npm run check` | build · lint · smoke · smoke:annotation · smoke:store · smoke:v2 통과. smoke:v2 는 v11 결과 왕복, 프런트·서버 본문 해시 일치, 본문 수정 → 요약 stale·근거/RA 재검토, 쟁점 최대 3개, 늦게 도착한 AI 요약 거부, 검증 규칙 11·12·14·15·16, 마이그레이션, flow 차이 계산·초안 상태 확인 |
| `python langflow/make_v11_flow.py` | Langflow 1.11 설치본 lfx 로 컴포넌트 template 생성 (11개 컴포넌트 / 20개 연결) |

## 실제 Langflow 연동 (Langflow Desktop 1.11.0 + Ollama gemma4:e4b-it-qat)

| 확인 | 결과 |
| --- | --- |
| v11 flow 가져오기 (API) | 새 flow `dfdc515a-…` 생성, 컴포넌트 ID 유지. Langflow 코드 검사 포함 서버 검증 오류 0. `.env` 의 `LANGFLOW_FLOW_ID`·입출력 ID 를 이 flow 로 변경 |
| 연결 확인 `/api/connections/status` | langflow · analysis_flow · flow_contract(v11 단계) · ollama · ollama_models · catalogs 모두 정상 (v10 flow 를 가리킬 때는 flow_contract 실패로 표시됨을 먼저 확인) |
| 첫 live 실행 2건 | **실패** — Issue Selector: "Issue catalog is empty". Langflow 실행 기록(transactions)에서 원인 확인: tweak 으로 넣은 JSON 문자열의 `\n` 이스케이프가 컴포넌트에 실제 줄바꿈으로 전달되어 엄격한 `json.loads` 가 실패하고 입력 전체가 평문 판결문으로 취급됨. 모든 컴포넌트와 서버 결과 파싱을 `strict=False` 로 바꾸고 회귀 테스트 추가, flow 재생성 후 Langflow 에 반영(재조회로 확인) |
| 샘플 판결문(1,424자, 합성) | 성공, 약 8분. 세부 쟁점 3개(ISS-007 핵심 진술의 일관성 · ISS-028 폭행·협박의 정도 · ISS-015 통화·문자·위치자료), 노드 25 / 관계 24, 요약 16/16 current, scheme 9 (미분류 0, 오류 0), flow 검증 통과, 실행용 스냅샷 flow 로 실행·해시 기록. ISS-028 은 선택 근거 인용이 원문과 맞지 않아 "근거 없음/미검출" 경고 |
| 두 번째 판결문(1,006자, 구현자가 만든 합성 무죄 판결: DNA 전이·인상 진술·기지국) | 성공, 약 7분. **다른 결과**: 세부 쟁점 2개(ISS-005 혼합·전이 가능성 · ISS-013 객관·다른 진술과의 부합) — 3개를 채우지 않는 경로가 실제 모델 출력에서 동작. 노드 21, 근거 인용 15개 모두 원문 일치, scheme 6 (오류 0), 경고 없음. 응답을 `backend/fixtures/langflow_run_response.live_v11.json` 으로 저장(비밀 값 없음 확인) |
| 파이프라인 통합 (API) | v11 작업용 복제 → Main Claim 프롬프트에 규칙 추가 → 초안 저장·재조회 시 차이(변경 1) 표시 → 틀린 기준 해시로 적용 409 `CONFLICT` → 올바른 기준으로 적용: 백업 버전 생성, 재조회 해시 = 보낸 해시(`verified: true`), 초안 삭제 → 같은 요청으로 테스트 실행 성공(실행 기록에 작업용 flow 이름·해시·실행용 스냅샷 ID 고정). 두 번째 판결문의 주 주장이 주문의 "…무죄."에서 이유 결론 "…무죄를 선고한다."로 바뀜 |
| 브라우저(Chrome) 조작 | live 결과 프로젝트 열기: 세부 쟁점 선택 보고(선택 2/3·이유·실행 버전), `RA · 짧은 이름` 배지, RA 상세(정의·적용 이유·역할별 전제·CQ·대안 후보). I 노드 [수정]으로 본문 변경 → 요약 "본문 변경됨", 근거 재검토 표시, 연결 RA 2개 "재검토 필요". [AI 요약 다시 생성](live) → 새 요약 "AI 요약 · 최신". 서버 저장 후 저장본에 요약 메타·근거 재검토·RA 이력 확인. 파이프라인 탭: 필드 편집 → 초안 자동 저장 표시 → 새로고침 후 같은 flow 를 열면 초안과 차이가 복원됨 |

## 품질 관찰 (연결 성공과 별개)

- 연결·JSON 계약은 정상이지만 분류 품질은 사람이 검토해야 합니다. 같은 판결문도 실행마다 선택 쟁점 수가 달라질 수 있습니다(두 번째 판결문: 2개 → 프롬프트 수정 후 3개).
- scheme 적용 이유 문장에 모델 입력용 별칭(`N3` 등)이 섞여 나오는 경우가 있습니다(Scheme Assigner 프롬프트 조정 대상).
- 한 전제 노드를 두 역할에 동시에 묶는 등 역할 배정이 느슨한 경우가 있습니다. 서버는 참조 유효성만 검증합니다.
- Walton scheme 카탈로그는 검토 전 초안입니다.

## 아직 확인하지 않은 것

- 긴 실제 판결문에서의 소요 시간(2000초 제한)·컨텍스트 한계.
- 브라우저에서 [Langflow 에 적용…] 대화상자를 끝까지 누르는 조작(같은 API 흐름은 위에서 live 로 확인).
- AIF/OVA 내보내기 파일 다운로드 후 재가져오기의 브라우저 조작(같은 로직은 smoke 테스트로 확인).
