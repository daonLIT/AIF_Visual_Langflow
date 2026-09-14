"""SQLite 저장소. 실행(run)과 프로젝트를 JSON 문서로 보존한다."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

# 명시적 마이그레이션. PRAGMA user_version 으로 적용 단계를 기록한다.
# 기존 DB 파일을 올릴 때는 먼저 같은 폴더에 백업 파일을 만든다. 사용자 데이터(실행·프로젝트)는 다시 만들지 않는다.
MIGRATIONS: list[tuple[int, str, str]] = [
    (
        1,
        "실행·프로젝트",
        """
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
""",
    ),
    (
        2,
        "파이프라인 편집(로컬 flow·초안·버전·복제 기록·설정)",
        """
CREATE TABLE IF NOT EXISTS local_flows (
    flow_id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    flow TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_drafts (
    flow_id TEXT PRIMARY KEY,
    base_updated_at TEXT,
    saved_at TEXT NOT NULL,
    note TEXT,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_versions (
    version_id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    note TEXT,
    remote_updated_at TEXT,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_versions_flow ON pipeline_versions(flow_id, created_at);
CREATE TABLE IF NOT EXISTS pipeline_flow_meta (
    flow_id TEXT PRIMARY KEY,
    source_flow_id TEXT,
    created_at TEXT NOT NULL,
    note TEXT
);
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
""",
    ),
    (
        3,
        "실행 버전 고정(실행용 스냅샷 flow)·flow 해시",
        """
CREATE TABLE IF NOT EXISTS run_snapshots (
    source_flow_id TEXT NOT NULL,
    flow_hash TEXT NOT NULL,
    snapshot_flow_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_flow_id, flow_hash)
);
ALTER TABLE pipeline_drafts ADD COLUMN base_hash TEXT;
ALTER TABLE pipeline_versions ADD COLUMN data_hash TEXT;
""",
    ),
]
LATEST_SCHEMA = MIGRATIONS[-1][0]


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self.backup_path: str | None = None
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        existed = self.path != ":memory:" and Path(self.path).exists() and Path(self.path).stat().st_size > 0
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self.migrate(backup=existed)

    def schema_version(self) -> int:
        return int(self._conn.execute("PRAGMA user_version").fetchone()[0])

    def _columns(self, table: str) -> set[str]:
        return {row["name"] for row in self._conn.execute(f"PRAGMA table_info({table})").fetchall()}

    def migrate(self, *, backup: bool) -> list[int]:
        current = self.schema_version()
        pending = [m for m in MIGRATIONS if m[0] > current]
        if not pending:
            return []
        if backup:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            target = f"{self.path}.backup-v{current}-{stamp}"
            source = sqlite3.connect(self.path)
            try:
                with sqlite3.connect(target) as destination:
                    source.backup(destination)
            finally:
                source.close()
            self.backup_path = target
        applied = []
        for version, _label, script in pending:
            for statement in [part.strip() for part in script.split(";") if part.strip()]:
                if statement.upper().startswith("ALTER TABLE"):
                    # 이전 개발 버전이 이미 만든 열이면 건너뛴다.
                    words = statement.split()
                    table, column = words[2], words[5]
                    if column in self._columns(table):
                        continue
                self._conn.execute(statement)
            self._conn.execute(f"PRAGMA user_version = {version}")
            self._conn.commit()
            applied.append(version)
        return applied

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

    # ---- local flows (mock) ----
    def get_local_flow(self, flow_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT flow FROM local_flows WHERE flow_id = ?", (flow_id,)).fetchone()
        return json.loads(row["flow"]) if row else None

    def list_local_flows(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT flow FROM local_flows ORDER BY updated_at DESC").fetchall()
        return [json.loads(row["flow"]) for row in rows]

    def save_local_flow(self, flow: dict) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO local_flows(flow_id, updated_at, flow) VALUES (?, ?, ?)
                ON CONFLICT(flow_id) DO UPDATE SET updated_at = excluded.updated_at, flow = excluded.flow
                """,
                (flow["id"], flow["updated_at"], json.dumps(flow, ensure_ascii=False)),
            )
            self._conn.commit()

    # ---- pipeline drafts ----
    def get_pipeline_draft(self, flow_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM pipeline_drafts WHERE flow_id = ?", (flow_id,)).fetchone()
        if not row:
            return None
        return {
            "flowId": row["flow_id"],
            "baseUpdatedAt": row["base_updated_at"],
            "baseHash": row["base_hash"],
            "savedAt": row["saved_at"],
            "note": row["note"],
            "data": json.loads(row["data"]),
        }

    def save_pipeline_draft(
        self, flow_id: str, base_updated_at: str | None, saved_at: str, note: str | None, data: dict, base_hash: str | None = None
    ) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO pipeline_drafts(flow_id, base_updated_at, base_hash, saved_at, note, data) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(flow_id) DO UPDATE SET
                    base_updated_at = excluded.base_updated_at, base_hash = excluded.base_hash, saved_at = excluded.saved_at,
                    note = excluded.note, data = excluded.data
                """,
                (flow_id, base_updated_at, base_hash, saved_at, note, json.dumps(data, ensure_ascii=False)),
            )
            self._conn.commit()

    def delete_pipeline_draft(self, flow_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM pipeline_drafts WHERE flow_id = ?", (flow_id,))
            self._conn.commit()

    # ---- pipeline versions ----
    def add_pipeline_version(
        self,
        version_id: str,
        flow_id: str,
        kind: str,
        created_at: str,
        note: str | None,
        remote_updated_at: str | None,
        data: dict,
        data_hash: str | None = None,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO pipeline_versions(version_id, flow_id, kind, created_at, note, remote_updated_at, data, data_hash) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (version_id, flow_id, kind, created_at, note, remote_updated_at, json.dumps(data, ensure_ascii=False), data_hash),
            )
            self._conn.commit()

    def find_pipeline_version_by_hash(self, flow_id: str, data_hash: str) -> dict | None:
        """적용·복원으로 기록된 버전 중 같은 실행 해시를 가진 가장 최근 버전."""
        with self._lock:
            row = self._conn.execute(
                "SELECT version_id, kind, created_at, note FROM pipeline_versions "
                "WHERE flow_id = ? AND data_hash = ? AND kind IN ('applied', 'restored', 'cloned') ORDER BY created_at DESC LIMIT 1",
                (flow_id, data_hash),
            ).fetchone()
        return {"versionId": row["version_id"], "kind": row["kind"], "createdAt": row["created_at"], "note": row["note"]} if row else None

    # ---- run snapshots ----
    def get_run_snapshot(self, source_flow_id: str, flow_hash: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT snapshot_flow_id FROM run_snapshots WHERE source_flow_id = ? AND flow_hash = ?", (source_flow_id, flow_hash)
            ).fetchone()
        return row["snapshot_flow_id"] if row else None

    def save_run_snapshot(self, source_flow_id: str, flow_hash: str, snapshot_flow_id: str, created_at: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO run_snapshots(source_flow_id, flow_hash, snapshot_flow_id, created_at) VALUES (?, ?, ?, ?)",
                (source_flow_id, flow_hash, snapshot_flow_id, created_at),
            )
            self._conn.commit()

    def list_pipeline_versions(self, flow_id: str) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT version_id, flow_id, kind, created_at, note, remote_updated_at, data_hash, "
                "json_array_length(data, '$.nodes') AS node_count, json_array_length(data, '$.edges') AS edge_count "
                "FROM pipeline_versions WHERE flow_id = ? ORDER BY created_at DESC",
                (flow_id,),
            ).fetchall()
        return [
            {
                "versionId": row["version_id"],
                "flowId": row["flow_id"],
                "kind": row["kind"],
                "createdAt": row["created_at"],
                "note": row["note"],
                "remoteUpdatedAt": row["remote_updated_at"],
                "dataHash": row["data_hash"],
                "nodeCount": row["node_count"],
                "edgeCount": row["edge_count"],
            }
            for row in rows
        ]

    def get_pipeline_version(self, version_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM pipeline_versions WHERE version_id = ?", (version_id,)).fetchone()
        if not row:
            return None
        return {
            "versionId": row["version_id"],
            "flowId": row["flow_id"],
            "kind": row["kind"],
            "createdAt": row["created_at"],
            "note": row["note"],
            "remoteUpdatedAt": row["remote_updated_at"],
            "dataHash": row["data_hash"],
            "data": json.loads(row["data"]),
        }

    # ---- pipeline flow meta / settings ----
    def set_flow_meta(self, flow_id: str, source_flow_id: str | None, created_at: str, note: str | None) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO pipeline_flow_meta(flow_id, source_flow_id, created_at, note) VALUES (?, ?, ?, ?)",
                (flow_id, source_flow_id, created_at, note),
            )
            self._conn.commit()

    def list_flow_meta(self) -> dict[str, dict]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM pipeline_flow_meta").fetchall()
        return {
            row["flow_id"]: {"sourceFlowId": row["source_flow_id"], "createdAt": row["created_at"], "note": row["note"]}
            for row in rows
        }

    def get_setting(self, key: str) -> str | None:
        with self._lock:
            row = self._conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str | None) -> None:
        with self._lock:
            if value is None:
                self._conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))
            else:
                self._conn.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, value))
            self._conn.commit()

