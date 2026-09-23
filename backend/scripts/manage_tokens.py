"""
API 토큰 관리. 토큰 파일에는 sha256 만 저장하고, 원문은 만들 때 한 번만 출력한다.

    python scripts/manage_tokens.py create --id desktop-publish --principal langflow-desktop --preset publish
    python scripts/manage_tokens.py create --id desktop-review --principal owner --preset review
    python scripts/manage_tokens.py list
    python scripts/manage_tokens.py disable --id desktop-publish

프리셋
    publish : catalog:read, results:publish         (Langflow Flow 의 게시 컴포넌트용)
    review  : catalog:read, catalog:write, projects:read, projects:write   (Desktop 검토 화면용)
    site    : review + analysis:run                  (사이트에서 분석까지)
    admin   : 모든 권한

principal 은 사람(또는 연동) 하나를 가리킨다. **한 사람의 게시 토큰·검토 토큰·웹 계정은 같은 principal 로
만든다.** 직접 만든 scheme 은 이 값으로 소유자를 가르므로, 검토 화면(검토 토큰)에서 만든 scheme 을
그 사람의 Flow 실행(게시 토큰으로 카탈로그를 읽는다)에서도 쓰려면 둘이 같아야 한다.

키 교체: 같은 principal 로 새 토큰을 만들고 셸 설정을 바꾼 뒤 옛 토큰을 disable 한다.
principal 이 같으면 교체 전후의 게시 재전송도 같은 결과로 묶인다.
파일 경로는 AIF_API_TOKENS_FILE (기본 backend/data/api_tokens.json).
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import SCOPES, hash_token  # noqa: E402
from app.config import BACKEND_ROOT  # noqa: E402

PRESETS = {
    # 게시는 Flow 가 결과를 보낼 때만 쓴다. scheme 을 만들지 않으므로 catalog:write 를 주지 않는다.
    "publish": ["catalog:read", "results:publish"],
    # 검토자는 그래프 화면에서 목록에 없는 도식을 직접 만들 수 있어야 하므로 catalog:write 를 함께 준다.
    "review": ["catalog:read", "catalog:write", "projects:read", "projects:write"],
    "site": ["catalog:read", "catalog:write", "projects:read", "projects:write", "analysis:run"],
    "admin": ["admin"],
}


def tokens_path() -> Path:
    return Path(os.environ.get("AIF_API_TOKENS_FILE") or BACKEND_ROOT / "data" / "api_tokens.json")


def load(path: Path) -> dict:
    if not path.exists():
        return {"tokens": []}
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--id", required=True)
    create.add_argument("--principal", required=True, help="게시 중복 판정·기록에 쓰는 연동/사용자 ID")
    create.add_argument("--preset", choices=sorted(PRESETS))
    create.add_argument("--scope", action="append", default=[], choices=SCOPES)
    sub.add_parser("list")
    disable = sub.add_parser("disable")
    disable.add_argument("--id", required=True)
    args = parser.parse_args()

    path = tokens_path()
    data = load(path)
    sys.stdout.reconfigure(encoding="utf-8")

    if args.command == "list":
        for entry in data["tokens"]:
            state = "disabled" if entry.get("disabled") else "active"
            print(f"{entry['id']:24} {entry.get('principal', ''):20} {state:8} {','.join(entry.get('scopes', []))}")
        return 0

    if args.command == "disable":
        for entry in data["tokens"]:
            if entry["id"] == args.id:
                entry["disabled"] = True
                entry["disabledAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                save(path, data)
                print(f"disabled {args.id}")
                return 0
        print(f"no token {args.id}", file=sys.stderr)
        return 1

    scopes = sorted(set(PRESETS.get(args.preset, [])) | set(args.scope))
    if not scopes:
        print("--preset 또는 --scope 가 필요합니다.", file=sys.stderr)
        return 1
    if any(entry["id"] == args.id and not entry.get("disabled") for entry in data["tokens"]):
        print(f"이미 있는 토큰 ID 입니다: {args.id}", file=sys.stderr)
        return 1
    token = "aif_" + secrets.token_urlsafe(32)
    data["tokens"].append(
        {
            "id": args.id,
            "principal": args.principal,
            "scopes": scopes,
            "sha256": hash_token(token),
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    )
    save(path, data)
    print(f"token file: {path}")
    print(f"scopes: {', '.join(scopes)}")
    print("아래 토큰은 다시 볼 수 없습니다. Desktop 셸 설정에 넣으세요:")
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
