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
