import { useCallback, useMemo, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore, type KindFilter, type StatusFilter } from '../../store/annotationStore';
import { edgeDependency, structuralWarningsFor, type BulkAcceptPreview, type ReviewSnapshot } from '../../store/reviewLogic';
import type { Annotation, EvidenceSpan } from '../../types/annotation';
import type { ArgumentNodeType } from '../../types/argument';
import { AnnotationCard } from './AnnotationCard';
import { BulkAcceptDialog } from './BulkAcceptDialog';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'pending', label: '미검토' },
  { value: 'accepted', label: '수락' },
  { value: 'modified', label: '수정 수락' },
  { value: 'rejected', label: '거절' },
];

const KIND_FILTERS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: '노드+관계' },
  { value: 'node', label: '노드' },
  { value: 'edge', label: '관계' },
];

/** 노드 ID 의 시퀀스 번호로 정렬해 제안 순서를 유지한다. */
function sequenceOf(id: string): number {
  const match = /^(\d+)_/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function AnnotationPanel() {
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
      ...(annotations.some((a) => a.origin === 'human') ? [{ runId: 'human', label: '사람 편집' }] : []),
      ...runs.map((run) => ({
        runId: run.runId,
        label: `${new Date(run.createdAt).toLocaleString()} · ${run.status}${run.mode === 'mock' ? ' (mock)' : ''}${run.stale ? ' · 원문 변경됨' : ''}`,
      })),
    ],
    [runs, annotations],
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
  const latestFailed = runs.find((run) => run.status === 'failed' || run.status === 'interrupted');
  const staleRuns = runs.filter((run) => run.stale && !run.imported);

  if (!caseData) {
    return (
      <aside className="annotation-panel">
        <div className="judgment-empty">판결문을 입력하고 AI 분석을 실행하면 제안이 여기에 표시됩니다.</div>
      </aside>
    );
  }

  return (
    <aside className="annotation-panel" aria-label="AI 제안 검토">
      <header className="annotation-header">
        <h2>AI 제안 검토</h2>
        <div className="annotation-counts">
          <span className="badge badge-status is-pending">미검토 {counts.pending}</span>
          <span className="badge badge-status is-accepted">수락 {counts.accepted}</span>
          <span className="badge badge-status is-rejected">거절 {counts.rejected}</span>
        </div>
      </header>

      {notice ? (
        <div className="annotation-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="알림 닫기">
            &#10005;
          </button>
        </div>
      ) : null}

      {latestFailed && (!activeRun || latestFailed.runId === runs[0]?.runId) ? (
        <div className="annotation-error" role="alert">
          <strong>분석 {latestFailed.status === 'failed' ? '실패' : '중단'}</strong>: {latestFailed.error?.message}
          {latestFailed.error?.details?.length ? (
            <ul>
              {latestFailed.error.details.slice(0, 6).map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          ) : null}
          <div className="annotation-hint">기존 편집 내용은 그대로 유지됩니다.</div>
        </div>
      ) : null}

      {staleRuns.map((run) => (
        <div key={run.runId} className="annotation-notice is-stale">
          <span>실행 {run.runId} 결과가 원문 변경 뒤에 도착했습니다. 반영하려면 눌러 주세요.</span>
          <button type="button" onClick={() => importStaleRun(run.runId)}>
            제안으로 불러오기
          </button>
        </div>
      ))}

      <div className="annotation-toolbar">
        <label className="annotation-run">
          실행
          <select value={activeRunId ?? ''} onChange={(event) => setActiveRun(event.target.value || null)}>
            <option value="">모든 실행</option>
            {runOptions.map((option) => (
              <option key={option.runId} value={option.runId}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="annotation-filters" role="group" aria-label="상태 필터">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`chip ${statusFilter === filter.value ? 'is-active' : ''}`}
              aria-pressed={statusFilter === filter.value}
              onClick={() => setStatusFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="annotation-filters" role="group" aria-label="종류 필터">
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`chip ${kindFilter === filter.value ? 'is-active' : ''}`}
              aria-pressed={kindFilter === filter.value}
              onClick={() => setKindFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
          <label className="chip-toggle">
            <input type="checkbox" checked={showRejected} onChange={(event) => setShowRejected(event.target.checked)} />
            거절도 그래프에 표시
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
            미검토 전체 수락…
          </button>
          {activeRun?.constraints?.issueCount ? (
            <span className="annotation-hint">flow 제약: 쟁점 {activeRun.constraints.issueCount}개 고정</span>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="judgment-empty">
          {annotations.length === 0 ? '아직 제안이 없습니다. 상단의 [AI 분석]을 실행하세요.' : '필터에 맞는 제안이 없습니다.'}
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
