# AIF_Visual_Langflow 구현 상태 (2026-09-11)

`claude_code_langflow_annotation_plan.md` 를 구현한 결과 요약. 새 프로젝트: `C:\project\2026\AIF_Visual_Langflow` (원본 `AIF_Visual` 은 변경 없음, 40개 파일 SHA-256 일치 확인).

## 구성
- `backend/` Starlette 중계 서버 (FastAPI 대신 — 클라우드 환경에서 pip 설치 불가). `/api/health`, `/api/analysis-runs`(+cancel), `/api/projects`(revision 검사), `/api/evidence/verify`. Langflow 호출은 tweaks 로 `CustomComponent-k5fj9.value` 에 `{"case_id","judgment"}` JSON 전달, 출력은 `ChatOutput-nL1VD` 만 사용. 응답 엄격 검증 → 실행별 namespace ID 변환 → `text` 에 원문 보존 → 근거 매칭(UTF-16 인덱스). SQLite 저장. mock 모드 기본.
- `frontend/` 기존 뷰어 + 3열 레이아웃(원문 | 그래프 | AI 제안 검토). 초안 레이어(점선 노드), 카드↔노드↔근거 하이라이트 양방향 동기화, 수락/수정 후 수락/거절/미검토, 엣지 의존성 검사, 전체 수락 확인 대화상자, 수동 근거 연결(선택 범위 저장), undo/redo 통합(graphStore 히스토리에 annotations 포함), 프로젝트 저장(서버/파일), AIF/OVA 내보내기(확정만), 재분석 시 사람 편집 보존·원문 변경 후 도착한 결과는 수동 반영, 좁은 화면 탭.
- `langflow/TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json` 근거 인용(evidence_quote) 출력 추가 수정본. 원본 참조본은 .gitignore.

## 검증
- 통과: backend unittest 36개, uvicorn 실제 기동 E2E(mock), TS 타입검사(스텁), 검토 로직 smoke 43개, 스토어 smoke(undo/redo·프로젝트 왕복).
- 미실행(사용자 PC 필요): `npm install && npm run check` (build/lint/smoke), 브라우저 UI 확인.
- 미검증: 실제 Langflow/Ollama 연동 (`LANGFLOW_MODE=live`, Flow ID, API 키 필요).

## 남은 값
`backend/.env`: LANGFLOW_BASE_URL, LANGFLOW_FLOW_ID(가져온 v9 flow 의 실제 ID), LANGFLOW_API_KEY. 자세한 내용은 새 프로젝트의 README.md / docs/verification.md.