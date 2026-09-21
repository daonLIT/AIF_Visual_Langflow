import { useCallback, useMemo, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore, type KindFilter, type StatusFilter } from '../../store/annotationStore';
import { edgeDependency, structuralWarningsFor, type BulkAcceptPreview, type ReviewSnapshot } from '../../store/reviewLogic';
import type { Annotation, EvidenceSpan } from '../../types/annotation';
import type { ArgumentNodeType } from '../../types/argument';
import { AnnotationCard } from './AnnotationCard';
import { BulkAcceptDialog } from './BulkAcceptDialog';
import { IssueSelectionReport } from './IssueSelectionReport';
import { useLang, useT, type MessageKey } from '../../i18n';

const STATUS_FILTERS: Array<{ value: StatusFilter; labelKey: MessageKey }> = [
  { value: 'all', labelKey: 'review.filter.all' },
  { value: 'pending', labelKey: 'review.filter.pending' },
  { value: 'accepted', labelKey: 'review.filter.accepted' },
  { value: 'modified', labelKey: 'review.filter.modified' },
  { value: 'rejected', labelKey: 'review.filter.rejected' },
];

const KIND_FILTERS: Array<{ value: KindFilter; labelKey: MessageKey }> = [
  { value: 'all', labelKey: 'review.kind.all' },
  { value: 'node', labelKey: 'review.kind.node' },
  { value: 'edge', labelKey: 'review.kind.edge' },
];

/** 노드 ID 의 시퀀스 번호로 정렬해 제안 순서를 유지한다. */
function sequenceOf(id: string): number {
  const match = /^(\d+)_/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function AnnotationPanel() {
  const t = useT();
  const lang = useLang();
  const caseData = useGraphStore((state) => state.caseData);
  const annotations = useGraphStore((state) => state.annotations);
  const edgeIdHighWater = useGraphStore((state) => state.edgeIdHighWater);
  const requestFocus = useGraphStore((state) => state.requestFocus);

  const runs = useAnnotationStore((state) => state.runs);
  const activeRunId = useAnnotationStore((state) => state.activeRunId);
  const setActiveRun = useAnnotationStore((state) => state.setActiveRun);
  const importStaleRun = useAnnotationStore((state) => state.importStaleRun);
  const selectedId = useAnnotationStore((state) => state.selectedAnnotationId);
  const select = useAnnotationStore((state) => state.select);
  const statusFilter = useAnnotationStore((state) => state.statusFilter);
  const kindFilter = useAnnotationStore((state) => state.kindFilter);
  const setStatusFilter = useAnnotationStore((state) => state.setStatusFilter);
  const setKindFilter = useAnnotationStore((state) => state.setKindFilter);
  const showRejected = useAnnotationStore((state) => state.showRejected);
  const setShowRejected = useAnnotationStore((state) => state.setShowRejected);
  const accept = useAnnotationStore((state) => state.accept);
  const reject = useAnnotationStore((state) => state.reject);
  const reset = useAnnotationStore((state) => state.reset);
  const removeEvidence = useAnnotationStore((state) => state.removeEvidence);
  const chooseEvidenceCandidate = useAnnotationStore((state) => state.chooseEvidenceCandidate);
  const bulkPreview = useAnnotationStore((state) => state.bulkPreview);
  const bulkAccept = useAnnotationStore((state) => state.bulkAccept);
  const focusEvidence = useAnnotationStore((state) => state.focusEvidence);
  const notice = useAnnotationStore((state) => state.notice);
  const setNotice = useAnnotationStore((state) => state.setNotice);

  const [preview, setPreview] = useState<BulkAcceptPreview | null>(null);

  const snapshot = useMemo<ReviewSnapshot | null>(
    () => (caseData ? { caseData, annotations, edgeIdHighWater } : null),
    [caseData, annotations, edgeIdHighWater],
  );

  const runOptions = useMemo(
    () => [
      ...(annotations.some((a) => a.origin === 'human') ? [{ runId: 'human', label: t('review.run.human') }] : []),
      ...runs.map((run) => ({
        runId: run.runId,
        label: `${new Date(run.createdAt).toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR')} · ${run.status}${
          run.mode === 'mock' ? t('review.run.mock') : ''
        }${run.stale ? t('review.run.staleTag') : ''}`,
      })),
    ],
    [runs, annotations, t, lang],
  );

  const visible = useMemo(() => {
    const list = annotations.filter((annotation) => {
      if (activeRunId && annotation.runId !== activeRunId) return false;
      if (statusFilter !== 'all' && annotation.status !== statusFilter) return false;
      if (kindFilter !== 'all' && annotation.kind !== kindFilter) return false;
      return true;
    });
    return list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'node' ? -1 : 1;
      const ka = a.kind === 'node' ? sequenceOf(a.nodeId) : a.originalValue.proposedEdgeId ?? 0;
      const kb = b.kind === 'node' ? sequenceOf(b.nodeId) : b.originalValue.proposedEdgeId ?? 0;
      return ka - kb;
    });
  }, [annotations, activeRunId, statusFilter, kindFilter]);

  const counts = useMemo(() => {
    const scoped = annotations.filter((a) => !activeRunId || a.runId === activeRunId);
    return {
      pending: scoped.filter((a) => a.status === 'pending').length,
      accepted: scoped.filter((a) => a.status === 'accepted' || a.status === 'modified').length,
      rejected: scoped.filter((a) => a.status === 'rejected').length,
    };
  }, [annotations, activeRunId]);

  const nodeText = useCallback(
    (nodeId: string): { text: string; type: ArgumentNodeType | null; accepted: boolean } => {
      const accepted = caseData?.nodes.find((node) => node.id === nodeId);
      if (accepted) return { text: accepted.text || `(${accepted.type})`, type: accepted.type, accepted: true };
      const proposal = annotations.find((a) => a.kind === 'node' && a.nodeId === nodeId);
      if (proposal && proposal.kind === 'node') {
        return { text: proposal.currentValue.text || `(${proposal.currentValue.type})`, type: proposal.currentValue.type, accepted: false };
      }
      return { text: nodeId, type: null, accepted: false };
    },
    [caseData, annotations],
  );

  const selectAnnotation = useCallback(
    (annotation: Annotation) => {
      select(annotation.id);
      const nodeId = annotation.kind === 'node' ? annotation.nodeId : annotation.currentValue.source;
      requestFocus(nodeId);
      const firstLocated = annotation.evidence.find((span) => span.start !== null);
      if (firstLocated) focusEvidence(firstLocated);
    },
    [select, requestFocus, focusEvidence],
  );

  const activeRun = runs.find((run) => run.runId === activeRunId) ?? null;
  const reportRun = activeRun ?? runs.find((run) => run.status === 'succeeded' && (run.imported || run.outcome === 'no_issues')) ?? null;
  const latestFailed = runs.find((run) => run.status === 'failed' || run.status === 'interrupted');
  const staleRuns = runs.filter((run) => run.stale && !run.imported);

  if (!caseData) {
    return (
      <aside className="annotation-panel">
        <div className="judgment-empty">{t('review.empty')}</div>
      </aside>
    );
  }

  return (
    <aside className="annotation-panel" aria-label={t('review.aria')}>
      <header className="annotation-header">
        <h2>{t('review.title')}</h2>
        <div className="annotation-counts">
          <span className="badge badge-status is-pending">{t('review.count.pending', { count: counts.pending })}</span>
          <span className="badge badge-status is-accepted">{t('review.count.accepted', { count: counts.accepted })}</span>
          <span className="badge badge-status is-rejected">{t('review.count.rejected', { count: counts.rejected })}</span>
        </div>
      </header>

      {notice ? (
        <div className="annotation-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label={t('review.notice.close')}>
            &#10005;
          </button>
        </div>
      ) : null}

      {latestFailed && (!activeRun || latestFailed.runId === runs[0]?.runId) ? (
        <div className="annotation-error" role="alert">
          <strong>{latestFailed.status === 'failed' ? t('review.run.failed') : t('review.run.interrupted')}</strong>:{' '}
          {latestFailed.error?.message}
          {latestFailed.error?.details?.length ? (
            <ul>
              {latestFailed.error.details.slice(0, 6).map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          ) : null}
          <div className="annotation-hint">{t('review.run.keepEdits')}</div>
        </div>
      ) : null}

      {staleRuns.map((run) => (
        <div key={run.runId} className="annotation-notice is-stale">
          <span>{t('review.stale', { runId: run.runId })}</span>
          <button type="button" onClick={() => importStaleRun(run.runId)}>
            {t('review.stale.import')}
          </button>
        </div>
      ))}

      <div className="annotation-toolbar">
        <label className="annotation-run">
          {t('review.run')}
          <select value={activeRunId ?? ''} onChange={(event) => setActiveRun(event.target.value || null)}>
            <option value="">{t('review.run.all')}</option>
            {runOptions.map((option) => (
              <option key={option.runId} value={option.runId}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="annotation-filters" role="group" aria-label={t('review.filter.statusAria')}>
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`chip ${statusFilter === filter.value ? 'is-active' : ''}`}
              aria-pressed={statusFilter === filter.value}
              onClick={() => setStatusFilter(filter.value)}
            >
              {t(filter.labelKey)}
            </button>
          ))}
        </div>
        <div className="annotation-filters" role="group" aria-label={t('review.filter.kindAria')}>
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`chip ${kindFilter === filter.value ? 'is-active' : ''}`}
              aria-pressed={kindFilter === filter.value}
              onClick={() => setKindFilter(filter.value)}
            >
              {t(filter.labelKey)}
            </button>
          ))}
          <label className="chip-toggle">
            <input type="checkbox" checked={showRejected} onChange={(event) => setShowRejected(event.target.checked)} />
            {t('review.showRejected')}
          </label>
        </div>
        <div className="annotation-bulk">
          <button
            type="button"
            className="is-primary"
            disabled={counts.pending === 0}
            onClick={() => {
              const next = bulkPreview();
              if (next) setPreview(next);
            }}
          >
            {t('review.bulkOpen')}
          </button>
          <span className="annotation-hint">{t('review.bulkHint')}</span>
        </div>
      </div>

      {reportRun ? <IssueSelectionReport run={reportRun} onFocusNode={requestFocus} /> : null}

      {visible.length === 0 ? (
        <div className="judgment-empty">
          {annotations.length === 0 ? t('review.noProposals') : t('review.noMatches')}
        </div>
      ) : (
        <ul className="annotation-list">
          {visible.map((annotation) => (
            <AnnotationCard
              key={annotation.id}
              annotation={annotation}
              selected={annotation.id === selectedId}
              nodeText={nodeText}
              dependency={snapshot && annotation.kind === 'edge' ? edgeDependency(snapshot, annotation) : null}
              structuralWarnings={
                snapshot && annotation.kind === 'node' && (annotation.status === 'accepted' || annotation.status === 'modified')
                  ? structuralWarningsFor(snapshot, annotation.nodeId)
                  : []
              }
              onSelect={() => selectAnnotation(annotation)}
              onFocusNode={requestFocus}
              onAccept={(options) => accept(annotation.id, options)}
              onReject={() => reject(annotation.id)}
              onReset={() => reset(annotation.id)}
              onJumpToEvidence={(span: EvidenceSpan) => {
                select(annotation.id);
                focusEvidence(span);
              }}
              onChooseCandidate={(index, candidate) => chooseEvidenceCandidate(annotation.id, index, candidate)}
              onRemoveEvidence={(index) => removeEvidence(annotation.id, index)}
            />
          ))}
        </ul>
      )}

      {preview ? (
        <BulkAcceptDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onConfirm={() => {
            bulkAccept(preview);
            setPreview(null);
          }}
        />
      ) : null}
    </aside>
  );
}
