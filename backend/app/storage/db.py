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
    (
        4,
        "외부 결과 게시(Langflow Desktop) 매핑",
        """
CREATE TABLE IF NOT EXISTS external_publications (
    principal TEXT NOT NULL,
    external_run_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    run_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (principal, external_run_id)
);
CREATE INDEX IF NOT EXISTS idx_external_publications_project ON external_publications(project_id);
""",
    ),
    (
        5,
        "브라우저 로그인 세션",
        """
CREATE TABLE IF NOT EXISTS auth_sessions (
    session_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    principal TEXT NOT NULL,
    scopes TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
""",
    ),
    (
        6,
        "사용자가 만든 scheme (정본 카탈로그 파일에 섞지 않고 따로 둔다)",
        """
CREATE TABLE IF NOT EXISTS custom_schemes (
    scheme_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    enabled_for_ai INTEGER NOT NULL DEFAULT 1,
    retired INTEGER NOT NULL DEFAULT 0,
    definition TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_schemes_updated ON custom_schemes(updated_at);
""",
    ),
]
LATEST_SCHEMA = MIGRATIONS[-1][0]


class PublicationConflict(Exception):
    """같은 (principal, externalRunId) 가 이미 있다. existing 에 기존 매핑이 들어 있다."""

    def __init__(self, existing: dict):
        super().__init__("publication exists")
        self.existing = existing


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
            # sqlite3 의 with 문은 커밋만 하고 연결을 닫지 않으므로 직접 닫는다(백업 파일이 잠긴 채 남지 않게).
            destination = sqlite3.connect(target)
            try:
                source.backup(destination)
            finally:
                destination.close()
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
                "json_extract(document, '$.title') AS title, json_extract(document, '$.document.caseId') AS case_id, "
                "json_extract(document, '$.analysisRuns[0].source.kind') AS source_kind, "
                "json_extract(document, '$.analysisRuns[0].createdAt') AS analyzed_at "
                "FROM projects ORDER BY updated_at DESC"
            ).fetchall()
        return [
            {
                "projectId": row["project_id"],
                "revision": row["revision"],
                "updatedAt": row["updated_at"],
                "documentId": row["document_id"],
                "title": row["title"],
                "caseId": row["case_id"],
                "source": row["source_kind"],
                "analyzedAt": row["analyzed_at"],
            }
            for row in rows
        ]

    # ---- 사용자가 만든 scheme ----
    @staticmethod
    def _custom_scheme_row(row: sqlite3.Row) -> dict:
        return {
            "schemeKey": row["scheme_key"],
            "revision": int(row["revision"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "createdBy": row["created_by"],
            "updatedBy": row["updated_by"],
            "enabledForAi": bool(row["enabled_for_ai"]),
            "retired": bool(row["retired"]),
            "definition": json.loads(row["definition"]),
        }

    def list_custom_schemes(self) -> list[dict]:
        """폐기한 것까지 모두. 과거 그래프가 쓰던 scheme 의 이름이 사라지지 않게 지우지 않는다."""
        with self._lock:
            rows = self._conn.execute("SELECT * FROM custom_schemes ORDER BY created_at").fetchall()
        return [self._custom_scheme_row(row) for row in rows]

    def get_custom_scheme(self, scheme_key: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM custom_schemes WHERE scheme_key = ?", (scheme_key,)).fetchone()
        return self._custom_scheme_row(row) if row else None

    def insert_custom_scheme(self, scheme_key: str, definition: dict, *, enabled_for_ai: bool, by: str, at: str) -> dict:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO custom_schemes(scheme_key, revision, created_at, updated_at, created_by, updated_by,
                                           enabled_for_ai, retired, definition)
                VALUES (?, 1, ?, ?, ?, ?, ?, 0, ?)
                """,
                (scheme_key, at, at, by, by, 1 if enabled_for_ai else 0, json.dumps(definition, ensure_ascii=False)),
            )
            self._conn.commit()
        return self.get_custom_scheme(scheme_key)

    def update_custom_scheme(
        self,
        scheme_key: str,
        *,
        definition: dict | None = None,
        enabled_for_ai: bool | None = None,
        retired: bool | None = None,
        by: str,
        at: str,
    ) -> dict | None:
        """준 값만 바꾸고 revision 을 1 올린다. 없는 key 면 None."""
        with self._lock:
            row = self._conn.execute("SELECT * FROM custom_schemes WHERE scheme_key = ?", (scheme_key,)).fetchone()
            if row is None:
                return None
            self._conn.execute(
                """
                UPDATE custom_schemes
                   SET revision = revision + 1, updated_at = ?, updated_by = ?,
                       enabled_for_ai = ?, retired = ?, definition = ?
                 WHERE scheme_key = ?
                """,
                (
                    at,
                    by,
                    row["enabled_for_ai"] if enabled_for_ai is None else (1 if enabled_for_ai else 0),
                    row["retired"] if retired is None else (1 if retired else 0),
                    row["definition"] if definition is None else json.dumps(definition, ensure_ascii=False),
                    scheme_key,
                ),
            )
            self._conn.commit()
        return self.get_custom_scheme(scheme_key)

    # ---- auth sessions ----
    def create_session(self, session_hash: str, username: str, principal: str, scopes: list[str], csrf_token: str, created_at: str, expires_at: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM auth_sessions WHERE expires_at < ?", (created_at,))
            self._conn.execute(
                "INSERT INTO auth_sessions(session_hash, username, principal, scopes, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (session_hash, username, principal, json.dumps(scopes), csrf_token, created_at, expires_at),
            )
            self._conn.commit()

    def get_session(self, session_hash: str, now: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM auth_sessions WHERE session_hash = ? AND expires_at > ?", (session_hash, now)
            ).fetchone()
        if not row:
            return None
        return {**dict(row), "scopes": json.loads(row["scopes"])}

    def delete_session(self, session_hash: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM auth_sessions WHERE session_hash = ?", (session_hash,))
            self._conn.commit()

    def delete_user_sessions(self, username: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM auth_sessions WHERE username = ?", (username,))
            self._conn.commit()

    # ---- external publications ----
    def find_publication(self, principal: str, external_run_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM external_publications WHERE principal = ? AND external_run_id = ?", (principal, external_run_id)
            ).fetchone()
        return dict(row) if row else None

    def publish_external(
        self,
        *,
        principal: str,
        external_run_id: str,
        request_hash: str,
        run_record: dict,
        document_text: str,
        project_id: str,
        project_revision: int,
        project_document: dict,
        created_at: str,
    ) -> None:
        """실행 기록·프로젝트·게시 매핑을 한 트랜잭션으로 저장한다. 하나라도 실패하면 아무것도 남지 않는다.

        같은 (principal, externalRunId) 가 먼저 저장돼 있으면(동시 요청) PublicationConflict 를 낸다.
        """
        with self._lock:
            conn = self._conn
            try:
                conn.execute("BEGIN IMMEDIATE")
                existing = conn.execute(
                    "SELECT * FROM external_publications WHERE principal = ? AND external_run_id = ?", (principal, external_run_id)
                ).fetchone()
                if existing:
                    conn.execute("ROLLBACK")
                    raise PublicationConflict(dict(existing))
                conn.execute(
                    "INSERT INTO analysis_runs(run_id, idempotency_key, status, created_at, updated_at, document, record) "
                    "VALUES (?, NULL, ?, ?, ?, ?, ?)",
                    (
                        run_record["runId"],
                        run_record["status"],
                        run_record["createdAt"],
                        run_record["updatedAt"],
                        document_text,
                        json.dumps(run_record, ensure_ascii=False),
                    ),
                )
                conn.execute(
                    "INSERT INTO projects(project_id, revision, updated_at, document) VALUES (?, ?, ?, ?)",
                    (project_id, project_revision, created_at, json.dumps(project_document, ensure_ascii=False)),
                )
                conn.execute(
                    "INSERT INTO external_publications(principal, external_run_id, request_hash, run_id, project_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (principal, external_run_id, request_hash, run_record["runId"], project_id, created_at),
                )
                conn.execute("COMMIT")
            except PublicationConflict:
                raise
            except Exception:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise

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

