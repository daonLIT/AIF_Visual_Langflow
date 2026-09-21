/**
 * 근거 범위 유틸. 서버(backend/app/services/evidence_matcher.py)와 같은 규칙을 따른다.
 * JS 문자열 인덱스는 UTF-16 code unit 이므로 별도 변환 없이 그대로 저장한다.
 */
import type { EvidenceCandidate, EvidenceMatchState, EvidenceSpan } from '../types/annotation';

const IGNORED = new Set(
  " \t\r\n 　·ㆍ,.、。'\"‘’“”()[]〔〕「」『』-–—_~:;!?".split(''),
);
const MAX_CANDIDATES = 20;

function foldChar(ch: string): string {
  const folded = ch.normalize('NFKC').toLowerCase();
  return folded.length > 0 ? folded[0] : ch;
}

function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let index = 0;
  // for...of 는 code point 단위로 순회하므로 UTF-16 인덱스를 따로 센다.
  for (const ch of text) {
    if (!IGNORED.has(ch)) {
      chars.push(foldChar(ch));
      map.push(index);
    }
    index += ch.length;
  }
  return { normalized: chars.join(''), map };
}

function normalizeQuote(quote: string): string {
  let out = '';
  for (const ch of quote) if (!IGNORED.has(ch)) out += foldChar(ch);
  return out;
}

function findAll(haystack: string, needle: string, limit = MAX_CANDIDATES + 1): number[] {
  const positions: number[] = [];
  if (!needle) return positions;
  let cursor = 0;
  while (positions.length < limit) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

export interface MatchResult {
  quote: string;
  match: EvidenceMatchState;
  start: number | null;
  end: number | null;
  candidates: EvidenceCandidate[];
}

/** 같은 원문에 여러 인용문을 매칭할 때 정규화 결과를 재사용한다. */
export class DocumentMatcher {
  readonly text: string;
  private readonly normalized: string;
  private readonly map: number[];

  constructor(text: string) {
    this.text = text;
    const result = normalizeWithMap(text);
    this.normalized = result.normalized;
    this.map = result.map;
  }

  private endOfCodePoint(utf16Index: number): number {
    const code = this.text.codePointAt(utf16Index);
    return utf16Index + (code !== undefined && code > 0xffff ? 2 : 1);
  }

  match(rawQuote: string): MatchResult {
    const quote = (rawQuote ?? '').trim();
    if (!quote) return { quote: rawQuote ?? '', match: 'unmatched', start: null, end: null, candidates: [] };

    const exact = findAll(this.text, quote);
    if (exact.length === 1) {
      return { quote, match: 'exact', start: exact[0], end: exact[0] + quote.length, candidates: [] };
    }
    if (exact.length > 1) {
      return {
        quote,
        match: 'ambiguous',
        start: null,
        end: null,
        candidates: exact.slice(0, MAX_CANDIDATES).map((start) => ({ start, end: start + quote.length })),
      };
    }

    const normalizedQuote = normalizeQuote(quote);
    if (!normalizedQuote) return { quote, match: 'unmatched', start: null, end: null, candidates: [] };
    const found = findAll(this.normalized, normalizedQuote);
    if (found.length === 0) return { quote, match: 'unmatched', start: null, end: null, candidates: [] };

    const spans = found.slice(0, MAX_CANDIDATES).map((pos) => ({
      start: this.map[pos],
      end: this.endOfCodePoint(this.map[pos + normalizedQuote.length - 1]),
    }));
    if (found.length === 1) {
      return { quote, match: 'normalized', start: spans[0].start, end: spans[0].end, candidates: [] };
    }
    return { quote, match: 'ambiguous', start: null, end: null, candidates: spans };
  }
}

export function matchQuote(text: string, quote: string): MatchResult {
  return new DocumentMatcher(text).match(quote);
}

/** 저장된 범위가 현재 원문과 여전히 일치하는지 */
export function isSpanValid(text: string, span: EvidenceSpan): boolean {
  if (span.start === null || span.end === null) return false;
  if (span.start < 0 || span.end > text.length || span.start >= span.end) return false;
  return text.slice(span.start, span.end) === span.quote;
}

/**
 * 원문이 바뀐 뒤 기존 근거를 다시 맞춘다.
 * 위치가 그대로 유효하면 유지하고, 아니면 인용문으로 재매칭하며, 확정되지 않으면 stale 로 둔다.
 */
export function rematchEvidence(
  text: string,
  spans: EvidenceSpan[],
  documentVersion: number,
  matcher = new DocumentMatcher(text),
): EvidenceSpan[] {
  return spans.map((span) => {
    if (span.documentVersion === documentVersion && (isSpanValid(text, span) || span.start === null)) {
      return span;
    }
    if (isSpanValid(text, span)) return { ...span, documentVersion };
    const result = matcher.match(span.quote);
    if (result.match === 'exact' || result.match === 'normalized') {
      return {
        ...span,
        start: result.start,
        end: result.end,
        match: span.match === 'manual' ? 'manual' : result.match,
        candidates: [],
        documentVersion,
      };
    }
    return {
      ...span,
      start: null,
      end: null,
      match: 'stale',
      candidates: result.candidates,
      documentVersion,
    };
  });
}

/** DOM 선택 영역을 컨테이너 텍스트 기준 [start, end) 로 바꾼다. 텍스트가 다르면 null. */
export function selectionToOffsets(
  container: HTMLElement,
  selection: Selection,
  fullText: string,
): { start: number; end: number; text: string } | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const selected = range.toString();
  const end = start + selected.length;
  if (end > fullText.length || fullText.slice(start, end) !== selected) return null;
  return { start, end, text: selected };
}

export interface HighlightLayer {
  start: number;
  end: number;
  className: string;
  annotationId?: string;
  /** 검색 매치 번호 */
  matchIndex?: number;
  /** 높을수록 위에 표시 */
  priority: number;
}

export interface TextSegment {
  text: string;
  start: number;
  classNames: string[];
  annotationIds: string[];
  matchIndex: number | null;
}

/** 겹치는 하이라이트 구간들을 서로 겹치지 않는 조각으로 나눈다. */
export function buildSegments(text: string, layers: HighlightLayer[]): TextSegment[] {
  const valid = layers.filter((l) => l.start < l.end && l.start >= 0 && l.end <= text.length);
  if (valid.length === 0) return [{ text, start: 0, classNames: [], annotationIds: [], matchIndex: null }];

  const boundaries = new Set<number>([0, text.length]);
  for (const layer of valid) {
    boundaries.add(layer.start);
    boundaries.add(layer.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const segments: TextSegment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (start === end) continue;
    const covering = valid
      .filter((l) => l.start <= start && l.end >= end)
      .sort((a, b) => a.priority - b.priority);
    const classNames = [...new Set(covering.map((l) => l.className))];
    const annotationIds = [...new Set(covering.map((l) => l.annotationId).filter((v): v is string => !!v))];
    const match = covering.find((l) => l.matchIndex !== undefined);
    segments.push({
      text: text.slice(start, end),
      start,
      classNames,
      annotationIds,
      matchIndex: match?.matchIndex ?? null,
    });
  }
  return segments;
}
