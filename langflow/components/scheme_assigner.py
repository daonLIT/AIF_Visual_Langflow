from __future__ import annotations

import json
import re

import httpx
from lfx.custom import Component
from lfx.io import BoolInput, DropdownInput, FloatInput, IntInput, MessageTextInput, MultilineInput, Output, StrInput
from lfx.schema.message import Message

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
# 모델 입력용 별칭(R1, N2…)이 한국어 설명에 섞인 경우: 괄호 묶음은 지우고, 맨 별칭은 "해당 전제/추론"으로 바꾼다.
# 그 그룹에 실제로 준 별칭만 지운다 (판결문의 "N95" 같은 표기는 건드리지 않는다).
_ALIAS = r"[RN]\d{1,2}"
_ALIAS_LIST = rf"(?<![A-Za-z0-9]){_ALIAS}(?:\s*(?:,|/|·|와|과|및)\s*{_ALIAS})*(?![A-Za-z0-9])"
_ALIAS_PAREN = re.compile(rf"\s*[(\[（]\s*({_ALIAS_LIST})\s*[)\]）]")
_ALIAS_AFTER_WORD = re.compile(rf"(전제|추론|노드)\s*({_ALIAS_LIST})")
_ALIAS_BARE = re.compile(rf"({_ALIAS_LIST})")
_ALIAS_TOKEN = re.compile(_ALIAS)
RESERVED = ("unclassified", "custom")
CQ_STATUSES = ("open", "satisfied", "challenged")
# 쟁점 노드에 닿는 RA 는 실질 추론이 아니라 그래프의 구조 관계다. 모델에게 묻지 않고 구조로 정한다.
# (묻게 두면 아래 추론을 다시 서술하거나 미분류로 떨어진다.)
ISSUE_RESOLUTION = "issue_resolution"
ISSUE_AGGREGATION = "issue_aggregation"
STRUCTURAL_ROLES = {ISSUE_RESOLUTION: "finding", ISSUE_AGGREGATION: "issueFinding"}
STRUCTURAL_RATIONALES = {
    ISSUE_RESOLUTION: "쟁점을 결론으로 두는 연결이므로 쟁점 판단 관계로 둔다. 실질 추론은 이 아래 RA 가 담는다.",
    ISSUE_AGGREGATION: "쟁점별 판단을 종국 판단으로 잇는 연결이므로 쟁점 종합 관계로 둔다.",
}


class SchemeAssigner(Component):
    display_name = "RA Scheme Assigner"
    description = (
        "RA scheme assignment stage. RAs that touch an ISSUE node are graph structure, not substantive inference, so "
        "they are assigned from the structure ('issue_resolution' when the ISSUE is the conclusion, 'issue_aggregation' "
        "when ISSUEs are the premises) and are never sent to the model. Every other RA is classified with one scheme "
        "key from the allowed Walton scheme catalog (or 'unclassified' when none fits), based on the full premise "
        "texts, the conclusion text and their evidence quotes - not on summaries. Validates keys, roles and premise "
        "references with a limited retry; invalid parts are recorded as errors and never invented."
    )
    icon = "Workflow"
    name = "SchemeAssigner"

    inputs = [
        MessageTextInput(name="graph_json", display_name="Graph JSON", required=True),
        MessageTextInput(name="scheme_catalog", display_name="Scheme Catalog (JSON lines)", required=True),
        MultilineInput(
            name="prompt_template",
            display_name="Scheme Prompt Template",
            info="Variables: {scheme_catalog}, {ra_items_json}. Substituted literally.",
            value="",
        ),
        MultilineInput(name="system_message", display_name="System Message", value="", advanced=True),
        StrInput(name="base_url", display_name="Ollama Base URL", value="http://localhost:11434"),
        DropdownInput(
            name="model_name",
            display_name="Model Name",
            options=["qwen36-27b-q8-ctx32k", "qwen36-27b-q8-ctx32k-np", "gemma4-e4b-ctx32k", "gemma4:e4b-it-qat", "qwen2.5:14b-instruct"],
            value="qwen36-27b-q8-ctx32k",
            combobox=True,
        ),
        BoolInput(
            name="think",
            display_name="Thinking",
            value=False,
            info="추론 모델의 사고 과정을 켠다. 답의 JSON 은 그대로지만 생성이 10배 이상 느려진다.",
            advanced=True,
        ),
        FloatInput(name="temperature", display_name="Temperature", value=0.1),
        IntInput(name="num_ctx", display_name="Context Window Size", value=32768),
        IntInput(name="timeout", display_name="Timeout per call (s)", value=600, info="0 = no limit"),
        IntInput(name="retries", display_name="Retries on invalid answer", value=1, advanced=True),
    ]

    outputs = [Output(display_name="Classified Graph JSON", name="classified_graph", method="assign")]

    # ---- helpers ----
    @staticmethod
    def _text(value) -> str:
        text = getattr(value, "text", None)
        return str(text if text is not None else (value or ""))

    @staticmethod
    def parse_json_object(text: str) -> dict:
        stripped = str(text or "").strip()
        match = _FENCE.match(stripped)
        if match:
            stripped = match.group(1).strip()
        value = json.loads(stripped, strict=False)
        if not isinstance(value, dict):
            raise ValueError("answer must be a JSON object")
        return value

    @staticmethod
    def read_catalog(text: str) -> dict[str, dict]:
        catalog = {}
        for line in str(text or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line, strict=False)
            except ValueError:
                continue
            if isinstance(item, dict) and item.get("schemeKey"):
                catalog[item["schemeKey"]] = item
        return catalog

    @staticmethod
    def selectable_catalog_text(text: str) -> str:
        """모델에게 보여줄 카탈로그. 구조로 정해지는 쟁점 관계 scheme 은 고르지 못하도록 뺀다."""
        kept = []
        for line in str(text or "").splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                item = json.loads(stripped, strict=False)
            except ValueError:
                kept.append(line)
                continue
            if isinstance(item, dict) and item.get("schemeKey") in STRUCTURAL_ROLES:
                continue
            kept.append(line)
        return "\n".join(kept)

    @staticmethod
    def groups(graph: dict) -> list[dict]:
        """쟁점 가지(instance)별로 RA 와 전제·결론 노드를 묶는다."""
        nodes = {n["nodeID"]: n for n in graph["AIF"]["nodes"]}
        incoming: dict[str, list[str]] = {}
        outgoing: dict[str, list[str]] = {}
        for edge in graph["AIF"]["edges"]:
            incoming.setdefault(edge["toID"], []).append(edge["fromID"])
            outgoing.setdefault(edge["fromID"], []).append(edge["toID"])
        grouped: dict[str, list[dict]] = {}
        for node in graph["AIF"]["nodes"]:
            if node.get("type") != "RA":
                continue
            refs = node.get("issueRefs") or []
            key = refs[0]["instanceId"] if refs and isinstance(refs[0], dict) and refs[0].get("instanceId") else "main"
            grouped.setdefault(key, []).append(
                {
                    "ra": node,
                    "premises": [nodes[i] for i in incoming.get(node["nodeID"], []) if i in nodes],
                    "conclusions": [nodes[i] for i in outgoing.get(node["nodeID"], []) if i in nodes],
                }
            )
        return [{"instanceId": key, "items": items} for key, items in grouped.items()]

    @staticmethod
    def structural_key(entry: dict) -> str | None:
        """쟁점 노드에 닿는 RA 인지 구조로 판별한다. 아니면 None (모델이 분류한다)."""
        if any(node.get("type") == "ISSUE" for node in entry["conclusions"]):
            return ISSUE_RESOLUTION
        if any(node.get("type") == "ISSUE" for node in entry["premises"]):
            return ISSUE_AGGREGATION
        return None

    @staticmethod
    def structural_application(entry: dict, key: str, catalog: dict[str, dict]) -> tuple[dict, list[str]]:
        """구조로 정해지는 RA 의 schemeApplication. 모델을 부르지 않으므로 지어낸 설명이 들어가지 않는다."""
        errors: list[str] = []
        if key not in catalog:
            errors.append(f"scheme_key {key!r} is not in the catalog; the catalog must define the issue relation schemes")
            key = "unclassified"
        role = STRUCTURAL_ROLES.get(key)
        node_ids = [p["nodeID"] for p in entry["premises"]]
        return (
            {
                "schemeKey": key,
                "status": "suggested",
                "origin": "ai",
                "rationale": STRUCTURAL_RATIONALES.get(key, ""),
                "premiseBindings": [{"roleId": role, "nodeIds": node_ids}] if role and node_ids else [],
                "conclusionNodeIds": [c["nodeID"] for c in entry["conclusions"]],
                # 비판적 질문은 사람이 검토할 몫이라 열어 둔다.
                "criticalQuestionResponses": [
                    {"questionId": q["id"], "status": "open", "answer": ""} for q in catalog.get(key, {}).get("criticalQuestions", [])
                ],
                "notes": "",
                "customSchemeName": None,
                "alternatives": [],
            },
            errors,
        )

    @staticmethod
    def strip_aliases(text, known: set[str]) -> str:
        """설명 문장에서 모델 입력용 별칭(known)을 없앤다. 사용자 화면에는 별칭이 없어 뜻이 통하지 않는다."""

        def only_known(group: str) -> bool:
            return all(token in known for token in _ALIAS_TOKEN.findall(group))

        def bare(match: re.Match) -> str:
            if not only_known(match.group(1)):
                return match.group(0)
            return "해당 추론" if match.group(1).startswith("R") else "해당 전제"

        text = str(text or "")
        text = _ALIAS_PAREN.sub(lambda m: "" if only_known(m.group(1)) else m.group(0), text)
        text = _ALIAS_AFTER_WORD.sub(lambda m: m.group(1) if only_known(m.group(2)) else m.group(0), text)
        text = _ALIAS_BARE.sub(bare, text)
        return re.sub(r"[ \t]{2,}", " ", text).strip()

    @staticmethod
    def quotes(node: dict) -> list[str]:
        return [e.get("quote") for e in node.get("evidence") or [] if isinstance(e, dict) and e.get("quote")]

    def build_items(self, group: dict) -> tuple[list[dict], dict[str, dict]]:
        """LLM 에는 짧은 별칭(R1, N1…)으로 준다. 반환: (프롬프트 항목, 별칭 → 실제 ID 정보)."""
        items: list[dict] = []
        aliases: dict[str, dict] = {}
        node_counter = 0
        for index, entry in enumerate(group["items"], start=1):
            ra_alias = f"R{index}"
            premise_aliases = {}
            premises = []
            for premise in entry["premises"]:
                node_counter += 1
                alias = f"N{node_counter}"
                premise_aliases[alias] = premise["nodeID"]
                premises.append({"id": alias, "type": premise["type"], "text": premise["text"], "evidence_quotes": self.quotes(premise)})
            conclusions = [{"type": c["type"], "text": c["text"], "evidence_quotes": self.quotes(c)} for c in entry["conclusions"]]
            aliases[ra_alias] = {"ra": entry["ra"], "premises": premise_aliases, "conclusions": [c["nodeID"] for c in entry["conclusions"]]}
            items.append({"ra": ra_alias, "premises": premises, "conclusion": conclusions[0] if len(conclusions) == 1 else conclusions})
        return items, aliases

    @staticmethod
    def validate_assignment(raw: dict, alias: dict, catalog: dict[str, dict], known_aliases: set[str] | None = None) -> tuple[dict, list[str]]:
        """한 RA 의 답을 schemeApplication 필드로 바꾼다. (결과, 오류)"""
        errors: list[str] = []
        known = known_aliases if known_aliases is not None else set(alias["premises"])
        key = str(raw.get("scheme_key") or "").strip()
        if key in STRUCTURAL_ROLES:
            # 쟁점 관계 scheme 은 구조로만 정한다. 모델이 고르면 받지 않는다.
            errors.append(f"scheme_key {key!r} is assigned by graph structure only and cannot be chosen")
            key = "unclassified"
        elif key not in catalog and key not in RESERVED:
            errors.append(f"scheme_key {key!r} is not allowed")
            key = "unclassified"
        roles = {r["roleId"] for r in catalog[key]["premiseRoles"]} if key in catalog else set()
        questions = {q["id"] for q in catalog[key]["criticalQuestions"]} if key in catalog else set()
        bindings = []
        bound_refs: dict[str, str] = {}
        for binding in raw.get("premise_bindings") or []:
            if not isinstance(binding, dict):
                continue
            role = str(binding.get("role_id") or "").strip()
            if key in catalog and role not in roles:
                errors.append(f"role_id {role!r} is not a role of {key}")
                continue
            node_ids = []
            for ref in binding.get("premises") or []:
                ref = str(ref)
                real = alias["premises"].get(ref)
                if real is None:
                    errors.append(f"premise reference {ref!r} is not a premise of this RA")
                elif ref in bound_refs and bound_refs[ref] != role:
                    # 한 명제가 서로 다른 두 전제 역할을 동시에 채울 수는 없다. 처음 역할만 남긴다.
                    errors.append(f"premise {ref} is bound to more than one role ({bound_refs[ref]}, {role}); bind each premise to at most one role")
                elif ref not in bound_refs:
                    bound_refs[ref] = role
                    node_ids.append(real)
            if node_ids:
                bindings.append({"roleId": role or None, "nodeIds": node_ids})
        responses = []
        for item in raw.get("critical_question_responses") or []:
            if not isinstance(item, dict):
                continue
            question_id = str(item.get("question_id") or "").strip()
            if question_id not in questions:
                errors.append(f"question_id {question_id!r} is not defined for {key}")
                continue
            status = str(item.get("status") or "").strip().lower()
            responses.append(
                {
                    "questionId": question_id,
                    "status": status if status in CQ_STATUSES else "open",
                    "answer": SchemeAssigner.strip_aliases(item.get("answer"), known),
                }
            )
        alternatives = []
        for item in raw.get("alternatives") or []:
            if not isinstance(item, dict):
                continue
            alt = str(item.get("scheme_key") or "").strip()
            if alt in catalog and alt != key:
                alternatives.append({"schemeKey": alt, "rationale": SchemeAssigner.strip_aliases(item.get("rationale"), known)})
            elif alt:
                errors.append(f"alternative scheme_key {alt!r} is not allowed")
        custom_name = str(raw.get("custom_scheme_name") or "").strip() or None
        return (
            {
                "schemeKey": key,
                "status": "suggested",
                "origin": "ai",
                "rationale": SchemeAssigner.strip_aliases(raw.get("rationale"), known),
                "premiseBindings": bindings,
                "conclusionNodeIds": alias["conclusions"],
                "criticalQuestionResponses": responses,
                "notes": "",
                "customSchemeName": custom_name if key == "custom" else None,
                "alternatives": alternatives,
            },
            errors,
        )

    def call_model(self, messages: list[dict]) -> str:
        timeout = int(self.timeout or 0)
        response = httpx.post(
            f"{self._text(self.base_url).rstrip('/')}/api/chat",
            json={
                "model": self._text(self.model_name),
                "messages": messages,
                "format": "json",
                "stream": False,
                "think": bool(getattr(self, "think", False)),
                "options": {"temperature": float(self.temperature or 0), "num_ctx": int(self.num_ctx or 2048)},
            },
            timeout=None if timeout <= 0 else float(timeout),
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Ollama HTTP {response.status_code}: {response.text[:300]}")
        return (response.json().get("message") or {}).get("content") or ""

    def assign_group(self, group: dict, catalog: dict[str, dict], catalog_text: str, template: str, version) -> list[str]:
        # 쟁점에 닿는 RA 는 구조로 정하고 모델에게 보내지 않는다.
        structural = [(entry, key) for entry in group["items"] if (key := self.structural_key(entry))]
        remaining = {"instanceId": group["instanceId"], "items": [entry for entry in group["items"] if not self.structural_key(entry)]}
        report: list[str] = []
        for entry, key in structural:
            application, errors = self.structural_application(entry, key, catalog)
            application["catalogVersion"] = version
            if errors:
                application["errors"] = errors
                report.append(f"{entry['ra']['nodeID']}: " + "; ".join(errors))
            entry["ra"]["schemeApplication"] = application
        if not remaining["items"]:
            return report

        items, aliases = self.build_items(remaining)
        selectable = self.selectable_catalog_text(catalog_text)
        prompt = template.replace("{scheme_catalog}", selectable).replace("{ra_items_json}", json.dumps(items, ensure_ascii=False, indent=2))
        messages = []
        system = self._text(getattr(self, "system_message", ""))
        if system.strip():
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        results: dict[str, tuple[dict, list[str]]] = {}
        group_errors: list[str] = []
        known_aliases = set(aliases) | {ref for info in aliases.values() for ref in info["premises"]}
        for attempt in range(1, max(1, int(self.retries or 0) + 1) + 1):
            try:
                content = self.call_model(messages)
                answer = self.parse_json_object(content)
            except Exception as error:  # noqa: BLE001
                group_errors = [f"attempt {attempt}: {error.__class__.__name__}: {error}"]
                continue
            feedback = []
            for raw in answer.get("assignments") or []:
                if not isinstance(raw, dict) or str(raw.get("ra")) not in aliases:
                    continue
                application, errors = self.validate_assignment(raw, aliases[str(raw["ra"])], catalog, known_aliases)
                previous = results.get(str(raw["ra"]))
                # 더 나은(오류가 적은) 답만 남긴다.
                if previous is None or len(errors) < len(previous[1]):
                    results[str(raw["ra"])] = (application, errors)
                if errors:
                    feedback.append(f"{raw['ra']}: " + "; ".join(errors))
            missing = [alias for alias in aliases if alias not in results]
            if missing:
                feedback.append(f"missing assignments for: {', '.join(missing)}")
            if not feedback:
                break
            messages = [
                *messages,
                {"role": "assistant", "content": content},
                {"role": "user", "content": "Your previous answer had problems:\n- " + "\n- ".join(feedback) + "\nReturn corrected JSON only, one assignment per RA."},
            ]
        report.extend(group_errors)
        for alias, info in aliases.items():
            application, errors = results.get(
                alias,
                (
                    {
                        "schemeKey": "unclassified",
                        "status": "suggested",
                        "origin": "ai",
                        "rationale": "",
                        "premiseBindings": [],
                        "conclusionNodeIds": info["conclusions"],
                        "criticalQuestionResponses": [],
                        "notes": "",
                        "customSchemeName": None,
                        "alternatives": [],
                    },
                    ["no valid assignment returned"],
                ),
            )
            application["catalogVersion"] = version
            if errors:
                application["errors"] = errors
                report.append(f"{info['ra']['nodeID']}: " + "; ".join(errors))
            info["ra"]["schemeApplication"] = application
        return report

    def assign(self) -> Message:
        graph = self.parse_json_object(self._text(self.graph_json))
        if graph.get("status") != "ok":
            self.status = f"skipped: {graph.get('status')}"
            return Message(text=json.dumps(graph, ensure_ascii=False, indent=2))
        catalog_text = self._text(self.scheme_catalog)
        catalog = self.read_catalog(catalog_text)
        if not catalog:
            raise ValueError("Scheme catalog is empty; the relay server must send the scheme catalog.")
        template = self._text(self.prompt_template)
        if not template.strip():
            raise ValueError("Scheme Prompt Template is empty.")
        version = (graph.get("meta") or {}).get("catalogVersions", {}).get("scheme")
        errors: list[str] = []
        for group in self.groups(graph):
            errors.extend(self.assign_group(group, catalog, catalog_text, template, version))
        ras = [n for n in graph["AIF"]["nodes"] if n.get("type") == "RA"]
        counts: dict[str, int] = {}
        for ra in ras:
            key = ra["schemeApplication"]["schemeKey"]
            counts[key] = counts.get(key, 0) + 1
        graph.setdefault("meta", {})["schemes"] = {"raCount": len(ras), "keys": counts, "errors": errors, "model": self._text(self.model_name)}
        self.status = f"{len(ras)} RA classified ({counts.get('unclassified', 0)} unclassified)"
        return Message(text=json.dumps(graph, ensure_ascii=False, indent=2))
