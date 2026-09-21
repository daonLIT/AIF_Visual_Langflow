import { useState } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';
import { useGraphStore } from '../../store/graphStore';
import { IssueSelectionReport } from '../Annotation/IssueSelectionReport';
import type { AnalysisRunRecord } from '../../types/annotation';
import type { PipelineIssue } from '../../types/pipeline';
import { useT, type MessageKey } from '../../i18n';

const LEVEL_KEY = {
  error: 'lf.level.error',
  warning: 'lf.level.warning',
  info: 'lf.level.info',
} as const satisfies Record<string, MessageKey>;

/** 검증 결과 + 테스트 실행 */
export function PipelineBottomPanel() {
  const t = useT();
  const [tab, setTab] = useState<'issues' | 'test'>('issues');
  const localIssues = usePipelineStore((state) => state.localIssues);
  const serverIssues = usePipelineStore((state) => state.serverIssues);
  const testRun = usePipelineStore((state) => state.testRun);
  const errorCount = [...localIssues, ...(serverIssues ?? [])].filter((issue) => issue.level === 'error').length;

  return (
    <section className="lf-bottom">
      <nav className="lf-bottom-tabs">
        <button type="button" className={tab === 'issues' ? 'is-active' : ''} onClick={() => setTab('issues')}>
          {errorCount > 0 ? t('lf.bottom.validationErrors', { count: errorCount }) : t('lf.bottom.validation')}
        </button>
        <button type="button" className={tab === 'test' ? 'is-active' : ''} onClick={() => setTab('test')}>
          {testRun ? t('lf.bottom.testRunStatus', { status: testRun.status }) : t('lf.bottom.testRun')}
        </button>
      </nav>
      <div className="lf-bottom-body">{tab === 'issues' ? <IssueList /> : <TestRun />}</div>
    </section>
  );
}

function IssueList() {
  const t = useT();
  const localIssues = usePipelineStore((state) => state.localIssues);
  const serverIssues = usePipelineStore((state) => state.serverIssues);
  const select = usePipelineStore((state) => state.select);

  const render = (issues: PipelineIssue[]) =>
    issues.length === 0 ? (
      <li className="lf-muted">{t('lf.bottom.none')}</li>
    ) : (
      issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className={`is-${issue.level}`}>
          <span className={`lf-level is-${issue.level}`}>{t(LEVEL_KEY[issue.level])}</span>
          {issue.nodeId ? (
            <button type="button" className="link-button" onClick={() => select(issue.nodeId!)}>
              {issue.message}
            </button>
          ) : (
            issue.message
          )}
        </li>
      ))
    );

  return (
    <div className="lf-issue-columns">
      <div>
        <h4>{t('lf.bottom.editorChecks')}</h4>
        <ul className="lf-issue-list">{render(localIssues)}</ul>
      </div>
      <div>
        <h4>{serverIssues === null ? t('lf.bottom.serverChecks.stale') : t('lf.bottom.serverChecks')}</h4>
        <ul className="lf-issue-list">
          {serverIssues === null ? <li className="lf-muted">{t('lf.bottom.serverHint')}</li> : render(serverIssues)}
        </ul>
      </div>
    </div>
  );
}

function TestRun() {
  const t = useT();
  const current = usePipelineStore((state) => state.current);
  const dirty = usePipelineStore((state) => state.dirty);
  const testRun = usePipelineStore((state) => state.testRun);
  const startTestRun = usePipelineStore((state) => state.startTestRun);
  const importTestRun = usePipelineStore((state) => state.importTestRun);
  const documentText = useGraphStore((state) => state.caseData?.text ?? '');
  const [custom, setCustom] = useState('');
  const [useDocument, setUseDocument] = useState(true);

  const text = useDocument && documentText ? documentText : custom;
  const record = testRun?.record;
  const running = testRun && (testRun.status === 'queued' || testRun.status === 'running');

  return (
    <div className="lf-test">
      <div className="lf-test-input">
        <label className="chip-toggle">
          <input type="checkbox" checked={useDocument && !!documentText} disabled={!documentText} onChange={(event) => setUseDocument(event.target.checked)} />
          {documentText
            ? t('lf.bottom.useDocument', { count: documentText.length.toLocaleString() })
            : t('lf.bottom.noDocument')}
        </label>
        {!useDocument || !documentText ? (
          <textarea
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            rows={4}
            placeholder={t('lf.test.placeholder')}
            aria-label={t('lf.test.aria')}
          />
        ) : null}
        <div className="lf-field-row">
          <button type="button" className="is-primary" disabled={!current || !text.trim() || !!running} onClick={() => void startTestRun({ text })}>
            {t('lf.bottom.run')}
          </button>
          <span className="lf-muted">
            {t('lf.bottom.runNote', { name: current?.flow.name ?? '' })}
            {dirty ? t('lf.bottom.runNote.dirty') : ''}.
          </span>
        </div>
      </div>

      {testRun ? (
        <div className={`lf-test-result is-${testRun.status}`}>
          <div>
            {t('lf.bottom.runLine', { runId: testRun.runId })}
            <strong>{testRun.status}</strong>
            {record?.mode === 'mock' ? t('lf.bottom.mock') : ''}
            {running ? t('lf.bottom.started', { time: new Date(testRun.startedAt).toLocaleTimeString() }) : ''}
          </div>
          {record?.error ? (
            <div className="lf-error">
              {record.error.code}: {record.error.message}
              {record.error.details?.length ? (
                <ul>
                  {record.error.details.slice(0, 8).map((detail, index) => (
                    <li key={index}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {record?.pipeline ? (
            <div className="lf-muted" title={t('lf.bottom.pinnedTitle')}>
              {t('lf.bottom.pinned', {
                name: record.pipeline.flowName ?? record.pipeline.flowId ?? '',
                hash: (record.pipeline.flowHash ?? '?').slice(0, 19),
              })}
              {record.pipeline.snapshot ? t('lf.bottom.snapshot', { id: record.pipeline.runFlowId ?? '' }) : ''}
              {record.pipeline.models?.length
                ? t('lf.bottom.models', {
                    models: record.pipeline.models.map((model) => String(model.model_name ?? '?')).join(', '),
                  })
                : ''}
            </div>
          ) : null}
          {record?.result ? (
            <>
              {record.result.outcome === 'no_issues' ? (
                <div>{t('lf.bottom.noIssues')}</div>
              ) : (
                <div>
                  {t('lf.bottom.counts', {
                    nodes: record.result.summary.nodeCount,
                    edges: record.result.summary.edgeCount,
                    issues: record.result.summary.issueCount,
                  })}
                </div>
              )}
              <IssueSelectionReport
                run={{ ...record, summary: record.result.summary, warnings: record.result.warnings, outcome: record.result.outcome } as AnalysisRunRecord}
              />
              {record.result.outcome !== 'no_issues' ? (
                <button type="button" onClick={importTestRun}>
                  {t('lf.bottom.import')}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
