"""환경변수 기반 설정. 비밀값은 여기서만 읽고 로그·응답에 노출하지 않는다."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _env_int(name: str, default: int) -> int:
    raw = _env(name, "")
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


@dataclass
class Settings:
    # Langflow 연결. mode 가 'mock' 이면 실제 서버를 호출하지 않고 fixture 를 사용한다.
    langflow_mode: str = field(default_factory=lambda: _env("LANGFLOW_MODE", "mock").lower())
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
    langflow_timeout_seconds: int = field(default_factory=lambda: _env_int("LANGFLOW_TIMEOUT_SECONDS", 900))
    mock_fixture_path: Path = field(
        default_factory=lambda: Path(
            _env("LANGFLOW_MOCK_FIXTURE", str(BACKEND_ROOT / "fixtures" / "langflow_run_response.sample.json"))
        )
    )
    mock_delay_seconds: float = field(default_factory=lambda: float(_env("LANGFLOW_MOCK_DELAY_SECONDS", "1.5")))

    # 실행 관리
    max_concurrency: int = field(default_factory=lambda: _env_int("ANALYSIS_MAX_CONCURRENCY", 1))
    # 저장소
    database_path: Path = field(
        default_factory=lambda: Path(_env("DATABASE_PATH", str(BACKEND_ROOT / "data" / "annotation.sqlite3")))
    )

    def public_dict(self) -> dict:
        """API 키 등 비밀값을 제외한 상태 정보."""
        return {
            "langflowMode": self.langflow_mode,
            "langflowBaseUrl": self.langflow_base_url if self.langflow_mode == "live" else None,
            "flowIdConfigured": bool(self.langflow_flow_id),
            "apiKeyConfigured": bool(self.langflow_api_key),
            "inputComponentId": self.langflow_input_component_id,
            "outputComponentId": self.langflow_output_component_id,
            "timeoutSeconds": self.langflow_timeout_seconds,
            "maxConcurrency": self.max_concurrency,
        }


def load_settings() -> Settings:
    return Settings()
