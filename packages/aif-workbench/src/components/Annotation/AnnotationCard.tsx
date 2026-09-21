import { useEffect, useRef, useState } from 'react';
import type { Annotation, EdgeAnnotation, EvidenceSpan, NodeAnnotation } from '../../types/annotation';
import { MATCH_KEY, ORIGIN_KEY, STATUS_KEY } from '../../types/annotation';
import type { ArgumentNodeType, ValidationResult } from '../../types/argument';
import type { EdgeDependency } from '../../store/reviewLogic';
import { findIssue, useCatalogStore } from '../../store/catalogStore';
import { issueLabel, schemeShortName } from '../../types/scheme';
import { useT } from '../../i18n';

function typeLabel(type: ArgumentNodeType, issueText: string): string {
  return type === 'ISSUE' ? issueText : type;
}

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
  const t = useT();
  if (annotation.kind === 'edge') return null;
  if (annotation.currentValue.type === 'RA' || annotation.currentValue.type === 'CA') return null;
  if (annotation.evidence.length === 0) {
    return (
      <div className="evidence-empty">{t('card.evidence.empty')}</div>
    );
  }
  return (
    <ul className="evidence-list">
      {annotation.evidence.map((span, index) => {
        const located = span.start !== null && span.end !== null;
        return (
          <li key={index} className={`evidence-item is-${span.match}`}>
            <span className={`evidence-badge is-${span.match}`}>{t(MATCH_KEY[span.match])}</span>
            {span.derived ? (
              <span className="evidence-derived" title={t('card.evidence.derived.title')}>
                {t('card.evidence.derived')}
              </span>
            ) : null}
            <button
              type="button"
              className="evidence-quote"
              disabled={!located}
              onClick={() => onJump(span)}
              title={located ? t('card.evidence.goTo') : t('card.evidence.noPosition')}
            >
              “{truncate(span.quote, 90)}”
            </button>
            {!located && span.candidates && span.candidates.length > 0 ? (
              <div className="evidence-candidates">
                {t('card.evidence.candidates', { count: span.candidates.length })}
                {span.candidates.slice(0, 8).map((candidate, i) => (
                  <button
                    key={`${candidate.start}-${i}`}
                    type="button"
                    className="link-button"
                    onClick={() => onChoose(index, candidate)}
                    title={t('card.evidence.pickCandidate')}
                  >
                    #{i + 1} ({candidate.start})
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              className="icon-button evidence-remove"
              onClick={() => onRemove(index)}
              aria-label={t('card.evidence.remove')}
              title={t('card.evidence.remove')}
            >
              &#10005;
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function AnnotationCard(props: CardProps) {
  const t = useT();
  const { annotation, selected, dependency, structuralWarnings } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLLIElement>(null);
  const schemeCatalog = useCatalogStore((state) => state.schemes);
  const issueCatalog = useCatalogStore((state) => state.issues);

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

  const schemeLabel = node?.currentValue.type === 'RA' ? schemeShortName(node.currentValue.schemeApplication, schemeCatalog) : null;
  const issueTypeLabel = t('card.type.issue');
  const title = node
    ? node.currentValue.type === 'RA'
      ? t('card.ra.title', {
          scheme: schemeLabel ?? t('card.ra.noScheme'),
          review: node.currentValue.schemeApplication?.status === 'needs_review' ? t('card.ra.needsReview') : '',
        })
      : node.currentValue.text || `(${typeLabel(node.currentValue.type, issueTypeLabel)})`
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
          <span className={`badge badge-origin is-${annotation.origin}`}>{t(ORIGIN_KEY[annotation.origin])}</span>
          <span className={`badge badge-status is-${status}`}>{t(STATUS_KEY[status])}</span>
          {node ? (
            <span className={`badge badge-type is-${node.currentValue.type}`}>
              {typeLabel(node.currentValue.type, issueTypeLabel)}
            </span>
          ) : (
            <span className="badge badge-type is-edge">{t('card.type.edge')}</span>
          )}
          {annotation.note ? (
            <span className="badge badge-note" title={annotation.note}>
              {t('card.note')}
            </span>
          ) : null}
        </span>
        <span className="annotation-title">{title}</span>
      </button>

      {node?.currentValue.summary ? (
        <div className="annotation-summary">{t('card.summary', { summary: node.currentValue.summary })}</div>
      ) : null}
      {node?.currentValue.type === 'ISSUE' && node.currentValue.issueRef ? (
        <div className="annotation-summary">
          {t('card.issueClass', {
            label:
              issueLabel(findIssue(issueCatalog, node.currentValue.issueRef.issueId)) || node.currentValue.issueRef.issueId,
          })}
        </div>
      ) : null}
      {node?.currentValue.type === 'RA' && node.currentValue.schemeApplication?.rationale ? (
        <div className="annotation-summary">
          {t('card.rationale', { rationale: truncate(node.currentValue.schemeApplication.rationale, 140) })}
        </div>
      ) : null}
      {node?.currentValue.type === 'ISSUE' && node.currentValue.issueRef?.selectionReason ? (
        <div className="annotation-summary">
          {t('card.selectionReason', { reason: truncate(node.currentValue.issueRef.selectionReason, 140) })}
        </div>
      ) : null}
      {annotation.evidence.some((span) => span.reviewReason) ? (
        <div className="annotation-warning">{t('card.evidenceReview')}</div>
      ) : null}

      {annotation.note ? <div className="annotation-note">{annotation.note}</div> : null}

      {node && status === 'modified' && node.currentValue.type !== 'RA' && node.originalValue.text !== node.currentValue.text ? (
        <div className="annotation-original">{t('card.original', { text: truncate(node.originalValue.text, 160) })}</div>
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
                {end === 'source' ? t('card.edge.source') : t('card.edge.target')}:{' '}
                {info.type ? `[${typeLabel(info.type, issueTypeLabel)}] ` : ''}
                {truncate(info.text, 60)}
                {info.accepted ? '' : t('card.edge.unconfirmed')}
              </button>
            );
          })}
        </div>
      ) : null}

      {dependency && !dependency.ready ? (
        <div className="annotation-warning">
          {t('card.dependency', { count: dependency.missingNodeIds.length })}
          {dependency.unresolvableNodeIds.length > 0 ? t('card.dependency.unresolvable') : ''}
        </div>
      ) : null}

      {structuralWarnings.length > 0 ? (
        <ul className="annotation-warning-list">
          {structuralWarnings.map((warning, index) => (
            <li key={index} className={`is-${warning.level}`}>
              {t('card.warning.line', {
                level: warning.level === 'error' ? t('card.warning.error') : t('card.warning.warning'),
                message: warning.message,
              })}
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
            aria-label={t('card.editor.aria')}
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
              {t('card.acceptEdited')}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {t('card.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="annotation-actions">
          {annotation.origin === 'human' ? (
            <span className="annotation-hint">{t('card.humanHint')}</span>
          ) : status === 'pending' ? (
            <>
              <button
                type="button"
                className="is-primary"
                disabled={!!dependency && dependency.unresolvableNodeIds.length > 0}
                onClick={() => props.onAccept({ withDependencies: true, withConnectableEdges: true })}
                title={
                  dependency && !dependency.ready
                    ? t('card.accept.titleWithNodes')
                    : node
                      ? t('card.accept.titleNode')
                      : t('card.accept.titleEdge')
                }
              >
                {dependency && !dependency.ready ? t('card.acceptWithNodes') : t('card.accept')}
              </button>
              {node && node.currentValue.type !== 'RA' ? (
                <button type="button" onClick={startEdit}>
                  {t('card.acceptEdited')}
                </button>
              ) : null}
              <button type="button" className="is-danger" onClick={props.onReject}>
                {t('card.reject')}
              </button>
            </>
          ) : (
            <>
              {inGraph && node && node.currentValue.type !== 'RA' ? (
                <button type="button" onClick={startEdit}>
                  {t('card.editText')}
                </button>
              ) : null}
              <button type="button" onClick={props.onReset}>
                {t('card.reset')}
              </button>
              {inGraph ? (
                <button type="button" className="is-danger" onClick={props.onReject}>
                  {t('card.reject')}
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
    </li>
  );
}
