import { useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Toolbar } from './components/Toolbar/Toolbar';
import { JudgmentPanel } from './components/JudgmentPanel/JudgmentPanel';
import { ArgumentGraph } from './components/Graph/ArgumentGraph';
import { ValidationPanel } from './components/Validation/ValidationPanel';
import { AnnotationPanel } from './components/Annotation/AnnotationPanel';
import { PipelineEditor } from './components/Pipeline/PipelineEditor';
import { useGraphStore } from './store/graphStore';
import { useAnnotationStore } from './store/annotationStore';
import { useCatalogStore } from './store/catalogStore';
import { usePipelineStore } from './store/pipelineStore';
import { LanguageToggle } from './components/Layout/LanguageToggle';
import { useLang, useT } from './i18n';

type Pane = 'text' | 'graph' | 'review';
type View = 'argument' | 'pipeline';

/** 좁은 화면(< 1100px)에서는 세 패널을 탭으로 전환한다. */
function useNarrow(): boolean {
  const query = '(max-width: 1100px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent) => setNarrow(event.matches);
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);
  return narrow;
}

function StatusBar() {
  const t = useT();
  const lang = useLang();
  const caseData = useGraphStore((state) => state.caseData);
  const validation = useGraphStore((state) => state.validation);
  const selectedNodeIds = useGraphStore((state) => state.selectedNodeIds);
  const annotations = useGraphStore((state) => state.annotations);
  const document = useAnnotationStore((state) => state.document);
  const dirty = useAnnotationStore((state) => state.dirty);
  const lastSavedAt = useAnnotationStore((state) => state.lastSavedAt);

  const counts = useMemo(() => {
    if (!caseData) return null;
    return {
      nodes: caseData.nodes.length,
      edges: caseData.edges.length,
      issues: caseData.nodes.filter((node) => node.type === 'ISSUE').length,
      pending: annotations.filter((annotation) => annotation.status === 'pending').length,
    };
  }, [caseData, annotations]);

  return (
    <footer className="status-bar">
      {counts ? (
        <>
          <span>{t('app.status.nodes', { count: counts.nodes })}</span>
          <span>{t('app.status.edges', { count: counts.edges })}</span>
          <span>{t('app.status.issues', { count: counts.issues })}</span>
          <span>{t('app.status.pending', { count: counts.pending })}</span>
          <span>
            {validation
              ? t('app.status.validationCounts', { errors: validation.errorCount, warnings: validation.warningCount })
              : t('app.status.validationNone')}
          </span>
          {document ? <span>{t('app.status.documentVersion', { version: document.version })}</span> : null}
          <span>
            {dirty
              ? t('app.status.unsaved')
              : lastSavedAt
                ? t('app.status.savedAt', { time: new Date(lastSavedAt).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR') })
                : ''}
          </span>
          {selectedNodeIds.length > 0 ? <span>{t('app.status.selected', { count: selectedNodeIds.length })}</span> : null}
        </>
      ) : (
        <span>{t('app.status.empty')}</span>
      )}
      <span className="status-spacer" />
      <span className="status-hint">{t('app.status.hint')}</span>
    </footer>
  );
}

function ErrorToast() {
  const t = useT();
  const errorMessage = useGraphStore((state) => state.errorMessage);
  const clearError = useGraphStore((state) => state.clearError);
  if (!errorMessage) return null;
  return (
    <div className="error-toast" role="alert">
      <span>{errorMessage}</span>
      <button type="button" onClick={clearError} aria-label={t('app.error.close')}>
        &#10005;
      </button>
    </div>
  );
}

export default function App() {
  const t = useT();
  const lang = useLang();
  const undo = useGraphStore((state) => state.undo);
  const redo = useGraphStore((state) => state.redo);
  const select = useAnnotationStore((state) => state.select);
  const dirty = useAnnotationStore((state) => state.dirty);
  const narrow = useNarrow();
  const [pane, setPane] = useState<Pane>('graph');
  const [view, setView] = useState<View>('argument');
  const [reviewCollapsed, setReviewCollapsed] = useState(false);
  const pipelineDirty = usePipelineStore((state) => state.dirty);
  // 초안이 서버에 자동 저장된 편집은 새로고침해도 남으므로 떠나기 경고는 저장 전 편집에만 띄운다.
  const pipelineUnsaved = usePipelineStore((state) => state.dirty && !state.draftSaved);
  const loadCatalogs = useCatalogStore((state) => state.load);

  useEffect(() => {
    void loadCatalogs();
  }, [loadCatalogs]);

  // 검증 메시지는 만들어질 때의 언어로 저장되므로, 언어를 바꾸면 다시 검사한다.
  useEffect(() => {
    if (useGraphStore.getState().validation) useGraphStore.getState().runValidation();
  }, [lang]);

  useEffect(() => {
    // 논증 그래프 단축키. 파이프라인 탭은 자체 undo/redo 를 쓴다.
    if (view !== 'argument') return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (typing) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
      if (event.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, select, view]);

  // 저장하지 않은 변경이 있으면 새로고침/닫기 전에 확인한다.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty && !pipelineUnsaved) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, pipelineUnsaved]);

  const viewTabs = (
    <div className="top-bar">
      <nav className="view-tabs" aria-label={t('app.view.aria')}>
        {(['argument', 'pipeline'] as View[]).map((key) => (
          <button key={key} type="button" className={view === key ? 'is-active' : ''} aria-pressed={view === key} onClick={() => setView(key)}>
            {key === 'argument' ? t('app.view.argument') : t('app.view.pipeline')}
            {key === 'pipeline' && pipelineDirty ? ' •' : ''}
          </button>
        ))}
      </nav>
      <LanguageToggle />
    </div>
  );

  if (view === 'pipeline') {
    return (
      <div className="app-shell is-pipeline">
        {viewTabs}
        <PipelineEditor active />
        <ErrorToast />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className={`app-shell ${narrow ? 'is-narrow' : ''} ${reviewCollapsed ? 'is-review-collapsed' : ''}`}>
        {viewTabs}
        <Toolbar />
        {narrow ? (
          <nav className="pane-tabs" aria-label={t('app.pane.aria')}>
            {(
              [
                ['text', t('app.pane.text')],
                ['graph', t('app.pane.graph')],
                ['review', t('app.pane.review')],
              ] as Array<[Pane, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={pane === key ? 'is-active' : ''}
                aria-pressed={pane === key}
                onClick={() => setPane(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        ) : null}
        <main className="app-main" data-pane={narrow ? pane : undefined}>
          <div className="pane pane-text">
            <JudgmentPanel />
          </div>
          <section className="graph-panel pane pane-graph">
            <ArgumentGraph />
            <ValidationPanel />
            {!narrow ? (
              <button
                type="button"
                className="review-toggle"
                onClick={() => setReviewCollapsed((value) => !value)}
                aria-expanded={!reviewCollapsed}
                title={reviewCollapsed ? t('app.review.expand') : t('app.review.collapse')}
              >
                {reviewCollapsed ? t('app.review.collapsedLabel') : t('app.review.expandedLabel')}
              </button>
            ) : null}
          </section>
          <div className="pane pane-review">
            <AnnotationPanel />
          </div>
        </main>
        <StatusBar />
        <ErrorToast />
      </div>
    </ReactFlowProvider>
  );
}
