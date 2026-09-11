"""SQLite 저장소. 실행(run)과 프로젝트를 JSON 문서로 보존한다."""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS analysis_runs (
    run_id TEXT PRIMARY KEY,
    idempotency_key TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    document TEXT NOT NULL,
    record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_idempotency ON analysis_runs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_runs_status ON analysis_runs(status);

CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    document TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---- runs ----
    def save_run(self, record: dict, document_text: str, idempotency_key: str | None) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO analysis_runs(run_id, idempotency_key, status, created_at, updated_at, document, record)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    status = excluded.status,
                    updated_at = excluded.updated_at,
                    record = excluded.record
                """,
                (
                    record["runId"],
                    idempotency_key,
                    record["status"],
                    record["createdAt"],
                    record["updatedAt"],
                    document_text,
                    json.dumps(record, ensure_ascii=False),
                ),
            )
            self._conn.commit()

    def get_run(self, run_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT record FROM analysis_runs WHERE run_id = ?", (run_id,)).fetchone()
        return json.loads(row["record"]) if row else None

    def get_run_document(self, run_id: str) -> str | None:
        with self._lock:
            row = self._conn.execute("SELECT document FROM analysis_runs WHERE run_id = ?", (run_id,)).fetchone()
        return row["document"] if row else None

    def find_run_by_idempotency(self, key: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT record FROM analysis_runs WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1",
                (key,),
            ).fetchone()
        return json.loads(row["record"]) if row else None

    def list_runs(self, statuses: tuple[str, ...] | None = None, limit: int = 100) -> list[dict]:
        with self._lock:
            if statuses:
                placeholders = ",".join("?" for _ in statuses)
                rows = self._conn.execute(
                    f"SELECT record FROM analysis_runs WHERE status IN ({placeholders}) ORDER BY created_at DESC LIMIT ?",
                    (*statuses, limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT record FROM analysis_runs ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [json.loads(row["record"]) for row in rows]

    def namespace_exists(self, namespace: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM analysis_runs WHERE json_extract(record, '$.namespace') = ? LIMIT 1",
                (namespace,),
            ).fetchone()
        return row is not None

    # ---- projects ----
    def get_project(self, project_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT document FROM projects WHERE project_id = ?", (project_id,)).fetchone()
        return json.loads(row["document"]) if row else None

    def get_project_revision(self, project_id: str) -> int | None:
        with self._lock:
            row = self._conn.execute("SELECT revision FROM projects WHERE project_id = ?", (project_id,)).fetchone()
        return int(row["revision"]) if row else None

    def save_project(self, project_id: str, revision: int, updated_at: str, document: dict) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO projects(project_id, revision, updated_at, document) VALUES (?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    revision = excluded.revision, updated_at = excluded.updated_at, document = excluded.document
                """,
                (project_id, revision, updated_at, json.dumps(document, ensure_ascii=False)),
            )
            self._conn.commit()

    def list_projects(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT project_id, revision, updated_at, json_extract(document, '$.document.id') AS document_id, "
                "json_extract(document, '$.title') AS title FROM projects ORDER BY updated_at DESC"
            ).fetchall()
        return [
            {
                "projectId": row["project_id"],
                "revision": row["revision"],
                "updatedAt": row["updated_at"],
                "documentId": row["document_id"],
                "title": row["title"],
            }
            for row in rows
        ]
