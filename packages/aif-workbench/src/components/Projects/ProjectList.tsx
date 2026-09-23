import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { describeApiError } from '../../api/errors';
import { useLang, useT } from '../../i18n';

type ProjectRow = Awaited<ReturnType<typeof api.listProjects>>['projects'][number];

export interface ProjectListProps {
  onOpen: (projectId: string) => void;
  /** 목록 위 오른쪽에 붙일 호스트 버튼 (예: 연결 설정) */
  actions?: ReactNode;
}

/** 한 번에 받아 오는 사건 수. 서버 상한(200)보다 작게 둔다. */
const PAGE_SIZE = 50;
/** 검색어를 이만큼 쉰 뒤에 서버로 보낸다(글자마다 요청하지 않는다). */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 서버에 저장된 사건 목록. 사건명·사건번호로 찾고 연다.
 *
 * 목록은 서버가 쪽으로 끊어 주고 검색도 서버가 한다. 사건이 수천 건이 되어도 한 번에 다 받으면
 * 응답이 커지고, 그 요청 하나가 서버의 이벤트 루프를 오래 붙잡아 다른 사람의 화면까지 느려진다.
 */
export function ProjectList({ onOpen, actions }: ProjectListProps) {
  const t = useT();
  const lang = useLang();
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');

  // 새로고침 버튼은 이 값을 올린다. 결과는 요청이 끝난 뒤에만 반영한다(언마운트 뒤 응답 무시).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // 입력했다가 되돌려 검색어가 그대로면 다시 부르지 않는다. 켜 둔 '불러오는 중'만 내린다.
      if (query === search) setLoading(false);
      else setSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, search]);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects({ limit: PAGE_SIZE, q: search })
      .then((result) => {
        if (cancelled) return;
        setRows(result.projects);
        setTotal(result.total);
        setError(null);
      })
      .catch((caught) => {
        if (cancelled) return;
        setRows(null);
        setTotal(0);
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
  }, [reloadKey, search]);

  const reload = () => {
    setLoading(true);
    setError(null);
    setReloadKey((key) => key + 1);
  };

  const loadMore = () => {
    if (!rows || loadingMore) return;
    setLoadingMore(true);
    api
      .listProjects({ limit: PAGE_SIZE, offset: rows.length, q: search })
      .then((result) => {
        // 그 사이 다른 사람이 저장해 순서가 바뀌었을 수 있다. 이미 받은 사건은 넣지 않는다.
        setRows((current) => {
          const seen = new Set((current ?? []).map((row) => row.projectId));
          return [...(current ?? []), ...result.projects.filter((row) => !seen.has(row.projectId))];
        });
        setTotal(result.total);
      })
      .catch((caught) => setError(describeApiError(t, caught)))
      .finally(() => setLoadingMore(false));
  };

  const shown = rows ?? [];
  const hasMore = shown.length < total;

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
          onChange={(event) => {
            setQuery(event.target.value);
            setLoading(true);
          }}
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
      {!loading && !error && shown.length === 0 ? (
        <p className="project-list-note">{search.trim() ? t('projects.noMatch') : t('projects.empty')}</p>
      ) : null}
      {shown.length > 0 ? (
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
            {shown.map((row) => (
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
      {shown.length > 0 ? (
        <div className="project-list-more">
          <span className="project-list-note">{t('projects.shownOfTotal', { shown: shown.length, total })}</span>
          {hasMore ? (
            <button type="button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? t('projects.loading') : t('projects.loadMore', { count: Math.min(PAGE_SIZE, total - shown.length) })}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
