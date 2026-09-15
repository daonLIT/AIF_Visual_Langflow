"""쟁점 카탈로그(엑셀 변환본)와 Walton 스킴 카탈로그 조회."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

MAX_SELECTED_ISSUES = 3
UNCLASSIFIED = "unclassified"
CUSTOM = "custom"
RESERVED_SCHEME_KEYS = (UNCLASSIFIED, CUSTOM)


class CatalogError(ValueError):
    pass


def _load_json(path: Path, label: str) -> tuple[dict, str]:
    if not path.exists():
        raise CatalogError(f"{label} 파일이 없습니다: {path}")
    raw = path.read_bytes()
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogError(f"{label} JSON 을 해석할 수 없습니다: {error}") from error
    if not isinstance(data, dict):
        raise CatalogError(f"{label} 최상위가 객체가 아닙니다.")
    return data, hashlib.sha256(raw).hexdigest()


@dataclass
class IssueCatalog:
    data: dict
    sha256: str = ""
    by_id: dict[str, dict] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "IssueCatalog":
        data, digest = _load_json(path, "쟁점 카탈로그")
        issues = data.get("issues")
        if not isinstance(issues, list) or not issues:
            raise CatalogError("쟁점 카탈로그에 issues 가 없습니다.")
        by_id = {}
        for issue in issues:
            if not isinstance(issue, dict) or not issue.get("issueId"):
                raise CatalogError("쟁점 카탈로그 항목에 issueId 가 없습니다.")
            by_id[issue["issueId"]] = issue
        return cls(data=data, sha256=digest, by_id=by_id)

    @property
    def version(self) -> int:
        return int(self.data.get("catalogVersion") or 0)

    def active_ids(self) -> list[str]:
        return [i["issueId"] for i in self.data["issues"] if not i.get("retired")]

    def is_active(self, issue_id: str) -> bool:
        issue = self.by_id.get(issue_id)
        return bool(issue) and not issue.get("retired")

    def input_items(self) -> list[dict]:
        """Langflow 입력에 넣을 52개 항목. 엑셀 원문 문자열을 줄이지 않는다."""
        return [
            {
                "issueId": issue_id,
                "categoryName": self.by_id[issue_id]["categoryName"],
                "label": self.by_id[issue_id]["label"],
                "criteria": self.by_id[issue_id]["criteria"],
            }
            for issue_id in self.active_ids()
        ]

    def reference(self, issue_id: str) -> dict | None:
        issue = self.by_id.get(issue_id)
        if issue is None:
            return None
        return {
            "issueId": issue_id,
            "categoryId": issue["categoryId"],
            "catalogVersion": self.version,
            "label": issue["label"],
            "categoryName": issue["categoryName"],
        }


SCHEME_MIGRATIONS_FILE = "scheme_catalog_migrations.json"
MIGRATION_ACTIONS = ("keep", "replace", "unclassify")


@dataclass
class SchemeCatalog:
    data: dict
    sha256: str = ""
    by_key: dict[str, dict] = field(default_factory=dict)
    # 이전 카탈로그 버전의 scheme key 를 현재 카탈로그로 옮기는 대응표 (카탈로그 옆 파일, 없으면 빈 목록)
    migrations: list[dict] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "SchemeCatalog":
        data, digest = _load_json(path, "스킴 카탈로그")
        schemes = data.get("schemes")
        if not isinstance(schemes, list) or not schemes:
            raise CatalogError("스킴 카탈로그에 schemes 가 없습니다.")
        by_key = {}
        for scheme in schemes:
            key = scheme.get("schemeKey") if isinstance(scheme, dict) else None
            if not key or key in RESERVED_SCHEME_KEYS:
                raise CatalogError(f"스킴 카탈로그의 schemeKey 가 비었거나 예약어입니다: {key!r}")
            by_key[key] = scheme
        catalog = cls(data=data, sha256=digest, by_key=by_key)
        migrations_path = path.parent / SCHEME_MIGRATIONS_FILE
        if migrations_path.exists():
            migration_data, _ = _load_json(migrations_path, "스킴 카탈로그 대응표")
            catalog.migrations = migration_data.get("migrations") or []
            catalog.validate_migrations()
        return catalog

    def validate_migrations(self) -> None:
        """현재 카탈로그로 가는 대응표의 대상 key·역할·CQ 가 실제로 있는지 확인한다. 틀리면 CatalogError."""
        if not isinstance(self.migrations, list):
            raise CatalogError("스킴 카탈로그 대응표의 migrations 가 배열이 아닙니다.")
        problems: list[str] = []
        for migration in self.migrations:
            if not isinstance(migration, dict) or not isinstance(migration.get("schemes"), dict):
                problems.append("대응표 항목에 schemes 가 없습니다.")
                continue
            source, target = migration.get("fromVersion"), migration.get("toVersion")
            if not isinstance(source, int) or not isinstance(target, int) or source >= target:
                problems.append(f"대응표 버전이 올바르지 않습니다: {source!r} → {target!r}")
                continue
            if target != self.version:
                continue  # 더 이전 단계의 대응표는 대상 카탈로그가 없어 검사할 수 없다.
            for key, rule in migration["schemes"].items():
                label = f"v{source}→v{target} {key}"
                action = rule.get("action") if isinstance(rule, dict) else None
                if action not in MIGRATION_ACTIONS:
                    problems.append(f"{label}: action 이 올바르지 않습니다 ({action!r})")
                    continue
                if action == "keep" and key not in self.by_key:
                    problems.append(f"{label}: keep 인데 현재 카탈로그에 key 가 없습니다")
                if action in ("replace", "unclassify") and key in self.by_key:
                    problems.append(f"{label}: 현재 카탈로그에 있는 key 는 keep 이어야 합니다")
                destination = key if action == "keep" else rule.get("to")
                if action == "replace" and destination not in self.by_key:
                    problems.append(f"{label}: 바꿀 key {destination!r} 가 현재 카탈로그에 없습니다")
                    continue
                if action != "unclassify":
                    unknown_roles = set((rule.get("roleMap") or {}).values()) - self.roles(destination)
                    unknown_questions = set((rule.get("questionMap") or {}).values()) - self.question_ids(destination)
                    if unknown_roles:
                        problems.append(f"{label}: {destination} 에 없는 역할 {sorted(unknown_roles)}")
                    if unknown_questions:
                        problems.append(f"{label}: {destination} 에 없는 CQ {sorted(unknown_questions)}")
                for candidate in rule.get("candidates") or []:
                    if candidate.get("schemeKey") not in self.by_key:
                        problems.append(f"{label}: 후보 {candidate.get('schemeKey')!r} 가 현재 카탈로그에 없습니다")
        if problems:
            raise CatalogError("스킴 카탈로그 대응표 오류: " + "; ".join(problems))

    def public_data(self) -> dict:
        """API 로 내보낼 카탈로그. 프런트가 불러오기 전환에 쓰도록 대응표를 함께 싣는다."""
        return {**self.data, "migrations": self.migrations}

    @property
    def version(self) -> int:
        return int(self.data.get("schemeCatalogVersion") or 0)

    def is_valid_key(self, key: str | None) -> bool:
        return bool(key) and (key in self.by_key or key in RESERVED_SCHEME_KEYS)

    def roles(self, key: str) -> set[str]:
        scheme = self.by_key.get(key)
        return {p["roleId"] for p in scheme["premiseRoles"]} if scheme else set()

    def question_ids(self, key: str) -> set[str]:
        scheme = self.by_key.get(key)
        return {q["id"] for q in scheme["criticalQuestions"]} if scheme else set()

    def aifdb_id(self, key: str) -> str | int | None:
        scheme = self.by_key.get(key)
        return scheme.get("aifdbSchemeId") if scheme else None

    def input_items(self) -> list[dict]:
        """Langflow 입력에 넣을 scheme 정의 (분류에 필요한 부분)."""
        return [
            {
                "schemeKey": s["schemeKey"],
                "nameKo": s["nameKo"],
                "name": s["name"],
                "description": s["description"],
                "premiseRoles": [{"roleId": r["roleId"], "label": r["label"], "template": r["template"]} for r in s["premiseRoles"]],
                "conclusion": s["conclusionRole"]["template"],
                "criticalQuestions": s["criticalQuestions"],
            }
            for s in self.data["schemes"]
        ]
