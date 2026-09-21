import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Toolbar } from './components/Toolbar/Toolbar';
import { JudgmentPanel } from './components/JudgmentPanel/JudgmentPanel';
import { ArgumentGraph } from './components/Graph/ArgumentGraph';
import { ValidationPanel } from './components/Validation/ValidationPanel';
import { AnnotationPanel } from './components/Annotation/AnnotationPanel';
import { useGraphStore } from './store/graphStore';
import { useAnnotationStore } from './store/annotationStore';
import { useCatalogStore } from './store/catalogStore';
import { useLang, useT } from './i18n';

type Pane = 'text' | 'graph' | 'review';

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

export function ErrorToast() {
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

export interface AifWorkbenchProps {
  /** 도구 모음 위에 붙일 호스트 영역 (웹: 화면 탭·언어 전환) */
  topBar?: ReactNode;
}

/**
 * 원문 | 논증 그래프 | AI 제안 검토 화면. 독립 웹과 Langflow 가 같은 컴포넌트를 쓴다.
 * 스타일은 .aif-root 아래에만 적용되므로, 호스트는 이 컴포넌트를 .aif-root 요소 안에 둔다.
 */
export function AifWorkbench({ topBar }: AifWorkbenchProps) {
  const t = useT();
  const lang = useLang();
  const undo = useGraphStore((state) => state.undo);
  const redo = useGraphStore((state) => state.redo);
  const select = useAnnotationStore((state) => state.select);
  const dirty = useAnnotationStore((state) => state.dirty);
  const loadCatalogs = useCatalogStore((state) => state.load);
  const narrow = useNarrow();
  const [pane, setPane] = useState<Pane>('graph');
  const [reviewCollapsed, setReviewCollapsed] = useState(false);

  useEffect(() => {
    void loadCatalogs();
  }, [loadCatalogs]);

  // 검증 메시지는 만들어질 때의 언어로 저장되므로, 언어를 바꾸면 다시 검사한다.
  useEffect(() => {
    if (useGraphStore.getState().validation) useGraphStore.getState().runValidation();
  }, [lang]);

  // 논증 그래프 단축키. 이 화면이 떠 있는 동안만 건다.
  useEffect(() => {
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
  }, [undo, redo, select]);

  // 저장하지 않은 변경이 있으면 새로고침/닫기 전에 확인한다.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  return (
    <ReactFlowProvider>
      <div className={`app-shell ${narrow ? 'is-narrow' : ''} ${reviewCollapsed ? 'is-review-collapsed' : ''}`}>
        {topBar}
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
