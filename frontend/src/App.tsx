import { useEffect, useState } from 'react';
import { AifWorkbench, ErrorToast, LanguageToggle } from '@aif/workbench';
import { useCatalogStore } from '@aif/workbench/store/catalogStore';
import { useT } from '@aif/workbench/i18n';
import { PipelineEditor } from './components/Pipeline/PipelineEditor';
import { usePipelineStore } from './store/pipelineStore';

type View = 'argument' | 'pipeline';

export default function App() {
  const t = useT();
  const [view, setView] = useState<View>('argument');
  const pipelineDirty = usePipelineStore((state) => state.dirty);
  // 초안이 서버에 자동 저장된 편집은 새로고침해도 남으므로 떠나기 경고는 저장 전 편집에만 띄운다.
  const pipelineUnsaved = usePipelineStore((state) => state.dirty && !state.draftSaved);
  const loadCatalogs = useCatalogStore((state) => state.load);

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

  return <AifWorkbench topBar={viewTabs} />;
}
