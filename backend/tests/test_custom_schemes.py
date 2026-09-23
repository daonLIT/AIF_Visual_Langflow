"""사용자가 그래프 화면에서 만드는 scheme: 저장·목록 합치기·AI 목록 노출."""
import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")  # app.main import 전에: 실제 .env 를 읽지 않음

import json
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.catalogs import CUSTOM_KEY_PREFIX, SchemeCatalog, is_custom_scheme_key, merged_scheme_catalog
from app.storage import Database

BACKEND = Path(__file__).resolve().parent.parent
# AIF_AUTH_MODE=off 인 시험에서 모든 요청의 주체(principal)
OWNER = "local-dev"
FIXTURE = BACKEND / "fixtures" / "langflow_run_response.sample.json"
CATALOG_PATH = BACKEND / "catalog" / "walton_schemes.json"

NEW_SCHEME = {
    "nameKo": "관행에 의한 논증",
    "nameEn": "Argument from Practice",
    "description": "그 업계에서 오래 지켜온 관행이 있으므로 이 사건에서도 같게 볼 만하다.",
    "premiseRoles": [
        {"label": "관행", "template": "그 업계에는 P 라는 관행이 있다."},
        {"label": "적용", "template": "이 사건은 그 관행이 미치는 범위에 있다."},
    ],
}


def make_client(db=None):
    settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0)
    return TestClient(create_app(settings, db=db or Database(":memory:")))


class CustomSchemeApiTest(unittest.TestCase):
    def setUp(self):
        self.db = Database(":memory:")
        self.client = make_client(self.db)

    def create(self, **overrides):
        return self.client.post("/api/catalogs/schemes/custom", json={**NEW_SCHEME, **overrides})

    def test_create_adds_to_catalog_list(self):
        response = self.create()
        self.assertEqual(response.status_code, 201, response.text)
        key = response.json()["schemeKey"]
        self.assertTrue(key.startswith(CUSTOM_KEY_PREFIX))

        catalog = self.client.get("/api/catalogs/schemes").json()
        added = [s for s in catalog["schemes"] if s["schemeKey"] == key]
        self.assertEqual(len(added), 1)
        scheme = added[0]
        self.assertEqual(scheme["nameKo"], NEW_SCHEME["nameKo"])
        self.assertEqual(scheme["name"], NEW_SCHEME["nameEn"])
        self.assertTrue(scheme["custom"])
        self.assertTrue(scheme["enabledForAi"])
        self.assertFalse(scheme["retired"])
        self.assertEqual([role["roleId"] for role in scheme["premiseRoles"]], ["r1", "r2"])
        # 받지 않는 항목은 기본값으로 채운다.
        self.assertEqual(scheme["criticalQuestions"], [])
        self.assertEqual(scheme["conclusionRole"]["roleId"], "conclusion")

    def test_catalog_version_and_sha_do_not_change(self):
        """사용자가 scheme 을 만들어도 정본 카탈로그 버전·해시는 그대로여야 한다(게시 대조·이행이 깨지지 않게)."""
        before = self.client.get("/api/catalogs/schemes").json()
        self.create()
        after = self.client.get("/api/catalogs/schemes").json()
        self.assertEqual(before["schemeCatalogVersion"], after["schemeCatalogVersion"])
        self.assertEqual(len(after["schemes"]), len(before["schemes"]) + 1)

        file_catalog = SchemeCatalog.load(CATALOG_PATH)
        merged = merged_scheme_catalog(file_catalog, self.db, OWNER)
        self.assertEqual(merged.sha256, file_catalog.sha256)
        self.assertEqual(merged.version, file_catalog.version)

    def test_enabled_scheme_reaches_the_model_list(self):
        key = self.create().json()["schemeKey"]
        merged = merged_scheme_catalog(SchemeCatalog.load(CATALOG_PATH), self.db, OWNER)
        keys = [item["schemeKey"] for item in merged.input_items()]
        self.assertIn(key, keys)

        # AI 사용을 끄면 모델 목록에서 빠지지만 카탈로그에는 남는다(과거 그래프의 이름 표시).
        self.client.put(f"/api/catalogs/schemes/custom/{key}", json={"enabledForAi": False})
        merged = merged_scheme_catalog(SchemeCatalog.load(CATALOG_PATH), self.db, OWNER)
        self.assertNotIn(key, [item["schemeKey"] for item in merged.input_items()])
        self.assertIn(key, merged.by_key)

    def test_retired_scheme_stays_in_catalog(self):
        key = self.create().json()["schemeKey"]
        self.client.put(f"/api/catalogs/schemes/custom/{key}", json={"retired": True})
        catalog = self.client.get("/api/catalogs/schemes").json()
        scheme = next(s for s in catalog["schemes"] if s["schemeKey"] == key)
        self.assertTrue(scheme["retired"])
        merged = merged_scheme_catalog(SchemeCatalog.load(CATALOG_PATH), self.db, OWNER)
        self.assertNotIn(key, [item["schemeKey"] for item in merged.input_items()])

    def test_role_ids_survive_an_edit(self):
        """역할을 하나 지워도 남은 역할의 roleId 는 그대로여야 한다(저장된 premiseBindings 가 가리킨다)."""
        key = self.create().json()["schemeKey"]
        response = self.client.put(
            f"/api/catalogs/schemes/custom/{key}",
            json={
                "nameKo": NEW_SCHEME["nameKo"],
                "description": NEW_SCHEME["description"],
                "premiseRoles": [{"label": "적용"}, {"label": "새 역할"}],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        scheme = next(s for s in response.json()["catalog"]["schemes"] if s["schemeKey"] == key)
        by_label = {role["label"]: role["roleId"] for role in scheme["premiseRoles"]}
        self.assertEqual(by_label["적용"], "r2")
        self.assertNotIn(by_label["새 역할"], ("r2",))
        # 형식 문장을 비우면 역할 이름을 그대로 쓴다.
        self.assertEqual(next(r for r in scheme["premiseRoles"] if r["label"] == "적용")["template"], "적용")

    def test_duplicate_name_is_refused(self):
        self.create()
        response = self.create()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "NAME_TAKEN")

    def test_partial_definition_change_is_refused(self):
        key = self.create().json()["schemeKey"]
        response = self.client.put(f"/api/catalogs/schemes/custom/{key}", json={"nameKo": "이름만 바꾸기"})
        self.assertEqual(response.status_code, 422)

    def test_unknown_key_is_not_found(self):
        response = self.client.put("/api/catalogs/schemes/custom/custom-0000abcd", json={"retired": True})
        self.assertEqual(response.status_code, 404)

    def test_blank_and_oversized_input_is_refused(self):
        self.assertEqual(self.create(nameKo="   ").status_code, 422)
        self.assertEqual(self.create(premiseRoles=[]).status_code, 422)
        self.assertEqual(self.create(premiseRoles=[{"label": "가"}] * 9).status_code, 422)
        self.assertEqual(
            self.create(premiseRoles=[{"label": "같은 이름"}, {"label": "같은 이름"}]).status_code, 422
        )

    def test_custom_key_helper(self):
        self.assertTrue(is_custom_scheme_key("custom-ab12cd34"))
        self.assertFalse(is_custom_scheme_key("custom"))
        self.assertFalse(is_custom_scheme_key("witness_testimony"))
        self.assertFalse(is_custom_scheme_key(None))


class CustomSchemeStorageTest(unittest.TestCase):
    def test_revision_rises_and_history_fields_are_kept(self):
        db = Database(":memory:")
        record = db.insert_custom_scheme(
            "custom-ab12cd34",
            {"schemeKey": "custom-ab12cd34", "nameKo": "가", "premiseRoles": []},
            enabled_for_ai=True,
            by="tester",
            at="2026-09-23T00:00:00+00:00",
        )
        self.assertEqual(record["revision"], 1)
        self.assertEqual(record["createdBy"], "tester")

        updated = db.update_custom_scheme("custom-ab12cd34", enabled_for_ai=False, by="other", at="2026-09-23T01:00:00+00:00")
        self.assertEqual(updated["revision"], 2)
        self.assertFalse(updated["enabledForAi"])
        # 만든 사람과 만든 시각은 남는다.
        self.assertEqual(updated["createdBy"], "tester")
        self.assertEqual(updated["createdAt"], "2026-09-23T00:00:00+00:00")
        self.assertEqual(updated["updatedBy"], "other")
        self.assertIsNone(db.update_custom_scheme("custom-missing", retired=True, by="x", at="y"))

    def test_migration_creates_the_table_on_an_existing_db(self):
        db = Database(":memory:")
        self.assertEqual(db.list_custom_schemes(), [])
        self.assertGreaterEqual(db.schema_version(), 6)


if __name__ == "__main__":
    unittest.main()


class CustomSchemeOwnershipTest(unittest.TestCase):
    """직접 만든 scheme 은 만든 사람만 본다. 두 사람이 같은 서버를 써도 서로 보이지 않아야 한다."""

    PASSWORD = "stress-pass-1234"

    def setUp(self):
        import json as _json
        import os as _os
        import tempfile

        from app.auth import hash_password

        self.tmp = tempfile.TemporaryDirectory()
        users = Path(self.tmp.name) / "users.json"
        scopes = ["catalog:read", "catalog:write", "projects:read", "projects:write"]
        users.write_text(
            _json.dumps(
                {
                    "users": [
                        {"username": "userA", "principal": "userA", "scopes": scopes, "password": hash_password(self.PASSWORD)},
                        {"username": "userB", "principal": "userB", "scopes": scopes, "password": hash_password(self.PASSWORD)},
                    ]
                }
            ),
            encoding="utf-8",
        )
        _os.utime(users, None)
        self.db = Database(":memory:")
        settings = Settings(
            langflow_mode="mock",
            mock_fixture_path=FIXTURE,
            mock_delay_seconds=0,
            auth_mode="token",
            api_tokens_path=Path(self.tmp.name) / "tokens.json",
            users_path=users,
        )
        self.app = create_app(settings, db=self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def session(self, username: str) -> TestClient:
        client = TestClient(self.app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        login = client.post("/api/auth/login", json={"username": username, "password": self.PASSWORD})
        self.assertEqual(login.status_code, 200, login.text)
        client.headers.update({"X-CSRF-Token": login.json()["csrfToken"]})
        return client

    def make(self, client: TestClient, name: str):
        return client.post("/api/catalogs/schemes/custom", json={**NEW_SCHEME, "nameKo": name})

    def keys(self, client: TestClient) -> set[str]:
        return {s["schemeKey"] for s in client.get("/api/catalogs/schemes").json()["schemes"]}

    def test_other_person_does_not_see_it(self):
        a, b = self.session("userA"), self.session("userB")
        key = self.make(a, "A 가 만든 도식").json()["schemeKey"]
        self.assertIn(key, self.keys(a))
        self.assertNotIn(key, self.keys(b))
        # 정본 12개는 둘 다 그대로 본다.
        self.assertEqual(len(self.keys(b)), 12)

    def test_other_person_cannot_change_it(self):
        a, b = self.session("userA"), self.session("userB")
        key = self.make(a, "A 가 만든 도식").json()["schemeKey"]
        # 남의 scheme 은 있는지조차 알리지 않는다.
        self.assertEqual(b.put(f"/api/catalogs/schemes/custom/{key}", json={"retired": True}).status_code, 404)
        self.assertEqual(a.put(f"/api/catalogs/schemes/custom/{key}", json={"retired": True}).status_code, 200)

    def test_same_name_is_allowed_for_different_people(self):
        a, b = self.session("userA"), self.session("userB")
        self.assertEqual(self.make(a, "같은 이름").status_code, 201)
        # 서로 보이지 않으므로 이름이 겹쳐도 된다.
        self.assertEqual(self.make(b, "같은 이름").status_code, 201)
        # 자기 것과는 여전히 겹칠 수 없다.
        self.assertEqual(self.make(a, "같은 이름").status_code, 409)

    def test_model_list_carries_only_the_owner_schemes(self):
        a, b = self.session("userA"), self.session("userB")
        key = self.make(a, "A 가 만든 도식").json()["schemeKey"]
        catalog = SchemeCatalog.load(CATALOG_PATH)
        self.assertIn(key, [item["schemeKey"] for item in merged_scheme_catalog(catalog, self.db, "userA").input_items()])
        self.assertNotIn(key, [item["schemeKey"] for item in merged_scheme_catalog(catalog, self.db, "userB").input_items()])
        # 주체를 모르면 사용자 scheme 을 하나도 싣지 않는다(남의 것이 새지 않게).
        self.assertEqual(len(merged_scheme_catalog(catalog, self.db, None).input_items()), 12)
