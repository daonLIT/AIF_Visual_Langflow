"""
LLM 이 인용한 근거 문장을 원문 안에서 찾아 [start, end) 범위(UTF-16 code unit)를 확정한다.

매칭 단계:
  1. exact      : 인용문이 원문에 그대로 1회 등장
  2. normalized : 공백·줄바꿈·일부 문장부호 차이를 무시하면 1회 등장
  3. ambiguous  : 위 방법으로 2회 이상 등장 → 자동 확정하지 않음 (후보 위치만 제공)
  4. unmatched  : 찾지 못함
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from .textindex import Utf16Index

MAX_CANDIDATES = 20
_IGNORED = set(" \t\r\n 　·ㆍ,.、。'\"‘’“”()[]〔〕「」『』-–—_~:;!?")


@dataclass
class EvidenceMatch:
    quote: str
    match: str  # exact | normalized | ambiguous | unmatched
    start: int | None = None  # UTF-16 code unit, inclusive
    end: int | None = None  # UTF-16 code unit, exclusive
    candidates: list[dict] = field(default_factory=list)

    def to_dict(self, document_version: int) -> dict:
        return {
            "quote": self.quote,
            "start": self.start,
            "end": self.end,
            "match": self.match,
            "documentVersion": document_version,
            "candidates": self.candidates,
        }


def _find_all(haystack: str, needle: str, limit: int = MAX_CANDIDATES + 1) -> list[int]:
    positions: list[int] = []
    if not needle:
        return positions
    cursor = 0
    while len(positions) < limit:
        found = haystack.find(needle, cursor)
        if found == -1:
            break
        positions.append(found)
        cursor = found + 1
    return positions


def _normalize_with_map(text: str) -> tuple[str, list[int]]:
    """무시 문자를 제거한 문자열과, 정규화 문자열 인덱스 -> 원문 code point 인덱스 매핑."""
    normalized_chars: list[str] = []
    mapping: list[int] = []
    for index, ch in enumerate(text):
        if ch in _IGNORED:
            continue
        folded = unicodedata.normalize("NFKC", ch).lower()
        # NFKC 가 여러 문자로 펼쳐지는 경우(예: ㈜) 첫 문자만 사용해 매핑을 단순하게 유지한다.
        normalized_chars.append(folded[0] if folded else ch)
        mapping.append(index)
    return "".join(normalized_chars), mapping


def _normalize_quote(quote: str) -> str:
    return "".join(
        (unicodedata.normalize("NFKC", ch).lower() or ch)[0] for ch in quote if ch not in _IGNORED
    )


class DocumentMatcher:
    """같은 원문에 대해 여러 인용문을 매칭할 때 정규화 결과를 재사용한다."""

    def __init__(self, text: str):
        self.text = text
        self.index = Utf16Index(text)
        self._normalized, self._map = _normalize_with_map(text)

    def _span_to_utf16(self, start_cp: int, end_cp: int) -> tuple[int, int]:
        return self.index.to_utf16(start_cp), self.index.to_utf16(end_cp)

    def match(self, quote: str) -> EvidenceMatch:
        cleaned = (quote or "").strip()
        if not cleaned:
            return EvidenceMatch(quote=quote or "", match="unmatched")

        exact = _find_all(self.text, cleaned)
        if len(exact) == 1:
            start, end = self._span_to_utf16(exact[0], exact[0] + len(cleaned))
            return EvidenceMatch(quote=cleaned, match="exact", start=start, end=end)
        if len(exact) > 1:
            candidates = [
                dict(zip(("start", "end"), self._span_to_utf16(pos, pos + len(cleaned))))
                for pos in exact[:MAX_CANDIDATES]
            ]
            return EvidenceMatch(quote=cleaned, match="ambiguous", candidates=candidates)

        normalized_quote = _normalize_quote(cleaned)
        if not normalized_quote:
            return EvidenceMatch(quote=cleaned, match="unmatched")
        found = _find_all(self._normalized, normalized_quote)
        if not found:
            return EvidenceMatch(quote=cleaned, match="unmatched")

        spans = []
        for pos in found[:MAX_CANDIDATES]:
            start_cp = self._map[pos]
            end_cp = self._map[pos + len(normalized_quote) - 1] + 1
            spans.append(self._span_to_utf16(start_cp, end_cp))

        if len(found) == 1:
            start, end = spans[0]
            return EvidenceMatch(quote=cleaned, match="normalized", start=start, end=end)
        return EvidenceMatch(
            quote=cleaned,
            match="ambiguous",
            candidates=[{"start": s, "end": e} for s, e in spans],
        )

    def verify_span(self, start: int, end: int, quote: str | None = None) -> bool:
        """UI 가 보낸 범위가 원문과 일치하는지 확인 (UTF-16 기준)."""
        try:
            actual = self.index.slice_utf16(start, end)
        except ValueError:
            return False
        if quote is None:
            return start < end
        return actual == quote


def match_quote(text: str, quote: str) -> EvidenceMatch:
    return DocumentMatcher(text).match(quote)
