import { useEffect, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';
import type { AnalysisRunRecord, RunStatus } from '../../types/annotation';
import { useT, type MessageKey } from '../../i18n';

const STATUS_KEY: Record<RunStatus, MessageKey> = {
  queued: 'run.status.queued',
  running: 'run.status.running',
  succeeded: 'run.status.succeeded',
  failed: 'run.status.failed',
  cancelled: 'run.status.cancelled',
  interrupted: 'run.status.interrupted',
};

function useElapsed(run: AnalysisRunRecord | undefined): string {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
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
  return seconds >= 60
    ? t('run.elapsed.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
    : t('run.elapsed.seconds', { seconds });
}

/**
 * 툴바에 붙는 AI 분석 버튼 + 실행 상태. 세부 쟁점은 사용자가 미리 고르지 않는다:
 * flow 가 판결문을 읽고 52개 중 최대 3개를 자동 선택한다. 완료율은 제공되지 않아 경과 시간만 표시한다.
 */
export function AnalysisStatus() {
  const t = useT();
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
        title={hasText ? t('analysis.start.title') : t('analysis.start.needText')}
      >
        {runs.some((run) => run.imported) ? t('analysis.restart') : t('analysis.start')}
      </button>
      {active ? (
        <span className="run-chip is-active" role="status" aria-live="polite">
          <span className="run-spinner" aria-hidden="true" />
          {t(STATUS_KEY[active.status])} · {elapsed}
          <button type="button" className="link-button" onClick={() => void cancelAnalysis(active.runId)}>
            {t('analysis.cancel')}
          </button>
        </span>
      ) : latest ? (
        <span
          className={`run-chip is-${latest.status}`}
          role="status"
          title={
            latest.error
              ? [latest.error.message, ...(latest.error.details ?? [])].join('\n')
              : latest.pipeline
                ? t('analysis.flowTitle', {
                    flow: latest.pipeline.flowName ?? latest.pipeline.flowId ?? '?',
                    hash: (latest.pipeline.flowHash ?? '?').slice(0, 19),
                  }) + (latest.pipeline.snapshot ? t('analysis.flowSnapshot') : '')
                : undefined
          }
        >
          {t(STATUS_KEY[latest.status])}
          {latest.status === 'succeeded' && latest.outcome === 'no_issues' ? t('analysis.noIssues') : ''}
          {latest.status === 'succeeded' && latest.outcome !== 'no_issues' && latest.summary
            ? t('analysis.counts', {
                nodes: latest.summary.nodeCount,
                edges: latest.summary.edgeCount,
                issues: latest.summary.issueCount,
              })
            : ''}
          {latest.status === 'failed' && latest.error ? ` · ${latest.error.code}` : ''}
          {latest.mode === 'mock' ? ' · mock' : ''}
        </span>
      ) : null}
    </div>
  );
}
