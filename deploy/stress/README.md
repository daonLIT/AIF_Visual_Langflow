# 중앙 서버 부하 시험 (Locust)

실제 사용 흐름(게시·조회·저장·로그인·첫 화면)으로 부하를 걸어 **어디가 먼저 막히는지** 본다.
인증·게시 절차는 `deploy/smoke_check.py` 와 같고, 게시에는 저장소의 실제 v11 실행 결과 fixture 를 쓴다.

## 이 서버에서 무엇을 보는가

중앙 서버는 `LANGFLOW_MODE=off` 라 분석·요약 경로가 닫혀 있다. 즉 **LLM 은 부하 요인이 아니다.**
부하는 게시·저장·조회·로그인·정적 파일에 집중되고, 다음 구조 때문에 처리량이 아니라 **직렬화**가 문제가 된다.

| 구조 | 근거 |
| --- | --- |
| uvicorn 워커 1개 (단일 이벤트 루프) | `deploy/Dockerfile` 의 CMD 에 `--workers` 없음 |
| DB 작업이 스레드풀로 가지 않음 | 백엔드에 `run_in_threadpool`/`to_thread` 호출 없음 |
| SQLite 단일 커넥션 + 락으로 직렬화 | `backend/app/storage/db.py` (WAL·busy_timeout 미설정) |
| 정적 자산도 같은 프로세스가 서빙 | `backend/app/main.py` 의 `StaticFiles` Mount |
| 로그인이 scrypt 를 루프에서 동기 실행 | `backend/app/auth.py` |
| 앞단 타임아웃·rate limit 없음 | `deploy/Caddyfile` (상한은 `request_body max_size 8MB` 뿐) |

그래서 **가장 먼저 볼 지표는 `00 /api/health (관찰)` 의 응답 시간**이다. HealthWatcher 가 1초마다 가장 싼 요청을
보내고, 3초(컨테이너 헬스체크 timeout)를 넘으면 실패로 기록한다. 이 선을 넘기 시작하면 서버가 `unhealthy` 로
떨어지고, 사용자 화면은 전부 느려진다.

## 준비

### 1. 대상 서버 (로컬 시험)

운영과 같은 Docker 구성을 localhost 로 띄운다. Caddy 내부 CA 를 쓰므로 `AIF_INSECURE=1` 이 필요하다.

```bash
cp deploy/.env.example deploy/.env      # AIF_DOMAIN=localhost, AIF_HTTP_PORT=8080, AIF_HTTPS_PORT=8443
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps    # aif (healthy)
```

### 2. 계정과 토큰

```bash
DC="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$DC exec aif python scripts/manage_users.py create --username owner --principal owner --preset review
$DC exec aif python scripts/manage_tokens.py create --id stress-publish --principal stress --preset publish
```

비밀번호와 토큰 원문을 각각 파일에 넣는다(저장소 밖에 두고, 줄바꿈만 있어도 된다).

### 3. Locust 설치

```bash
python -m venv .venv-stress
.venv-stress/Scripts/activate        # PowerShell: .venv-stress\Scripts\Activate.ps1
pip install -r deploy/stress/requirements.txt
```

## 실행

환경 변수로 자격 증명 파일 위치를 준다. 값 자체를 명령줄에 쓰지 않는다.

```bash
export AIF_USER=owner
export AIF_PASSWORD_FILE=/path/to/pw.txt
export AIF_PUBLISH_TOKEN_FILE=/path/to/publish.tok
export AIF_INSECURE=1                 # 로컬 시험(Caddy 내부 CA)에서만

# 웹 UI 로 관찰하며 손으로 올린다 (http://localhost:8089)
locust -f deploy/stress/locustfile.py --host https://localhost:8443

# 정해진 부하로 한 번 돌리고 끝낸다
locust -f deploy/stress/locustfile.py --host https://localhost:8443 --headless -u 20 -r 2 -t 3m
```

PowerShell 은 `$env:AIF_USER = "owner"` 형식으로 넣는다.

`-u` 는 가상 사용자 수, `-r` 은 초당 늘리는 수, `-t` 는 시간이다.
사용자 비율은 Reviewer 4 : Publisher 2 : WebVisitor 1 이고, HealthWatcher 는 항상 1명으로 고정된다.
사용자 수가 적으면 비중이 낮은 종류가 0명이 될 수 있으니, 표에 `11 게시` 가 보이는지 확인하고 올린다.

### 무엇부터 해 보는가

1. `-u 5` 로 3분 — 평상시 응답 시간의 기준선을 잡는다.
2. `-u 20`, `-u 50` 으로 올리며 `00 /api/health` 의 p95 가 언제 3초를 넘는지 본다.
3. 넘는 지점을 찾으면 그 직전 값으로 `-t 30m` soak 을 돌려 메모리·DB 크기·로그가 늘어나는지 본다.

### 저장 충돌을 일부러 만들려면

```bash
export AIF_STRESS_SHARED=1
```

모든 검토자가 한 사건을 같이 저장한다. **409 REVISION_CONFLICT 만 나와야 정상**이고, 조용한 덮어쓰기
(`revision 을 두 사용자가 같이 받았다` 실패)가 보이면 그것이 진짜 결함이다.
끝나면 `[동시 저장] 성공 N건 / 충돌 409 M건 / 덮어쓰기 0건` 이 찍힌다. **충돌이 충분히 나왔는지 먼저 보고**,
그 다음에 덮어쓰기가 0 인지 본다(충돌이 0 이면 경쟁 자체가 없었던 것이라 결과가 뜻이 없다).

2026-09-23 로컬 측정: 저장 76건 = 성공 29 + 충돌 47(62%), 덮어쓰기 0건.
서버가 기록한 revision 도 1 → 30 으로 성공 횟수와 정확히 맞았다.

> 이 결과는 **uvicorn 워커가 1개일 때만** 보장된다. `routes/api.py` 의 revision 검사와 저장 사이에는
> `await` 가 없어 한 이벤트 루프 안에서 원자적이지만, 워커를 늘리거나 서버를 여러 대로 두면
> 두 프로세스가 같은 revision 을 읽고 둘 다 저장할 수 있다. 확장할 때는 `docs/deploy.md` 의
> 운영 규모 항목(PostgreSQL 이전)과 함께 이 검사를 트랜잭션 안으로 옮겨야 한다.

## 같이 볼 것

부하를 거는 동안 다른 창에서:

```bash
DC="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$DC ps                       # aif 가 healthy 를 유지하는가
docker stats                 # CPU 가 코어 1개분(100%)에 붙는가 = 단일 워커 한계
$DC logs --tail 50 caddy     # 502/504 가 나오는가
```

## 주의

- **게시는 서버 DB 에 사건을 하나씩 남긴다.** 로컬은 볼륨을 지우면 되지만, 운영에 돌리면 `STRESS-<시각>`
  사건이 쌓인다. 운영에 걸기 전에 `backend/scripts/backup_db.py` 로 백업하고, 끝난 뒤 남은 사건을 정리한다.
- 운영 서버는 Ollama 가 도는 GPU 서버와 같은 기계다. 다른 사람이 추론을 돌리는 시간대는 피한다.
- 로그인 실패가 (계정, 주소) 조합으로 10분에 5회면 429 로 막힌다. 비밀번호가 틀리면 시험이 곧바로 막히니
  먼저 `deploy/smoke_check.py` 로 자격 증명이 맞는지 확인하고 시작한다.
