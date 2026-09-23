"""
API 인증과 권한(scope).

- AIF_AUTH_MODE=off: 로컬 개발용. 모든 요청을 'local-dev' 주체로 보고 모든 권한을 준다.
- AIF_AUTH_MODE=token: /api/health 를 뺀 모든 /api 요청에 `Authorization: Bearer <토큰>` 이 필요하다.
  토큰 파일(AIF_API_TOKENS_FILE)에는 토큰 원문이 아니라 sha256 만 둔다. 파일이 바뀌면 다음 요청부터 다시 읽는다(키 교체).
- 경로마다 필요한 권한이 정해져 있고, 표에 없는 /api 경로는 'admin' 권한이 있어야 한다(기본 거부).
- 게시 중복 판정의 주체는 토큰이 아니라 토큰의 principal(연동 ID)이다. 토큰을 바꿔도 같은 연동의 재전송은 같은 결과로 묶인다.
- 브라우저는 로그인(POST /api/auth/login)으로 받은 세션 쿠키(aif_session, HttpOnly, SameSite=Strict)를 쓴다.
  쿠키로 인증한 요청이 GET·HEAD 가 아니면 X-CSRF-Token 헤더가 세션의 CSRF 토큰과 같아야 한다.
  세션은 DB 에 해시로만 두고, 계정 파일(AIF_USERS_FILE)에는 scrypt 해시만 둔다.
- 토큰·세션·비밀번호 값은 로그·응답에 남기지 않는다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from starlette.responses import JSONResponse

from .i18n import t

logger = logging.getLogger("annotation.auth")

SCOPES = (
    "catalog:read",
    # 그래프 화면에서 scheme 을 직접 만들고 고치는 권한. 정본 카탈로그 파일은 바꾸지 못한다.
    "catalog:write",
    "results:publish",
    "projects:read",
    "projects:write",
    "analysis:run",
    "pipeline:admin",
    "admin",
)

# (메서드, 경로 정규식) → 필요한 권한. 위에서부터 처음 맞는 규칙을 쓴다.
ROUTE_SCOPES: list[tuple[frozenset[str], re.Pattern, str]] = [
    (frozenset({"POST", "PUT"}), re.compile(r"^/api/catalogs/schemes/custom(/.*)?$"), "catalog:write"),
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

PUBLIC_PATHS = frozenset({"/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/session"})
SESSION_COOKIE = "aif_session"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class Principal:
    principal: str
    token_id: str
    scopes: frozenset[str]
    # 세션 쿠키로 인증했을 때만: 사용자 이름과 CSRF 토큰
    username: str | None = None
    csrf_token: str | None = None

    def allows(self, scope: str) -> bool:
        return scope in self.scopes or "admin" in self.scopes


LOCAL_DEV = Principal("local-dev", "local-dev", frozenset(SCOPES), username="local-dev")


# ---- 비밀번호 (scrypt, 표준 라이브러리) ----
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, **_SCRYPT)
    parts = ["scrypt", str(_SCRYPT["n"]), str(_SCRYPT["r"]), str(_SCRYPT["p"]), base64.b64encode(salt).decode(), base64.b64encode(digest).decode()]
    return "$".join(parts)


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt), dklen=len(expected), n=int(n), r=int(r), p=int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# 계정이 없을 때도 같은 시간이 걸리게 비교할 더미 해시(사용자 이름 추측 방지)
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


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


class UserStore(TokenStore):
    """계정 파일: {"users": [{username, principal, scopes, password(scrypt), disabled}]}. 파일이 바뀌면 다시 읽는다."""

    def _load(self) -> list[dict]:
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            self._mtime, self._entries = None, []
            return []
        if mtime != self._mtime:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                entries = [e for e in data.get("users", []) if isinstance(e, dict) and isinstance(e.get("username"), str)]
            except (OSError, ValueError, AttributeError):
                logger.error("user file could not be read: %s", self.path)
                entries = []
            self._mtime, self._entries = mtime, entries
        return self._entries

    def active(self, username: str) -> bool:
        with self._lock:
            entries = self._load()
        return any(e["username"] == username and not e.get("disabled") for e in entries)

    def verify(self, username: str, password: str) -> dict | None:
        with self._lock:
            entries = self._load()
        user = next((e for e in entries if e["username"] == username and not e.get("disabled")), None)
        ok = verify_password(password, user["password"] if user else _DUMMY_HASH)
        return user if (user and ok) else None


class LoginLimiter:
    """같은 사용자 이름·주소의 로그인 실패가 window 초 안에 limit 번이면 잠시 막는다(메모리, 단일 프로세스)."""

    def __init__(self, limit: int = 5, window: float = 600.0):
        self.limit = limit
        self.window = window
        self._failures: dict[tuple[str, str], list[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: tuple[str, str], now: float) -> list[float]:
        return [t for t in self._failures.get(key, []) if now - t < self.window]

    def blocked(self, username: str, address: str) -> bool:
        now = time.monotonic()
        with self._lock:
            return len(self._recent((username, address), now)) >= self.limit

    def failed(self, username: str, address: str) -> None:
        now = time.monotonic()
        with self._lock:
            key = (username, address)
            self._failures[key] = [*self._recent(key, now), now]

    def succeeded(self, username: str, address: str) -> None:
        with self._lock:
            self._failures.pop((username, address), None)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


class SessionManager:
    def __init__(self, db, ttl_hours: int, users: "UserStore | None" = None):
        self.db = db
        self.ttl = timedelta(hours=max(1, ttl_hours))
        # 계정을 끄거나 지우면 이미 발급한 세션도 바로 막는다.
        self.users = users

    def create(self, user: dict) -> tuple[str, str, datetime]:
        """(쿠키 값, CSRF 토큰, 만료 시각). DB 에는 쿠키 값의 해시만 남긴다."""
        cookie = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        now = _now()
        expires = now + self.ttl
        scopes = [s for s in user.get("scopes", []) if s in SCOPES]
        principal = str(user.get("principal") or user["username"])
        self.db.create_session(hash_token(cookie), user["username"], principal, scopes, csrf, _iso(now), _iso(expires))
        return cookie, csrf, expires

    def principal(self, cookie: str) -> Principal | None:
        row = self.db.get_session(hash_token(cookie), _iso(_now()))
        if row is None:
            return None
        if self.users is not None and not self.users.active(row["username"]):
            return None
        return Principal(
            row["principal"], f"session:{row['username']}", frozenset(row["scopes"]), username=row["username"], csrf_token=row["csrf_token"]
        )

    def delete(self, cookie: str) -> None:
        self.db.delete_session(hash_token(cookie))


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


def make_auth_middleware(settings, sessions: SessionManager):
    store = TokenStore(settings.api_tokens_path)

    async def auth_middleware(request, call_next):
        path = request.url.path
        request.state.principal = None
        request.state.auth_via = None
        if not path.startswith("/api/") or request.method == "OPTIONS":
            return await call_next(request)
        if settings.auth_mode == "off":
            request.state.principal = LOCAL_DEV
            request.state.auth_via = "off"
            return await call_next(request)
        principal = None
        token = bearer_token(request.headers.get("authorization"))
        if token:
            principal = store.authenticate(token)
            request.state.auth_via = "token" if principal else None
        else:
            cookie = request.cookies.get(SESSION_COOKIE)
            if cookie:
                principal = sessions.principal(cookie)
                request.state.auth_via = "session" if principal else None
        request.state.principal = principal
        if path in PUBLIC_PATHS:
            return await call_next(request)
        if principal is None:
            return _error(401, "AUTH_REQUIRED", t("auth.required"))
        # 쿠키 인증은 브라우저가 자동으로 붙이므로, 상태를 바꾸는 요청에는 CSRF 토큰을 요구한다.
        if request.state.auth_via == "session" and request.method not in SAFE_METHODS:
            sent = request.headers.get(CSRF_HEADER) or ""
            if not principal.csrf_token or not hmac.compare_digest(sent, principal.csrf_token):
                return _error(403, "CSRF_FAILED", t("auth.csrf"))
        if not principal.allows(required_scope(request.method, path)):
            return _error(403, "FORBIDDEN", t("auth.forbidden"))
        return await call_next(request)

    return auth_middleware
