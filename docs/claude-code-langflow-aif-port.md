# Claude Code 구현 지시서: Langflow 안으로 AIF 작업 화면 이식

작성일: 2026-09-21

## 1. 최종 목표와 이전 계획의 변경

사용자는 대부분의 작업을 Langflow Desktop 안에서 수행하기를 원한다. 기존 AIF 웹 프로젝트의 사건 목록, 판결문 원문, 논증 그래프, 검토·수정·저장 기능을 Langflow 프런트엔드에 이식하라. 외부 사이트로 이동하는 버튼만 추가하는 방식은 이번 목표를 충족하지 않는다.

최종 사용자 동선:

```text
Langflow Desktop 실행
 → 기존 Flow 편집/실행
 → AIF 결과 서버 자동 저장
 → 같은 Desktop 창의 AIF 검토 화면
 → 원문·그래프 확인, 수락/거절/수정, 서버 저장
 → 필요할 때만 [웹에서 열기]
```

서버 DB에 저장된 동일 프로젝트는 독립 웹사이트에서도 열 수 있어야 한다. 사용자는 로컬 파일을 수동으로 내보내거나 업로드하지 않는다. 서버·DB는 운영 서버에서 실행하고 PC에는 Desktop 및 로컬 모델 사용 시 Ollama와 모델이 필요하다.

이 문서는 이전 `claude-code-desktop-integration.md`의 **사이트 이동 중심 UX와 구현 순서**를 대체한다. 이전 문서의 결과 게시·원자적 저장·재시도 원칙은 유지하며 아래에도 핵심 요구를 포함했다. 두 문서가 충돌하면 이 문서를 우선한다.

## 2. 실제 Desktop 확인 결과와 검증 한계

### 이번 조사에서 직접 확인한 사실

Windows PC의 설치 파일과 실행 중인 앱을 읽기 전용으로 조사했다. 설치본의 파일이나 Flow·DB는 변경하지 않았다.

| 항목 | 관측 결과 |
|---|---|
| Desktop 실행 파일 | `C:\Program Files\Langflow\Langflow .exe` |
| 내부 실행 파일 | `C:\Users\tldkw\AppData\Local\com.LangflowDesktop\.langflow-venv\Scripts\langflow.exe` |
| Python 패키지 메타데이터 | `langflow==1.11.0`, `langflow-base==0.11.0` |
| 설치 리소스 | `langflow-1.11.0`, `langflow_base-0.11.0`, `lfx-1.11.0` wheel 파일 존재 |
| 실제 Desktop UI | Starter Project와 기존 AIF v11 Flow 목록이 같은 Desktop 창에 표시됨 |
| 설치된 서버의 `langflow/main.py` | `setup_static_files`가 프런트엔드 정적 파일을 제공하고 SPA fallback을 설정함 |
| 같은 파일의 기본 화면 경로 | Python 패키지 내부 `langflow/frontend` |
| 설치된 `langflow/__main__.py` | `frontend_path` CLI 옵션을 받아 `setup_app(static_files_dir=...)`로 전달함 |
| 해당 CLI 설명 | 사용자 지정 프런트엔드 경로는 development purposes only로 설명됨 |

위 소스의 관측 위치: `main.py` 약 959–1036행, `__main__.py` 약 351, 463–479행. 버전 변경 시 행 번호에 의존하지 말고 함수 이름으로 재확인한다.

### 판단

**AIF React 화면을 Langflow 웹 프런트엔드에 이식할 수 있는 구조는 확인됐다. 설치된 Desktop 역시 Langflow 웹 UI를 표시한다.** 그러나 사용자 지정 빌드가 공식 Desktop 런처에서 로드되는 것까지 검증한 것은 아니다.

이번에 확인하지 않은 것:
- 공식 Desktop 런처가 사용자 환경변수/설정의 frontend_path를 실제 자식 서버에 전달하는지.
- 사용자 지정 React 빌드를 Desktop에 로드했을 때 전체 UI가 동작하는지.
- 런처가 재시작 시 패키지 무결성 검사·재설치로 변경을 되돌리는지.
- Desktop 설치 프로그램의 정확한 자체 버전 및 전체 런처 소스·빌드 재현성.
- 이식 화면, 서버 저장, Desktop/Web 간 동기화의 E2E 동작.

Python 패키지 1.11.0을 Desktop 설치 프로그램의 자체 버전이라고 단정하지 않는다. 정적 화면 경로 옵션 존재만으로 공식 Desktop 커스터마이징 지원 또는 배포 지원을 입증했다고 말하지 않는다.

## 3. 가장 먼저 수행할 Desktop 가능성 검증(P0)

대규모 이식 전에 다음 작은 실험을 먼저 완료하라.

1. 실제 설치 버전 및 사용 중 데이터 위치를 재확인하고 원본 파일·DB를 보존한다.
2. 공식 저장소의 해당 릴리스 태그/커밋을 확인하여 버전을 고정한다. 최신 main을 무조건 사용하지 않는다.
3. 동일 버전 프런트엔드에 단순한 `AIF Integration Check` 페이지와 메뉴 하나만 추가하여 별도 경로에 빌드한다.
4. 공식 Desktop 런처가 별도 프런트엔드 경로를 지원하는지 확인한다. `LANGFLOW_FRONTEND_PATH`/CLI 옵션은 후보이며 실제 설정 전달을 입증해야 한다.
5. 기존 작업이 실행 중이면 강제 종료하지 않는다. 별도 테스트 프로필·포트·DB를 우선 사용한다. 재시작이 필요하면 실행 중 작업과 미저장 편집 여부를 확인하고 안전한 시점을 확보한다.
6. **실제 네이티브 Desktop 창에서** 기존 Flow 화면 → 테스트 페이지 → Flow 화면 왕복, 새로고침·앱 재시작을 검증한다.
7. 성공한 로딩 방식, 버전, 빌드 해시, 테스트 데이터 경로, 원복 절차를 기록한다.

브라우저에서 테스트 페이지를 연 것만으로 Desktop 검증 통과라고 처리하지 않는다.

### 적용 경로 선택

- **경로 A: 공식 Desktop + 사용자 지정 Langflow 프런트엔드.** 실제 런처 설정 전달과 재시작 유지가 검증되면 개발 실증에 사용한다. 개발용 옵션을 정식 배포 계약처럼 설명하지 않는다.
- **경로 B: 전용 Desktop 패키지.** 공식 런처가 커스텀 빌드를 안정적으로 지원하지 않으면 포크한 Langflow와 전용 데스크톱 셸을 패키징한다. 공식 런처 소스를 확보할 수 있는지 먼저 확인한다. 없다면 별도 Tauri 등 셸을 만드는 방안을 명시적으로 구분하고 비용·범위를 기록한다.

공식 Desktop 서명키나 동일한 자동 업데이트 권한을 가진다고 전제하지 않는다. 전용 패키지는 별도 앱 ID, 데이터 경로, 이름, 버전 및 업데이트 체계를 사용한다. 기존 Langflow 설치를 덮어쓰지 않는다.

경로 A 실패를 전체 이식 불가로 결론 내리지 말고 경로 B의 실현 조건을 제시한다. 반대로 경로 B 설계만으로 실제 Desktop 실행 완료라고 보고하지 않는다. 필요한 소스·권한 등이 없으면 차단 지점을 구체적으로 기록하고 독립적으로 가능한 이식·서버 작업을 진행한다.

## 4. 저장소 역할과 작업 위치

현재 프로젝트: `C:\project\2026\AIF_Visual_Langflow`

이 프로젝트를 도메인 기능·중앙 서버·공유 UI의 원본으로 유지한다. Langflow upstream 원본을 이 저장소의 기존 `langflow/` 폴더 위에 덮어쓰지 않는다. 그 폴더에는 AIF Flow와 커스텀 컴포넌트가 있다.

권장 구조:

```text
AIF_Visual_Langflow/
  frontend/                 독립 웹 호스트
  backend/                  중앙 AIF 서비스
  packages/aif-workbench/    공유 React 화면/상태/도메인 로직(신규)
  langflow/                 AIF 컴포넌트·Flow·생성 도구
  integrations/langflow/    포크 참조, 빌드 연결, 적용·복구 도구
  docs/

별도 Langflow 포크 체크아웃/
  src/frontend/             AIF 메뉴·라우트·호스트 어댑터
  필요한 최소 백엔드 연결 코드
```

포크 체크아웃은 쓰기 가능한 별도 경로를 정하고 문서화한다. 예를 들어 현재 워크스페이스 하위 `vendor/langflow-fork`를 격리 체크아웃으로 사용할 수 있지만 의존성·빌드 결과를 원본 저장소에 무분별하게 커밋하지 않는다. GitHub 원격 포크 생성은 계정과 권한이 있어야 하며 실제 생성하지 않았으면 생성했다고 말하지 않는다.

읽을 코드:
- frontend/src/App.tsx
- frontend/src/components/{Graph,JudgmentPanel,Annotation,Validation,Toolbar}
- frontend/src/store/{annotationStore,graphStore,catalogStore}.ts
- frontend/src/{api,types,io,layout,validation,i18n}
- backend/app/{routes/api.py,schemas/models.py,storage/db.py}
- backend/app/services/{aif_adapter,evidence_matcher,run_manager}.py
- langflow/components 및 make_v11_flow.py

시작 시 실제 경로·모델·테스트를 확인하고 각 저장소 AGENTS.md를 따른다.

## 5. UI 이식 방식

Langflow와 현재 앱은 React 계열이지만 의존성 버전이 같다고 가정하지 않는다. 기존 React Flow 캔버스는 실행 단계용이고 AIF 캔버스는 논증 결과용이다. 서로 별도 화면·store로 유지한다.

공유 `AifWorkbench`를 추출하여 두 호스트에서 사용한다:

```text
독립 웹사이트 ───┐
                 ├─ 공통 AifWorkbench ── 중앙 AIF API ── 서버 DB
Langflow 화면 ───┘
```

공유 컴포넌트에 API client, 인증 어댑터, projectId, 외부 열기, Flow로 돌아가기 콜백을 주입한다. Langflow 전용 전역 store나 브라우저 경로를 공유 패키지에서 직접 가정하지 않는다.

필수 화면:
- AIF 사건 목록: 사건명, 저장 시각, 실행 출처, 검색 및 열기.
- AIF 검토: 원문, 논증 그래프, 제안 카드, 상세 편집, 근거 하이라이트.
- 실행 결과: 저장 중/완료/실패, 다시 저장, 해당 결과 열기.
- 웹에서 열기: 현재 projectId의 웹 검토 화면을 기본 브라우저로 열기.

Langflow에 `/aif/projects`, `/aif/projects/:projectId` 같은 독립 라우트를 추가하되 실제 라우터 규칙에 맞춘다. 기존 메뉴에서 접근하고 Flow 실행 결과에서도 해당 결과로 이동한다. iframe으로 웹사이트만 표시하는 것은 최종 이식으로 인정하지 않는다.

이식 시 확인:
- React/react-dom 중복 번들 방지, peer dependency 및 React Flow 버전 호환.
- CSS 전역 reset, Tailwind, 폰트, z-index, portal·modal 충돌 방지.
- Flow 편집과 AIF 편집의 undo/redo, 단축키, 선택 상태, provider 격리.
- 모바일/좁은 창, 다크 모드, 한국어/영어 및 키보드 접근성.
- 프로젝트 전환 시 늦은 응답 덮어쓰기, 미저장 변경 손실 방지.
- 여러 화면 인스턴스가 가능하면 store를 인스턴스별 생성하여 전역 상태 충돌 방지.
- 파일 다운로드 등은 Desktop WebView와 일반 브라우저 차이를 호스트 어댑터로 처리.
- 기존 사이트의 중복 파이프라인 편집기를 Langflow 내부에 다시 이식하지 않는다. Flow 편집은 Langflow 기존 기능을 사용한다.

## 6. 중앙 서버와 Desktop 연결

중앙 AIF 백엔드는 원문, AIF, 미검토/확정 상태, 변경 이력, 프로젝트 revision을 관리한다. Langflow 내부 DB는 Flow·설정 관리에 사용하고 AIF 공유 데이터의 원본 저장소로 혼용하지 않는다.

중앙 서비스는 Langflow/Ollama가 없어도 조회·검토·저장이 가능해야 한다. 사용자 PC에서 기존 Starlette 서버를 별도로 켜도록 요구하지 않는다.

Desktop UI와 서버 연결 방식은 P0에서 선택한다:
- HTTPS 중앙 API 직접 호출 + 적절한 Desktop 사용자 인증/CORS.
- 또는 로컬 Langflow에 제한된 AIF 전용 bridge를 추가해 중앙 API로 전달.

bridge를 만들면 허용된 중앙 서버와 API 경로만 중계하고 임의 URL 프록시로 만들지 않는다. 전용 중앙 API 토큰을 프런트엔드 코드나 Flow JSON에 하드코딩하지 않는다. Loopback Langflow 인증과 중앙 서버 계정 인증은 별개다. 브라우저 쿠키가 Desktop WebView와 자동 공유된다고 가정하지 않는다.

초기 운영은 단일 사용자/팀 인증으로 단순화할 수 있으나 목록·조회·수정·게시 권한을 모두 보호한다. 웹과 Desktop의 프로젝트 접근 권한을 일치시키고 계정이 여러 개면 소유권을 검사한다.

## 7. Flow 실행과 자동 게시

입력 준비 → 기존 분석 → Result Validator → AIF Publish → 실행별 결과 보기 순서로 Desktop용 Flow를 생성한다.

- 기존 Flow와 생성 스크립트를 보존하고 Desktop용 버전을 별도로 만든다.
- 입력 준비 단계에서 원문과 사건 정보를 받고 쟁점·스킴 카탈로그를 중앙 API에서 조회한다.
- 카탈로그 버전/해시, 실행 식별자를 실행 시작에 고정하고 모든 후속 단계에 전달한다.
- 원문 공백·줄바꿈을 보존한다. 카탈로그 조회 실패를 빈 카탈로그로 대체하지 않는다.
- 새로운 전체 실행은 새로운 externalRunId, 저장만 재시도할 때는 동일 ID를 사용한다. Langflow 캐시와 노드 부분 재실행 동작을 검증한다.
- Publish 노드를 실제 최종 출력 경로에 연결하여 실행 누락을 방지한다.
- 최종 JSON 결과를 서버에 전송하고 projectId/runId/viewerUrl을 받는다.
- 분석 성공과 게시 성공을 별도 상태로 표시한다. 게시 실패 때문에 LLM 전체를 다시 돌리지 않는다.
- 임시 네트워크 오류는 제한된 재시도와 로컬 outbox로 복구한다. 앱 재시작 후에도 동일 요청을 재전송하고 성공 후 정리한다. outbox에는 토큰을 저장하지 않는다.
- Flow 실행 완료 UI는 현재 실행 ID와 게시 응답을 정확히 연결한다. 전역 '마지막 결과'만 사용하여 다른 실행을 여는 버그를 만들지 않는다.
- 외부 Desktop 실행을 중앙 서버가 다시 Langflow 호출로 실행하지 않는다.

## 8. API 및 DB 계약

권장 수신 API: `POST /api/integrations/langflow/results`

요청: schemaVersion, externalRunId, source(flowId/flowName 등), document(text/caseId/title), catalogs(실제 버전·해시), result(기존 최종 AIF 계약).

응답: projectId, runId, revision, status=saved, viewerUrl, duplicate. 최초 201, 동일 요청 재시도 200, 동일 실행 ID의 다른 내용 409.

구현 규칙:
- Pydantic 요청 모델과 기존 오류 envelope 사용, 크기·필드·그래프 참조 검사.
- 기존 aif_adapter로 ID namespace 변환, 원문 근거 매칭, 미검토 annotation 생성.
- AI 결과는 자동 수락하지 않지만 검토 화면에서 즉시 표시한다.
- no_issues는 빈 그래프와 사유를 저장, invalid는 정상 프로젝트로 공개하지 않는다.
- 인증 주체 + externalRunId에 UNIQUE 제약을 두고 정규화한 요청 해시 저장.
- 실행 기록·프로젝트·게시 매핑은 하나의 트랜잭션으로 저장한다. 기존 함수 내부 commit 때문에 부분 저장이 생기지 않게 한다.
- 응답 유실·병렬 중복 요청·재시작 후에도 같은 ID를 반환한다.
- 재전송이 이미 사람이 수정한 프로젝트를 덮어쓰지 않는다. 새 분석은 별도 결과로 저장한다.
- 프로젝트 schemaVersion 2와 revision 충돌 처리 유지. 변경이 필요하면 명시적 마이그레이션 제공.
- 서버 카탈로그 변경 시 실행 당시 버전을 재현해 검증하거나 지원 불가를 명시한다.
- 실제 수집할 수 없는 Flow 해시나 모델 설정을 임의로 기록하지 않는다.
- viewerUrl은 신뢰된 사이트 설정에서 생성하며 키·원문은 URL에 포함하지 않는다.
- 기존 DB 백업과 명시적 마이그레이션 사용. 초기화로 해결하지 않는다.

단일 서버에서는 SQLite+영구 볼륨을 유지할 수 있다. 다중 서버 운영이 필요하면 PostgreSQL 전환을 별도로 계획한다. Desktop마다 DB 파일을 복제하여 공유를 대신하지 않는다.

## 9. 빌드·배포·업데이트

- Langflow 포크의 태그/커밋, Python 패키지, Node 및 프런트엔드 버전을 잠근다.
- 공유 AIF 패키지를 웹과 Langflow 양쪽에서 재현 가능하게 빌드한다. 수동 복사된 서로 다른 UI 버전을 유지하지 않는다.
- 개발용 프런트엔드 경로 주입과 운영용 설치 패키지를 구분한다.
- 공식 앱 설치 폴더의 JS를 손으로 바꾸는 것만으로 완료 처리하지 않는다.
- 전용 Desktop이면 서버 기동·종료·포트 충돌·로그·데이터 보존·업데이트·원복을 다룬다.
- upstream 업데이트는 고정 버전에서 검증 후 반영하고 커스텀 UI가 사라지는 업데이트를 방지한다.
- 웹 배포는 HTTPS, 인증, DB 영구 저장, 백업·복구 및 필요한 환경변수 문서를 포함한다.
- 배포 계정·도메인이 없으면 배포 구성까지 완성하고 미제공 항목을 보고한다. 실제 배포했다고 말하지 않는다.

## 10. 단계별 완료 조건

### P0 — 실제 Desktop 경로 확정
실제 Desktop에서 테스트 메뉴와 페이지가 열리고 재시작 후 유지됨. 공식 Desktop 경로 또는 전용 Desktop 경로를 근거와 함께 확정.

### P1 — 공유 AIF UI 추출
기존 웹에서 동일 동작 유지. Langflow 안에서 fixture 프로젝트의 원문·그래프·상세 화면 표시. React·CSS·store 충돌 없음.

### P2 — 중앙 저장과 Flow 연결
실제 Desktop Flow 실행 → 자동 게시 → 같은 창에서 해당 결과 열기. 카탈로그 및 결과 계약 검증.

### P3 — 검토 작업 완성
Desktop 안에서 수락·거절·수정·근거 연결·저장. 앱 재시작 후 같은 상태 복원. 웹에서 동일 결과 확인.

### P4 — 배포와 회귀 검증
다른 테스트 프로필 또는 깨끗한 환경에서 설치·실행 재현. 기존 Flow와 사용자 데이터 유지. 설치/업데이트/백업 문서 완료.

## 11. 필수 검증

- backend: 기존 `python run_tests.py` 및 추가된 게시·인증·트랜잭션 테스트.
- frontend: 기존 `npm run check` 및 공유 UI/호스트 연결 검증.
- Langflow: 고정한 버전의 공식 프런트엔드·관련 백엔드 검사와 Flow 생성 검증.
- Desktop 실제 테스트: 메뉴 왕복, 라우트 새로고침, 드래그/줌, 상세 편집, 키보드 undo/redo, 저장, 재시작, 웹 열기.
- 동시/반복 게시, 서버 응답 유실, 동일 ID 다른 내용, outbox 복구.
- Desktop/Web에서 같은 revision을 수정할 때 409 처리와 편집 보존.
- 정상 무쟁점·잘못된 AIF·카탈로그 버전 불일치·원문 근거 매칭.
- 인증 만료/없음/권한 부족, 중앙 서버 단절, 잘못된 프로젝트 ID.
- 기존 Langflow Flow 편집·실행·가져오기·저장 회귀 없음.
- Langflow Desktop 종료 후 웹 결과 조회·수정 가능.

최종 E2E는 실제 Desktop에서 원문 입력 → 분석 → 중앙 저장 → 같은 창 검토/수정/저장 → 웹에서 수정 결과 확인이다. 수동 JSON 업로드 없이 수행해야 한다.

fixture/mock 통과, 브라우저 통과, Desktop 통과, 실제 Ollama 분석 통과를 별도로 기록한다. 확인하지 않은 단계는 명시한다.

## 12. 산출물과 보고

1. Langflow 포크 변경과 고정 upstream 정보.
2. 공유 AIF UI 및 기존 독립 웹 호스트 변경.
3. 중앙 API·DB 마이그레이션·인증 및 재시도 구현.
4. Desktop용 Flow와 생성 스크립트.
5. 실제 Desktop 적용/패키징·원복 도구와 설치 안내.
6. 테스트 기록과 P0/Desktop E2E 검증 증거.
7. 운영 서버 설정·배포·DB 백업 문서.

작업은 기존 프로젝트에서 시작하되, 초기 P0 이후 Langflow 포크 체크아웃과 현재 프로젝트 양쪽을 수정한다. 사용자 데이터를 보존하고 진행 중 변경을 덮어쓰지 않는다. 코드 구현 요청을 계획으로만 끝내지 말고 가능한 항목을 끝까지 완성한다.

최종 보고에서는 '구조상 가능', 'Desktop 테스트 페이지 확인', 'AIF 이식 완료', '실제 전체 분석 E2E 완료'를 구분하라.

## 13. 참고 자료

- 공식 소스: https://github.com/langflow-ai/langflow
- 소스 빌드 및 정적 프런트엔드 구조: https://github.com/langflow-ai/langflow/blob/main/DEVELOPMENT.md
- 프런트엔드 경로 환경변수 예시: https://github.com/langflow-ai/langflow/blob/main/.env.example
- 커스텀 Python 컴포넌트: https://docs.langflow.org/components-custom-components
- Desktop 업데이트 배포 저장소: https://github.com/langflow-ai/desktop-updates

공식 main/문서는 현재 설치본보다 새 버전일 수 있다. 실제 구현은 선택한 태그의 코드와 설치본을 기준으로 검증한다. Desktop 업데이트 저장소는 업데이트 메타데이터·바이너리 배포 근거이며, 전체 런처 소스가 제공된다는 근거로 사용하지 않는다.
