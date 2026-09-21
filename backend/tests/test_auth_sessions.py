import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")

import json
import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from app.auth import hash_password
from app.config import Settings
from app.main import create_app
from app.storage import Database
from tests.test_integrations import FIXTURE

PASSWORD = "correct-horse-battery"


class SessionAuthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.users = Path(self.tmp.name) / "users.json"
        self.write_users([
            {"username": "owner", "principal": "owner", "scopes": ["catalog:read", "projects:read", "projects:write"], "password": hash_password(PASSWORD)},
        ])
        self.settings = Settings(
            langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0,
            auth_mode="token", api_tokens_path=Path(self.tmp.name) / "tokens.json", users_path=self.users,
        )
        self.client = TestClient(create_app(self.settings, db=Database(":memory:")))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def write_users(self, users):
        self.users.write_text(json.dumps({"users": users}), encoding="utf-8")
        mtime = os.path.getmtime(self.users) + (getattr(self, "_bump", 0) + 1)
        self._bump = getattr(self, "_bump", 0) + 1
        os.utime(self.users, (mtime, mtime))

    def login(self, password=PASSWORD, username="owner"):
        return self.client.post("/api/auth/login", json={"username": username, "password": password})

    def test_login_sets_strict_httponly_cookie_and_returns_csrf(self):
        self.assertEqual(self.client.get("/api/auth/session").status_code, 401)
        response = self.login()
        self.assertEqual(response.status_code, 200, response.text)
        cookie = response.headers["set-cookie"]
        self.assertIn("aif_session=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=strict", cookie)
        self.assertNotIn("Secure", cookie)  # 로컬 http
        body = response.json()
        self.assertEqual(body["user"]["username"], "owner")
        self.assertTrue(body["csrfToken"])
        self.assertNotIn(cookie.split("aif_session=")[1].split(";")[0], response.text)
        session = self.client.get("/api/auth/session").json()
        self.assertEqual(session["csrfToken"], body["csrfToken"])

    def test_cookie_session_needs_csrf_for_changes_and_keeps_scopes(self):
        csrf = self.login().json()["csrfToken"]
        self.assertEqual(self.client.get("/api/projects").status_code, 200)
        put = self.client.put("/api/projects/p1", json={})
        self.assertEqual((put.status_code, put.json()["error"]["code"]), (403, "CSRF_FAILED"))
        put = self.client.put("/api/projects/p1", json={}, headers={"X-CSRF-Token": "wrong"})
        self.assertEqual(put.status_code, 403)
        put = self.client.put("/api/projects/p1", json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(put.status_code, 422)  # 인증·CSRF 통과 → 본문 검증 단계
        self.assertEqual(self.client.get("/api/pipelines").status_code, 403)
        publish = self.client.post("/api/integrations/langflow/results", json={}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(publish.status_code, 403)

    def test_wrong_password_then_lockout(self):
        for _ in range(5):
            self.assertEqual(self.login("wrong-password").status_code, 401)
        self.assertEqual(self.login().status_code, 429)
        unknown = self.login(username="nobody")
        self.assertEqual(unknown.status_code, 401)
        self.assertEqual(unknown.json()["error"]["code"], "LOGIN_FAILED")

    def test_logout_and_disabled_user_end_the_session(self):
        self.login()
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/projects").status_code, 401)
        self.login()
        self.assertEqual(self.client.get("/api/projects").status_code, 200)
        users = json.loads(self.users.read_text(encoding="utf-8"))["users"]
        users[0]["disabled"] = True
        self.write_users(users)
        self.assertEqual(self.client.get("/api/projects").status_code, 401)

    def test_secure_cookie_behind_https_proxy(self):
        response = self.client.post(
            "/api/auth/login", json={"username": "owner", "password": PASSWORD}, headers={"X-Forwarded-Proto": "https"}
        )
        self.assertIn("Secure", response.headers["set-cookie"])

    def test_bearer_token_does_not_need_csrf(self):
        # 토큰은 브라우저가 자동으로 붙이지 않으므로 CSRF 대상이 아니다(tests.test_integrations.TokenAuthTest 가 PUT 을 검증).
        self.assertEqual(self.client.put("/api/projects/p1", json={}, headers={"Authorization": "Bearer nope"}).status_code, 401)


class AuthOffTest(unittest.TestCase):
    def test_session_reports_local_dev(self):
        settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0)
        with TestClient(create_app(settings, db=Database(":memory:"))) as client:
            body = client.get("/api/auth/session").json()
            self.assertEqual((body["authMode"], body["user"]["username"], body["csrfToken"]), ("off", "local-dev", None))
            self.assertEqual(client.post("/api/auth/login", json={}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
