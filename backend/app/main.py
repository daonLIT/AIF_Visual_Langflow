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
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from .auth import LoginLimiter, SessionManager, UserStore, make_auth_middleware
from .config import ConfigError, Settings, load_settings
from .i18n import parse_accept_language, reset_language, set_language
from .routes.api import routes as api_routes
from .routes.auth import routes as auth_routes
from .routes.integrations import routes as integration_routes
from .routes.pipeline import routes as pipeline_routes
from .services.catalogs import CatalogError, IssueCatalog, SchemeCatalog
from .services.langflow_client import LangflowClient
from .services.pipeline.repository import LangflowFlowRepository, LocalFlowRepository
from .services.pipeline.service import PipelineService
from .services.publication import PublicationService
from .services.run_manager import RunManager
from .storage import Database

logger = logging.getLogger("annotation.main")


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    # 웹은 같은 출처의 스크립트·스타일·API 만 쓴다. 이미지·폰트는 data: 도 허용(React Flow·아이콘).
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
        "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    ),
}


async def security_headers_middleware(request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    if request.url.path.startswith("/api/"):
        # 원문·그래프가 담긴 응답은 공유 캐시에 남기지 않는다.
        response.headers.setdefault("Cache-Control", "no-store")
    return response


async def language_middleware(request, call_next):
    """Accept-Language 로 이 요청의 메시지 언어를 정한다 (지원: ko, en)."""
    token = set_language(parse_accept_language(request.headers.get("accept-language")))
    try:
        return await call_next(request)
    finally:
        reset_language(token)


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

    # 서버 시작 때는 요청 언어를 모르므로 오류를 그대로 담아 두고, 응답할 때 그 요청의 언어로 만든다.
    catalog_errors: list[CatalogError] = []
    issue_catalog = scheme_catalog = None
    try:
        issue_catalog = IssueCatalog.load(settings.issue_catalog_path)
    except CatalogError as error:
        catalog_errors.append(error)
    try:
        scheme_catalog = SchemeCatalog.load(settings.scheme_catalog_path)
    except CatalogError as error:
        catalog_errors.append(error)
    for error in catalog_errors:
        logger.warning("%s", error)

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
    publication = PublicationService(settings, database, issue_catalog=issue_catalog, scheme_catalog=scheme_catalog)
    users = UserStore(settings.users_path)
    sessions = SessionManager(database, settings.session_ttl_hours, users)

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

    if settings.langflow_mode == "off":
        # 중앙 서버만 운영: 사이트에서 Langflow 를 부르는 경로(분석 시작·취소·요약·파이프라인)는 열지 않는다.
        # 실행 기록 조회(GET)는 Desktop 이 게시한 실행을 보여 주므로 남긴다. mock 결과가 운영 데이터에 섞이지 않게 하려는 것이다.
        closed = {("/api/analysis-runs", "POST"), ("/api/analysis-runs/{run_id}/cancel", "POST"), ("/api/summaries", "POST")}
        kept = [route for route in api_routes if not any((route.path, method) in closed for method in (route.methods or []))]
        routes = [*kept, *integration_routes, *auth_routes]
    else:
        routes = [*api_routes, *pipeline_routes, *integration_routes, *auth_routes]
    if settings.web_dist is not None:
        if not (settings.web_dist / "index.html").exists():
            raise ConfigError(f"AIF_WEB_DIST 에 index.html 이 없습니다: {settings.web_dist}")
        # /api 경로가 먼저 맞고, 나머지는 빌드한 웹(단일 페이지: / 와 ?projectId=)이다.
        routes.append(Mount("/", app=StaticFiles(directory=settings.web_dist, html=True), name="web"))

    app = Starlette(
        routes=routes,
        lifespan=lifespan,
        middleware=[
            Middleware(BaseHTTPMiddleware, dispatch=security_headers_middleware),
            # 개발 중 Vite dev 서버(다른 포트)에서 호출할 수 있게 허용. 배포 시엔 같은 출처를 권장.
            Middleware(
                CORSMiddleware,
                allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                allow_methods=["*"],
                allow_headers=["*"],
            ),
            # 이 요청 동안의 메시지 언어. 분석 실행 task 도 이 컨텍스트를 물려받는다.
            Middleware(BaseHTTPMiddleware, dispatch=language_middleware),
            # 토큰·권한 확인 (AIF_AUTH_MODE=off 면 로컬 개발 주체로 통과). 언어가 정해진 뒤라 오류 문구도 요청 언어로.
            Middleware(BaseHTTPMiddleware, dispatch=make_auth_middleware(settings, sessions)),
        ],
    )
    app.state.settings = settings
    app.state.db = database
    app.state.runs = runs
    app.state.pipeline = pipeline
    app.state.publication = publication
    app.state.sessions = sessions
    app.state.users = users
    app.state.login_limiter = LoginLimiter()
    app.state.issue_catalog = issue_catalog
    app.state.scheme_catalog = scheme_catalog
    app.state.catalog_errors = catalog_errors
    return app


app = create_app()
