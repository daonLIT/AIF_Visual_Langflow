import unittest

from app.services.evidence_matcher import DocumentMatcher
from app.services.textindex import Utf16Index, utf16_len


class Utf16IndexTest(unittest.TestCase):
    def test_korean_is_single_unit(self):
        text = "피고인은 법정에서"
        index = Utf16Index(text)
        self.assertEqual(index.utf16_length, len(text))
        self.assertEqual(index.to_utf16(3), 3)
        self.assertEqual(index.to_codepoint(3), 3)

    def test_emoji_takes_two_units(self):
        text = "a😀b"
        index = Utf16Index(text)
        self.assertEqual(utf16_len(text), 4)
        self.assertEqual(index.to_utf16(2), 3)  # 'b' 는 UTF-16 에서 3번째
        self.assertEqual(index.to_codepoint(3), 2)
        with self.assertRaises(ValueError):
            index.to_codepoint(2)  # surrogate pair 중간
        self.assertEqual(index.slice_utf16(1, 3), "😀")

    def test_combining_characters_are_preserved(self):
        text = "éx"  # e + combining acute
        index = Utf16Index(text)
        self.assertEqual(index.utf16_length, 3)
        self.assertEqual(index.slice_utf16(0, 2), "é")


class DocumentMatcherTest(unittest.TestCase):
    TEXT = (
        "1. 판단\n피해자의 진술은 신빙성이 있다.\n피고인의 진술은 신빙성이 낮다.\n"
        "피해자의 진술은 신빙성이 있다.\n😀 기록 끝. 피고인은  법정에서\n진술하였다."
    )

    def test_exact_unique(self):
        result = DocumentMatcher(self.TEXT).match("피고인의 진술은 신빙성이 낮다.")
        self.assertEqual(result.match, "exact")
        self.assertEqual(self.TEXT[result.start : result.end], "피고인의 진술은 신빙성이 낮다.")

    def test_duplicate_sentence_is_ambiguous(self):
        result = DocumentMatcher(self.TEXT).match("피해자의 진술은 신빙성이 있다.")
        self.assertEqual(result.match, "ambiguous")
        self.assertIsNone(result.start)
        self.assertEqual(len(result.candidates), 2)

    def test_whitespace_and_newline_differences_are_normalized(self):
        result = DocumentMatcher(self.TEXT).match("피고인은 법정에서 진술하였다")
        self.assertEqual(result.match, "normalized")
        index = Utf16Index(self.TEXT)
        self.assertEqual(index.slice_utf16(result.start, result.end), "피고인은  법정에서\n진술하였다")

    def test_offsets_after_emoji_are_utf16(self):
        result = DocumentMatcher(self.TEXT).match("기록 끝.")
        self.assertEqual(result.match, "exact")
        index = Utf16Index(self.TEXT)
        self.assertEqual(index.slice_utf16(result.start, result.end), "기록 끝.")
        # code point 인덱스와 UTF-16 인덱스가 다름을 확인 (이모지 뒤이므로 +1)
        self.assertEqual(result.start, self.TEXT.index("기록") + 1)

    def test_unmatched(self):
        result = DocumentMatcher(self.TEXT).match("존재하지 않는 문장")
        self.assertEqual(result.match, "unmatched")

    def test_verify_span(self):
        matcher = DocumentMatcher(self.TEXT)
        self.assertTrue(matcher.verify_span(3, 5, "판단"))
        self.assertFalse(matcher.verify_span(3, 5, "판결"))
        self.assertFalse(matcher.verify_span(5, 3))


if __name__ == "__main__":
    unittest.main()
