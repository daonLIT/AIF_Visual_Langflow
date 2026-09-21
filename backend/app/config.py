"""환경변수 기반 설정. 비밀값은 여기서만 읽고 로그·응답에 노출하지 않는다."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from .i18n import t

BACKEND_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_ROOT.parent

# 먼저 읽은 파일이 우선한다(이미 설정된 값은 덮어쓰지 않음). 셸 환경변수가 가장 우선.
ENV_FILE_CANDIDATES = (BACKEND_ROOT / ".env", PROJECT_ROOT / ".env")

# off: Langflow 없이 운영하는 중앙 서버(Desktop 게시·검토·저장만). 사이트 분석·요약·파이프라인 경로를 열지 않는다.
LANGFLOW_MODES = ("mock", "live", "off")
# off: 로컬 개발(인증 없음, 모든 권한). token: /api 요청마다 Bearer 토큰과 권한(scope)을 확인한다.
AUTH_MODES = ("off", "token")


class ConfigError(ValueError):
    """시작 시 설정 오류. 잘못된 값으로 조용히 다른 모드가 되지 않도록 한다."""


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _env_int(name: str, default: int) -> int:
    raw = _env(name, "")
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def load_dotenv_files(paths=ENV_FILE_CANDIDATES) -> list[dict]:
    """
    의존성 없이 KEY=VALUE 형식의 .env 를 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다.
    반환: 파일별 진단 정보(경로, 존재 여부, 읽은 키 이름). 값은 담지 않는다.
    """
    report: list[dict] = []
    for path in paths:
        entry = {"path": str(path), "exists": path.exists(), "keys": [], "applied": []}
        if path.exists():
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key, value = stripped.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if not key:
                    continue
                entry["keys"].append(key)
                if key not in os.environ:
                    os.environ[key] = value
                    entry["applied"].append(key)
        report.append(entry)
    return report


@dataclass
class Settings:
    # Langflow 연결. mode 가 'mock' 이면 실제 서버를 호출하지 않고 fixture 를 사용한다.
    langflow_mode: str = field(default_factory=lambda: _env("LANGFLOW_MODE", "mock").strip().lower())
    langflow_base_url: str = field(default_factory=lambda: _env("LANGFLOW_BASE_URL", "http://localhost:7860").rstrip("/"))
    langflow_api_key: str = field(default_factory=lambda: _env("LANGFLOW_API_KEY", ""))
    langflow_flow_id: str = field(default_factory=lambda: _env("LANGFLOW_FLOW_ID", ""))
    langflow_input_component_id: str = field(
        default_factory=lambda: _env("LANGFLOW_INPUT_COMPONENT_ID", "CustomComponent-k5fj9")
    )
    langflow_output_component_id: str = field(
        default_factory=lambda: _env("LANGFLOW_OUTPUT_COMPONENT_ID", "ChatOutput-nL1VD")
    )
    # 서버 측 명시적 실행 제한(초). Langflow 컴포넌트의 timeout 0 은 '무제한' 이므로 여기서 제한한다.
    langflow_timeout_seconds: int = field(default_factory=lambda: _env_int("LANGFLOW_TIMEOUT_SECONDS", 2000))
    mock_fixture_path: Path = field(
        default_factory=lambda: Path(
            _env("LANGFLOW_MOCK_FIXTURE", str(BACKEND_ROOT / "fixtures" / "langflow_run_response.sample.json"))
        )
    )
    mock_delay_seconds: float = field(default_factory=lambda: float(_env("LANGFLOW_MOCK_DELAY_SECONDS", "1.5")))
    # mock 모드 파이프라인 편집이 사용하는 로컬 flow 파일 (실제 Langflow 대신 SQLite 에 복제해 편집)
    mock_flow_files: tuple[Path, ...] = field(
        default_factory=lambda: tuple(
            Path(p)
            for p in _env(
                "LANGFLOW_MOCK_FLOW_FILES",
                str(PROJECT_ROOT / "langflow" / "TopDown_Judgment_to_AIF_v11_Top3Issues.json"),
            ).split(os.pathsep)
            if p
        )
    )

    # live 실행을 flow 해시별 실행용 스냅샷 flow 로 돌린다(실행 중 편집이 섞이지 않게). false 면 원래 flow 로 실행.
    run_snapshot_flows: bool = field(default_factory=lambda: _env("RUN_SNAPSHOT_FLOWS", "true").strip().lower() not in ("0", "false", "no"))
    # 실제 Langflow 응답 envelope 를 저장할 폴더 (fixture 확보용). 비우면 저장하지 않는다. 원문이 포함되므로 저장소에 넣지 않는다.
    capture_dir: Path | None = field(default_factory=lambda: Path(_env("LANGFLOW_CAPTURE_DIR")) if _env("LANGFLOW_CAPTURE_DIR") else None)

    # 실행 관리
    max_concurrency: int = field(default_factory=lambda: _env_int("ANALYSIS_MAX_CONCURRENCY", 1))
    # 저장소
    database_path: Path = field(
        default_factory=lambda: Path(_env("DATABASE_PATH", str(BACKEND_ROOT / "data" / "annotation.sqlite3")))
    )
    # 카탈로그
    issue_catalog_path: Path = field(
        default_factory=lambda: Path(_env("ISSUE_CATALOG_PATH", str(BACKEND_ROOT / "catalog" / "issue_catalog.json")))
    )
    scheme_catalog_path: Path = field(
        default_factory=lambda: Path(_env("SCHEME_CATALOG_PATH", str(BACKEND_ROOT / "catalog" / "walton_schemes.json")))
    )

    # 인증. 토큰 파일에는 토큰 원문이 아니라 sha256 만 둔다(scripts/manage_tokens.py 로 만든다).
    auth_mode: str = field(default_factory=lambda: _env("AIF_AUTH_MODE", "off").strip().lower())
    api_tokens_path: Path = field(
        default_factory=lambda: Path(_env("AIF_API_TOKENS_FILE", str(BACKEND_ROOT / "data" / "api_tokens.json")))
    )
    # 브라우저 로그인 계정 파일(scrypt 해시만 저장, scripts/manage_users.py 로 만든다)
    users_path: Path = field(default_factory=lambda: Path(_env("AIF_USERS_FILE", str(BACKEND_ROOT / "data" / "users.json"))))
    # 로그인 세션 유효 시간(시간)
    session_ttl_hours: int = field(default_factory=lambda: _env_int("AIF_SESSION_TTL_HOURS", 12))
    # 세션 쿠키 Secure 속성: auto(https 요청·X-Forwarded-Proto https 일 때) | true | false
    cookie_secure: str = field(default_factory=lambda: _env("AIF_COOKIE_SECURE", "auto").strip().lower())
    # 게시 응답의 viewerUrl 을 만들 공개 사이트 주소 (예: https://aif.example.org). 비우면 viewerUrl 은 null.
    public_site_url: str = field(default_factory=lambda: _env("AIF_PUBLIC_SITE_URL", "").rstrip("/"))
    # 빌드한 웹(frontend/dist)을 같은 출처에서 제공한다(운영: 웹 + /api 한 주소). 비우면 API 만.
    web_dist: Path | None = field(default_factory=lambda: Path(_env("AIF_WEB_DIST")) if _env("AIF_WEB_DIST") else None)
    # 외부 결과 게시 요청 본문 상한(바이트)
    max_publish_bytes: int = field(default_factory=lambda: _env_int("AIF_MAX_PUBLISH_BYTES", 6_000_000))

    # 시작 시 읽은 .env 파일 진단(값 없음)
    env_files: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.langflow_mode not in LANGFLOW_MODES:
            raise ConfigError(
                t("config.bad_mode", value=repr(self.langflow_mode), allowed=", ".join(LANGFLOW_MODES))
            )
        if self.auth_mode not in AUTH_MODES:
            raise ConfigError(t("config.bad_auth_mode", value=repr(self.auth_mode), allowed=", ".join(AUTH_MODES)))

    @property
    def is_live(self) -> bool:
        return self.langflow_mode == "live"

    def public_dict(self) -> dict:
        """API 키 등 비밀값을 제외한 상태 정보. '설정됨'은 연결 성공을 뜻하지 않는다."""
        return {
            "langflowMode": self.langflow_mode,
            "langflowBaseUrl": self.langflow_base_url if self.is_live else None,
            "flowIdConfigured": bool(self.langflow_flow_id),
            "apiKeyConfigured": bool(self.langflow_api_key),
            "inputComponentId": self.langflow_input_component_id,
            "outputComponentId": self.langflow_output_component_id,
            "timeoutSeconds": self.langflow_timeout_seconds,
            "maxConcurrency": self.max_concurrency,
            "authMode": self.auth_mode,
            "webDist": bool(self.web_dist),
            "envFiles": [
                {"path": item["path"], "exists": item["exists"], "keys": item["keys"]} for item in self.env_files
            ],
        }


def load_settings() -> Settings:
    # 테스트는 개발자 PC 의 실제 .env(live 설정)에 영향받지 않아야 한다.
    report = [] if os.environ.get("AIF_SKIP_DOTENV") == "1" else load_dotenv_files()
    settings = Settings()
    settings.env_files = report
    return settings
