import { useEffect } from 'react';
import { AifWorkbench, ErrorToast, LanguageToggle, ProjectList, useServerProject } from '@aif/workbench';
import { useCatalogStore } from '@aif/workbench/store/catalogStore';
import { useT } from '@aif/workbench/i18n';
import { PipelineEditor } from './components/Pipeline/PipelineEditor';
import { usePipelineStore } from './store/pipelineStore';
import { LoginPage } from './auth/LoginPage';
import { hasScope, useSession } from './auth/session';
import { navigate, usePlace, type View } from './nav';

function TopBar({ view, projectId }: { view: View; projectId: string | null }) {
  const t = useT();
  const pipelineDirty = usePipelineStore((state) => state.dirty);
  const user = useSession((state) => state.user);
  const authMode = useSession((state) => state.authMode);
  const logout = useSession((state) => state.logout);
  // 파이프라인 편집은 권한이 있는 계정에만 보인다(없으면 서버가 403).
  const canEditPipeline = useSession((state) => hasScope(state, 'pipeline:admin'));
  const tabs: Array<[View, string]> = [
    ['projects', t('nav.projects')],
    ['argument', t('app.view.argument')],
    ...(canEditPipeline ? ([['pipeline', t('app.view.pipeline')]] as Array<[View, string]>) : []),
  ];
  return (
    <div className="top-bar">
      <nav className="view-tabs" aria-label={t('app.view.aria')}>
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={view === key ? 'is-active' : ''}
            aria-pressed={view === key}
            data-view={key}
            onClick={() => navigate({ view: key, projectId: key === 'argument' ? projectId : null })}
          >
            {label}
            {key === 'pipeline' && pipelineDirty ? ' •' : ''}
          </button>
        ))}
      </nav>
      <span className="status-spacer" />
      {authMode === 'token' && user ? (
        <span className="top-bar-user">
          {user.username}
          <button type="button" onClick={() => void logout()} data-action="logout">
            {t('auth.logout')}
          </button>
        </span>
      ) : null}
      <LanguageToggle />
    </div>
  );
}

function ArgumentView({ projectId }: { projectId: string | null }) {
  const t = useT();
  const state = useServerProject(projectId, (editing) => navigate({ view: 'argument', projectId: editing }, true));
  const bar = (
    <>
      <TopBar view="argument" projectId={projectId} />
      {state.kind === 'loading' ? <p className="project-list-note project-load-note">{t('projects.opening')}</p> : null}
      {state.kind === 'error' ? (
        <p className="project-list-note is-error project-load-note" role="alert">
          {state.message}
        </p>
      ) : null}
    </>
  );
  return (
    <div data-testid="aif-web-project" data-loaded-project={state.kind === 'ready' ? projectId ?? '' : ''} className="web-view">
      <AifWorkbench topBar={bar} />
    </div>
  );
}

function MainApp() {
  const place = usePlace();
  const canEditPipeline = useSession((state) => hasScope(state, 'pipeline:admin'));
  // 권한 없이 ?view=pipeline 으로 들어오면 사건 목록을 보여 준다.
  const { view, projectId } = place.view === 'pipeline' && !canEditPipeline ? { view: 'projects' as View, projectId: null } : place;
  const loadCatalogs = useCatalogStore((state) => state.load);
  // 초안이 서버에 자동 저장된 편집은 새로고침해도 남으므로 떠나기 경고는 저장 전 편집에만 띄운다.
  const pipelineUnsaved = usePipelineStore((state) => state.dirty && !state.draftSaved);

  useEffect(() => {
    void loadCatalogs();
  }, [loadCatalogs]);

  // 논증 화면의 미저장 경고는 AifWorkbench 가 건다. 여기서는 파이프라인 편집만 본다.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!pipelineUnsaved) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pipelineUnsaved]);

  if (view === 'pipeline') {
    return (
      <div className="app-shell is-pipeline">
        <TopBar view="pipeline" projectId={null} />
        <PipelineEditor active />
        <ErrorToast />
      </div>
    );
  }
  if (view === 'projects') {
    return (
      <div className="app-shell">
        <TopBar view="projects" projectId={null} />
        <ProjectList onOpen={(id) => navigate({ view: 'argument', projectId: id })} />
      </div>
    );
  }
  return <ArgumentView projectId={projectId} />;
}

export default function App() {
  const t = useT();
  const status = useSession((state) => state.status);
  const check = useSession((state) => state.check);

  useEffect(() => {
    void check();
  }, [check]);

  if (status === 'checking') return <div className="login-page">{t('auth.checking')}</div>;
  if (status === 'signedOut') return <LoginPage />;
  return <MainApp />;
}
