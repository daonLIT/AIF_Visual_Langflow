"""
Langflow 중계 서버 진입점.

실행: uvicorn app.main:app --host 127.0.0.1 --port 8000
환경변수는 backend/.env 또는 셸에서 설정한다 (.env.example 참고).
"""
from __future__ import annotations

import contextlib
import logging
import os
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

from .config import Settings, load_settings
from .routes.api import routes
from .services.langflow_client import LangflowClient
from .services.run_manager import RunManager
from .storage import Database


def _load_dotenv(path: Path) -> None:
    """의존성 없이 KEY=VALUE 형식의 .env 를 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def create_app(settings: Settings | None = None, *, transport=None, db: Database | None = None) -> Starlette:
    if settings is None:
        _load_dotenv(Path(__file__).resolve().parent.parent / ".env")
        settings = load_settings()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    owns_database = db is None
    database = db or Database(settings.database_path)
    client = LangflowClient(settings, transport=transport)
    runs = RunManager(settings, database, client)

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        runs.recover_interrupted()
        yield
        await runs.shutdown()
        if owns_database:
            database.close()

    app = Starlette(
        routes=routes,
        lifespan=lifespan,
        middleware=[
            # 개발 중 Vite dev 서버(다른 포트)에서 호출할 수 있게 허용. 배포 시엔 같은 출처를 권장.
            Middleware(
                CORSMiddleware,
                allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                allow_methods=["*"],
                allow_headers=["*"],
            )
        ],
    )
    app.state.settings = settings
    app.state.db = database
    app.state.runs = runs
    return app


app = create_app()
