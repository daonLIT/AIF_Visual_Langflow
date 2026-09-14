import { useState } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';
import { useGraphStore } from '../../store/graphStore';
import { IssueSelectionReport } from '../Annotation/IssueSelectionReport';
import type { AnalysisRunRecord } from '../../types/annotation';
import type { PipelineIssue } from '../../types/pipeline';

const LEVEL_LABEL = { error: '오류', warning: '경고', info: '정보' } as const;

/** 검증 결과 + 테스트 실행 */
export function PipelineBottomPanel() {
  const [tab, setTab] = useState<'issues' | 'test'>('issues');
  const localIssues = usePipelineStore((state) => state.localIssues);
  const serverIssues = usePipelineStore((state) => state.serverIssues);
  const testRun = usePipelineStore((state) => state.testRun);
  const errorCount = [...localIssues, ...(serverIssues ?? [])].filter((issue) => issue.level === 'error').length;

  return (
    <section className="lf-bottom">
      <nav className="lf-bottom-tabs">
        <button type="button" className={tab === 'issues' ? 'is-active' : ''} onClick={() => setTab('issues')}>
          검증 {errorCount > 0 ? `(오류 ${errorCount})` : ''}
        </button>
        <button type="button" className={tab === 'test' ? 'is-active' : ''} onClick={() => setTab('test')}>
          테스트 실행 {testRun ? `(${testRun.status})` : ''}
        </button>
      </nav>
      <div className="lf-bottom-body">{tab === 'issues' ? <IssueList /> : <TestRun />}</div>
    </section>
  );
}

function IssueList() {
  const localIssues = usePipelineStore((state) => state.localIssues);
  const serverIssues = usePipelineStore((state) => state.serverIssues);
  const select = usePipelineStore((state) => state.select);

  const render = (issues: PipelineIssue[]) =>
    issues.length === 0 ? (
      <li className="lf-muted">없음</li>
    ) : (
      issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className={`is-${issue.level}`}>
          <span className={`lf-level is-${issue.level}`}>{LEVEL_LABEL[issue.level]}</span>
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
        <h4>편집기 즉시 검사</h4>
        <ul className="lf-issue-list">{render(localIssues)}</ul>
      </div>
      <div>
        <h4>서버 검증 {serverIssues === null ? '(편집 후 미실행)' : ''}</h4>
        <ul className="lf-issue-list">{serverIssues === null ? <li className="lf-muted">[검증]을 누르면 서버 규칙으로 확인합니다.</li> : render(serverIssues)}</ul>
      </div>
    </div>
  );
}

function TestRun() {
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
          논증 그래프 탭의 판결문 사용 {documentText ? `(${documentText.length.toLocaleString()}자)` : '(입력된 판결문 없음)'}
        </label>
        {!useDocument || !documentText ? (
          <textarea value={custom} onChange={(event) => setCustom(event.target.value)} rows={4} placeholder="테스트할 판결문 원문" aria-label="테스트 원문" />
        ) : null}
        <div className="lf-field-row">
          <button type="button" className="is-primary" disabled={!current || !text.trim() || !!running} onClick={() => void startTestRun({ text })}>
            이 flow 로 테스트 실행
          </button>
          <span className="lf-muted">
            Langflow 에 저장된 “{current?.flow.name}” 을 실행합니다{dirty ? ' — 편집 중인 변경은 먼저 적용해야 반영됩니다' : ''}.
          </span>
        </div>
      </div>

      {testRun ? (
        <div className={`lf-test-result is-${testRun.status}`}>
          <div>
            실행 {testRun.runId} · <strong>{testRun.status}</strong>
            {record?.mode === 'mock' ? ' · mock 응답' : ''}
            {running ? ` · 시작 ${new Date(testRun.startedAt).toLocaleTimeString()}` : ''}
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
            <div className="lf-muted" title="이 실행에 고정된 flow 버전">
              고정 버전: {record.pipeline.flowName ?? record.pipeline.flowId} · 해시 {(record.pipeline.flowHash ?? '?').slice(0, 19)}
              {record.pipeline.snapshot ? ` · 실행용 스냅샷 ${record.pipeline.runFlowId}` : ''}
              {record.pipeline.models?.length
                ? ` · 모델 ${record.pipeline.models.map((model) => String(model.model_name ?? '?')).join(', ')}`
                : ''}
            </div>
          ) : null}
          {record?.result ? (
            <>
              {record.result.outcome === 'no_issues' ? (
                <div>근거 있는 세부 쟁점이 없어 그래프를 만들지 않았습니다.</div>
              ) : (
                <div>
                  노드 {record.result.summary.nodeCount} · 관계 {record.result.summary.edgeCount} · 쟁점 {record.result.summary.issueCount}
                </div>
              )}
              <IssueSelectionReport
                run={{ ...record, summary: record.result.summary, warnings: record.result.warnings, outcome: record.result.outcome } as AnalysisRunRecord}
              />
              {record.result.outcome !== 'no_issues' ? (
                <button type="button" onClick={importTestRun}>
                  검토 제안으로 불러오기
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
