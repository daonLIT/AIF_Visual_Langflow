"""쟁점 카탈로그(엑셀 변환본)와 Walton 스킴 카탈로그 조회."""
from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass, field, replace
from pathlib import Path

from ..i18n import Joined, Msg, t

# 쟁점 수는 판결문이 정하고 이 값은 천장일 뿐이다(사람이 만든 정답 그래프는 1~4개, 평균 2.65).
# flow 의 Issue Selector·Branch Extractor·Graph Builder·Result Validator 의 MAX_SELECTED 와 같은 값이어야 한다.
MAX_SELECTED_ISSUES = 3
UNCLASSIFIED = "unclassified"
CUSTOM = "custom"
RESERVED_SCHEME_KEYS = (UNCLASSIFIED, CUSTOM)

# 사용자가 만든 scheme 의 key 접두사. 정본 카탈로그 파일의 key 와 섞이지 않고,
# 카탈로그 버전 이행(migrations)이 건드리지 않아야 하므로 이것으로 구분한다.
# 콜론을 쓰지 않는다: key 가 URL 경로에 들어가므로 따로 인코딩하지 않아도 되는 글자만 쓴다.
CUSTOM_KEY_PREFIX = "custom-"
CUSTOM_GROUP = "직접 만든 도식"
CUSTOM_GROUP_EN = "User-defined"
CUSTOM_VERIFICATION = "user-defined"
# 결론 역할은 사용자에게 받지 않는다. 화면·프롬프트가 요구하는 자리를 이 기본값으로 채운다.
CUSTOM_CONCLUSION_ROLE = {
    "roleId": "conclusion",
    "label": "결론",
    "labelEn": "Conclusion",
    "template": "위 전제들에서 이 결론을 받아들일 만하다.",
    "templateEn": "Given the premises above, this conclusion may be accepted.",
}
MAX_CUSTOM_PREMISE_ROLES = 8


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

    def with_custom(self, records: list[dict]) -> "SchemeCatalog":
        """사용자가 만든 scheme(DB 기록)을 얹은 사본.

        정본 파일의 schemeCatalogVersion·sha256 은 그대로 둔다. 사용자가 scheme 을 하나 더 만들었다고
        카탈로그 버전이 오르면 기존 그래프가 모두 이행 대상이 되고, 게시할 때 카탈로그 대조도 깨진다.
        """
        if not records:
            return self
        entries = [custom_scheme_entry(record) for record in records]
        labels = {**(self.data.get("verificationLabels") or {}), CUSTOM_VERIFICATION: t("catalog.custom_verification")}
        data = {
            **self.data,
            "schemes": [*self.data["schemes"], *entries],
            "verificationLabels": labels,
            # 사용자 scheme 이 몇 번 바뀌었는지. 버전과 달리 이행(migrations) 기준이 아니라 기록용이다.
            "customSchemesRevision": sum(int(record.get("revision") or 0) for record in records),
        }
        return replace(
            self,
            data=data,
            by_key={**self.by_key, **{entry["schemeKey"]: entry for entry in entries}},
        )

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
        """Langflow 입력에 넣을 scheme 정의 (분류에 필요한 부분).

        사용자가 만든 scheme 중 폐기한 것과 'AI 사용 허용'을 끈 것은 모델에게 보내지 않는다.
        (과거 그래프의 이름 표시에는 계속 쓰이므로 카탈로그 자체에서는 빠지지 않는다.)
        """
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
            if not s.get("retired") and s.get("enabledForAi", True)
        ]


# ---- 사용자가 만든 scheme ----
def is_custom_scheme_key(key: str | None) -> bool:
    return bool(key) and str(key).startswith(CUSTOM_KEY_PREFIX)


def new_custom_scheme_key() -> str:
    """사용자가 만든 scheme 의 key. 이름과 무관하게 서버가 정한다(이름을 바꿔도 과거 그래프가 가리키는 key 는 그대로)."""
    return f"{CUSTOM_KEY_PREFIX}{secrets.token_hex(4)}"


def build_custom_definition(
    scheme_key: str,
    *,
    name_ko: str,
    name_en: str | None,
    description: str,
    premise_roles: list[dict],
    previous: dict | None = None,
) -> dict:
    """입력값을 카탈로그 scheme 정의 형식으로 만든다. 비판적 질문과 결론 역할은 받지 않고 기본값으로 둔다.

    고치는 경우에는 이름이 같은 역할의 roleId 를 그대로 물려준다. 이미 저장된 그래프의
    premiseBindings 가 roleId 를 가리키므로, 역할을 하나 지웠다고 남은 역할의 배정이 밀려서는 안 된다.
    """
    kept = {role["label"]: role["roleId"] for role in (previous or {}).get("premiseRoles", [])}
    used = set(kept.values())
    roles = []
    for role in premise_roles:
        role_id = kept.get(role["label"])
        if role_id is None:
            index = 1
            while f"r{index}" in used:
                index += 1
            role_id = f"r{index}"
        used.add(role_id)
        roles.append({"roleId": role_id, "label": role["label"], "template": (role.get("template") or "").strip() or role["label"]})
    return {
        "schemeKey": scheme_key,
        "name": (name_en or "").strip() or name_ko,
        "nameKo": name_ko,
        "group": CUSTOM_GROUP,
        "groupEn": CUSTOM_GROUP_EN,
        "description": description,
        "premiseRoles": roles,
        "conclusionRole": dict(CUSTOM_CONCLUSION_ROLE),
        # 비판적 질문은 받지 않는다. 화면과 프롬프트는 빈 목록을 다룰 수 있다.
        "criticalQuestions": [],
        "aifdbSchemeId": None,
        "verification": CUSTOM_VERIFICATION,
    }


def custom_scheme_entry(record: dict) -> dict:
    """DB 기록을 카탈로그 schemes 항목으로. 정본 항목과 구분되도록 custom 표시와 상태를 함께 싣는다."""
    return {
        **record["definition"],
        "schemeKey": record["schemeKey"],
        "custom": True,
        "enabledForAi": bool(record.get("enabledForAi", True)),
        "retired": bool(record.get("retired")),
        "revision": int(record.get("revision") or 1),
        "createdAt": record.get("createdAt"),
        "updatedAt": record.get("updatedAt"),
        "createdBy": record.get("createdBy"),
        "updatedBy": record.get("updatedBy"),
    }


def merged_scheme_catalog(catalog: "SchemeCatalog | None", db) -> "SchemeCatalog | None":
    """정본 카탈로그에 DB 의 사용자 scheme 을 얹는다. 카탈로그를 읽는 모든 곳이 이것을 쓴다."""
    if catalog is None:
        return None
    return catalog.with_custom(db.list_custom_schemes())
