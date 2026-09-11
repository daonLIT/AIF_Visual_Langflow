# Legal Argument Graph Viewer

법적 판결문 분석에 특화된 논증 그래프 뷰어/에디터. 브라우저에서만 동작하며 백엔드·DB·로그인이 없다.

```
JSON 불러오기 → AIF/OVA 파싱 → 판결문 + 논증 그래프 렌더 → 노드/엣지 편집 → 구조 검증 → JSON 내보내기
```

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
```

| 스크립트 | 설명 |
| --- | --- |
| `npm run dev` | 개발 서버 |
| `npm run build` | 타입 체크 + 프로덕션 빌드 |
| `npm run lint` | ESLint |
| `npm run sample` | 예제 판결문 JSON 재생성 (`public/sample/sample-case.json`) |
| `npm run smoke` | import → 편집 → 검증 → export → 재import 왕복 테스트 |

## 사용법

- **JSON 불러오기** — 프로젝트 JSON 파일 선택. **예제 열기** 로 동봉된 예제(노드 37 / 엣지 39 / 쟁점 4)를 바로 열 수 있다.
- **노드 추가** — 그래프 캔버스 우클릭 → I / RA / CA / ISSUE. I·ISSUE 는 텍스트를 입력받는다.
- **판결문에서 노드 추가** — 왼쪽 판결문에서 문장을 드래그 선택하면 `+ I 노드 만들기` 버튼이 뜬다. 엣지는 자동으로 만들지 않는다.
- **텍스트 편집** — 노드 더블클릭 → 인라인 편집. `Ctrl+Enter` 저장, `Esc` 취소.
- **엣지 생성** — 전제 노드의 **위쪽 핸들**에서 결론 노드의 **아래쪽 핸들**로 드래그. (`fromID → toID` 방향 그대로)
- **삭제** — 노드/엣지 선택 후 `Delete`, 또는 우클릭 메뉴.
- **쟁점 이동** — 왼쪽 쟁점 목록 클릭 시 해당 ISSUE 노드로 이동하고, 그 쟁점에 이르는 하위 논증만 강조된다. 다시 클릭하거나 캔버스 빈 곳을 클릭하면 해제.
- **자동 정렬** — ELK 계층형 레이아웃(아래 전제 → 위 결론). 좌표가 없는 파일은 불러올 때 자동 실행된다.
- **되돌리기/다시 실행** — `Ctrl+Z` / `Ctrl+Shift+Z`.

## 데이터 규약

- `AIF.edges` 의 `fromID → toID` 는 화면에서도 `source → target` 으로 그대로 유지된다. 표시 편의를 위한 방향 반전은 하지 않는다.
- `ISSUE` 는 이 프로젝트 고유 확장 타입이며, 내부 모델과 export 양쪽에서 `"ISSUE"` 로 유지된다.
- 내보내기는 **불러온 원본 JSON 을 base 로** 노드/엣지/좌표만 갱신한다. 앱이 다루지 않는 필드(`schemefulfillments`, `participants`, `locutions` 등)와 최상위 미지 필드는 그대로 보존된다.
- 새 노드 ID: `{sequence}_{YYYYMMDDHHmmss}`. 새 엣지 ID: `max(기존) + 1` (세션 내 삭제된 ID 재사용 안 함).

## 검증 규칙

| 코드 | 내용 | 수준 |
| --- | --- | --- |
| RULE 01 | 엣지가 존재하지 않는 노드를 참조 | error |
| RULE 02 | 자기 자신을 가리키는 엣지 | error |
| RULE 03 | `I → I` 직접 연결 (`I → RA → I` 여야 함) | error |
| RULE 04 | RA 에 들어오는 엣지 없음 | error |
| RULE 05 | RA 에서 나가는 엣지 없음 | error |
| RULE 06 | CA 의 in/out 이 각각 1개 미만 | error |
| RULE 07 | 고립 노드 | warning |
| RULE 08 | 중복 nodeID | error |
| RULE 09 | 중복 edgeID | error |
| RULE 10 | 불러온 파일의 OVA/AIF 불일치 | warning |

## 구조

```
src/
├── App.tsx                  2분할 레이아웃 + 상태바
├── components/
│   ├── Toolbar/             불러오기 / 화면맞춤 / 자동정렬 / 검증 / undo-redo / 내보내기
│   ├── JudgmentPanel/       판결문 표시·검색·선택, 쟁점 네비게이터
│   ├── Graph/               React Flow 캔버스, I·RA·CA·ISSUE 커스텀 노드, 컨텍스트 메뉴
│   └── Validation/          검증 결과 패널 (항목 클릭 시 해당 노드로 이동)
├── store/graphStore.ts      Zustand. 단일 진실원본 + undo/redo
├── io/                      importAifOva.ts / exportAifOva.ts
├── layout/elkLayout.ts      ELK 계층형 레이아웃 (direction: UP)
├── validation/              graphValidator.ts
├── types/                   argument.ts (내부 모델) / rawJson.ts (원본 JSON)
└── utils/                   generateNodeId.ts / generateEdgeId.ts
```

## 이번 단계에서 제외한 것

Node Info/Inspector 패널, 논증 스킴(Walton) 및 Critical Questions, `schemefulfillments` 편집, 로그인, 협업, DB, 백엔드 API, AI 추출, PDF 주석, 실시간 동기화.

## Langflow 연동 · 검토 UI 추가분 (AIF_Visual_Langflow)

```text
src/api/client.ts                     /api 호출 (Vite proxy → backend)
src/types/annotation.ts               제안·근거·실행·프로젝트 파일 타입 (backend schemas 와 대응)
src/utils/evidence.ts                 근거 매칭(TS, 서버와 같은 규칙) · DOM 선택 → UTF-16 범위 · 하이라이트 분할
src/store/graphStore.ts               확정 그래프 + annotations 를 같은 undo/redo 히스토리로 관리
src/store/reviewLogic.ts              수락/수정/거절/미검토/전체 수락/의존성 (순수 함수)
src/store/annotationStore.ts          검토 UI 상태, 분석 실행·폴링·취소, 프로젝트 저장/불러오기
src/components/Analysis/              판결문 입력 대화상자, 실행 상태
src/components/Annotation/            제안 카드·패널·전체 수락 대화상자
src/components/JudgmentPanel/         근거 하이라이트, 수동 근거 연결, 선택 범위 저장
src/components/Graph/                 초안 레이어(점선 노드/엣지), 상태 배지, 컨텍스트 메뉴 수락/거절
scripts/annotationSmoke.ts            검토 로직 스모크 (npm run smoke:annotation)
scripts/storeSmoke.ts                 스토어 undo/redo · 프로젝트 왕복 스모크 (npm run smoke:store)
```

`npm run check` 로 build · lint · smoke 세 가지를 한 번에 실행합니다.
