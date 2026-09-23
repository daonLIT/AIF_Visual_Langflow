# 운영 배포·백업·설치 안내

이 문서는 두 가지를 다룬다.

1. 중앙 AIF 서버(웹 + API, DB) 운영
2. 사용자 PC 의 AIF Langflow Desktop 설치·업데이트

구현 배경과 검증 기록은 `integrations/langflow/README.md` 에 있다.

```text
사용자 PC                                   운영 서버
AIF Langflow Desktop (Electron)             Caddy (HTTPS, 인증서 자동)
 ├ Langflow 1.11.0 (포크 화면, 로컬)          └ aif 컨테이너: 웹 + /api (LANGFLOW_MODE=off)
 │   Flow 실행 → AIF Publish ─── HTTPS ───▶      └ /data 볼륨: annotation.sqlite3, api_tokens.json, users.json
 └ AIF 검토 화면 ── /aif-bridge ── HTTPS ───▶
Ollama (로컬 또는 SSH 터널)                   브라우저: https://<도메인>/?projectId=…
```

## 1. 중앙 서버

### 준비물

- Docker(Compose v2)가 있는 서버. 80/443 포트가 열려 있어야 한다.
- 도메인 A 레코드가 서버를 가리켜야 한다. 그래야 Caddy 가 Let's Encrypt 인증서를 자동으로 받는다.
- 저장소 사본. 이미지는 서버에서 빌드한다(`deploy/Dockerfile`: 웹 빌드 → Python 런타임, 해시 고정 `backend/requirements.lock.txt`).

### 처음 배포

```bash
cp deploy/.env.example deploy/.env        # AIF_DOMAIN 등을 채운다. 이 파일은 저장소에 넣지 않는다.
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps     # aif (healthy), caddy (Up)

# 계정·토큰 (컨테이너 안 /data 에 해시로 저장된다)
# 쓰는 사람마다 한 벌씩 만든다. 아래는 userA 의 예.
DC="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$DC exec aif python scripts/manage_users.py create --username userA --principal userA --preset review   # 비밀번호 입력창
$DC exec aif python scripts/manage_tokens.py create --id userA-publish --principal userA --preset publish
$DC exec aif python scripts/manage_tokens.py create --id userA-review  --principal userA --preset review
```

**한 사람의 세 가지(웹 계정·게시 토큰·검토 토큰)는 `--principal` 을 같게 만든다.** 직접 만든 scheme 은
이 값으로 소유자를 가른다. 검토 화면(검토 토큰)에서 만든 scheme 을 그 사람의 Flow 실행(게시 토큰으로
카탈로그를 읽는다)에서도 쓰려면 둘이 같아야 한다. 게시 중복 판정도 같은 기준이다.

토큰 원문은 만들 때 한 번만 출력된다. 두 토큰을 사용자에게 안전한 경로로 전달하면, 사용자가 Desktop 의 **AIF → AIF 연결 설정** 에 넣는다.

- 게시 토큰: `results:publish`, `catalog:read`
- 검토 토큰: 목록·조회·저장

`--preset admin` 계정은 운영자에게만 만든다.

### 기본 설정 (이미지에 들어 있는 값)

| 변수 | 값 | 뜻 |
| --- | --- | --- |
| `LANGFLOW_MODE` | `off` | 서버는 Langflow 를 부르지 않는다. 분석은 Desktop 에서 한다. 사이트 분석·요약·파이프라인 경로는 닫힌다 |
| `AIF_AUTH_MODE` | `token` | `/api/health` 를 뺀 모든 API 에 토큰 또는 로그인 세션이 필요하다 |
| `AIF_WEB_DIST` | `/app/web` | 웹을 같은 출처에서 제공한다 |
| `DATABASE_PATH`, `AIF_API_TOKENS_FILE`, `AIF_USERS_FILE` | `/data/…` | 볼륨 `aif-data` 에만 쓴다 |
| `AIF_COOKIE_SECURE` | `auto` | Caddy 가 붙인 `X-Forwarded-Proto: https` 를 보고 Secure 쿠키를 쓴다 |

`deploy/.env` 로 바꾸는 값은 다음과 같다.

- `AIF_DOMAIN`: 공개 주소. `viewerUrl`·[웹에서 열기] 주소도 여기서 만든다.
- `AIF_SESSION_TTL_HOURS`, `AIF_MAX_PUBLISH_BYTES`, `AIF_BACKUP_DIR`, 포트, `AIF_IMAGE_TAG`

자세한 목록은 `.env.example` 과 `backend/README.md` 에 있다.

### 점검

```bash
python deploy/smoke_check.py --base https://<도메인> --user owner --password-file pw.txt --publish-token-file pub.tok
```

확인하는 항목(14개):

- 보안 헤더·HSTS·CSP, 익명 401
- 로그인 쿠키 속성, CSRF
- 게시 201·재전송 200, 조회, 저장 revision +1
- 파이프라인 경로 닫힘, 로그아웃

점검용 프로젝트가 하나 남는다(사건번호 `SMOKE-<시각>`). 운영 DB 에 남기기 싫으면 스테이징에서 돌린다.

### 상태 확인·재시작

- `docker compose … ps`: `aif` 는 30초마다 `/api/health` 로 healthcheck 한다. `caddy` 는 `aif` 가 healthy 가 된 뒤 뜬다.
- `docker compose … restart aif`: 진행 중인 요청만 끊긴다. 데이터는 볼륨에 남는다.
- 로그 보기: `docker compose … logs -f aif`. 원문·토큰은 로그에 남기지 않는다(요청 경로와 상태 코드만).

### 백업

```bash
# 서버를 멈추지 않고 일관된 사본(sqlite backup API) + 토큰·계정 파일 + manifest(sha256·프로젝트 수)
$DC exec aif python scripts/backup_db.py --out-dir /backups --keep 14
$DC exec aif python scripts/backup_db.py --verify /backups/aif-<시각>
```

- `/backups` 는 호스트의 `AIF_BACKUP_DIR` 이다. 하루 한 번 cron 등으로 돌리고, 이 폴더를 다른 저장소로 복사해 둔다.
- 백업에는 판결문 원문과 토큰·계정 해시가 들어 있다. 운영 데이터와 같은 수준으로 접근을 제한한다.

### 복구

```bash
$DC stop aif
$DC run --rm --no-deps --entrypoint sh aif -c "cp /backups/aif-<시각>/annotation.sqlite3 /data/annotation.sqlite3"
# 토큰·계정도 되돌릴 때:  cp /backups/aif-<시각>/api_tokens.json /backups/aif-<시각>/users.json /data/
$DC start aif
```

- 복구 전의 DB 는 먼저 한 번 더 백업해 둔다.
- 서버를 켜면 DB 스키마가 더 낮은 경우 명시적 마이그레이션이 돌고, 그 전에 같은 폴더에 `*.backup-v<N>-<시각>` 사본을 만든다.

### 업데이트·원복

서버에서 `deploy/update.sh` 를 쓴다. 코드 받기 → 백업 → 이미지 태그 → 재배포(healthy 까지 대기) 순으로 돌고,
끝에 되돌리는 방법(이전 태그·이전 커밋)을 출력한다.

```bash
cd ~/aif-central
./deploy/update.sh                      # git pull 부터 전부
./deploy/update.sh --check              # 끝나고 smoke_check 까지 (아래 두 변수가 필요)
#   SMOKE_PASSWORD_FILE=<비밀번호 파일> SMOKE_PUBLISH_TOKEN_FILE=<게시 토큰 파일>
./deploy/update.sh --no-pull            # 코드를 직접 올린 경우
```

이미지 태그는 `<날짜>-<커밋>` 으로 자동으로 붙는다(같은 날 두 번 배포해도 구분된다).
백업은 바꾸기 전 컨테이너에서 받고, DB 스키마가 바뀌는 배포면 컨테이너가 시작하면서 `*.backup-v<N>-<시각>` 을 하나 더 만든다.

원복하려면 스크립트가 출력한 이전 태그로 `AIF_IMAGE_TAG` 를 되돌리고 `$DC up -d --wait` 한다(이전 이미지가 서버에 있어야 한다).
새 버전이 DB 를 마이그레이션한 뒤라면, 업데이트 직전 백업으로 DB 도 함께 되돌린다(새 스키마는 이전 코드가 모른다).

서버 코드 폴더가 아직 `git archive` 사본이면 한 번만 clone 사본으로 바꾼다(스크립트가 방법을 알려 준다).
데이터는 Docker 볼륨에 있어 그대로 남는다.

### 인증키 교체

- **Desktop 토큰**
  1. 같은 `principal` 로 새 토큰을 만든다.
  2. 사용자가 연결 설정에 새 토큰을 넣는다.
  3. `manage_tokens.py disable --id <옛 id>`.

  서버 재시작은 필요 없다. principal 이 같으면 교체 전후 게시 재전송이 같은 결과로 묶인다.
- **웹 비밀번호**: `manage_users.py password --username <이름>`.
- **계정 끄기**: `manage_users.py disable`. 이미 로그인한 세션도 다음 요청부터 막힌다.
- **모든 세션 끊기**: 서버를 멈추고 DB 의 `auth_sessions` 표를 비운다.

### 운영 규모

- SQLite + 영구 볼륨 한 대를 기준으로 한다(`aif` 한 컨테이너). 로그인 잠금 기록은 프로세스 메모리에 있다.
- 여러 프로세스·서버로 늘리려면 다음이 필요하다.
  - PostgreSQL 로 이전(현재 `app/storage/db.py` 는 SQLite 전용)
  - 로그인 잠금·세션을 공유 저장소로
  - 게시 중복 판정은 DB 기본 키 기반이라 그대로 쓸 수 있다

### 로컬에서 시험

`AIF_DOMAIN=localhost`, 포트 8080/8443 으로 띄우면 Caddy 내부 CA 로 HTTPS 가 된다. 점검 스크립트는 `--insecure` 로 돌린다.

## 2. AIF Langflow Desktop (사용자 PC)

### 설치 파일 만들기 (개발 PC)

```powershell
npm install                                                                 # 저장소 루트
powershell -ExecutionPolicy Bypass -File integrations\langflow\build-fork.ps1 # 포크 화면 빌드
cd integrations\langflow\desktop-shell
npm install
npm run dist        # → dist-installer\AIF-Langflow-Desktop-Setup-<버전>.exe
```

설치 파일에 들어가는 것:

- 셸
- 포크 화면
- uv 0.11.29 (sha256 확인)
- Langflow 실행 환경 잠금 파일(`integrations/langflow/runtime/requirements.lock.txt`)

Python·Langflow 패키지는 들어 있지 않다. 처음 실행할 때 사용자 PC 에 설치한다.

코드 서명 인증서가 없어서 서명하지 않은 설치 파일이 나온다. 그래서 Windows SmartScreen 경고가 뜬다. 배포 전에 서명 인증서를 준비해 `electron-builder` 의 `win.signtoolOptions` 에 넣는다.

### 사용자 설치

1. `AIF-Langflow-Desktop-Setup-<버전>.exe` 를 실행한다. 사용자 단위 설치라 관리자 권한은 필요 없고, 설치 폴더를 고를 수 있다.
2. 처음 실행하면 "처음 실행 준비" 창이 뜬다. uv 로 Python 3.13 과 Langflow 1.11.0 환경(패키지 566개, 해시 고정)을 `%LOCALAPPDATA%\com.aif.LangflowDesktop` 에 설치한다. 인터넷이 필요하고 몇 분 걸린다.
3. **AIF → AIF 연결 설정** 에 넣는다.
   - 서버 주소 `https://<도메인>`
   - 웹사이트 주소 `https://<도메인>`
   - 검토 토큰, 게시 토큰

   토큰은 Windows DPAPI 로 암호화해 저장한다. 설정한 뒤 앱을 다시 켜야 Flow 가 게시 토큰을 받는다.
4. Ollama 와 모델이 필요하다. 기본은 `http://localhost:11434`, `gemma4:26b` 이다(`langflow/make_v11_flow.py`).
5. Langflow 에서 `langflow/TopDown_Judgment_to_AIF_v11_Desktop.json` 을 가져온다.

### 데이터 위치

| 경로 | 내용 | 업데이트·제거 때 |
| --- | --- | --- |
| `%LOCALAPPDATA%\com.aif.LangflowDesktop\langflow-venv`, `python`, `uv-cache` | 실행 환경 | 잠금 파일이 바뀌면 다시 만든다. 지워도 다음 실행 때 다시 설치된다 |
| `%APPDATA%\com.aif.LangflowDesktop\langflow` | 이 앱의 Langflow Flow·설정 DB | 남는다 |
| `%APPDATA%\com.aif.LangflowDesktop\aif-config.json` | 서버 주소, 암호화된 토큰 | 남는다 |
| `%APPDATA%\com.aif.LangflowDesktop\outbox` | 아직 게시하지 못한 결과(원문 포함, 토큰 없음) | 성공하면 지워진다. `failed\` 는 확인 뒤 지운다 |
| `%APPDATA%\com.aif.LangflowDesktop\logs\langflow.log` | Langflow 로그(10MB 넘으면 `.1` 로 돌림) | 남는다 |

공식 Langflow Desktop(`%APPDATA%\com.LangflowDesktop`, `%LOCALAPPDATA%\com.LangflowDesktop`) 과 설치 폴더는 건드리지 않는다. 두 앱을 함께 써도 되지만, 이 앱은 17870 포트를 쓴다(`AIF_LANGFLOW_PORT` 로 바꿀 수 있다).

### 업데이트·원복

- **업데이트**: 새 설치 파일을 그대로 실행한다(같은 앱 ID 라 덮어쓴다).
  - Flow·설정·토큰·outbox 는 `%APPDATA%` 에 남는다.
  - 잠금 파일이 바뀐 버전이면 첫 실행 때 실행 환경만 다시 설치한다.
  - 자동 업데이트는 넣지 않았다. Langflow 버전은 이 앱이 고정한다.
- **원복**: 이전 설치 파일을 다시 실행한다. 실행 환경은 잠금 파일에 맞춰 다시 설치된다.
- **백업**: 업데이트 전에 `%APPDATA%\com.aif.LangflowDesktop\langflow` 를 복사해 두면 Flow 를 되돌릴 수 있다.
- **제거**: Windows "앱 제거" 로 지운다. 사용자 데이터는 남으니, 완전히 지우려면 위 두 폴더(`%APPDATA%`·`%LOCALAPPDATA%` 아래 `com.aif.LangflowDesktop`)를 지운다.
