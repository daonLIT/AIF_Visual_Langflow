# @aif/workbench

AIF 검토 화면(원문 | 논증 그래프 | AI 제안 검토)과 그 상태·도메인 로직. 독립 웹(`frontend/`)과 Langflow 포크가 **빌드 없이 소스 그대로** 가져다 쓴다.
수동으로 복사한 UI 를 따로 두지 않는다.

## 호스트가 지킬 것

```tsx
import { AifWorkbench, configureWorkbench, LanguageToggle } from '@aif/workbench';

configureWorkbench({ apiBase: '', analysis: true }); // 앱 시작 때 한 번

<div className="aif-root">            {/* 스타일은 .aif-root 아래에만 적용된다 */}
  <AifWorkbench topBar={<LanguageToggle />} />
</div>
```

- `configureWorkbench`
  - `apiBase`: 중앙 AIF API 주소 앞부분. 빈 문자열이면 같은 출처의 `/api`.
  - `credentials`: 다른 출처를 쿠키로 부를 때 `'include'`.
  - `analysis`: 사이트에서 분석을 시작하는 버튼(Langflow 안에서는 끈다).
  - `sampleUrl`: 예제 사건 주소. 기본은 `fixtures/sample-case.json`.
- 세부 모듈은 `@aif/workbench/<경로>`(예: `@aif/workbench/store/graphStore`). 호스트 번들러에 별칭을 둔다.
  - 웹: `frontend/vite.config.ts`, `frontend/tsconfig.app.json`
  - Langflow: 포크 `vite.config.mts`
- React·react-dom 은 호스트 것 하나만 쓴다(peer). Langflow 는 `resolve.dedupe` 로 React·React Flow 를 자기 것으로 맞춘다. zustand·elkjs 는 이 저장소 루트 `node_modules` 것(npm workspaces).
- 상태(store)는 모듈 전역 zustand 다. 한 화면에 워크벤치는 하나만 띄운다.
- 단축키(undo/redo/Esc)와 미저장 경고는 `AifWorkbench` 가 떠 있는 동안만 건다.

## 스타일

`src/workbench.css` 의 모든 규칙은 `:where(.aif-root) …` 로 감싸 원래 우선순위를 유지한 채 AIF 영역에만 적용된다.
`html`·`body`·`#root` 같은 문서 전역 규칙은 호스트가 가진다(웹: `frontend/src/host.css`).
Langflow 의 React Flow 전역 규칙(`!important` 포함)은 포크 패치에서 `.aif-root` 안을 제외한다.

## 검사

`frontend` 의 `npm run check`(build · lint · 스모크 4종)가 이 패키지까지 검사한다. 스모크 테스트는 `.tmp-smoke/` 에 CommonJS 로 컴파일되어 돈다.
