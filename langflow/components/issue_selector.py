from __future__ import annotations

import json
import re

import httpx
from lfx.custom import Component
from lfx.io import BoolInput, DropdownInput, FloatInput, IntInput, MessageTextInput, MultilineInput, Output, StrInput
from lfx.schema.message import Message

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
# 정답 그래프의 쟁점 수는 1~4개(평균 2.65)다. 여유를 두어 5개까지 받고, 몇 개를 고를지는 판결문이 정한다.
MAX_SELECTED = 5


class IssueSelector(Component):
    display_name = "Issue Selector"
    description = (
        "Reads the whole judgment and automatically selects the detailed issues the court actually decided (at most 5) from the 52-item "
        "issue catalog, each with a selection reason and a verbatim evidence quote. Validates the answer "
        "(at most 5, catalog IDs only, no duplicates, no two issues grounded in the same quote) with limited retries. Zero is allowed with a reason."
    )
    icon = "ListChecks"
    name = "IssueSelector"

    inputs = [
        MessageTextInput(name="judgment", display_name="Judgment", required=True),
        MessageTextInput(name="issue_catalog", display_name="Issue Catalog (JSON lines)", required=True),
        MessageTextInput(name="claim_json", display_name="Main Claim JSON", required=True),
        MultilineInput(
            name="prompt_template",
            display_name="Selection Prompt Template",
            info="Variables: {max_issues}, {main_claim}, {issue_catalog}, {judgment}. Substituted literally.",
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
        IntInput(name="retries", display_name="Retries on invalid answer", value=2, advanced=True),
    ]

    outputs = [Output(display_name="Selection JSON", name="selection_json", method="select")]

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
    def catalog_ids(text: str) -> list[str]:
        ids = []
        for line in str(text or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line, strict=False)
            except ValueError:
                continue
            if isinstance(item, dict) and item.get("issue_id"):
                ids.append(str(item["issue_id"]))
        return ids

    @staticmethod
    def validate_selection(obj: dict, catalog: set[str]) -> tuple[list[dict], str, list[str]]:
        """(선택 목록, 0개 사유, 오류). 오류가 있으면 재시도 대상."""
        errors: list[str] = []
        items = obj.get("selected_issues")
        if not isinstance(items, list):
            return [], "", ["selected_issues must be an array"]
        if len(items) > MAX_SELECTED:
            errors.append(f"selected {len(items)} issues; at most {MAX_SELECTED} are allowed")
        selected: list[dict] = []
        seen: set[str] = set()
        quotes_seen: dict[str, int] = {}
        for index, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                errors.append(f"selected_issues[{index}] must be an object")
                continue
            issue_id = str(item.get("issue_id") or "").strip()
            if issue_id not in catalog:
                errors.append(f"selected_issues[{index}].issue_id {issue_id!r} is not in the issue catalog")
                continue
            if issue_id in seen:
                errors.append(f"issue_id {issue_id} is selected more than once")
                continue
            seen.add(issue_id)
            issue_text = str(item.get("issue_text") or "").strip()
            reason = str(item.get("selection_reason") or "").strip()
            if not issue_text:
                errors.append(f"selected_issues[{index}].issue_text is empty")
            if not reason:
                errors.append(f"selected_issues[{index}].selection_reason is empty")
            quote = str(item.get("evidence_quote") or "").strip()
            # 같은 대목을 근거로 든 두 쟁점은 한 쟁점을 쪼갠 것이다. 수를 채우려고 나눈 경우를 막는다.
            if quote and quote in quotes_seen:
                errors.append(
                    f"selected_issues[{index}] is grounded in the same quote as selected_issues[{quotes_seen[quote]}]; "
                    "select one issue for one ground instead of splitting it"
                )
                continue
            if quote:
                quotes_seen[quote] = index
            selected.append(
                {
                    "issue_id": issue_id,
                    "issue_text": issue_text,
                    "selection_reason": reason,
                    "evidence_quote": str(item.get("evidence_quote") or "").strip(),
                }
            )
        no_issue_reason = str(obj.get("no_issue_reason") or "").strip()
        if not items and not no_issue_reason:
            errors.append("no issue selected but no_issue_reason is empty")
        return selected, no_issue_reason, errors

    def render_prompt(self, template: str, main_claim: str, catalog: str, judgment: str) -> str:
        rendered = template.replace("{max_issues}", str(MAX_SELECTED)).replace("{main_claim}", main_claim)
        rendered = rendered.replace("{issue_catalog}", catalog)
        # 판결문은 마지막에 넣어 원문 안의 중괄호가 변수로 오인되지 않게 한다.
        return rendered.replace("{judgment}", judgment)

    def call_model(self, messages: list[dict]) -> dict:
        payload = {
            "model": self._text(self.model_name),
            "messages": messages,
            "format": "json",
            "stream": False,
            "think": bool(getattr(self, "think", False)),
            "options": {"temperature": float(self.temperature or 0), "num_ctx": int(self.num_ctx or 2048)},
        }
        timeout = int(self.timeout or 0)
        response = httpx.post(
            f"{self._text(self.base_url).rstrip('/')}/api/chat",
            json=payload,
            timeout=None if timeout <= 0 else float(timeout),
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Ollama HTTP {response.status_code}: {response.text[:300]}")
        body = response.json()
        return {
            "content": (body.get("message") or {}).get("content") or "",
            "prompt_eval_count": body.get("prompt_eval_count"),
            "done_reason": body.get("done_reason"),
        }

    def select(self) -> Message:
        catalog_text = self._text(self.issue_catalog)
        catalog = set(self.catalog_ids(catalog_text))
        if not catalog:
            raise ValueError("Issue catalog is empty; the relay server must send the 52-item catalog.")
        template = self._text(self.prompt_template)
        if not template.strip():
            raise ValueError("Selection Prompt Template is empty.")
        try:
            main_claim = str(self.parse_json_object(self._text(self.claim_json)).get("main_claim") or "").strip()
        except ValueError:
            main_claim = ""
        prompt = self.render_prompt(template, main_claim, catalog_text, self._text(self.judgment))
        messages = []
        system = self._text(getattr(self, "system_message", ""))
        if system.strip():
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        attempts = max(1, int(self.retries or 0) + 1)
        errors: list[str] = []
        warnings: list[str] = []
        for attempt in range(1, attempts + 1):
            try:
                result = self.call_model(messages)
            except Exception as error:  # noqa: BLE001 - 호출 오류도 기록하고 재시도한다.
                errors = [f"attempt {attempt}: {error.__class__.__name__}: {error}"]
                continue
            content = result.get("content", "")
            used = result.get("prompt_eval_count")
            num_ctx = int(self.num_ctx or 0)
            if isinstance(used, int) and num_ctx and used >= num_ctx - 8:
                warnings.append(f"context_limit: prompt used {used} of {num_ctx} tokens; the judgment may have been truncated.")
            try:
                obj = self.parse_json_object(content)
            except ValueError as error:
                errors = [f"attempt {attempt}: invalid JSON: {error}"]
            else:
                selected, reason, errors = self.validate_selection(obj, catalog)
                if not errors:
                    status = "ok" if selected else "no_issues"
                    self.status = f"{status}: {', '.join(i['issue_id'] for i in selected) or reason}"
                    return Message(
                        text=json.dumps(
                            {
                                "status": status,
                                "selected": selected,
                                "no_issue_reason": reason,
                                "attempts": attempt,
                                "warnings": sorted(set(warnings)),
                                "model": self._text(self.model_name),
                            },
                            ensure_ascii=False,
                        )
                    )
            # 제한된 재시도: 무엇이 틀렸는지 알려 주고 다시 답하게 한다.
            messages = [
                *messages,
                {"role": "assistant", "content": content},
                {
                    "role": "user",
                    "content": "Your previous answer was invalid:\n- "
                    + "\n- ".join(errors)
                    + f"\nReturn corrected JSON only. Select at most {MAX_SELECTED} distinct issue_id values from the catalog, "
                    + "one per separate ground the court decided. Do not add issues to reach the maximum.",
                },
            ]
        self.status = "invalid selection"
        return Message(
            text=json.dumps(
                {"status": "invalid", "selected": [], "no_issue_reason": "", "attempts": attempts, "errors": errors, "warnings": sorted(set(warnings))},
                ensure_ascii=False,
            )
        )
