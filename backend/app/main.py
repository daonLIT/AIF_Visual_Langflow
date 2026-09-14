"""
Langflow 중계 서버 진입점.

실행: uvicorn app.main:app --host 127.0.0.1 --port 8000
환경변수는 셸, backend/.env, 프로젝트 루트 .env 순서로 읽는다 (.env.example 참고).
LANGFLOW_MODE 가 mock / live 가 아니면 시작하지 않는다.
"""
from __future__ import annotations

import contextlib
import logging

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

from .config import Settings, load_settings
from .routes.api import routes as api_routes
from .routes.pipeline import routes as pipeline_routes
from .services.catalogs import CatalogError, IssueCatalog, SchemeCatalog
from .services.langflow_client import LangflowClient
from .services.pipeline.repository import LangflowFlowRepository, LocalFlowRepository
from .services.pipeline.service import PipelineService
from .services.run_manager import RunManager
from .storage import Database

logger = logging.getLogger("annotation.main")


def create_app(
    settings: Settings | None = None,
    *,
    transport=None,
    db: Database | None = None,
    flow_repository=None,
) -> Starlette:
    if settings is None:
        settings = load_settings()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # 요청마다 URL 을 남기는 httpx 로그는 끈다 (Langflow 주소·flow ID 가 로그에 반복되지 않게).
    logging.getLogger("httpx").setLevel(logging.WARNING)

    catalog_errors: list[str] = []
    issue_catalog = scheme_catalog = None
    try:
        issue_catalog = IssueCatalog.load(settings.issue_catalog_path)
    except CatalogError as error:
        catalog_errors.append(str(error))
    try:
        scheme_catalog = SchemeCatalog.load(settings.scheme_catalog_path)
    except CatalogError as error:
        catalog_errors.append(str(error))
    for message in catalog_errors:
        logger.warning(message)

    owns_database = db is None
    database = db or Database(settings.database_path)
    client = LangflowClient(settings, transport=transport)
    runs = RunManager(settings, database, client, issue_catalog=issue_catalog, scheme_catalog=scheme_catalog)
    if flow_repository is None:
        flow_repository = (
            LangflowFlowRepository(settings) if settings.is_live else LocalFlowRepository(database, settings.mock_flow_files)
        )
    pipeline = PipelineService(settings, database, flow_repository, issue_catalog=issue_catalog, scheme_catalog=scheme_catalog)
    runs.pipeline = pipeline

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        runs.recover_interrupted()
        loaded = [item["path"] for item in settings.env_files if item["exists"]]
        logger.info("mode=%s env files=%s", settings.langflow_mode, loaded or "none")
        if database.backup_path:
            logger.warning("database migrated to schema v%d (backup: %s)", database.schema_version(), database.backup_path)
        yield
        await runs.shutdown()
        if owns_database:
            database.close()

    app = Starlette(
        routes=[*api_routes, *pipeline_routes],
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
    app.state.pipeline = pipeline
    app.state.issue_catalog = issue_catalog
    app.state.scheme_catalog = scheme_catalog
    app.state.catalog_errors = catalog_errors
    return app


app = create_app()
