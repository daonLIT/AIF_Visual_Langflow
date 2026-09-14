import { useState } from 'react';
import type { AnalysisRunRecord } from '../../types/annotation';
import { MAX_SELECTED_ISSUES } from '../../types/scheme';

interface Props {
  run: AnalysisRunRecord;
  onFocusNode?: (nodeId: string) => void;
}

const shortHash = (hash?: string | null) => (hash ? hash.replace(/^sha256:/, '').slice(0, 12) : '?');

/**
 * 한 실행의 세부 쟁점 자동 선택 결과(52개 중 최대 3개)와 실행 버전 정보.
 * '근거 없음/미검출'은 판결문에서 선택 근거를 찾지 못했다는 뜻이며 법원의 부정 판단이 아니다.
 * 부분 실패·경고는 숨기지 않는다. 연결 성공과 분류 품질은 별개다.
 */
export function IssueSelectionReport({ run, onFocusNode }: Props) {
  const [open, setOpen] = useState(true);
  const summary = run.summary;
  const selection = summary?.issueSelection;
  const warnings = run.warnings ?? [];
  if (!summary && warnings.length === 0) return null;

  const selected = selection?.selected ?? [];
  const notFound = selected.filter((item) => item.evidenceStatus === 'not_found').length;
  const failedBranches = selected.filter((item) => item.branchStatus && item.branchStatus !== 'ok').length;
  const noIssues = run.outcome === 'no_issues' || selection?.status === 'no_issues';
  const problems = notFound + failedBranches + (summary?.validation && !summary.validation.ok ? 1 : 0);
  const max = run.constraints?.maxSelectedIssues ?? MAX_SELECTED_ISSUES;
  const pin = run.pipeline;

  return (
    <section className={`coverage ${problems > 0 ? 'has-problems' : ''}`} aria-label="세부 쟁점 선택 결과">
      <button type="button" className="coverage-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <strong>세부 쟁점 자동 선택</strong>
        <span className="coverage-counts">
          {noIssues ? (
            <span className="coverage-chip is-not_detected">선택 0개</span>
          ) : (
            <span className="coverage-chip is-detected">
              선택 {selected.length}/{max}
            </span>
          )}
          {notFound > 0 ? <span className="coverage-chip is-not_detected">근거 없음/미검출 {notFound}</span> : null}
          {failedBranches > 0 ? <span className="coverage-chip is-failed">추출 실패 {failedBranches}</span> : null}
          {summary?.schemeCounts ? (
            <span className="coverage-chip" title="RA scheme 분류 (AI 제안)">
              scheme {summary.schemeCounts.classified} · 미분류 {summary.schemeCounts.unclassified}
              {summary.schemeCounts.withErrors ? ` · 오류 ${summary.schemeCounts.withErrors}` : ''}
            </span>
          ) : null}
        </span>
        {warnings.length > 0 ? <span className="coverage-chip is-warning">경고 {warnings.length}</span> : null}
        <span className="coverage-toggle">{open ? '접기' : '펼치기'}</span>
      </button>
      {open ? (
        <div className="coverage-body">
          {noIssues ? (
            <div className="annotation-warning">
              52개 세부 쟁점 중 판결문에 근거가 있는 항목이 없어 그래프를 만들지 않았습니다.
              {selection?.reason ? ` 사유: ${selection.reason}` : ''}
            </div>
          ) : (
            <ol className="selection-list">
              {selected.map((item) => (
                <li key={item.instanceId ?? item.issueId} className={item.evidenceStatus === 'not_found' ? 'is-not_detected' : 'is-detected'}>
                  <div>
                    <span className="node-detail-muted">{item.categoryName ?? ''}</span>
                    {item.categoryName ? ' › ' : ''}
                    <strong>{item.label ?? item.issueId}</strong> <span className="node-detail-code">{item.issueId}</span>
                    {item.evidenceStatus === 'not_found' ? <span className="coverage-chip is-not_detected">근거 없음/미검출</span> : null}
                    {item.branchStatus && item.branchStatus !== 'ok' ? (
                      <span className="coverage-chip is-failed" title={item.branchError ?? undefined}>
                        세부 추출 {item.branchStatus}
                      </span>
                    ) : null}
                    {onFocusNode ? (
                      <button type="button" className="link-button" onClick={() => onFocusNode(item.nodeId)}>
                        쟁점 보기
                      </button>
                    ) : null}
                  </div>
                  {item.selectionReason ? <div className="coverage-reason">선택 이유: {item.selectionReason}</div> : null}
                  {item.branchError ? <div className="coverage-error">{item.branchError}</div> : null}
                </li>
              ))}
            </ol>
          )}
          <div className="coverage-meta">
            {selection?.attempts ? `선택 시도 ${selection.attempts}회` : ''}
            {selection?.model ? ` · 모델 ${selection.model}` : ''}
            {summary?.summaryCounts ? ` · 요약 ${summary.summaryCounts.withSummary}/${summary.summaryCounts.withSummary + summary.summaryCounts.withoutSummary}` : ''}
            {summary?.validation ? ` · flow 검증 ${summary.validation.ok ? '통과' : `오류 ${summary.validation.errors.length}`}` : ''}
          </div>
          <div className="coverage-meta" title="실행에 고정된 버전">
            {run.mode === 'mock' ? 'mock 응답' : `flow ${pin?.flowName ?? run.flowId ?? '?'}`}
            {pin?.flowHash ? ` · 해시 ${shortHash(pin.flowHash)}` : ''}
            {pin?.snapshot ? ' · 실행용 스냅샷' : ''}
            {run.catalogs ? ` · 쟁점 카탈로그 v${run.catalogs.issueCatalogVersion ?? '?'} · scheme 카탈로그 v${run.catalogs.schemeCatalogVersion ?? '?'}` : ''}
          </div>
          {warnings.length > 0 ? (
            <ul className="coverage-warnings">
              {warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
