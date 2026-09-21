import { useState } from 'react';
import type { AnalysisRunRecord } from '../../types/annotation';
import { MAX_SELECTED_ISSUES, issueCategoryName, issueLabel } from '../../types/scheme';
import { findIssue, useCatalogStore } from '../../store/catalogStore';
import { useT } from '../../i18n';

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
  const t = useT();
  const issueCatalog = useCatalogStore((state) => state.issues);
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
    <section className={`coverage ${problems > 0 ? 'has-problems' : ''}`} aria-label={t('report.aria')}>
      <button type="button" className="coverage-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <strong>{t('report.title')}</strong>
        <span className="coverage-counts">
          {noIssues ? (
            <span className="coverage-chip is-not_detected">{t('report.selectedNone')}</span>
          ) : (
            <span className="coverage-chip is-detected">{t('report.selected', { count: selected.length, max })}</span>
          )}
          {notFound > 0 ? <span className="coverage-chip is-not_detected">{t('report.notFound', { count: notFound })}</span> : null}
          {failedBranches > 0 ? (
            <span className="coverage-chip is-failed">{t('report.failedBranches', { count: failedBranches })}</span>
          ) : null}
          {summary?.schemeCounts ? (
            <span className="coverage-chip" title={t('report.schemeCounts.title')}>
              {t('report.schemeCounts', {
                classified: summary.schemeCounts.classified,
                unclassified: summary.schemeCounts.unclassified,
              })}
              {summary.schemeCounts.withErrors ? t('report.schemeErrors', { count: summary.schemeCounts.withErrors }) : ''}
            </span>
          ) : null}
        </span>
        {warnings.length > 0 ? <span className="coverage-chip is-warning">{t('report.warnings', { count: warnings.length })}</span> : null}
        <span className="coverage-toggle">{open ? t('report.collapse') : t('report.expand')}</span>
      </button>
      {open ? (
        <div className="coverage-body">
          {noIssues ? (
            <div className="annotation-warning">
              {t('report.noIssues')}
              {selection?.reason ? t('report.noIssues.reason', { reason: selection.reason }) : ''}
            </div>
          ) : (
            <ol className="selection-list">
              {selected.map((item) => {
                // 실행 기록에 남은 이름 대신 현재 카탈로그의 이름(선택한 언어)을 우선 쓴다.
                const catalogItem = findIssue(issueCatalog, item.issueId);
                const category = issueCategoryName(catalogItem) || item.categoryName || '';
                return (
                <li key={item.instanceId ?? item.issueId} className={item.evidenceStatus === 'not_found' ? 'is-not_detected' : 'is-detected'}>
                  <div>
                    <span className="node-detail-muted">{category}</span>
                    {category ? ' › ' : ''}
                    <strong>{issueLabel(catalogItem) || item.label || item.issueId}</strong>{' '}
                    <span className="node-detail-code">{item.issueId}</span>
                    {item.evidenceStatus === 'not_found' ? (
                      <span className="coverage-chip is-not_detected">{t('report.item.notFound')}</span>
                    ) : null}
                    {item.branchStatus && item.branchStatus !== 'ok' ? (
                      <span className="coverage-chip is-failed" title={item.branchError ?? undefined}>
                        {t('report.item.branchStatus', { status: item.branchStatus })}
                      </span>
                    ) : null}
                    {onFocusNode ? (
                      <button type="button" className="link-button" onClick={() => onFocusNode(item.nodeId)}>
                        {t('report.item.view')}
                      </button>
                    ) : null}
                  </div>
                  {item.selectionReason ? (
                    <div className="coverage-reason">{t('report.item.reason', { reason: item.selectionReason })}</div>
                  ) : null}
                  {item.branchError ? <div className="coverage-error">{item.branchError}</div> : null}
                </li>
                );
              })}
            </ol>
          )}
          <div className="coverage-meta">
            {selection?.attempts ? t('report.meta.attempts', { count: selection.attempts }) : ''}
            {selection?.model ? t('report.meta.model', { model: selection.model }) : ''}
            {summary?.summaryCounts
              ? t('report.meta.summaries', {
                  done: summary.summaryCounts.withSummary,
                  total: summary.summaryCounts.withSummary + summary.summaryCounts.withoutSummary,
                })
              : ''}
            {summary?.validation
              ? summary.validation.ok
                ? t('report.meta.validationOk')
                : t('report.meta.validationErrors', { count: summary.validation.errors.length })
              : ''}
          </div>
          <div className="coverage-meta" title={t('report.meta.versionTitle')}>
            {run.mode === 'mock'
              ? t('report.meta.mock')
              : t('report.meta.flow', { flow: pin?.flowName ?? run.flowId ?? '?' })}
            {pin?.flowHash ? t('report.meta.hash', { hash: shortHash(pin.flowHash) }) : ''}
            {pin?.snapshot ? t('report.meta.snapshot') : ''}
            {run.catalogs
              ? t('report.meta.catalogs', {
                  issue: run.catalogs.issueCatalogVersion ?? '?',
                  scheme: run.catalogs.schemeCatalogVersion ?? '?',
                })
              : ''}
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
