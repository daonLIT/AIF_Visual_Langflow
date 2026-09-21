"""
API 인증과 권한(scope).

- AIF_AUTH_MODE=off: 로컬 개발용. 모든 요청을 'local-dev' 주체로 보고 모든 권한을 준다.
- AIF_AUTH_MODE=token: /api/health 를 뺀 모든 /api 요청에 `Authorization: Bearer <토큰>` 이 필요하다.
  토큰 파일(AIF_API_TOKENS_FILE)에는 토큰 원문이 아니라 sha256 만 둔다. 파일이 바뀌면 다음 요청부터 다시 읽는다(키 교체).
- 경로마다 필요한 권한이 정해져 있고, 표에 없는 /api 경로는 'admin' 권한이 있어야 한다(기본 거부).
- 게시 중복 판정의 주체는 토큰이 아니라 토큰의 principal(연동 ID)이다. 토큰을 바꿔도 같은 연동의 재전송은 같은 결과로 묶인다.
- 토큰 값은 로그·응답에 남기지 않는다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from starlette.responses import JSONResponse

from .i18n import t

logger = logging.getLogger("annotation.auth")

SCOPES = (
    "catalog:read",
    "results:publish",
    "projects:read",
    "projects:write",
    "analysis:run",
    "pipeline:admin",
    "admin",
)

# (메서드, 경로 정규식) → 필요한 권한. 위에서부터 처음 맞는 규칙을 쓴다.
ROUTE_SCOPES: list[tuple[frozenset[str], re.Pattern, str]] = [
    (frozenset({"GET"}), re.compile(r"^/api/catalogs/(issues|schemes)$"), "catalog:read"),
    (frozenset({"GET"}), re.compile(r"^/api/integrations/langflow/context$"), "catalog:read"),
    (frozenset({"POST"}), re.compile(r"^/api/integrations/langflow/results$"), "results:publish"),
    (frozenset({"GET"}), re.compile(r"^/api/projects$"), "projects:read"),
    (frozenset({"GET"}), re.compile(r"^/api/projects/[^/]+$"), "projects:read"),
    (frozenset({"PUT"}), re.compile(r"^/api/projects/[^/]+$"), "projects:write"),
    (frozenset({"POST"}), re.compile(r"^/api/evidence/verify$"), "projects:read"),
    (frozenset({"GET", "POST"}), re.compile(r"^/api/analysis-runs(/.*)?$"), "analysis:run"),
    (frozenset({"POST"}), re.compile(r"^/api/summaries$"), "analysis:run"),
    (frozenset({"GET", "POST", "PUT", "DELETE"}), re.compile(r"^/api/(pipelines|pipeline-components|pipeline-settings|connections|diagnostics)(/.*)?$"), "pipeline:admin"),
]

PUBLIC_PATHS = frozenset({"/api/health"})


@dataclass(frozen=True)
class Principal:
    principal: str
    token_id: str
    scopes: frozenset[str]

    def allows(self, scope: str) -> bool:
        return scope in self.scopes or "admin" in self.scopes


LOCAL_DEV = Principal("local-dev", "local-dev", frozenset(SCOPES))


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def required_scope(method: str, path: str) -> str:
    for methods, pattern, scope in ROUTE_SCOPES:
        if method in methods and pattern.match(path):
            return scope
    return "admin"


class TokenStore:
    """토큰 파일을 읽는다. 파일 수정 시각이 바뀌면 다시 읽는다."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._mtime: float | None = None
        self._entries: list[dict] = []

    def _load(self) -> list[dict]:
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            self._mtime, self._entries = None, []
            return []
        if mtime != self._mtime:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                entries = [e for e in data.get("tokens", []) if isinstance(e, dict) and isinstance(e.get("sha256"), str)]
            except (OSError, ValueError, AttributeError):
                logger.error("token file could not be read: %s", self.path)
                entries = []
            self._mtime, self._entries = mtime, entries
        return self._entries

    def authenticate(self, token: str) -> Principal | None:
        digest = hash_token(token)
        with self._lock:
            entries = self._load()
        for entry in entries:
            if entry.get("disabled"):
                continue
            if hmac.compare_digest(entry["sha256"], digest):
                scopes = frozenset(s for s in entry.get("scopes", []) if s in SCOPES)
                return Principal(str(entry.get("principal") or entry.get("id")), str(entry.get("id")), scopes)
        return None


def _error(status: int, code: str, message: str) -> JSONResponse:
    headers = {"WWW-Authenticate": "Bearer"} if status == 401 else None
    return JSONResponse({"error": {"code": code, "message": message, "details": []}}, status_code=status, headers=headers)


def bearer_token(header: str | None) -> str | None:
    if not header:
        return None
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip() or None


def make_auth_middleware(settings):
    store = TokenStore(settings.api_tokens_path)

    async def auth_middleware(request, call_next):
        path = request.url.path
        request.state.principal = None
        if not path.startswith("/api/") or request.method == "OPTIONS":
            return await call_next(request)
        if settings.auth_mode == "off":
            request.state.principal = LOCAL_DEV
            return await call_next(request)
        token = bearer_token(request.headers.get("authorization"))
        principal = store.authenticate(token) if token else None
        request.state.principal = principal
        if path in PUBLIC_PATHS:
            return await call_next(request)
        if principal is None:
            return _error(401, "AUTH_REQUIRED", t("auth.required"))
        if not principal.allows(required_scope(request.method, path)):
            return _error(403, "FORBIDDEN", t("auth.forbidden"))
        return await call_next(request)

    return auth_middleware
