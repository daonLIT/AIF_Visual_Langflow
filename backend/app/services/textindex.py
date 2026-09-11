"""
문자열 인덱스 변환 유틸.

브라우저(JavaScript)의 문자열 인덱스는 UTF-16 code unit 기준이고, Python 은 code point 기준이다.
근거 범위 [start, end) 는 UI 와 서버가 같은 값을 써야 하므로 저장·전송 시에는 항상 UTF-16 code unit 을 사용한다.
"""
from __future__ import annotations

from bisect import bisect_right


def utf16_len(text: str) -> int:
    """UTF-16 code unit 길이 (BMP 밖 문자는 2)."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


class Utf16Index:
    """code point 인덱스 <-> UTF-16 code unit 인덱스 변환기."""

    def __init__(self, text: str):
        self.text = text
        # prefix[i] = text[:i] 의 UTF-16 길이
        prefix = [0]
        total = 0
        for ch in text:
            total += 2 if ord(ch) > 0xFFFF else 1
            prefix.append(total)
        self._prefix = prefix

    @property
    def utf16_length(self) -> int:
        return self._prefix[-1]

    def to_utf16(self, codepoint_index: int) -> int:
        if codepoint_index < 0:
            raise ValueError("index must be >= 0")
        if codepoint_index > len(self.text):
            raise ValueError("index out of range")
        return self._prefix[codepoint_index]

    def to_codepoint(self, utf16_index: int) -> int:
        """UTF-16 인덱스를 code point 인덱스로. surrogate pair 중간을 가리키면 ValueError."""
        if utf16_index < 0 or utf16_index > self.utf16_length:
            raise ValueError("utf16 index out of range")
        position = bisect_right(self._prefix, utf16_index) - 1
        if self._prefix[position] != utf16_index:
            raise ValueError("utf16 index points inside a surrogate pair")
        return position

    def slice_utf16(self, start: int, end: int) -> str:
        return self.text[self.to_codepoint(start) : self.to_codepoint(end)]
