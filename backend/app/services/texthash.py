"""노드 본문 해시. flow 컴포넌트(node_summarizer.py)와 프런트엔드(utils/textHash.ts)와 같은 값을 낸다."""
from __future__ import annotations

import hashlib
import json


def text_hash(text: str) -> str:
    """FNV-1a 64bit (UTF-8). 요약이 어떤 본문으로 만들어졌는지(summarySourceHash) 비교하는 용도."""
    value = 0xCBF29CE484222325
    for byte in (text or "").encode("utf-8"):
        value ^= byte
        value = (value * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"fnv1a64:{value:016x}"


def canonical_sha256(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
