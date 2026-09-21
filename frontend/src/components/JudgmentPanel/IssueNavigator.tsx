import { useMemo, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useT } from '../../i18n';

/** 판결문 패널 안에 접을 수 있는 형태로 붙는 쟁점 목록. */
export function IssueNavigator() {
  const t = useT();
  const caseData = useGraphStore((state) => state.caseData);
  const highlightIssueId = useGraphStore((state) => state.highlightIssueId);
  const requestFocus = useGraphStore((state) => state.requestFocus);
  const setHighlightIssue = useGraphStore((state) => state.setHighlightIssue);
  const [collapsed, setCollapsed] = useState(false);

  const issues = useMemo(
    () => (caseData ? caseData.nodes.filter((node) => node.type === 'ISSUE') : []),
    [caseData],
  );

  if (!caseData) return null;

  return (
    <section className="issue-navigator">
      <header className="issue-navigator-header">
        <button
          type="button"
          className="issue-navigator-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <span className={`caret ${collapsed ? 'is-collapsed' : ''}`} aria-hidden="true" />
          {t('issueNav.count', { count: issues.length })}
        </button>
        {highlightIssueId ? (
          <button
            type="button"
            className="link-button"
            onClick={() => setHighlightIssue(null)}
          >
            {t('issueNav.clearHighlight')}
          </button>
        ) : null}
      </header>

      {collapsed ? null : (
        <ol className="issue-list">
          {issues.length === 0 ? (
            <li className="issue-empty">{t('issueNav.empty')}</li>
          ) : (
            issues.map((issue, index) => (
              <li key={issue.id}>
                <button
                  type="button"
                  className={`issue-item ${highlightIssueId === issue.id ? 'is-active' : ''}`}
                  onClick={() => {
                    requestFocus(issue.id);
                    setHighlightIssue(highlightIssueId === issue.id ? null : issue.id);
                  }}
                  title={issue.text}
                >
                  <span className="issue-index">{index + 1}</span>
                  <span className="issue-text">{issue.text || t('issueNav.untitled')}</span>
                </button>
              </li>
            ))
          )}
        </ol>
      )}
    </section>
  );
}
