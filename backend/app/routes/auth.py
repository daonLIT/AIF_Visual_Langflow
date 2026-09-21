"""브라우저 로그인: 세션 쿠키 발급·확인·삭제. 토큰(Desktop·Flow)과 별개다."""
from __future__ import annotations

import json

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..auth import SCOPES, SESSION_COOKIE
from ..i18n import t
from .api import _error


def _secure(request: Request) -> bool:
    mode = request.app.state.settings.cookie_secure
    if mode in ("true", "1", "yes"):
        return True
    if mode in ("false", "0", "no"):
        return False
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or forwarded == "https"


def _describe(request: Request, principal) -> dict:
    settings = request.app.state.settings
    return {
        "authMode": settings.auth_mode,
        "user": {"username": principal.username, "principal": principal.principal},
        "scopes": sorted(principal.scopes),
        # 쿠키로 인증한 브라우저만 CSRF 토큰이 필요하다(상태를 바꾸는 요청의 X-CSRF-Token 헤더).
        "csrfToken": principal.csrf_token,
    }


async def session(request: Request) -> Response:
    principal = request.state.principal
    if principal is None:
        return _error(401, "AUTH_REQUIRED", t("auth.required"))
    return JSONResponse(_describe(request, principal))


async def login(request: Request) -> Response:
    settings = request.app.state.settings
    if settings.auth_mode == "off":
        return JSONResponse(_describe(request, request.state.principal))
    try:
        body = json.loads(await request.body())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _error(400, "BAD_JSON", t("api.bad_json"))
    username = body.get("username") if isinstance(body, dict) else None
    password = body.get("password") if isinstance(body, dict) else None
    if not isinstance(username, str) or not isinstance(password, str) or not (0 < len(username) <= 64) or not (0 < len(password) <= 256):
        return _error(422, "VALIDATION", t("auth.login_input"))
    address = request.client.host if request.client else ""
    limiter = request.app.state.login_limiter
    if limiter.blocked(username, address):
        return _error(429, "LOGIN_LOCKED", t("auth.login_locked"))
    user = request.app.state.users.verify(username, password)
    if user is None:
        limiter.failed(username, address)
        return _error(401, "LOGIN_FAILED", t("auth.login_failed"))
    limiter.succeeded(username, address)
    cookie, csrf, _expires = request.app.state.sessions.create(user)
    scopes = sorted(s for s in user.get("scopes", []) if s in SCOPES)
    response = JSONResponse(
        {
            "authMode": settings.auth_mode,
            "user": {"username": user["username"], "principal": str(user.get("principal") or user["username"])},
            "scopes": scopes,
            "csrfToken": csrf,
        }
    )
    response.set_cookie(
        SESSION_COOKIE,
        cookie,
        max_age=settings.session_ttl_hours * 3600,
        path="/",
        httponly=True,
        samesite="strict",
        secure=_secure(request),
    )
    return response


async def logout(request: Request) -> Response:
    cookie = request.cookies.get(SESSION_COOKIE)
    if cookie:
        request.app.state.sessions.delete(cookie)
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="strict", secure=_secure(request))
    return response


routes = [
    Route("/api/auth/session", session, methods=["GET"]),
    Route("/api/auth/login", login, methods=["POST"]),
    Route("/api/auth/logout", logout, methods=["POST"]),
]
