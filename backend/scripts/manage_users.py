"""
브라우저 로그인 계정 관리. 계정 파일에는 scrypt 해시만 저장한다. 비밀번호는 입력창(getpass) 또는 표준 입력으로 받는다.

    python scripts/manage_users.py create --username owner --principal owner --preset review
    echo 비밀번호 | python scripts/manage_users.py create --username owner --principal owner --preset review --password-stdin
    python scripts/manage_users.py password --username owner
    python scripts/manage_users.py list
    python scripts/manage_users.py disable --username owner

프리셋: review(목록·조회·저장) / site(review + 사이트 분석 실행) / admin(모든 권한, 파이프라인 편집 포함)
principal 은 같은 팀·소유자를 뜻하는 이름이다. Desktop 검토 토큰과 같은 principal 을 쓰면 기록이 한 주체로 묶인다.
계정을 끄면 이미 로그인한 세션도 다음 요청부터 막힌다. 파일 경로는 AIF_USERS_FILE (기본 backend/data/users.json).
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import SCOPES, hash_password  # noqa: E402
from app.config import BACKEND_ROOT  # noqa: E402

PRESETS = {
    "review": ["catalog:read", "projects:read", "projects:write"],
    "site": ["catalog:read", "projects:read", "projects:write", "analysis:run"],
    "admin": ["admin"],
}
MIN_PASSWORD = 10


def users_path() -> Path:
    return Path(os.environ.get("AIF_USERS_FILE") or BACKEND_ROOT / "data" / "users.json")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"users": []}


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def read_password(from_stdin: bool) -> str:
    if from_stdin:
        return sys.stdin.readline().rstrip("\r\n")
    first = getpass.getpass("비밀번호: ")
    if first != getpass.getpass("다시 입력: "):
        raise SystemExit("두 비밀번호가 다릅니다.")
    return first


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--username", required=True)
    create.add_argument("--principal", required=True)
    create.add_argument("--preset", choices=sorted(PRESETS))
    create.add_argument("--scope", action="append", default=[], choices=SCOPES)
    create.add_argument("--password-stdin", action="store_true")
    password = sub.add_parser("password")
    password.add_argument("--username", required=True)
    password.add_argument("--password-stdin", action="store_true")
    sub.add_parser("list")
    disable = sub.add_parser("disable")
    disable.add_argument("--username", required=True)
    args = parser.parse_args()

    path = users_path()
    data = load(path)
    sys.stdout.reconfigure(encoding="utf-8")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if args.command == "list":
        for user in data["users"]:
            state = "disabled" if user.get("disabled") else "active"
            print(f"{user['username']:20} {user.get('principal', ''):20} {state:8} {','.join(user.get('scopes', []))}")
        return 0

    user = next((u for u in data["users"] if u["username"] == getattr(args, "username", None)), None)
    if args.command == "disable":
        if user is None:
            print(f"no user {args.username}", file=sys.stderr)
            return 1
        user["disabled"] = True
        user["disabledAt"] = now
        save(path, data)
        print(f"disabled {args.username}")
        return 0

    secret = read_password(args.password_stdin)
    if len(secret) < MIN_PASSWORD:
        print(f"비밀번호는 {MIN_PASSWORD}자 이상이어야 합니다.", file=sys.stderr)
        return 1
    if args.command == "password":
        if user is None:
            print(f"no user {args.username}", file=sys.stderr)
            return 1
        user["password"] = hash_password(secret)
        user["passwordChangedAt"] = now
        save(path, data)
        print(f"password changed for {args.username}")
        return 0

    if user is not None:
        print(f"이미 있는 사용자입니다: {args.username}", file=sys.stderr)
        return 1
    scopes = sorted(set(PRESETS.get(args.preset, [])) | set(args.scope))
    if not scopes:
        print("--preset 또는 --scope 가 필요합니다.", file=sys.stderr)
        return 1
    data["users"].append({"username": args.username, "principal": args.principal, "scopes": scopes, "password": hash_password(secret), "createdAt": now})
    save(path, data)
    print(f"user file: {path}")
    print(f"created {args.username} ({', '.join(scopes)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
