from __future__ import annotations

import json
import re

import httpx
from lfx.custom import Component
from lfx.io import BoolInput, DropdownInput, FloatInput, IntInput, MessageTextInput, MultilineInput, Output, StrInput
from lfx.schema.message import Message

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.I | re.S)


def text_hash(text: str) -> str:
    """본문 해시 (FNV-1a 64bit, UTF-8). 프런트엔드 utils/textHash.ts 와 같은 값이어야 한다."""
    value = 0xCBF29CE484222325
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"fnv1a64:{value:016x}"


class NodeSummarizer(Component):
    display_name = "I-node Summarizer"
    description = (
        "Summary stage. Writes a one-sentence summary for every I and ISSUE node of the built graph that keeps "
        "negation, subject, conditions and uncertainty. The node text is never replaced. Records summaryOrigin, "
        "summaryStatus and summarySourceHash; nodes whose summary could not be produced are reported, not filled."
    )
    icon = "Text"
    name = "NodeSummarizer"

    inputs = [
        MessageTextInput(name="graph_json", display_name="Graph JSON", required=True),
        MultilineInput(
            name="prompt_template",
            display_name="Summary Prompt Template",
            info="Variable: {nodes_json} (array of {node_id, type, text}). Substituted literally.",
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
        IntInput(name="num_ctx", display_name="Context Window Size", value=8192),
        IntInput(name="timeout", display_name="Timeout per call (s)", value=600, info="0 = no limit"),
        IntInput(name="batch_size", display_name="Nodes per call", value=16, advanced=True),
        IntInput(name="retries", display_name="Retries for missing summaries", value=1, advanced=True),
    ]

    outputs = [Output(display_name="Summarized Graph JSON", name="summarized_graph", method="summarize")]

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
    def read_summaries(obj: dict, expected: set[str]) -> dict[str, str]:
        found: dict[str, str] = {}
        for item in obj.get("summaries") or []:
            if not isinstance(item, dict):
                continue
            node_id = str(item.get("node_id") or "").strip()
            summary = str(item.get("summary") or "").strip()
            if node_id in expected and summary:
                found[node_id] = summary
        return found

    def call_model(self, prompt: str) -> str:
        messages = []
        system = self._text(getattr(self, "system_message", ""))
        if system.strip():
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
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

    def summarize_batch(self, items: list[dict], template: str) -> tuple[dict[str, str], list[str]]:
        pending = {item["node_id"]: item for item in items}
        done: dict[str, str] = {}
        errors: list[str] = []
        for attempt in range(1, max(1, int(self.retries or 0) + 1) + 1):
            if not pending:
                break
            prompt = template.replace("{nodes_json}", json.dumps(list(pending.values()), ensure_ascii=False, indent=2))
            try:
                found = self.read_summaries(self.parse_json_object(self.call_model(prompt)), set(pending))
            except Exception as error:  # noqa: BLE001
                errors.append(f"attempt {attempt}: {error.__class__.__name__}: {error}")
                continue
            done.update(found)
            for node_id in found:
                pending.pop(node_id, None)
        if pending:
            errors.append(f"no summary for {len(pending)} node(s): {', '.join(pending)}")
        return done, errors

    def summarize(self) -> Message:
        graph = self.parse_json_object(self._text(self.graph_json))
        if graph.get("status") != "ok":
            self.status = f"skipped: {graph.get('status')}"
            return Message(text=json.dumps(graph, ensure_ascii=False, indent=2))
        template = self._text(self.prompt_template)
        if not template.strip():
            raise ValueError("Summary Prompt Template is empty.")
        nodes = [n for n in graph["AIF"]["nodes"] if n.get("type") in ("I", "ISSUE")]
        items = [{"node_id": n["nodeID"], "type": n["type"], "text": n["text"]} for n in nodes]
        size = max(1, int(self.batch_size or 16))
        summaries: dict[str, str] = {}
        errors: list[str] = []
        for start in range(0, len(items), size):
            done, batch_errors = self.summarize_batch(items[start : start + size], template)
            summaries.update(done)
            errors.extend(batch_errors)
        for node in nodes:
            summary = summaries.get(node["nodeID"])
            if summary:
                node["summary"] = summary
                node["summaryOrigin"] = "ai"
                node["summaryStatus"] = "current"
                node["summarySourceHash"] = text_hash(node["text"])
        graph.setdefault("meta", {})["summaries"] = {
            "requested": len(items),
            "done": len(summaries),
            "missing": [n["nodeID"] for n in nodes if n["nodeID"] not in summaries],
            "errors": errors,
            "model": self._text(self.model_name),
        }
        self.status = f"{len(summaries)} of {len(items)} summaries"
        return Message(text=json.dumps(graph, ensure_ascii=False, indent=2))
