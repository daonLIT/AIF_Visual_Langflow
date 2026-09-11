import { useEffect, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';
import type { AnalysisRunRecord, RunStatus } from '../../types/annotation';

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: '대기 중',
  running: '분석 중',
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소됨',
  interrupted: '중단됨',
};

function useElapsed(run: AnalysisRunRecord | undefined): string {
  const [now, setNow] = useState(Date.now());
  const active = run && (run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!run) return '';
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
}

/** 툴바에 붙는 AI 분석 버튼 + 실행 상태. 완료율은 제공되지 않으므로 경과 시간만 표시한다. */
export function AnalysisStatus() {
  const caseData = useGraphStore((state) => state.caseData);
  const runs = useAnnotationStore((state) => state.runs);
  const startAnalysis = useAnnotationStore((state) => state.startAnalysis);
  const cancelAnalysis = useAnnotationStore((state) => state.cancelAnalysis);

  const latest = runs[0];
  const active = runs.find((run) => run.status === 'queued' || run.status === 'running');
  const elapsed = useElapsed(active ?? latest);
  const hasText = !!caseData && caseData.text.trim().length > 0;

  return (
    <div className="analysis-status">
      <button
        type="button"
        disabled={!hasText || !!active}
        onClick={() => void startAnalysis()}
        title={hasText ? 'Langflow 로 판결문을 분석해 초안 제안을 만듭니다' : '먼저 판결문을 입력하세요'}
      >
        {runs.some((run) => run.imported) ? '다시 분석' : 'AI 분석'}
      </button>
      {active ? (
        <span className="run-chip is-active" role="status" aria-live="polite">
          <span className="run-spinner" aria-hidden="true" />
          {STATUS_LABEL[active.status]} · {elapsed}
          <button type="button" className="link-button" onClick={() => void cancelAnalysis(active.runId)}>
            취소
          </button>
        </span>
      ) : latest ? (
        <span className={`run-chip is-${latest.status}`} role="status" title={latest.error?.message ?? undefined}>
          {STATUS_LABEL[latest.status]}
          {latest.status === 'succeeded' && latest.summary
            ? ` · 노드 ${latest.summary.nodeCount} / 관계 ${latest.summary.edgeCount}`
            : ''}
          {latest.status === 'failed' && latest.error ? ` · ${latest.error.code}` : ''}
          {latest.mode === 'mock' ? ' · mock' : ''}
        </span>
      ) : null}
    </div>
  );
}
