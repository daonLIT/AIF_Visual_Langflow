import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';
import { buildSegments, selectionToOffsets, type HighlightLayer } from '../../utils/evidence';
import type { EvidenceSpan } from '../../types/annotation';
import { IssueNavigator } from './IssueNavigator';

interface SelectionState {
  text: string;
  start: number | null;
  end: number | null;
  top: number;
  left: number;
}

/** 검색어 매치 구간 */
function searchLayers(text: string, query: string): HighlightLayer[] {
  if (!query) return [];
  const layers: HighlightLayer[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let cursor = 0;
  let matchIndex = 0;
  for (;;) {
    const found = lowerText.indexOf(lowerQuery, cursor);
    if (found === -1) break;
    layers.push({ start: found, end: found + query.length, className: 'is-search', matchIndex, priority: 50 });
    matchIndex += 1;
    cursor = found + query.length;
  }
  return layers;
}

export function JudgmentPanel() {
  const caseData = useGraphStore((state) => state.caseData);
  const annotations = useGraphStore((state) => state.annotations);
  const addNode = useGraphStore((state) => state.addNode);
  const requestFocus = useGraphStore((state) => state.requestFocus);

  const selectedAnnotationId = useAnnotationStore((state) => state.selectedAnnotationId);
  const select = useAnnotationStore((state) => state.select);
  const addEvidence = useAnnotationStore((state) => state.addEvidence);
  const evidenceFocus = useAnnotationStore((state) => state.evidenceFocus);
  const documentVersion = useAnnotationStore((state) => state.document?.version ?? 1);
  const activeRunId = useAnnotationStore((state) => state.activeRunId);

  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [showAllEvidence, setShowAllEvidence] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  const text = caseData?.text ?? '';
  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId],
  );

  const layers = useMemo(() => {
    const result: HighlightLayer[] = searchLayers(text, query.trim());
    for (const annotation of annotations) {
      if (annotation.kind !== 'node') continue;
      if (activeRunId && annotation.runId !== activeRunId && annotation.id !== selectedAnnotationId) continue;
      const isSelected = annotation.id === selectedAnnotationId;
      if (!isSelected && (!showAllEvidence || annotation.status === 'rejected')) continue;
      for (const span of annotation.evidence) {
        if (span.start === null || span.end === null) continue;
        result.push({
          start: span.start,
          end: span.end,
          className: isSelected ? 'is-evidence-selected' : `is-evidence is-${annotation.status}`,
          annotationId: annotation.id,
          priority: isSelected ? 40 : 10,
        });
      }
    }
    if (evidenceFocus) {
      result.push({ start: evidenceFocus.start, end: evidenceFocus.end, className: 'is-evidence-focus', priority: 60 });
    }
    return result;
  }, [text, query, annotations, activeRunId, selectedAnnotationId, showAllEvidence, evidenceFocus]);

  const segments = useMemo(() => buildSegments(text, layers), [text, layers]);
  const matchCount = useMemo(() => layers.filter((layer) => layer.matchIndex !== undefined).length, [layers]);

  // 검색어가 바뀌면 매치 수가 줄 수 있으므로 렌더 시점에 범위를 보정한다.
  const currentMatch = matchCount === 0 ? 0 : activeMatch % matchCount;

  // 현재 매치로 스크롤
  useEffect(() => {
    if (matchCount === 0) return;
    const element = textRef.current?.querySelector(`[data-match="${currentMatch}"]`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentMatch, matchCount]);

  // 근거 위치로 스크롤
  useEffect(() => {
    if (!evidenceFocus) return;
    const element = textRef.current?.querySelector(`[data-start="${evidenceFocus.start}"]`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [evidenceFocus]);

  const captureSelection = useCallback(() => {
    const domSelection = window.getSelection();
    const selectedText = domSelection?.toString() ?? '';
    if (
      !domSelection ||
      domSelection.rangeCount === 0 ||
      selectedText.trim().length === 0 ||
      !textRef.current ||
      !textRef.current.contains(domSelection.anchorNode)
    ) {
      setSelection(null);
      return;
    }

    const rect = domSelection.getRangeAt(0).getBoundingClientRect();
    const bounds = containerRef.current?.getBoundingClientRect();
    // 실제 선택 범위(UTF-16 인덱스). 렌더된 텍스트와 원문이 다르면 null.
    const offsets = selectionToOffsets(textRef.current, domSelection, text);
    setSelection({
      text: selectedText.trim(),
      start: offsets?.start ?? null,
      end: offsets?.end ?? null,
      top: rect.bottom - (bounds?.top ?? 0) + 6,
      left: Math.max(8, rect.left - (bounds?.left ?? 0)),
    });
  }, [text]);

  const selectionSpan = useCallback((): EvidenceSpan | null => {
    if (!selection) return null;
    if (selection.start === null || selection.end === null) {
      return { quote: selection.text, start: null, end: null, match: 'unmatched', documentVersion };
    }
    return {
      quote: text.slice(selection.start, selection.end),
      start: selection.start,
      end: selection.end,
      match: 'manual',
      documentVersion,
    };
  }, [selection, text, documentVersion]);

  const createINodeFromSelection = useCallback(() => {
    if (!selection || !caseData) return;
    // 기존 그래프 아래쪽 빈 자리에 새 노드를 놓는다.
    const minX = caseData.nodes.length ? Math.min(...caseData.nodes.map((node) => node.x)) : 0;
    const maxY = caseData.nodes.length ? Math.max(...caseData.nodes.map((node) => node.y)) : 0;
    const span = selectionSpan();
    const id = addNode('I', selection.text, { x: minX, y: maxY + 180 }, { evidence: span ? [span] : [] });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    if (id) {
      requestFocus(id);
      select(`human:node:${id}`);
    }
  }, [selection, caseData, addNode, requestFocus, select, selectionSpan]);

  const linkSelectionAsEvidence = useCallback(() => {
    if (!selection || !selectedAnnotation) return;
    const span = selectionSpan();
    if (!span) return;
    addEvidence(selectedAnnotation.id, span);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, selectedAnnotation, selectionSpan, addEvidence]);

  if (!caseData) {
    return (
      <aside className="judgment-panel">
        <div className="judgment-empty">판결문이 아직 없습니다. 상단의 [판결문 입력]을 누르세요.</div>
      </aside>
    );
  }

  return (
    <aside className="judgment-panel" ref={containerRef} aria-label="판결문 원문">
      <div className="judgment-search">
        <input
          type="search"
          value={query}
          placeholder="판결문 내 검색"
          aria-label="판결문 내 검색"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveMatch(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matchCount > 0) {
              event.preventDefault();
              setActiveMatch(
                event.shiftKey
                  ? (currentMatch - 1 + matchCount) % matchCount
                  : (currentMatch + 1) % matchCount,
              );
            }
          }}
        />
        {query.trim() ? (
          <div className="judgment-search-nav">
            <span className="judgment-search-count">
              {matchCount === 0 ? '0' : `${currentMatch + 1} / ${matchCount}`}
            </span>
            <button
              type="button"
              disabled={matchCount === 0}
              onClick={() => setActiveMatch((currentMatch - 1 + matchCount) % matchCount)}
              aria-label="이전 검색 결과"
            >
              &#8593;
            </button>
            <button
              type="button"
              disabled={matchCount === 0}
              onClick={() => setActiveMatch((currentMatch + 1) % matchCount)}
              aria-label="다음 검색 결과"
            >
              &#8595;
            </button>
          </div>
        ) : null}
        <label className="chip-toggle" title="모든 제안의 근거 위치를 연하게 표시">
          <input type="checkbox" checked={showAllEvidence} onChange={(event) => setShowAllEvidence(event.target.checked)} />
          근거 표시
        </label>
      </div>

      <IssueNavigator />

      {selectedAnnotation ? (
        <div className="judgment-context" role="status">
          선택된 제안: {selectedAnnotation.kind === 'node' ? selectedAnnotation.currentValue.text.slice(0, 40) : '관계'}
          {selectedAnnotation.kind === 'node' && selectedAnnotation.evidence.every((span) => span.start === null)
            ? ' — 근거 위치 없음. 원문을 드래그해 연결하세요.'
            : ''}
          <button type="button" className="link-button" onClick={() => select(null)}>
            선택 해제
          </button>
        </div>
      ) : null}

      <div
        className="judgment-text"
        ref={textRef}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        tabIndex={0}
      >
        {segments.map((segment) => {
          if (segment.classNames.length === 0) {
            return <span key={segment.start}>{segment.text}</span>;
          }
          const clickable = segment.annotationIds.length > 0;
          return (
            <mark
              key={segment.start}
              data-start={segment.start}
              data-match={segment.matchIndex ?? undefined}
              className={[
                ...segment.classNames,
                segment.matchIndex !== null && segment.matchIndex === currentMatch ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              title={clickable ? '이 근거의 제안 선택' : undefined}
              onClick={
                clickable
                  ? () => {
                      const id = segment.annotationIds[0];
                      select(id);
                      const annotation = annotations.find((item) => item.id === id);
                      if (annotation?.kind === 'node') requestFocus(annotation.nodeId);
                    }
                  : undefined
              }
              onKeyDown={
                clickable
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        (event.currentTarget as HTMLElement).click();
                      }
                    }
                  : undefined
              }
            >
              {segment.text}
            </mark>
          );
        })}
      </div>

      {selection ? (
        <div className="selection-actions" style={{ top: selection.top, left: selection.left }}>
          <button type="button" className="selection-action" onMouseDown={(event) => event.preventDefault()} onClick={createINodeFromSelection}>
            + I 노드 만들기
          </button>
          {selectedAnnotation && selectedAnnotation.kind === 'node' && selectedAnnotation.origin !== 'human' ? (
            <button
              type="button"
              className="selection-action is-secondary"
              onMouseDown={(event) => event.preventDefault()}
              onClick={linkSelectionAsEvidence}
              title={selection.start === null ? '선택 범위를 원문 위치로 확정할 수 없어 인용문만 저장됩니다' : undefined}
            >
              이 제안의 근거로 연결
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
