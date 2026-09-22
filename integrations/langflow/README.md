# Langflow 안의 AIF 화면: 포크·전용 Desktop 셸

지시서: `docs/claude-code-langflow-aif-port.md`. 이 폴더는 Langflow 포크를 고정 버전으로 만들고, 그 화면을 네이티브 창에 띄우는 도구를 둔다.

```text
integrations/langflow/
  patches/             Langflow v1.11.0 프런트엔드에 적용하는 AIF 변경 (git diff, P0·P1 누적)
  build-fork.ps1       고정 태그 체크아웃 → 패치 적용 → npm ci → 빌드
  start-langflow-p0.ps1 포크 빌드를 화면으로 제공하는 Langflow 서버 (별도 포트·설정·DB)
  start-central-dev.ps1 로컬 통합 테스트용 중앙 AIF 서버 (토큰 인증, .profile/central 의 DB·토큰)
  desktop-shell/       전용 Desktop 셸 (Electron, 별도 앱 ID·데이터 경로, 연결 설정·중계·outbox, 설치형 런타임·설치 파일)
  runtime/             설치본이 처음 실행 때 설치하는 Langflow 1.11.0 환경 잠금 파일(해시 고정)
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

## P2 결과 (2026-09-21): 중앙 저장과 Flow 연결

### 구조

```text
Electron 셸 창 (Langflow 포크 화면)
  Flow: Judgment Text Input → AIF Run Context ──(카탈로그 조회: 게시 토큰)──▶ 중앙 AIF 서버
                              └▶ v11 분석(Ollama) → Result Validator → AIF Publish ──(게시: 게시 토큰)──▶ POST /api/integrations/langflow/results
                                                                          │ 실패 시 outbox 보관
  Flow 화면 오른쪽 아래 패널: 이번 실행의 게시 상태 · [이 결과 보기] · [다시 보내기]
  /aif/projects, /aif/projects/:id ── /aif-bridge/api/… ──(셸이 검토 토큰을 붙여 허용 경로만)──▶ 중앙 AIF 서버
```

- 중앙 서버 (`backend/`, 자세한 계약은 `backend/README.md`)
  - `AIF_AUTH_MODE=token`: 경로별 권한(scope). 토큰은 sha256 만 저장하고 `scripts/manage_tokens.py` 로 만든다.
  - `GET /api/integrations/langflow/context`: Flow 입력 형식의 카탈로그와 버전·sha256.
  - `POST /api/integrations/langflow/results`: 기존 어댑터로 검증·namespace·근거 매칭 → 미검토 annotation 프로젝트. 201/200(재전송)/409/413/422.
    (principal, externalRunId) 기본 키와 요청 해시, 한 트랜잭션 저장. DB 마이그레이션 v4.
  - 기존 마이그레이션의 백업 연결이 닫히지 않던 문제(백업 파일이 잠긴 채 남음)를 함께 고쳤다.
- Desktop Flow (`langflow/make_desktop_flow.py` → `TopDown_Judgment_to_AIF_v11_Desktop.json`, 원래 v11 은 그대로)
  - `components/aif_run_context.py`: 서버 카탈로그를 읽어 버전·해시를 고정하고 실행 ID(`lfd-<uuid>`)를 만든다. 읽지 못하면 오류로 멈춘다(빈 카탈로그로 분석하지 않음). 기존 Splitter 입력 형식을 그대로 낸다.
  - `components/aif_publish.py`: 최종 출력 바로 앞. 보내기 전에 outbox 에 쓰고(토큰 없음), 일시 오류만 제한 재시도(기본 3회: 1·3·9초), 인증·검증·충돌 오류는 재시도하지 않는다. 분석 상태와 게시 상태를 따로 출력한다. invalid 분석은 게시하지 않는다.
  - 서버 주소·토큰은 Flow 에 없다. 셸이 Langflow 를 띄울 때 `AIF_API_BASE`, `AIF_PUBLISH_TOKEN`, `AIF_OUTBOX_DIR` 로 넘긴다.
- 셸 (`desktop-shell/`)
  - `config.js`: 메뉴 **AIF → AIF 연결 설정** 창. 서버 주소·웹사이트 주소·검토 토큰·게시 토큰. 토큰은 Electron safeStorage(DPAPI)로 암호화해 `%APPDATA%\com.aif.LangflowDesktop\aif-config.json` 에 둔다. 화면에 토큰을 돌려주지 않는다.
  - `bridge.js`·`bridge-rules.js`: 같은 출처 `/aif-bridge/api/…` 중 허용 목록(목록·조회·저장·카탈로그·근거 검증·health)만 설정된 서버로 넘기고 검토 토큰을 붙인다. 게시·파이프라인·분석 실행은 넘기지 않는다. 쿠키는 넘기지 않는다.
  - `outbox.js`: `%APPDATA%\com.aif.LangflowDesktop\outbox` 를 시작 때·5분마다·메뉴·패널 [다시 보내기]로 재전송. 보내는 주소는 파일의 url 이 아니라 설정의 서버 주소. 200/201 삭제, 401/403·네트워크·5xx 는 남김, 그 밖의 4xx 는 `outbox/failed/` 로.
  - 앱 안 링크는 같은 창에서, 설정된 웹사이트 출처만 기본 브라우저로 연다. [웹에서 열기]는 설정된 웹사이트 주소 + `/?projectId=`.
  - 페이지가 저장 안 한 변경으로 닫기를 막으면(beforeunload) 확인 대화상자를 띄운다(Electron 은 기본적으로 안내 없이 막는다. P2 점검 중 발견).
- 포크 화면 (`patches/0001-aif-langflow-host.patch`)
  - `/aif/projects`(사건 목록: 검색·출처·저장 시각·버전, 로딩·인증 필요·권한 없음·설정 없음·연결 실패 구분), `/aif/projects/:projectId`(검토, ← 사건 목록, 웹에서 열기), `/aif` → 목록.
  - 저장 안 한 편집이 있는 채로 다른 프로젝트를 열면 확인한다. 같은 프로젝트로 돌아오면 다시 불러오지 않는다. 늦게 도착한 이전 불러오기 응답은 버린다(공유 store).
  - Flow 화면 게시 패널: AIF Publish 노드(출력 이름 `publish_result`)의 **이번 실행** 출력만 읽는다. 실행 중에는 숨긴다.

### Langflow 부분 재실행 동작 (실측)

게시 노드의 실행 버튼만 눌러도 Langflow 1.11 은 앞 단계(Run Context·LLM 단계)를 다시 빌드한다. 그래서 새 실행 ID·새 분석(128초)·새 프로젝트가 생긴다.
**게시만 다시 보내는 방법은 outbox 재전송**(패널 [다시 보내기], 메뉴 **게시 대기 결과 다시 보내기**, 앱 시작 시 자동)이며 같은 실행 ID 를 쓴다.

### 검증

- 백엔드 `python run_tests.py`: 134개 통과.
  - `tests/test_integrations.py`: 게시 201·재전송 200·사람 편집 보존·다른 내용 409·새 실행 별도·no_issues·invalid 미저장·깨진 참조·카탈로그 불일치·빈 원문·크기 413·노드 수 초과·동시 6건→1개·트랜잭션 중간 실패 무잔여·토큰 401/403·scope·토큰 교체·v3→v4 마이그레이션.
  - `tests/test_desktop_components.py`: 실제 서버 앱에 붙인 Run Context·Publish 계약(카탈로그 → Splitter, 게시·재전송, 네트워크 실패 outbox, 제한 재시도, 409 → failed/, invalid 미게시, 링크).
- 웹 `npm run check` 통과. 셸 `npm test` 3개 통과(중계 허용 목록, outbox 규칙). 포크 Jest: 헤더·AIF·FlowPage 65 묶음 905개 통과.
- 실제 창 E2E (Electron 셸 + 테스트 Langflow 7870 + 로컬 중앙 서버 8000 토큰 모드 + 로컬 Ollama `gemma4:26b`, 예제 판결문 1,424자)
  - `AIF_SHELL_PROBE=p2`:
    1. Desktop Flow 를 올리고 출력 노드 실행 버튼을 눌렀다. 분석과 게시까지 149초가 걸렸고 패널이 "저장됨"을 표시했다.
    2. 중앙 서버 조회: 출처 `langflow-desktop`, externalRunId 일치, 미검토 43, 확정 0, 카탈로그 버전·해시가 기록됐다.
    3. [이 결과 보기]를 누르자 같은 창(창 1개)의 `/aif/projects/<id>` 에서 노드 21개와 원문이 표시됐다.
    4. 사건 목록에 새 프로젝트가 나타났다.
  - `AIF_SHELL_PROBE=p2b`:
    1. 카탈로그를 읽은 직후 중앙 서버를 멈췄다. 게시가 실패(ConnectError)했고, outbox 에 보관됐다(토큰 없음).
    2. 서버를 다시 켜고 [다시 보내기]를 눌렀다. 같은 externalRunId 로 저장됐고 outbox 가 비워졌다(미검토 41). 분석은 다시 돌지 않았다.
- 입력은 테스트 준비 단계에서 Flow JSON 에 넣었다(사람이 입력 칸에 붙여 넣는 동작은 자동화하지 않음).

### 아직 안 된 것 (P3 이후)

- 사람이 직접 하는 수락·거절·수정·근거 연결·저장, 앱 재시작 뒤 복원, 웹에서 같은 결과 확인 (P3).
- 독립 웹의 `?projectId=` 열기와 브라우저 로그인. 지금 viewerUrl·[웹에서 열기]가 가리키는 웹 주소는 아직 그 프로젝트를 열지 못하고, 토큰 모드 서버에는 웹이 로그인할 방법이 없다 (P3).
- Desktop 과 웹이 같은 revision 을 고칠 때의 409 처리 확인 (P3).
- 앱 재시작 직후 outbox 자동 재전송은 단위 테스트로만 확인했다(실제 창에서는 [다시 보내기] 경로를 확인).
- 운영 배포(HTTPS·영구 볼륨·백업), 설치 패키지, 셸이 쓸 전용 Langflow venv (P4).

## P3 결과 (2026-09-21): 검토 작업 완성

### 바뀐 것

- 중앙 서버: 브라우저 로그인(세션 쿠키·CSRF·계정 파일·로그인 잠금, DB 마이그레이션 v5). `backend/README.md` 의 "브라우저 로그인".
- 웹(`frontend/`): 사건 목록이 기본 진입, `?projectId=` 직접 열기·새로고침·뒤로 가기, 로그인 뒤 원래 주소로 복귀, 권한에 맞춰 사이트 분석·파이프라인 탭 숨김. `frontend/README.md` 의 "주소와 로그인".
- 공유 화면(`@aif/workbench`)
  - 저장 충돌(409) 배너: 편집은 그대로 두고 [내 편집 파일로 저장] / [서버 최신본 불러오기(확인 후 버림)] / [닫기].
  - `useServerProject`: 웹과 Langflow 가 같은 규칙으로 서버 프로젝트를 연다(같은 프로젝트는 다시 불러오지 않음, 다른 프로젝트로 갈 때 미저장 편집 확인, 늦은 응답 버림).
  - 호스트 설정 `extraHeaders`(CSRF)·`onAuthRequired`(401 → 로그인).
- 셸: 다시 켜면 마지막으로 보던 앱 안 화면(예: 검토 중이던 `/aif/projects/<id>`)을 연다(`%APPDATA%\com.aif.LangflowDesktop\last-view.json`).

### 검증 (실제 창)

환경: Electron 셸 + 테스트 Langflow 7870 + 로컬 중앙 서버 8000(토큰·세션 인증) + 웹 개발 서버 5174. 점검용 프로젝트는 실제 v11 실행 결과 fixture 를 게시해 만들었다(LLM 재실행 없음).

- `AIF_SHELL_PROBE=p3`(8단계 모두 통과):
  1. Desktop 에서 미검토 47개 프로젝트를 열었다.
  2. 노드 수락(필요한 노드 포함), 거절, 본문을 고쳐 수락, 원문 선택 → 선택한 제안에 수동 근거 연결.
  3. 프로젝트 메뉴 → 서버 저장. 서버 revision 2. 수락·수정·거절·수동 근거·확정 노드가 저장됐고, 고친 본문이 그대로 들어갔다.
  4. 새 브라우저 세션(쿠키 없음)으로 웹 `/?projectId=<id>` 를 열자 로그인 화면이 나왔다. 로그인하자 같은 주소의 프로젝트가 열렸고 개수가 Desktop 과 같았다. 검토 권한 계정이라 파이프라인 탭·분석 버튼은 보이지 않았다.
  5. 웹 새로고침 → 쿠키 세션으로 유지.
  6. 웹이 먼저 거절 하나를 저장(rev 3). Desktop(rev 2 기준)에서 수락 하나 → 저장 → 409 충돌 배너. 화면 편집과 개수가 그대로 남았다.
  7. [서버 최신본 불러오기] → Desktop·웹·서버가 같다(rev 3).
- `AIF_SHELL_PROBE=p3r`: 셸을 다시 켰다(Langflow 도 새로 기동). 마지막 화면 `/aif/projects/<id>` 가 열리고 개수가 저장된 상태와 같았다.
- outbox 재시작 재전송: 보내지 못한 게시 요청 파일을 outbox 에 넣고 셸을 켰다. 시작하자마자 전송되고 파일이 지워졌으며, 중앙 서버에 프로젝트가 생겼다.
- 테스트
  - 백엔드 141개 통과. `tests/test_auth_sessions.py` 가 로그인·쿠키 속성·CSRF·잠금·로그아웃·계정 끄기·Secure·off 모드를 본다.
  - 웹 `npm run check` 통과.
  - 셸 `npm test` 3개 통과.
  - 포크 Jest(AIF·헤더) 24개 통과.

### 아직 안 된 것 (P4)

- 운영 배포: HTTPS, 같은 출처 서빙(웹 + `/api`), 영구 볼륨, 백업·복구, 재시작·상태 확인, 인증키 교체 절차 문서.
- 설치 패키지: 전용 Desktop 설치 파일(`electron-builder`), 셸 전용 Langflow venv, 업데이트·원복, 깨끗한 환경에서의 설치 재현.
- 사람이 직접 하는 드래그·줌·키보드 undo/redo 는 자동 점검에 넣지 않았다(점검은 버튼·선택 범위를 스크립트로 조작).
- 로그인 잠금은 서버 프로세스 메모리 기준이다. 여러 프로세스로 운영하면 공유 저장소가 필요하다.

## P4 결과 (2026-09-21): 배포와 회귀 검증

운영·설치 절차는 `docs/deploy.md` 에 모았다.

### 중앙 서버

- **같은 출처 제공:** `AIF_WEB_DIST` 를 주면 백엔드가 빌드한 웹을 함께 제공한다(웹 + `/api` 한 주소).
- **보안 헤더:** 모든 응답에 CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` 를 붙이고, `/api` 응답에는 `Cache-Control: no-store` 를 붙인다.
- **`LANGFLOW_MODE=off`:** Langflow 없는 중앙 서버. 사이트 분석·요약·파이프라인 경로를 열지 않아, mock 결과가 운영 데이터에 섞이지 않는다. 로컬 통합용 `start-central-dev.ps1` 도 이 모드로 바꿨다.
- **컨테이너:**
  - `deploy/Dockerfile`: 웹 빌드 → Python 런타임. `backend/requirements.lock.txt` 는 로컬 테스트 환경과 같은 버전으로 해시를 고정했다. 비루트 실행, healthcheck 포함.
  - `deploy/docker-compose.yml`: Caddy 가 HTTPS 인증서를 자동으로 받는다. 데이터는 `aif-data` 볼륨, 백업은 호스트 폴더에 둔다.
  - `deploy/Caddyfile`, `deploy/.env.example`
- **백업:** `backend/scripts/backup_db.py` — 서버를 켠 채 sqlite 일관 사본, 토큰·계정 파일, manifest(sha256·프로젝트 수), `--keep`, `--verify`.
- **점검:** `deploy/smoke_check.py` — 배포 주소에 14개 항목.

검증:

- 백엔드 145개 통과. `tests/test_deploy.py` 가 같은 출처 웹·보안 헤더, `index.html` 없음 시작 오류, off 모드, 백업·보관 개수·검증·복구·손상 감지를 본다.
- Docker(Desktop 29.4.3)로 실제 이미지 빌드 → compose(`AIF_DOMAIN=localhost`, 8080/8443).
  - aif healthy. Caddy HTTPS 200, HTTP → HTTPS 308, HSTS·CSP 적용.
  - `smoke_check.py` 14/14 통과: 세션 쿠키 `HttpOnly; Secure; SameSite=strict`, CSRF 없는 저장 403, 게시 201·재전송 200, 저장 revision +1 등.
  - 컨테이너 안 백업·검증 통과.
  - 이미지 업데이트(`p4` → `p4b` 태그로 재빌드)해도 프로젝트 유지.
  - DB 를 지운 뒤 백업으로 복구 → 프로젝트 복원, health 200.
- 배포 웹을 실제 브라우저 창(Electron, 로컬 CA 만 예외)으로 열어 봤다. CSP 아래에서 다음이 콘솔 오류 없이 동작했다.
  1. 로그인 → 목록 → `?projectId=` 프로젝트(노드 24)
  2. 예제 열기(노드 37) → 자동 정렬(elkjs)로 위치 변경

### Desktop 설치 파일

- **설치형 런타임 (`desktop-shell/runtime.js`):**
  - 설치본(또는 `AIF_RUNTIME=managed`)은 처음 실행 때 "처음 실행 준비" 창을 띄운다.
  - uv 로 Python 3.13 과 Langflow 1.11.0 환경(`runtime/requirements.lock.txt`, 566개, 해시 고정)을 `%LOCALAPPDATA%\com.aif.LangflowDesktop` 에 설치한다. 설치 로그는 `logs/runtime-setup.log`.
  - Langflow 는 17870 포트로 띄운다. 포크 화면(`resources/langflow-frontend`)을 쓰고, Flow·설정은 `%APPDATA%\com.aif.LangflowDesktop\langflow` 에 둔다.
  - 잠금 파일이 바뀐 업데이트만 실행 환경을 다시 만든다.
- **설치 파일 만들기:** `npm run dist`
  1. `prepare-resources.js`: uv 0.11.29 를 받아 sha256 을 확인하고, 잠금 파일·포크 빌드를 모은다.
  2. `electron-builder`: NSIS, 사용자 단위 설치, 설치 폴더 선택 가능, 제거해도 사용자 데이터 유지. 앱 ID `com.aif.LangflowDesktop`.
  - 설치 파일은 117MB 이고 서명하지 않았다(`NotSigned`, 인증서 없음).
- **시작 실패 대화상자:** 설치본은 시작에 실패하면 오류 대화상자를 띄운다(개발 모드는 콘솔).
- **점검용 옵션:**
  - `AIF_USER_DATA`·`AIF_DESKTOP_HOME`: 깨끗한 프로필로 점검할 때 데이터·런타임 폴더를 바꾼다.
  - `AIF_SHELL_PROBE=p4`: 설치본 점검.

검증 (이 PC, 공식 Desktop 이 켜진 상태에서):

1. **개발 모드 런타임:** 빈 폴더에서 설치 152초, 첫 기동 포함 452초. Langflow 17870 에 포크 화면이 떴다.
2. **설치와 첫 실행:** `Setup-0.1.0.exe /S` 로 설치(HKCU 등록, 시작 메뉴 바로가기). 새 빈 프로필로 첫 실행하자 런타임 설치 166초를 포함해 406초 만에 `packaged: true` 로 떴다. P4 점검 통과: 포크 화면 표식, AIF 화면, 점검용 Flow 업로드.
3. **업데이트 0.1.1:** 덮어 설치 → 42초 만에 떴다. 런타임은 다시 설치하지 않았다(설치 시각 그대로). 점검용 Flow 는 같은 ID 로 남아 있었다.
4. **업데이트 0.1.2:** 덮어 설치 → 셸 중계로 로컬 중앙 서버의 사건 목록 10건을 불러왔다.
5. **제거:** `/S` 로 제거. 앱 폴더·등록 정보·바로가기는 사라지고, 사용자 데이터·런타임은 남았다.
6. **공식 Desktop 영향 없음:** 공식 Desktop DB(`%APPDATA%\com.LangflowDesktop\data\database.db`) 의 sha256·수정 시각이 전후 같았고, 공식 Desktop(7860)은 내내 정상 응답했다.

점검 결과 JSON 은 `.profile/p4-evidence/` 에 있다. 시험용 설치·런타임 폴더(`%LOCALAPPDATA%\aifp4`)는 점검 뒤 지웠다.

### 사람이 직접 확인 (2026-09-22)

개발 모드 셸 + 로컬 중앙 서버 8000 에서 기존 사건을 열어 직접 조작했다. 모두 이상 없음.

- 드래그: 확정·초안 노드 이동과 여러 노드 함께 이동, Ctrl+Z 로 원위치.
- 줌·이동: 휠 줌 한계, 빈 곳 끌기, 미니맵, 확대·축소·화면 맞춤 버튼, 쟁점 클릭 시 노드로 이동.
- 키보드: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Delete·Backspace 삭제와 되돌리기(연결선·검토 상태 함께), Esc.
  입력칸 안의 Ctrl+Z·Backspace 는 글자만 바꾸고 그래프는 그대로. Langflow Flow 화면 단축키와 겹치지 않음.
- 편집 뒤 저장, 재시작 후 최종 상태 유지.

### 확인하지 않은 것 / 운영 전에 필요한 것

- 실제 공개 도메인·서버 배포와 Let's Encrypt 인증서 발급. 계정·도메인이 없어서 localhost(Caddy 내부 CA)로만 시험했다.
- 코드 서명 인증서와 서명된 설치 파일(SmartScreen 경고 없애기). 자동 업데이트(서명·배포 서버 필요)는 넣지 않았다.
- 설치본을 HTTPS 공개 서버에 연결한 Desktop↔서버 E2E. 로컬 CA 인증서는 Electron 이 거부하므로 로컬 http 중앙 서버로만 확인했다. 게시·검토 E2E 는 P2·P3 에서 같은 코드로 확인했다.
- 다른 PC(공식 Desktop·Ollama 가 없는 PC)에서의 설치. 이 PC 에서 빈 프로필·빈 런타임 폴더로 대신했다.
- 기존 공식 Desktop 의 Flow 를 이 앱으로 옮기는 기능은 만들지 않았다. Langflow 의 Flow 내보내기·가져오기(JSON)를 쓴다.
- `AIF_SHELL_PROBE=p1` 은 P1 당시 화면 구조(헤더 AIF → 검토 화면)에 맞춘 점검이다. P2 이후 헤더가 사건 목록으로 가므로 지금은 일부 단계가 맞지 않는다. 설치본 점검은 p4 를 쓴다.

## 실행 방법

```powershell
# 0. 저장소 루트 의존성 (npm workspaces)
npm install

# 1. 포크 빌드 (처음 한 번, 패치를 바꿨을 때)
powershell -ExecutionPolicy Bypass -File integrations\langflow\build-fork.ps1

# 2. 중앙 서버 (로컬 통합 테스트용: 토큰 인증, .profile\central 의 DB·토큰)
cd backend
$env:AIF_API_TOKENS_FILE = (Resolve-Path ..\integrations\langflow\.profile\central).Path + '\api_tokens.json'
python scripts\manage_tokens.py create --id desktop-publish --principal langflow-desktop --preset publish
python scripts\manage_tokens.py create --id desktop-review --principal owner --preset review
cd ..
powershell -ExecutionPolicy Bypass -File integrations\langflow\start-central-dev.ps1

#    웹 로그인 계정 (P3). 비밀번호는 입력창으로 받는다.
cd backend
$env:AIF_USERS_FILE = (Resolve-Path ..\integrations\langflow\.profile\central).Path + '\users.json'
python scripts\manage_users.py create --username owner --principal owner --preset review
cd ..
#    웹: 5173 을 이미 쓰고 있으면 다른 포트로
cd frontend; $env:VITE_API_TARGET = 'http://127.0.0.1:8000'; npx vite --port 5174; cd ..

# 3. 셸
cd integrations\langflow\desktop-shell; npm install
$env:AIF_LANGFLOW_START = (Resolve-Path ..\start-langflow-p0.ps1).Path
npx electron .
#   처음 켜면 'AIF 연결 설정' 창이 뜬다: 서버 주소 http://127.0.0.1:8000, 위에서 만든 토큰 두 개.
#   게시 토큰은 셸이 Langflow 를 띄울 때 넘기므로, 설정 후 셸을 다시 켠다.

# 4. Langflow 에서 langflow\TopDown_Judgment_to_AIF_v11_Desktop.json 을 가져와 판결문을 붙여 넣고 출력 노드를 실행한다.
#    끝나면 오른쪽 아래 패널의 [이 결과 보기].

# 자동 점검: p0(테스트 페이지·재시작) / p1(검토 화면·스타일 격리) / p2(실제 실행·게시·열기) / p2b(서버 단절 후 재전송)
#           p3(Desktop 검토·저장 → 웹 로그인 확인 → 409) / p3r(재시작 복원, p3 다음에)
#   p3 는 AIF_P3_WEB_URL(기본 http://localhost:5173), AIF_P3_WEB_USER, AIF_P3_WEB_PASSWORD 도 쓴다.
#   p2·p2b 는 연결 설정 대신 환경변수 AIF_API_BASE, AIF_REVIEW_TOKEN, AIF_PUBLISH_TOKEN 을 쓸 수 있다.
$env:AIF_SHELL_PROBE = 'p2'; npx electron .
```

개발 모드(`npx electron .`)에서 `start-langflow-p0.ps1` 이 띄우는 Langflow 는 공식 Desktop 의 venv 를 빌려 쓴다.
설치본은 자체 실행 환경을 쓴다(`AIF_RUNTIME=managed` 로 개발 중에도 같은 방식을 쓸 수 있다). 설치 파일 만들기·사용자 설치는 `docs/deploy.md` 2장.
