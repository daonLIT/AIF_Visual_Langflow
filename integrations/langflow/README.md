# Langflow 안의 AIF 화면: 포크·전용 Desktop 셸

지시서: `docs/claude-code-langflow-aif-port.md`. 이 폴더는 Langflow 포크를 고정 버전으로 만들고, 그 화면을 네이티브 창에 띄우는 도구를 둔다.

```text
integrations/langflow/
  patches/             Langflow v1.11.0 프런트엔드에 적용하는 AIF 변경 (git diff, P0·P1 누적)
  build-fork.ps1       고정 태그 체크아웃 → 패치 적용 → npm ci → 빌드
  start-langflow-p0.ps1 포크 빌드를 화면으로 제공하는 Langflow 서버 (별도 포트·설정·DB)
  desktop-shell/       전용 Desktop 셸 (Electron, 별도 앱 ID·데이터 경로)
  .profile/            실험용 Langflow 설정·DB·로그 (git 제외)
vendor/langflow-fork/  포크 체크아웃 (git 제외, build-fork.ps1 이 만든다)
```

## P0 결과 (2026-09-21)

### 공식 Desktop 조사 (읽기 전용)

| 항목 | 관측 |
|---|---|
| 런처 | `C:\Program Files\Langflow\Langflow .exe`, Tauri 2.11.2 (exe 문자열의 crate 경로), 앱 ID `com.LangflowDesktop`, WebView2 |
| 런처 버전 | WebView2 인자 `--webview-exe-version=1.11.0` |
| Python 패키지 | `langflow 1.11.0`, `langflow-base 0.11.0`, `lfx 1.11.0` (`/api/v1/version` 도 1.11.0) |
| 서버 실행 | `langflow.exe run --port 7860 --no-open-browser --backend-only` |
| 화면 출처 | 런처 exe 에 내장된 정적 파일(`https://tauri.localhost`). exe 안에 `assets/index-*.js` 192개. 파이썬 패키지의 `langflow/frontend` 빌드(185개)와 해시가 다름 |
| `localhost:7860/` | 404. `--backend-only` 라서 파이썬 서버는 화면을 제공하지 않음 |
| 사용자 설정 | 런처가 `.env` 를 읽어 서버 환경변수로 넘김. `LANGFLOW_HOST/PORT/CONFIG_DIR/DESKTOP` 등은 덮어쓸 수 없음 |
| 런처 소스 | `langflow-ai/langflow` v1.11.0 트리에 Tauri/desktop 소스 없음. 조직 공개 저장소 중 런처 소스로 보이는 것은 없고 `desktop-updates`(배포 메타데이터)만 있음 |

### 판단

- **경로 A (공식 Desktop + 사용자 지정 프런트엔드): 불가.** `LANGFLOW_FRONTEND_PATH`/`--frontend-path` 는 파이썬 서버의 정적 파일만 바꾼다. 공식 Desktop 은 서버를 `--backend-only` 로 띄우고 창은 exe 에 내장된 화면을 읽으므로, 이 설정이 서버에 전달되더라도 창에는 반영되지 않는다. 바꾸려면 설치된 exe 를 손으로 고쳐야 하는데, 지시서가 금지하고 업데이트 때 되돌아간다.
- **경로 B (전용 Desktop 셸 + 포크 프런트엔드): 네이티브 창에서 동작 확인.** 공식 런처 소스가 없으므로 별도 셸을 만든다. 이 PC 에 Rust 가 없어 P0 셸은 Electron 으로 만들었다. Tauri 로 바꾸려면 Rust 와 MSVC Build Tools 설치가 필요하다.

### 경로 B 검증 기록

- 포크: `langflow-ai/langflow` 태그 `v1.11.0` = `562e5f2d6feeb52a28dfa647e63a1a620fcee334`, `src/frontend` 만 sparse 체크아웃.
- 변경: 헤더에 `AIF` 버튼, `/aif/check` 라우트(`CustomRoutesStorePages` 확장점), `AifIntegrationCheckPage`. 지금은 P1 변경과 함께 `patches/0001-aif-langflow-host.patch` 에 들어 있다.
- 마지막 빌드(`build-fork.ps1`): 표식 `aif lf-v1.11.0@562e5f2 20260921T081609Z`, `build/index.html` sha256 앞 16자 `c0f5d436777362c6`, 빌드 전체 파일 해시 `fdae534eaf511e1b`. 표식에 시각이 들어가므로 빌드할 때마다 달라진다.
- 서버: 공식 Desktop venv 의 `langflow.exe` (1.11.0)을 실행만 함. 포트 7870, 설정·DB 는 `.profile/`. 공식 Desktop(7860)과 그 데이터는 건드리지 않았고, 점검 중에도 7860 은 계속 응답했다.
- 셸: Electron 38.2.0, 데이터 경로 `%APPDATA%\com.aif.LangflowDesktop`.
- 자동 점검(`AIF_SHELL_PROBE=1`)을 실제 Electron 창에서 4회 실행했고 모두 통과했다. 점검 항목은 `/flows` 로드 → 헤더 AIF 클릭 → `/aif/check`(빌드 표식·호스트 `aif-desktop-shell` 확인) → 새로고침 → Flow 목록 복귀 → 재시작 뒤 localStorage 표식 유지(2 → 4 → 6 → 8).
  - 1·2회: 이미 떠 있는 7870 서버에 붙음.
  - 3·4회: 셸이 `start-langflow-p0.ps1` 로 서버를 직접 띄우고, 종료할 때 자식 프로세스까지 정리함(7870 응답 없음, 남은 프로세스 없음 확인). 4회는 `build-fork.ps1` 로 다시 만든 빌드.
- P1 부터 헤더 `AIF` 는 검토 화면(`/aif`)으로 가고, P0 점검은 `/aif/check` 를 주소로 연다. P1 빌드로 다시 돌린 P0 점검도 통과(재시작 표식 10).
- 확인하지 않은 것: 사람이 직접 하는 드래그·줌·키보드 조작, 기존 Flow 를 가져와서 편집·실행하는 것(테스트 DB 는 비어 있음), 설치 패키지 형태로 배포.

### 원복

- 포크·셸 실험을 모두 지우려면 `vendor/`, `integrations/langflow/.profile/`, `%APPDATA%\com.aif.LangflowDesktop` 를 삭제한다.
- 공식 Desktop 설치 폴더, `%APPDATA%\com.LangflowDesktop`, `%LOCALAPPDATA%\com.LangflowDesktop` 는 바꾸지 않았다.

## P1 결과 (2026-09-21): 공유 AIF 화면 추출

### 구조

- `packages/aif-workbench` (`@aif/workbench`): 원문·그래프·제안 검토 화면, store, 도메인 로직, i18n, API 클라이언트. 사용법은 그 폴더 README.
- `frontend/`: 화면 탭과 파이프라인 편집기만 남은 웹 호스트. `AifWorkbench` 를 가져다 쓴다.
- 저장소 루트 `package.json` 이 npm workspaces(`frontend`, `packages/aif-workbench`)를 묶는다. 루트 `overrides` 로 React 19.2.8·Vite 8.2.2 등 기존 잠금 버전을 유지했다(개발 도구 일부는 패치 버전만 올라감).
- Langflow 포크(`patches/0001-aif-langflow-host.patch`):
  - `/aif` 라우트(지연 로드) + `AifWorkbenchPage`: `configureWorkbench({ analysis: false })`, `.aif-root` 로 감쌈.
  - `vite.config.mts`: `@aif/workbench` 별칭, `resolve.dedupe: react, react-dom, @xyflow/react` → Langflow 의 React 19.2.5·React Flow 12.10.2 한 벌만 번들된다(AIF 청크에 React·React Flow 사본 없음 확인). zustand 5·elkjs 0.12 는 AIF 저장소 것.
  - `App.css`·`style/classes.css` 의 React Flow 전역 규칙 19개에 `:where(:not(.aif-root *))` 를 붙여 AIF 캔버스를 제외(우선순위는 그대로). 이 규칙들이 `!important` 로 AIF 그래프의 선 색·굵기와 확대/축소 아이콘(`fill: none`)을 덮고 있었다.
  - 헤더 버튼은 `ignoreTitleCase` (Langflow `Button` 이 글자를 "Aif" 로 바꿈).
- 공유 코드 수정: Langflow 는 전역 `fetch` 를 가로채(`fetch-intercept`) `config.headers` 에 값을 넣으므로, 옵션 없이 부른 `fetch(url)` 가 실패했다. 예제 불러오기에 `{ headers: {} }` 를 넘긴다. API 호출은 원래 헤더를 넘기고 있었다.
- 스타일 격리: `workbench.css` 전체를 `:where(.aif-root)` 아래로 옮겼다. `:root` 변수는 `.aif-root` 로, `html/body/#root` 규칙은 웹 호스트 `frontend/src/host.css` 로. 키프레임은 `aif-spin` 으로 이름을 바꿨다.
  - 예전 edge 기본 선 규칙(#8b94a6, 1.6)은 React Flow CSS 가 뒤에 로드되어 웹에서 실제로 적용된 적이 없었다. Langflow 에서는 로드 순서가 반대라 적용되므로, 두 곳 모양을 같게 하려고 지웠다.

### 검증

- 웹 회귀:
  - `npm run check` 통과(build · lint · 스모크 4종).
  - 옮기기 전(HEAD 3645f09 빌드)과 후의 웹을 같은 창 크기로 캡처해 비교했다. 빈 화면·예제 불러오기(노드 37)·노드 선택(상세 패널) 세 상태 모두 픽셀 차이 0.
- Langflow 안(Electron 셸 실제 창, `AIF_SHELL_PROBE=p1`, 서버는 셸이 직접 기동):
  - 헤더 AIF → `/aif` 검토 화면
  - 예제 열기 → 노드 37, 원문 표시
  - 노드 클릭 → 상세 패널
  - 로고로 Langflow 첫 화면 복귀: AIF 화면에 들어가기 전과 캡처 비교. 저장된 PNG 는 픽셀 차이 0, 메모리 비트맵은 29px(0.003%) 차이
  - 다시 AIF → 편집 상태 유지(노드 37)
  - `/aif` 새로고침
  - 콘솔 오류 없음
- Langflow 헤더 Jest 테스트 22개 통과. 바꾼 포크 파일은 Biome 으로 정리했다. 남은 Biome 오류 1개(`custom-routes-store-pages.tsx` 의 쓰지 않는 import)는 upstream 원본에 원래 있던 것이다.
- `patches/0001-aif-langflow-host.patch` 는 깨끗한 v1.11.0 체크아웃에 적용되는 것을 확인했고, `build-fork.ps1` 로 다시 빌드한 결과로 P0·P1 점검을 돌렸다.

### 아직 안 된 것 (P2 이후)

- 중앙 AIF API 연결. Langflow 안에서 `/api/...` 는 Langflow 경로라서 카탈로그 조회·서버 저장·프로젝트 목록이 동작하지 않는다. P2 에서 중앙 API 주소(`VITE_AIF_API_BASE`)나 bridge 로 정한다.
- 사건 목록 화면(`/aif/projects`), `projectId` 로 열기, Flow 실행 결과에서 바로 열기, [웹에서 열기].
- Langflow 다크 모드에서 AIF 화면은 밝은 색 그대로다.
- 파일 내려받기(프로젝트 파일·AIF 내보내기)는 Electron 에서 기본 저장 대화상자로 처리되는지 확인하지 않았다.
- 사람이 직접 하는 드래그·줌·키보드 undo/redo 는 해 보지 않았다.

## 실행 방법

```powershell
# 1. 포크 빌드 (처음 한 번, 패치를 바꿨을 때)
powershell -ExecutionPolicy Bypass -File integrations\langflow\build-fork.ps1

# 2. 셸 의존성
cd integrations\langflow\desktop-shell; npm install

# 3. 셸 실행: 7870 이 비어 있으면 서버를 직접 띄운다. 헤더의 AIF 를 누르면 검토 화면
$env:AIF_LANGFLOW_START = (Resolve-Path ..\start-langflow-p0.ps1).Path
npx electron .

# 자동 점검: p0(테스트 페이지·재시작) / p1(검토 화면·스타일 격리). 결과 JSON 과 캡처가 남는다
$env:AIF_SHELL_PROBE = 'p1'; npx electron .
```

P0 서버는 공식 Desktop 의 venv 를 빌려 쓴다. 전용 Desktop 패키지로 배포할 때는 `C:\Program Files\Langflow\resources` 의 wheel 과 `constraints.txt` 로 별도 venv 를 만들어야 한다(P4).
