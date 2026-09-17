from __future__ import annotations

import json
import re
import time

import httpx
from lfx.custom import Component
from lfx.io import BoolInput, DropdownInput, FloatInput, IntInput, MessageTextInput, MultilineInput, Output, StrInput
from lfx.schema.message import Message

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)
# 정답 그래프의 쟁점 수는 1~4개(평균 2.65)다. 상한 5에서는 4·5번째 쟁점의 적중이 낮아(정답 13건 1/12) 3으로 둔다.
# 몇 개를 고를지는 판결문이 정하고 이 값은 천장일 뿐이다.
MAX_SELECTED = 3


class BranchError(ValueError):
    pass


class IssueBranchExtractor(Component):
    display_name = "Issue Branch Extractor"
    description = (
        "For each selected issue (at most 3) calls Ollama once to extract the upper/lower I-node texts with "
        "verbatim evidence quotes. Summaries and Walton schemes are produced by later stages. Per-issue failures "
        "and context-limit warnings are reported instead of being dropped."
    )
    icon = "GitBranch"
    name = "IssueBranchExtractor"

    inputs = [
        MessageTextInput(name="selection_json", display_name="Selection JSON", required=True),
        MessageTextInput(name="judgment", display_name="Judgment", required=True),
        MessageTextInput(name="claim_json", display_name="Main Claim JSON", required=True),
        MultilineInput(
            name="prompt_template",
            display_name="Branch Prompt Template",
            info="Variables: {issue_json}, {main_claim}, {judgment}. Substituted literally (JSON braces are safe).",
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
        IntInput(name="timeout", display_name="Timeout per issue (s)", value=600, info="0 = no limit"),
        IntInput(name="retries", display_name="Retries on invalid JSON", value=1, advanced=True),
    ]

    outputs = [Output(display_name="Branches JSON", name="branches_json", method="extract")]

    # ---- parsing helpers (pure) ----
    @staticmethod
    def _text(value) -> str:
        text = getattr(value, "text", None)
        return str(text if text is not None else (value or ""))

    @staticmethod
    def parse_json_object(text: str, label: str) -> dict:
        stripped = str(text or "").strip()
        match = _FENCE.match(stripped)
        if match:
            stripped = match.group(1).strip()
        try:
            value = json.loads(stripped, strict=False)
        except ValueError as error:
            raise BranchError(f"{label} is not valid JSON: {error}") from error
        if not isinstance(value, dict):
            raise BranchError(f"{label} must be a JSON object.")
        return value

    @staticmethod
    def validate_branch(obj: dict) -> dict:
        upper = obj.get("upper_i_node")
        if isinstance(upper, str):
            upper = {"text": upper}
        if not isinstance(upper, dict) or not str(upper.get("text") or "").strip():
            raise BranchError("upper_i_node.text is missing.")
        lowers = obj.get("lower_i_nodes")
        if not isinstance(lowers, list) or not lowers:
            raise BranchError("lower_i_nodes must be a non-empty array.")
        normalized = []
        for index, lower in enumerate(lowers, start=1):
            if isinstance(lower, str):
                lower = {"text": lower}
            if not isinstance(lower, dict) or not str(lower.get("text") or "").strip():
                raise BranchError(f"lower_i_nodes[{index}].text is missing.")
            normalized.append({"text": str(lower["text"]).strip(), "evidence_quote": str(lower.get("evidence_quote") or "").strip()})
        return {
            "upper_i_node": {"text": str(upper["text"]).strip(), "evidence_quote": str(upper.get("evidence_quote") or "").strip()},
            "lower_i_nodes": normalized,
        }

    @staticmethod
    def render_prompt(template: str, issue: dict, main_claim: str, judgment: str) -> str:
        rendered = template.replace("{issue_json}", json.dumps(issue, ensure_ascii=False, indent=2))
        rendered = rendered.replace("{main_claim}", main_claim)
        # 판결문을 마지막에 넣어 원문 안의 중괄호가 다른 변수로 오인되지 않게 한다.
        return rendered.replace("{judgment}", judgment)

    # ---- model call ----
    def call_model(self, prompt: str) -> dict:
        messages = []
        system = self._text(getattr(self, "system_message", ""))
        if system.strip():
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
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
            raise BranchError(f"Ollama HTTP {response.status_code}: {response.text[:300]}")
        body = response.json()
        return {
            "content": (body.get("message") or {}).get("content") or "",
            "prompt_eval_count": body.get("prompt_eval_count"),
            "done_reason": body.get("done_reason"),
        }

    def extract_one(self, index: int, issue: dict, main_claim: str, judgment: str, template: str) -> dict:
        prompt = self.render_prompt(
            template,
            {"issue_id": issue["issue_id"], "issue_text": issue["issue_text"], "selection_reason": issue["selection_reason"]},
            main_claim,
            judgment,
        )
        attempts = max(1, int(self.retries or 0) + 1)
        warnings: list[str] = []
        last_error = ""
        started = time.monotonic()
        for attempt in range(1, attempts + 1):
            try:
                result = self.call_model(prompt)
            except Exception as error:  # noqa: BLE001 - 쟁점별 오류로 기록한다.
                last_error = f"{error.__class__.__name__}: {error}"
                continue
            num_ctx = int(self.num_ctx or 0)
            used = result.get("prompt_eval_count")
            if isinstance(used, int) and num_ctx and used >= num_ctx - 8:
                warnings.append(f"context_limit: prompt used {used} of {num_ctx} tokens; the judgment may have been truncated.")
            if result.get("done_reason") == "length":
                warnings.append("output_truncated: the model stopped at the length limit.")
            try:
                branch = self.validate_branch(self.parse_json_object(result["content"], "branch output"))
            except BranchError as error:
                last_error = f"attempt {attempt}: {error}"
                continue
            return {
                "issue_id": issue["issue_id"],
                "issue_index": index,
                "status": "ok",
                "attempts": attempt,
                "seconds": round(time.monotonic() - started, 1),
                "warnings": sorted(set(warnings)),
                **branch,
            }
        return {
            "issue_id": issue["issue_id"],
            "issue_index": index,
            "status": "failed",
            "attempts": attempts,
            "seconds": round(time.monotonic() - started, 1),
            "error": last_error or "unknown error",
            "warnings": sorted(set(warnings)),
        }

    def extract(self) -> Message:
        selection = self.parse_json_object(self._text(self.selection_json), "Selection JSON")
        status = selection.get("status")
        selected = selection.get("selected") if isinstance(selection.get("selected"), list) else []
        if status != "ok":
            # 쟁점이 없거나 선택이 무효면 가지를 만들지 않는다(가짜 추출 금지).
            self.status = f"skipped: selection status {status}"
            return Message(text=json.dumps({"status": "skipped", "reason": f"selection status {status}", "branches": []}, ensure_ascii=False))
        if len(selected) > MAX_SELECTED:
            raise ValueError(f"Selection has {len(selected)} issues; at most {MAX_SELECTED} are allowed.")
        try:
            main_claim = str(self.parse_json_object(self._text(self.claim_json), "Main Claim JSON").get("main_claim") or "").strip()
        except BranchError:
            main_claim = ""
        template = self._text(self.prompt_template)
        if not template.strip():
            raise ValueError("Branch Prompt Template is empty.")
        judgment = self._text(self.judgment)
        branches = [self.extract_one(index, issue, main_claim, judgment, template) for index, issue in enumerate(selected, start=1)]
        summary = {
            "selected": len(selected),
            "ok": sum(1 for b in branches if b["status"] == "ok"),
            "failed": sum(1 for b in branches if b["status"] == "failed"),
        }
        self.status = f"{summary['ok']} ok / {summary['failed']} failed"
        return Message(text=json.dumps({"status": "done", "summary": summary, "branches": branches}, ensure_ascii=False))
