"""쟁점 카탈로그(엑셀 변환본)와 Walton 스킴 카탈로그 조회."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from ..i18n import Joined, Msg

# 쟁점 수는 판결문이 정하고 이 값은 천장일 뿐이다(사람이 만든 정답 그래프는 1~4개, 평균 2.65).
# flow 의 Issue Selector·Branch Extractor·Graph Builder·Result Validator 의 MAX_SELECTED 와 같은 값이어야 한다.
MAX_SELECTED_ISSUES = 3
UNCLASSIFIED = "unclassified"
CUSTOM = "custom"
RESERVED_SCHEME_KEYS = (UNCLASSIFIED, CUSTOM)


class CatalogError(ValueError):
    pass


def _load_json(path: Path, label: Msg) -> tuple[dict, str]:
    # 카탈로그는 서버 시작 때 읽으므로 아직 언어를 모른다. 메시지는 Msg 로 두고 응답할 때 만든다.
    if not path.exists():
        raise CatalogError(Msg("catalog.file_missing", label=label, path=path))
    raw = path.read_bytes()
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogError(Msg("catalog.bad_json", label=label, error=error)) from error
    if not isinstance(data, dict):
        raise CatalogError(Msg("catalog.not_object", label=label))
    return data, hashlib.sha256(raw).hexdigest()


@dataclass
class IssueCatalog:
    data: dict
    sha256: str = ""
    by_id: dict[str, dict] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> "IssueCatalog":
        data, digest = _load_json(path, Msg("catalog.issue"))
        issues = data.get("issues")
        if not isinstance(issues, list) or not issues:
            raise CatalogError(Msg("catalog.no_issues"))
        by_id = {}
        for issue in issues:
            if not isinstance(issue, dict) or not issue.get("issueId"):
                raise CatalogError(Msg("catalog.no_issue_id"))
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
        data, digest = _load_json(path, Msg("catalog.scheme"))
        schemes = data.get("schemes")
        if not isinstance(schemes, list) or not schemes:
            raise CatalogError(Msg("catalog.no_schemes"))
        by_key = {}
        for scheme in schemes:
            key = scheme.get("schemeKey") if isinstance(scheme, dict) else None
            if not key or key in RESERVED_SCHEME_KEYS:
                raise CatalogError(Msg("catalog.bad_scheme_key", key=repr(key)))
            by_key[key] = scheme
        catalog = cls(data=data, sha256=digest, by_key=by_key)
        migrations_path = path.parent / SCHEME_MIGRATIONS_FILE
        if migrations_path.exists():
            migration_data, _ = _load_json(migrations_path, Msg("catalog.migrations"))
            catalog.migrations = migration_data.get("migrations") or []
            catalog.validate_migrations()
        return catalog

    def validate_migrations(self) -> None:
        """현재 카탈로그로 가는 대응표의 대상 key·역할·CQ 가 실제로 있는지 확인한다. 틀리면 CatalogError."""
        if not isinstance(self.migrations, list):
            raise CatalogError(Msg("catalog.migrations_not_array"))
        problems: list[Msg] = []
        for migration in self.migrations:
            if not isinstance(migration, dict) or not isinstance(migration.get("schemes"), dict):
                problems.append(Msg("catalog.migration_no_schemes"))
                continue
            source, target = migration.get("fromVersion"), migration.get("toVersion")
            if not isinstance(source, int) or not isinstance(target, int) or source >= target:
                problems.append(Msg("catalog.migration_bad_version", source=repr(source), target=repr(target)))
                continue
            if target != self.version:
                continue  # 더 이전 단계의 대응표는 대상 카탈로그가 없어 검사할 수 없다.
            for key, rule in migration["schemes"].items():
                label = f"v{source}→v{target} {key}"
                action = rule.get("action") if isinstance(rule, dict) else None
                if action not in MIGRATION_ACTIONS:
                    problems.append(Msg("catalog.migration_bad_action", label=label, action=repr(action)))
                    continue
                if action == "keep" and key not in self.by_key:
                    problems.append(Msg("catalog.migration_keep_missing", label=label))
                if action in ("replace", "unclassify") and key in self.by_key:
                    problems.append(Msg("catalog.migration_should_keep", label=label))
                destination = key if action == "keep" else rule.get("to")
                if action == "replace" and destination not in self.by_key:
                    problems.append(Msg("catalog.migration_missing_target", label=label, destination=repr(destination)))
                    continue
                if action != "unclassify":
                    unknown_roles = set((rule.get("roleMap") or {}).values()) - self.roles(destination)
                    unknown_questions = set((rule.get("questionMap") or {}).values()) - self.question_ids(destination)
                    if unknown_roles:
                        problems.append(Msg("catalog.migration_unknown_roles", label=label, destination=destination, roles=sorted(unknown_roles)))
                    if unknown_questions:
                        problems.append(Msg("catalog.migration_unknown_questions", label=label, destination=destination, questions=sorted(unknown_questions)))
                for candidate in rule.get("candidates") or []:
                    if candidate.get("schemeKey") not in self.by_key:
                        problems.append(Msg("catalog.migration_unknown_candidate", label=label, candidate=repr(candidate.get("schemeKey"))))
        if problems:
            raise CatalogError(Msg("catalog.migration_errors", problems=Joined(problems)))

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
