"""중앙 서버 부하 시험(Locust). 원문·토큰·비밀번호는 출력하지 않는다.

배포한 서버에 실제 사용 흐름으로 부하를 건다. `deploy/smoke_check.py` 와 같은 인증·게시 절차를 쓴다.

    locust -f deploy/stress/locustfile.py --host https://localhost:8443
    locust -f deploy/stress/locustfile.py --host https://localhost:8443 --headless -u 20 -r 2 -t 3m

환경 변수
    AIF_USER                웹 로그인 계정 이름 (기본 owner)
    AIF_PASSWORD_FILE       그 계정의 비밀번호가 든 파일
    AIF_PUBLISH_TOKEN_FILE  게시 토큰(`results:publish`)이 든 파일
    AIF_INSECURE=1          인증서 검사를 끈다 (Caddy 내부 CA 로 띄운 로컬 시험 전용)
    AIF_STRESS_SHARED=1     모든 검토자가 한 사건을 같이 저장한다 (revision 충돌을 일부러 만든다)

주의
    - 게시는 서버 DB 에 사건을 하나씩 남긴다. 운영 서버에 돌리면 `STRESS-<시각>` 사건이 쌓인다.
    - 서버는 uvicorn 워커 1개이므로, HealthWatcher 의 `/api/health` 응답 시간이 이벤트 루프가
      막혔는지 보는 가장 빠른 지표다. 이 값이 3초를 넘으면 컨테이너 헬스체크도 실패하기 시작한다.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from locust import HttpUser, between, constant, events, task

REPO = Path(__file__).resolve().parent.parent.parent
LIVE_FIXTURE = REPO / "backend" / "fixtures" / "langflow_run_response.live_v11.json"
# 컨테이너 헬스체크(timeout=3s)와 같은 기준. 이 선을 넘으면 서버가 unhealthy 로 떨어지기 시작한다.
HEALTH_BUDGET_MS = 3000


def _read(env_name: str, default: str = "") -> str:
    """환경 변수가 가리키는 파일의 내용. 없으면 빈 값으로 두고 시작할 때 알린다(여기서 죽지 않는다)."""
    path = os.environ.get(env_name)
    if not path:
        return default
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError as error:
        print(f"[{env_name}] 파일을 읽지 못했다: {error}")
        return default


def _fixture() -> tuple[str, dict]:
    """게시에 쓸 실제 v11 실행 결과. (판결문 원문, 결과 그래프)"""
    live = json.loads(LIVE_FIXTURE.read_text(encoding="utf-8"))
    judgment = json.loads(live["outputs"][0]["inputs"]["input_value"], strict=False)["judgment"]
    result = json.loads(live["outputs"][0]["outputs"][0]["results"]["message"]["text"], strict=False)
    return judgment, result


USERNAME = os.environ.get("AIF_USER", "owner")
PASSWORD = _read("AIF_PASSWORD_FILE")
PUBLISH_TOKEN = _read("AIF_PUBLISH_TOKEN_FILE")
INSECURE = os.environ.get("AIF_INSECURE") == "1"
SHARED_PROJECT = os.environ.get("AIF_STRESS_SHARED") == "1"

JUDGMENT, RESULT = _fixture()
if INSECURE:
    import urllib3

    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
# 검토자들이 같이 저장할 사건. Publisher 가 처음 게시한 것을 쓴다.
_shared: dict[str, str] = {}
# (사건, revision) → 그 revision 을 받은 가상 사용자. 두 사람이 같은 revision 을 받으면
# 한쪽 저장이 조용히 사라졌다는 뜻이다(409 로 막혔어야 한다).
_granted: dict[tuple[str, int], int] = {}
# 동시 저장 집계. 충돌이 실제로 일어났는지 봐야 "덮어쓰기가 없다" 는 결과가 뜻을 가진다.
_saves = {"saved": 0, "conflict": 0, "overwritten": 0}


@events.test_start.add_listener
def _require_credentials(environment, **_):
    """자격 증명이 없으면 시작하지 않는다. 로그인 실패가 쌓이면 (계정, 주소) 기준 10분 잠금에 걸린다."""
    missing = [
        name
        for name, value in (("AIF_PASSWORD_FILE", PASSWORD), ("AIF_PUBLISH_TOKEN_FILE", PUBLISH_TOKEN))
        if not value
    ]
    if missing:
        print(f"[설정 없음] {', '.join(missing)} 가 필요하다. deploy/stress/README.md 참고.")
        environment.runner.quit()


@events.test_stop.add_listener
def _report_saves(environment, **_):
    """동시 저장 결과. 409 가 충분히 나왔는데 덮어쓰기가 0 이어야 정합성이 지켜진 것이다."""
    total = _saves["saved"] + _saves["conflict"]
    if not total:
        return
    print(
        f"[동시 저장] 성공 {_saves['saved']}건 / 충돌 409 {_saves['conflict']}건 "
        f"({_saves['conflict'] / total * 100:.0f}%) / 덮어쓰기 {_saves['overwritten']}건"
    )


class _Base(HttpUser):
    abstract = True

    def on_start(self):
        if INSECURE:
            # 로컬 시험은 Caddy 내부 CA 라 검사할 수 없다. 경고까지 끄지 않으면 로그가 이것으로 가득 찬다.
            self.client.verify = False


class HealthWatcher(_Base):
    """이벤트 루프가 막혔는지 보는 관찰자. 부하를 만들지 않고 1초마다 가장 싼 요청만 보낸다."""

    fixed_count = 1
    wait_time = constant(1)

    @task
    def health(self):
        with self.client.get("/api/health", name="00 /api/health (관찰)", catch_response=True) as response:
            if response.elapsed.total_seconds() * 1000 > HEALTH_BUDGET_MS:
                response.failure(f"{HEALTH_BUDGET_MS}ms 초과 — 이벤트 루프 지연")


class Publisher(_Base):
    """Langflow Desktop 이 결과를 게시하는 흐름. 가장 무거운 쓰기 경로다.

    사용자 수가 적어도 이 경로가 빠지면 안 되므로 WebVisitor 보다 비중을 높게 둔다.
    """

    weight = 2
    wait_time = between(5, 15)

    def on_start(self):
        super().on_start()
        self.client.headers.update({"Authorization": f"Bearer {PUBLISH_TOKEN}"})
        self.catalogs = None
        self.sequence = 0

    @task(1)
    def read_context(self):
        """실행 시작 때 카탈로그를 읽는다. 카탈로그 버전·해시를 게시에 그대로 써야 한다.

        이름을 `context` 로 두면 안 된다: Locust 의 User.context() 는 요청마다 호출되는 예약 메서드라
        덮어쓰면 요청 → context() → 요청 … 무한 재귀가 난다.
        """
        with self.client.get("/api/integrations/langflow/context", name="10 카탈로그 읽기", catch_response=True) as response:
            if response.status_code != 200:
                response.failure(f"HTTP {response.status_code}")
                return
            body = response.json()
            self.catalogs = {
                key: body[key]
                for key in ("issueCatalogVersion", "issueCatalogSha256", "schemeCatalogVersion", "schemeCatalogSha256")
            }

    @task(3)
    def publish(self):
        if self.catalogs is None:
            self.read_context()
            if self.catalogs is None:
                return
        self.sequence += 1
        stamp = time.strftime("%Y%m%d%H%M%S")
        external_run_id = f"stress-{stamp}-{id(self):x}-{self.sequence:04d}"
        body = {
            "schemaVersion": 1,
            "externalRunId": external_run_id,
            "source": {"kind": "langflow-desktop", "componentVersion": "stress"},
            "document": {"text": JUDGMENT, "caseId": f"STRESS-{stamp}", "title": f"부하 시험 {stamp}"},
            "catalogs": self.catalogs,
            "result": RESULT,
        }
        with self.client.post(
            "/api/integrations/langflow/results", json=body, name="11 게시 (새 사건)", catch_response=True
        ) as response:
            if response.status_code == 201:
                project_id = response.json().get("projectId")
                _shared.setdefault("projectId", project_id)
                # 같은 요청을 한 번 더 보내는 것이 Desktop outbox 의 재전송이다. 200 + duplicate 여야 한다.
                self._resend(body)
            elif response.status_code == 409:
                response.failure("게시 충돌(409) — externalRunId 가 겹쳤다")
            else:
                response.failure(f"HTTP {response.status_code}")

    def _resend(self, body: dict):
        with self.client.post(
            "/api/integrations/langflow/results", json=body, name="12 게시 재전송 (중복)", catch_response=True
        ) as response:
            if response.status_code != 200 or response.json().get("duplicate") is not True:
                response.failure(f"중복 판정 실패: HTTP {response.status_code}")


class Reviewer(_Base):
    """웹에서 사건을 열어 보고 저장하는 검토자. 세션 쿠키 + CSRF 를 쓴다."""

    weight = 4
    wait_time = between(2, 6)

    def on_start(self):
        super().on_start()
        self.csrf = None
        self.project_id = None
        self.document = None
        self.login()

    def login(self):
        with self.client.post(
            "/api/auth/login",
            json={"username": USERNAME, "password": PASSWORD},
            name="20 로그인",
            catch_response=True,
        ) as response:
            if response.status_code == 200:
                self.csrf = response.json().get("csrfToken")
            elif response.status_code == 429:
                response.failure("로그인 잠김(429) — 계정·주소 조합이 10분에 5회 실패했다")
            else:
                response.failure(f"HTTP {response.status_code}")

    @task(3)
    def list_projects(self):
        self.client.get("/api/projects", name="21 사건 목록")

    @task(1)
    def catalogs(self):
        """화면이 처음 뜰 때 읽는 두 카탈로그."""
        self.client.get("/api/catalogs/issues", name="22 쟁점 카탈로그")
        self.client.get("/api/catalogs/schemes", name="23 스킴 카탈로그")

    @task(4)
    def open_project(self):
        project_id = self._pick()
        if not project_id:
            return
        with self.client.get(f"/api/projects/{project_id}", name="24 사건 열기", catch_response=True) as response:
            if response.status_code == 200:
                self.project_id = project_id
                self.document = response.json()
            elif response.status_code == 404:
                # 아직 게시된 사건이 없다. 다음 차례에 다시 고른다.
                response.success()
                self.project_id = None
            else:
                response.failure(f"HTTP {response.status_code}")

    @task(2)
    def save_project(self):
        """가장 무거운 쓰기. revision 이 맞지 않으면 409 가 정상이다(덮어쓰기가 아니라)."""
        if not self.document or not self.project_id:
            self.open_project()
            if not self.document:
                return
        with self.client.put(
            f"/api/projects/{self.project_id}",
            json=self.document,
            headers={"X-CSRF-Token": self.csrf or ""},
            name="25 사건 저장",
            catch_response=True,
        ) as response:
            if response.status_code == 200:
                saved = response.json().get("revision")
                if saved != self.document["revision"] + 1:
                    response.failure(f"revision 이 어긋났다: {self.document['revision']} → {saved}")
                # 같은 (사건, revision) 을 두 사람이 받으면 한쪽 저장이 덮어써진 것이다.
                owner = _granted.setdefault((self.project_id, saved), id(self))
                if owner != id(self):
                    _saves["overwritten"] += 1
                    response.failure(f"revision {saved} 을 두 사용자가 같이 받았다 — 저장이 덮어써졌다")
                _saves["saved"] += 1
                self.document["revision"] = saved
            elif response.status_code == 409:
                # 다른 사람이 먼저 저장했다. 화면과 같게 다시 읽어 온다.
                _saves["conflict"] += 1
                response.success()
                self.document = None
            elif response.status_code == 403:
                response.failure("CSRF 또는 세션 만료")
                self.login()
            else:
                response.failure(f"HTTP {response.status_code}")

    def _pick(self) -> str | None:
        if SHARED_PROJECT:
            # 모두가 한 사건을 저장하게 한다. 게시된 사건이 아직 없으면 목록 맨 앞 사건을 같이 쓴다.
            if "projectId" not in _shared:
                with self.client.get("/api/projects?limit=1", name="21 사건 목록", catch_response=True) as response:
                    if response.status_code != 200:
                        response.failure(f"HTTP {response.status_code}")
                        return None
                    items = response.json().get("projects") or []
                    if items:
                        _shared.setdefault("projectId", items[0]["projectId"])
            return _shared.get("projectId")
        if self.project_id:
            return self.project_id
        with self.client.get("/api/projects", name="21 사건 목록", catch_response=True) as response:
            if response.status_code != 200:
                response.failure(f"HTTP {response.status_code}")
                return None
            items = response.json().get("projects") or []
            if not items:
                return _shared.get("projectId")
            # 가상 사용자마다 다른 사건을 잡아 revision 충돌 없이 순수 처리량을 본다.
            return items[hash(id(self)) % len(items)].get("projectId")


class WebVisitor(_Base):
    """첫 화면 로딩. 정적 자산도 같은 파이썬 프로세스가 서빙하므로 API 와 루프를 경쟁한다."""

    weight = 1
    wait_time = between(10, 30)

    @task
    def index(self):
        self.client.get("/", name="30 웹 첫 화면")
