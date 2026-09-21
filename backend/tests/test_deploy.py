"""운영 배포: 같은 출처 웹 제공, 보안 헤더, 백업·검증·복구."""
import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from app.config import ConfigError, Settings
from app.main import create_app
from app.storage import Database
from tests.test_integrations import FIXTURE, body, catalogs_of

BACKEND = Path(__file__).resolve().parent.parent


class WebDistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        dist = Path(self.tmp.name) / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html><div id=root class=aif-root></div>", encoding="utf-8")
        (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
        self.dist = dist

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_origin_web_and_api(self):
        settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0, web_dist=self.dist)
        with TestClient(create_app(settings, db=Database(":memory:"))) as client:
            index = client.get("/")
            self.assertEqual(index.status_code, 200)
            self.assertIn("aif-root", index.text)
            self.assertEqual(client.get("/?projectId=project-1").status_code, 200)
            self.assertEqual(client.get("/assets/app.js").status_code, 200)
            health = client.get("/api/health")
            self.assertEqual(health.json()["status"], "ok")
            for response in (index, health):
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                self.assertEqual(response.headers["x-frame-options"], "DENY")
                self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
            self.assertEqual(health.headers["cache-control"], "no-store")
            self.assertEqual(client.get("/api/unknown-path").status_code, 404)

    def test_missing_index_is_a_startup_error(self):
        (self.dist / "index.html").unlink()
        with self.assertRaises(ConfigError):
            create_app(Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, web_dist=self.dist), db=Database(":memory:"))


class LangflowOffTest(unittest.TestCase):
    def test_central_only_server_closes_langflow_routes(self):
        settings = Settings(langflow_mode="off", mock_fixture_path=FIXTURE)
        with TestClient(create_app(settings, db=Database(":memory:"))) as client:
            self.assertEqual(client.get("/api/health").json()["langflow"]["langflowMode"], "off")
            self.assertIn(client.post("/api/analysis-runs", json={}).status_code, (404, 405))
            self.assertIn(client.post("/api/summaries", json={}).status_code, (404, 405))
            self.assertEqual(client.get("/api/pipelines").status_code, 404)
            # 게시·검토·저장은 그대로
            saved = client.post("/api/integrations/langflow/results", json=body(catalogs_of(client)))
            self.assertEqual(saved.status_code, 201, saved.text)
            self.assertEqual(client.get(f"/api/analysis-runs/{saved.json()['runId']}").status_code, 200)
            self.assertEqual(client.get("/api/projects").status_code, 200)


class BackupTest(unittest.TestCase):
    def test_backup_verify_rotate_and_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            db_path = tmp / "data" / "annotation.sqlite3"
            tokens = tmp / "data" / "api_tokens.json"
            tokens.parent.mkdir(parents=True)
            tokens.write_text(json.dumps({"tokens": []}), encoding="utf-8")
            db = Database(db_path)
            settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0)
            with TestClient(create_app(settings, db=db)) as client:
                saved = client.post("/api/integrations/langflow/results", json=body(catalogs_of(client))).json()
            env = {**os.environ, "DATABASE_PATH": str(db_path), "AIF_API_TOKENS_FILE": str(tokens), "AIF_USERS_FILE": str(tmp / "none.json"), "PYTHONIOENCODING": "utf-8"}
            script = str(BACKEND / "scripts" / "backup_db.py")
            folders = []
            for _ in range(3):
                out = subprocess.run([sys.executable, script, "--out-dir", str(tmp / "backups"), "--keep", "2"], env=env, capture_output=True, text=True, encoding="utf-8", check=True)
                folders.append(Path(out.stdout.strip()))
                # 같은 초에 두 번 만들지 않게
                import time

                time.sleep(1.1)
            remaining = sorted(p.name for p in (tmp / "backups").iterdir())
            self.assertEqual(remaining, sorted(p.name for p in folders[-2:]))
            latest = folders[-1]
            manifest = json.loads((latest / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["database"]["projects"], 1)
            self.assertEqual(manifest["database"]["integrity"], "ok")
            self.assertIn("tokens", manifest["files"])
            check = subprocess.run([sys.executable, script, "--verify", str(latest)], env=env, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(check.returncode, 0, check.stdout)

            # 복구: 서버를 멈춘 뒤(연결 닫기) 백업 사본을 원래 자리로 복사하면 같은 프로젝트가 열린다.
            db.close()
            db_path.unlink()
            shutil.copy2(latest / "annotation.sqlite3", db_path)
            restored = Database(db_path)
            self.assertEqual(restored.get_project(saved["projectId"])["projectId"], saved["projectId"])
            restored.close()

            # 손상된 백업은 검증에서 걸린다.
            (latest / "api_tokens.json").write_text("tampered", encoding="utf-8")
            bad = subprocess.run([sys.executable, script, "--verify", str(latest)], env=env, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(bad.returncode, 1)


if __name__ == "__main__":
    unittest.main()
