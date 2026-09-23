"""사건 목록: 쪽 나누기·검색·목록 열.

사건이 늘어도 목록 응답과 처리 시간이 일정해야 한다. 문서 전체를 읽으면 목록 요청 하나가
이벤트 루프를 오래 붙잡아 다른 요청까지 같이 느려진다(단일 워커).
"""
import os

os.environ.setdefault("AIF_SKIP_DOTENV", "1")  # app.main import 전에: 실제 .env 를 읽지 않음

import unittest
from pathlib import Path

from starlette.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.storage import Database
from app.storage.db import DEFAULT_PROJECT_LIMIT, MAX_PROJECT_LIMIT

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "langflow_run_response.sample.json"


def document(index: int, *, title: str | None = None, case_id: str | None = None) -> dict:
    return {
        "schemaVersion": 4,
        "projectId": f"project-{index:04d}",
        "revision": 1,
        "title": title if title is not None else f"사건 {index}",
        "document": {"id": f"doc-{index:04d}", "caseId": case_id if case_id is not None else f"2026고합{index}", "text": "x"},
        "analysisRuns": [{"createdAt": f"2026-09-{(index % 28) + 1:02d}T00:00:00Z", "source": {"kind": "langflow-desktop"}}],
    }


def make_db(count: int) -> Database:
    db = Database(":memory:")
    for index in range(count):
        # updated_at 을 거꾸로 두어 최신순 정렬을 확인할 수 있게 한다.
        db.save_project(f"project-{index:04d}", 1, f"2026-09-23T{index % 24:02d}:{index % 60:02d}:00Z", document(index))
    return db


class ProjectListStorageTest(unittest.TestCase):
    def test_returns_one_page_and_total(self):
        db = make_db(120)
        projects, total = db.list_projects()
        self.assertEqual(total, 120)
        self.assertEqual(len(projects), DEFAULT_PROJECT_LIMIT)

    def test_offset_walks_without_overlap(self):
        db = make_db(30)
        first, total = db.list_projects(limit=10, offset=0)
        second, _ = db.list_projects(limit=10, offset=10)
        self.assertEqual(total, 30)
        self.assertEqual(len(first), 10)
        self.assertEqual(len(second), 10)
        self.assertFalse({row["projectId"] for row in first} & {row["projectId"] for row in second})

    def test_limit_is_clamped(self):
        db = make_db(5)
        self.assertEqual(len(db.list_projects(limit=9999)[0]), 5)
        # 상한을 넘겨도 그 이상 돌려주지 않는다.
        big = make_db(MAX_PROJECT_LIMIT + 10)
        self.assertEqual(len(big.list_projects(limit=MAX_PROJECT_LIMIT + 10)[0]), MAX_PROJECT_LIMIT)
        self.assertEqual(len(db.list_projects(limit=0)[0]), 1)
        self.assertEqual(len(db.list_projects(limit=-5)[0]), 1)

    def test_newest_first(self):
        db = make_db(5)
        projects, _ = db.list_projects()
        self.assertEqual([row["updatedAt"] for row in projects], sorted((row["updatedAt"] for row in projects), reverse=True))

    def test_search_matches_title_case_id_and_project_id(self):
        db = Database(":memory:")
        db.save_project("project-0001", 1, "2026-09-23T01:00:00Z", document(1, title="증인 신빙성", case_id="2026고합111"))
        db.save_project("project-0002", 1, "2026-09-23T02:00:00Z", document(2, title="위법수집증거", case_id="2026고단222"))

        by_title, total = db.list_projects(query="증인")
        self.assertEqual((total, len(by_title)), (1, 1))
        self.assertEqual(by_title[0]["projectId"], "project-0001")

        by_case, total = db.list_projects(query="고단222")
        self.assertEqual((total, by_case[0]["projectId"]), (1, "project-0002"))

        by_id, total = db.list_projects(query="project-0002")
        self.assertEqual((total, by_id[0]["projectId"]), (1, "project-0002"))

        self.assertEqual(db.list_projects(query="없는말")[1], 0)
        # 빈 검색어는 검색하지 않은 것과 같다.
        self.assertEqual(db.list_projects(query="   ")[1], 2)

    def test_list_columns_follow_the_saved_document(self):
        db = Database(":memory:")
        db.save_project("project-0001", 1, "2026-09-23T01:00:00Z", document(1, title="처음 제목"))
        self.assertEqual(db.list_projects()[0][0]["title"], "처음 제목")
        db.save_project("project-0001", 2, "2026-09-23T02:00:00Z", document(1, title="바뀐 제목"))
        row = db.list_projects()[0][0]
        self.assertEqual((row["title"], row["revision"]), ("바뀐 제목", 2))
        self.assertEqual(row["caseId"], "2026고합1")
        self.assertEqual(row["source"], "langflow-desktop")
        self.assertEqual(row["documentId"], "doc-0001")

    def test_summary_reads_the_same_places_as_the_migration(self):
        values = Database.project_summary(document(7, title="제목", case_id="사건번호"))
        self.assertEqual(values, ("doc-0007", "제목", "사건번호", "langflow-desktop", "2026-09-08T00:00:00Z"))
        # 없는 값은 None 으로 두고 지어내지 않는다.
        self.assertEqual(Database.project_summary({}), (None, None, None, None, None))
        self.assertEqual(Database.project_summary({"analysisRuns": []}), (None, None, None, None, None))


class ProjectListApiTest(unittest.TestCase):
    def client(self, count: int) -> TestClient:
        settings = Settings(langflow_mode="mock", mock_fixture_path=FIXTURE, mock_delay_seconds=0)
        return TestClient(create_app(settings, db=make_db(count)))

    def test_default_page(self):
        response = self.client(120).get("/api/projects")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["total"], 120)
        self.assertEqual(body["limit"], DEFAULT_PROJECT_LIMIT)
        self.assertEqual(body["offset"], 0)
        self.assertEqual(len(body["projects"]), DEFAULT_PROJECT_LIMIT)

    def test_paging_parameters(self):
        body = self.client(30).get("/api/projects?limit=5&offset=10").json()
        self.assertEqual((body["limit"], body["offset"], len(body["projects"]), body["total"]), (5, 10, 5, 30))

    def test_bad_parameters_fall_back_to_defaults(self):
        body = self.client(10).get("/api/projects?limit=abc&offset=-3").json()
        self.assertEqual((body["limit"], body["offset"]), (DEFAULT_PROJECT_LIMIT, 0))

    def test_search_parameter(self):
        body = self.client(30).get("/api/projects?q=사건 7").json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["projects"][0]["title"], "사건 7")

    def test_response_size_stays_flat_as_projects_grow(self):
        """사건이 늘어도 목록 한 쪽의 응답은 커지지 않는다(이 기능의 목적)."""
        small = self.client(60).get("/api/projects").content
        large = self.client(600).get("/api/projects").content
        self.assertLess(abs(len(large) - len(small)) / len(small), 0.1)


if __name__ == "__main__":
    unittest.main()
