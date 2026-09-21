import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { describeApiError } from '../../api/errors';
import { useLang, useT } from '../../i18n';

type ProjectRow = Awaited<ReturnType<typeof api.listProjects>>['projects'][number];

export interface ProjectListProps {
  onOpen: (projectId: string) => void;
  /** 목록 위 오른쪽에 붙일 호스트 버튼 (예: 연결 설정) */
  actions?: ReactNode;
}

/** 서버에 저장된 사건 목록. 사건명·사건번호로 찾고 연다. */
export function ProjectList({ onOpen, actions }: ProjectListProps) {
  const t = useT();
  const lang = useLang();
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  // 새로고침 버튼은 이 값을 올린다. 결과는 요청이 끝난 뒤에만 반영한다(언마운트 뒤 응답 무시).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((result) => {
        if (cancelled) return;
        setRows(result.projects);
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setRows(null);
        setError(describeApiError(t, caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 언어가 바뀌어도 다시 부르지 않는다(오류 문구는 다음 새로고침 때 바뀜).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const reload = () => {
    setLoading(true);
    setError(null);
    setReloadKey((key) => key + 1);
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!rows || !needle) return rows ?? [];
    return rows.filter((row) =>
      [row.title, row.caseId, row.projectId].some((value) => (value ?? '').toLowerCase().includes(needle)),
    );
  }, [rows, query]);

  const time = (value?: string | null) =>
    value ? new Date(value).toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '';

  return (
    <section className="project-list" data-testid="aif-project-list">
      <header className="project-list-header">
        <h2>{t('projects.title')}</h2>
        <input
          type="search"
          value={query}
          placeholder={t('projects.search')}
          aria-label={t('projects.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" onClick={reload} disabled={loading}>
          {t('projects.refresh')}
        </button>
        {actions}
      </header>
      {loading ? <p className="project-list-note">{t('projects.loading')}</p> : null}
      {error ? (
        <p className="project-list-note is-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && !error && rows && rows.length === 0 ? <p className="project-list-note">{t('projects.empty')}</p> : null}
      {!loading && !error && rows && rows.length > 0 && filtered.length === 0 ? (
        <p className="project-list-note">{t('projects.noMatch')}</p>
      ) : null}
      {filtered.length > 0 ? (
        <table className="project-table">
          <thead>
            <tr>
              <th>{t('projects.col.title')}</th>
              <th>{t('projects.col.caseId')}</th>
              <th>{t('projects.col.source')}</th>
              <th>{t('projects.col.updatedAt')}</th>
              <th>{t('projects.col.revision')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.projectId} data-project-id={row.projectId}>
                <td>
                  <button type="button" className="link-button" onClick={() => onOpen(row.projectId)}>
                    {row.title || t('projects.untitled')}
                  </button>
                  <div className="project-id">{row.projectId}</div>
                </td>
                <td>{row.caseId ?? ''}</td>
                <td>{row.source === 'langflow-desktop' ? t('projects.source.langflow-desktop') : t('projects.source.site')}</td>
                <td>{time(row.updatedAt)}</td>
                <td>{row.revision}</td>
                <td>
                  <button type="button" onClick={() => onOpen(row.projectId)}>
                    {t('projects.open')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
