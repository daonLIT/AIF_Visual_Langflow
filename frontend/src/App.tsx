import { useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Toolbar } from './components/Toolbar/Toolbar';
import { JudgmentPanel } from './components/JudgmentPanel/JudgmentPanel';
import { ArgumentGraph } from './components/Graph/ArgumentGraph';
import { ValidationPanel } from './components/Validation/ValidationPanel';
import { AnnotationPanel } from './components/Annotation/AnnotationPanel';
import { useGraphStore } from './store/graphStore';
import { useAnnotationStore } from './store/annotationStore';

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
          <span>확정 노드 {counts.nodes}</span>
          <span>엣지 {counts.edges}</span>
          <span>쟁점 {counts.issues}</span>
          <span>미검토 제안 {counts.pending}</span>
          <span>
            검증:{' '}
            {validation
              ? `오류 ${validation.errorCount} / 경고 ${validation.warningCount}`
              : '미실행'}
          </span>
          {document ? <span>문서 v{document.version}</span> : null}
          <span>{dirty ? '저장 안 됨' : lastSavedAt ? `저장됨 ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}</span>
          {selectedNodeIds.length > 0 ? <span>선택 {selectedNodeIds.length}</span> : null}
        </>
      ) : (
        <span>판결문을 입력하거나 파일을 불러오세요.</span>
      )}
      <span className="status-spacer" />
      <span className="status-hint">
        캔버스 우클릭: 노드 추가 · 더블클릭: 텍스트 편집 · 아래 핸들→위 핸들 드래그: 엣지 · 점선 노드: AI 초안
      </span>
    </footer>
  );
}

function ErrorToast() {
  const errorMessage = useGraphStore((state) => state.errorMessage);
  const clearError = useGraphStore((state) => state.clearError);
  if (!errorMessage) return null;
  return (
    <div className="error-toast" role="alert">
      <span>{errorMessage}</span>
      <button type="button" onClick={clearError} aria-label="닫기">
        &#10005;
      </button>
    </div>
  );
}

export default function App() {
  const undo = useGraphStore((state) => state.undo);
  const redo = useGraphStore((state) => state.redo);
  const select = useAnnotationStore((state) => state.select);
  const dirty = useAnnotationStore((state) => state.dirty);
  const narrow = useNarrow();
  const [pane, setPane] = useState<Pane>('graph');
  const [reviewCollapsed, setReviewCollapsed] = useState(false);

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
        <Toolbar />
        {narrow ? (
          <nav className="pane-tabs" aria-label="패널 선택">
            {(
              [
                ['text', '판결문'],
                ['graph', '그래프'],
                ['review', '검토'],
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
                title={reviewCollapsed ? '검토 패널 열기' : '검토 패널 접기'}
              >
                {reviewCollapsed ? '◀ 검토' : '검토 ▶'}
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
