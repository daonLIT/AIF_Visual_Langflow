"""
중앙 서버 백업: SQLite DB 를 서버를 멈추지 않고 일관된 사본으로 뜬다(sqlite3 backup API). 토큰·계정 파일도 함께 복사한다.

    python scripts/backup_db.py --out-dir /backups            # 기본: DATABASE_PATH, AIF_API_TOKENS_FILE, AIF_USERS_FILE
    python scripts/backup_db.py --out-dir /backups --keep 14  # 최근 14개만 남기기
    python scripts/backup_db.py --verify /backups/aif-20260921T101500Z   # 백업 폴더 검사(무결성·표·프로젝트 수)

결과: <out-dir>/aif-<UTC 시각>/ 아래 annotation.sqlite3, api_tokens.json, users.json, manifest.json(sha256·크기·프로젝트 수).
복구: 서버를 멈추고 백업 폴더의 파일을 원래 경로(DATABASE_PATH 등)로 복사한 뒤 서버를 시작한다(docs/deploy.md).
원문·토큰 해시가 들어 있으므로 백업 폴더는 서버 데이터와 같은 수준으로 접근을 제한한다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import BACKEND_ROOT  # noqa: E402

PREFIX = "aif-"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sources() -> dict[str, Path]:
    return {
        "database": Path(os.environ.get("DATABASE_PATH") or BACKEND_ROOT / "data" / "annotation.sqlite3"),
        "tokens": Path(os.environ.get("AIF_API_TOKENS_FILE") or BACKEND_ROOT / "data" / "api_tokens.json"),
        "users": Path(os.environ.get("AIF_USERS_FILE") or BACKEND_ROOT / "data" / "users.json"),
    }


def inspect_db(path: Path) -> dict:
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        projects = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        runs = conn.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0]
    finally:
        conn.close()
    return {"integrity": integrity, "schemaVersion": version, "projects": projects, "runs": runs}


def backup(out_dir: Path, keep: int | None) -> Path:
    src = sources()
    if not src["database"].exists():
        raise SystemExit(f"DB 가 없습니다: {src['database']}")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = out_dir / f"{PREFIX}{stamp}"
    target.mkdir(parents=True, exist_ok=False)
    files = {}
    db_copy = target / src["database"].name
    source = sqlite3.connect(src["database"])
    destination = sqlite3.connect(db_copy)
    try:
        source.backup(destination)  # 쓰기 중에도 일관된 사본
    finally:
        destination.close()
        source.close()
    files["database"] = db_copy
    for key in ("tokens", "users"):
        if src[key].exists():
            files[key] = target / src[key].name
            shutil.copy2(src[key], files[key])
    manifest = {
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {key: str(path) for key, path in src.items()},
        "files": {key: {"name": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path)} for key, path in files.items()},
        "database": inspect_db(db_copy),
    }
    (target / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if manifest["database"]["integrity"] != "ok":
        raise SystemExit(f"백업 사본 무결성 검사 실패: {manifest['database']['integrity']}")
    if keep:
        old = sorted(p for p in out_dir.iterdir() if p.is_dir() and p.name.startswith(PREFIX))
        for path in old[:-keep]:
            shutil.rmtree(path)
    return target


def verify(folder: Path) -> dict:
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    problems = []
    for key, info in manifest["files"].items():
        path = folder / info["name"]
        if not path.exists():
            problems.append(f"{key}: 파일 없음")
        elif sha256_file(path) != info["sha256"]:
            problems.append(f"{key}: sha256 다름")
    db = inspect_db(folder / manifest["files"]["database"]["name"])
    if db["integrity"] != "ok":
        problems.append(f"database: {db['integrity']}")
    return {"ok": not problems, "problems": problems, "database": db}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", type=Path)
    parser.add_argument("--keep", type=int, default=None)
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if args.verify:
        report = verify(args.verify)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["ok"] else 1
    if not args.out_dir:
        parser.error("--out-dir 또는 --verify 가 필요합니다.")
    target = backup(args.out_dir, args.keep)
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
