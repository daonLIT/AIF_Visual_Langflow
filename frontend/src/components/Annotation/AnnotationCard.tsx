import { useEffect, useRef, useState } from 'react';
import type { Annotation, EdgeAnnotation, EvidenceSpan, NodeAnnotation } from '../../types/annotation';
import { MATCH_LABEL, ORIGIN_LABEL, STATUS_LABEL } from '../../types/annotation';
import type { ArgumentNodeType, ValidationResult } from '../../types/argument';
import type { EdgeDependency } from '../../store/reviewLogic';

const TYPE_LABEL: Record<ArgumentNodeType, string> = { I: 'I', RA: 'RA', CA: 'CA', ISSUE: '쟁점' };

export interface CardProps {
  annotation: Annotation;
  selected: boolean;
  /** 노드 ID → 표시용 텍스트 (엣지 카드용) */
  nodeText: (nodeId: string) => { text: string; type: ArgumentNodeType | null; accepted: boolean };
  dependency: EdgeDependency | null;
  structuralWarnings: ValidationResult[];
  onSelect: () => void;
  onFocusNode: (nodeId: string) => void;
  onAccept: (options?: { withDependencies?: boolean; withConnectableEdges?: boolean; text?: string }) => void;
  onReject: () => void;
  onReset: () => void;
  onJumpToEvidence: (span: EvidenceSpan) => void;
  onChooseCandidate: (index: number, candidate: { start: number; end: number }) => void;
  onRemoveEvidence: (index: number) => void;
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function EvidenceList({
  annotation,
  onJump,
  onChoose,
  onRemove,
}: {
  annotation: Annotation;
  onJump: (span: EvidenceSpan) => void;
  onChoose: (index: number, candidate: { start: number; end: number }) => void;
  onRemove: (index: number) => void;
}) {
  if (annotation.kind === 'edge') return null;
  if (annotation.evidence.length === 0) {
    return (
      <div className="evidence-empty">
        근거 없음 — 원문에서 문장을 드래그한 뒤 “이 제안의 근거로 연결”을 누르세요.
      </div>
    );
  }
  return (
    <ul className="evidence-list">
      {annotation.evidence.map((span, index) => {
        const located = span.start !== null && span.end !== null;
        return (
          <li key={index} className={`evidence-item is-${span.match}`}>
            <span className={`evidence-badge is-${span.match}`}>{MATCH_LABEL[span.match]}</span>
            {span.derived ? <span className="evidence-derived" title="인용문이 아니라 노드 문장으로 원문을 찾은 결과">문장 매칭</span> : null}
            <button
              type="button"
              className="evidence-quote"
              disabled={!located}
              onClick={() => onJump(span)}
              title={located ? '원문 위치로 이동' : '원문 위치가 확정되지 않았습니다'}
            >
              “{truncate(span.quote, 90)}”
            </button>
            {!located && span.candidates && span.candidates.length > 0 ? (
              <div className="evidence-candidates">
                후보 {span.candidates.length}곳:
                {span.candidates.slice(0, 8).map((candidate, i) => (
                  <button
                    key={`${candidate.start}-${i}`}
                    type="button"
                    className="link-button"
                    onClick={() => onChoose(index, candidate)}
                    title="이 위치로 확정"
                  >
                    #{i + 1} ({candidate.start})
                  </button>
                ))}
              </div>
            ) : null}
            <button type="button" className="icon-button evidence-remove" onClick={() => onRemove(index)} aria-label="근거 제거" title="근거 제거">
              &#10005;
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function AnnotationCard(props: CardProps) {
  const { annotation, selected, dependency, structuralWarnings } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const isNode = annotation.kind === 'node';
  const node = isNode ? (annotation as NodeAnnotation) : null;
  const edge = !isNode ? (annotation as EdgeAnnotation) : null;
  const status = annotation.status;
  const inGraph = status === 'accepted' || status === 'modified';

  const startEdit = () => {
    setDraft(node?.currentValue.text ?? '');
    setEditing(true);
  };

  const title = node
    ? node.currentValue.text || `(${TYPE_LABEL[node.currentValue.type]})`
    : (() => {
        const source = props.nodeText(edge!.currentValue.source);
        const target = props.nodeText(edge!.currentValue.target);
        return `${truncate(source.text, 40)} → ${truncate(target.text, 40)}`;
      })();

  return (
    <li
      ref={ref}
      className={`annotation-card is-${status} ${selected ? 'is-selected' : ''} ${annotation.kind === 'edge' ? 'is-edge' : ''}`}
      data-annotation-id={annotation.id}
    >
      <button type="button" className="annotation-card-main" onClick={props.onSelect} aria-pressed={selected}>
        <span className="annotation-badges">
          <span className={`badge badge-origin is-${annotation.origin}`}>{ORIGIN_LABEL[annotation.origin]}</span>
          <span className={`badge badge-status is-${status}`}>{STATUS_LABEL[status]}</span>
          {node ? <span className={`badge badge-type is-${node.currentValue.type}`}>{TYPE_LABEL[node.currentValue.type]}</span> : <span className="badge badge-type is-edge">관계</span>}
          {annotation.note ? <span className="badge badge-note" title={annotation.note}>비고</span> : null}
        </span>
        <span className="annotation-title">{title}</span>
      </button>

      {annotation.note ? <div className="annotation-note">{annotation.note}</div> : null}

      {node && status === 'modified' && node.originalValue.text !== node.currentValue.text ? (
        <div className="annotation-original">원안: {truncate(node.originalValue.text, 160)}</div>
      ) : null}

      {edge ? (
        <div className="annotation-edge-detail">
          {(['source', 'target'] as const).map((end) => {
            const info = props.nodeText(edge.currentValue[end]);
            return (
              <button
                key={end}
                type="button"
                className={`link-button ${info.accepted ? '' : 'is-muted'}`}
                onClick={() => props.onFocusNode(edge.currentValue[end])}
              >
                {end === 'source' ? '전제' : '결론'}: {info.type ? `[${TYPE_LABEL[info.type]}] ` : ''}
                {truncate(info.text, 60)}
                {info.accepted ? '' : ' (미확정)'}
              </button>
            );
          })}
        </div>
      ) : null}

      {dependency && !dependency.ready ? (
        <div className="annotation-warning">
          끝점 노드 {dependency.missingNodeIds.length}개가 아직 확정 그래프에 없습니다.
          {dependency.unresolvableNodeIds.length > 0 ? ' (제안에도 없어 수락할 수 없습니다)' : ''}
        </div>
      ) : null}

      {structuralWarnings.length > 0 ? (
        <ul className="annotation-warning-list">
          {structuralWarnings.map((warning, index) => (
            <li key={index} className={`is-${warning.level}`}>
              {warning.level === 'error' ? '오류' : '경고'}: {warning.message}
            </li>
          ))}
        </ul>
      ) : null}

      <EvidenceList
        annotation={annotation}
        onJump={props.onJumpToEvidence}
        onChoose={props.onChooseCandidate}
        onRemove={props.onRemoveEvidence}
      />

      {editing && node ? (
        <div className="annotation-editor">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            autoFocus
            aria-label="수정할 텍스트"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                props.onAccept({ text: draft, withConnectableEdges: true });
                setEditing(false);
              }
            }}
          />
          <div className="annotation-actions">
            <button
              type="button"
              className="is-primary"
              disabled={!draft.trim()}
              onClick={() => {
                props.onAccept({ text: draft, withConnectableEdges: true });
                setEditing(false);
              }}
            >
              수정 후 수락
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <div className="annotation-actions">
          {annotation.origin === 'human' ? (
            <span className="annotation-hint">사람이 만든 항목입니다. 그래프에서 직접 편집·삭제하세요.</span>
          ) : status === 'pending' ? (
            <>
              <button
                type="button"
                className="is-primary"
                disabled={!!dependency && dependency.unresolvableNodeIds.length > 0}
                onClick={() => props.onAccept({ withDependencies: true, withConnectableEdges: true })}
                title={
                  dependency && !dependency.ready
                    ? '필요한 끝점 노드 제안을 함께 수락합니다'
                    : node
                      ? '수락하고, 양 끝이 확정된 관계 제안도 함께 수락합니다'
                      : '관계를 확정 그래프에 추가합니다'
                }
              >
                {dependency && !dependency.ready ? '노드와 함께 수락' : '수락'}
              </button>
              {node ? (
                <button type="button" onClick={startEdit}>
                  수정 후 수락
                </button>
              ) : null}
              <button type="button" className="is-danger" onClick={props.onReject}>
                거절
              </button>
            </>
          ) : (
            <>
              {inGraph && node ? (
                <button type="button" onClick={startEdit}>
                  텍스트 수정
                </button>
              ) : null}
              <button type="button" onClick={props.onReset}>
                미검토로
              </button>
              {inGraph ? (
                <button type="button" className="is-danger" onClick={props.onReject}>
                  거절
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
    </li>
  );
}
