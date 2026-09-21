import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { usePipelineStore } from '../../store/pipelineStore';
import { PipelineCanvas } from './PipelineCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { Palette } from './Palette';
import { PipelineBottomPanel } from './PipelineBottomPanel';
import { VersionsDialog } from './VersionsDialog';
import { ApplyDialog } from './ApplyDialog';
import { describeDiff } from '../../pipeline/flowUtils';
import { useLang, useT } from '@aif/workbench/i18n';

/**
 * 파이프라인 탭: 사이트 안에서 실제 Langflow flow data 를 편집하고 저장한다.
 * 논증 그래프와 별도의 React Flow 인스턴스·스토어·undo/redo 를 쓴다.
 */
export function PipelineEditor({ active }: { active: boolean }) {
  const loadFlows = usePipelineStore((state) => state.loadFlows);
  const flows = usePipelineStore((state) => state.flows);
  const current = usePipelineStore((state) => state.current);

  useEffect(() => {
    if (active && flows.length === 0) void loadFlows();
  }, [active, flows.length, loadFlows]);

  // 탭이 보일 때만 이 편집기의 단축키를 받는다.
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const state = usePipelineStore.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        state.redo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void state.saveDraft();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active]);

  return (
    <ReactFlowProvider>
      <div className="pipeline">
        <PipelineToolbar />
        <PipelineBanner />
        <div className={`pipeline-main ${current ? '' : 'is-empty'}`}>
          <Palette />
          <section className="graph-panel">
            <PipelineCanvas />
          </section>
          <PropertiesPanel />
        </div>
        {current ? <PipelineBottomPanel /> : null}
      </div>
    </ReactFlowProvider>
  );
}

function PipelineToolbar() {
  const t = useT();
  const lang = useLang();
  const flows = usePipelineStore((state) => state.flows);
  const mode = usePipelineStore((state) => state.mode);
  const current = usePipelineStore((state) => state.current);
  const dirty = usePipelineStore((state) => state.dirty);
  const busy = usePipelineStore((state) => state.busy);
  const canUndo = usePipelineStore((state) => state.past.length > 0);
  const canRedo = usePipelineStore((state) => state.future.length > 0);
  const analysisFlowId = usePipelineStore((state) => state.analysisFlowId);
  const store = usePipelineStore.getState;
  const draftSaved = usePipelineStore((state) => state.draftSaved);
  const draftSavedAt = usePipelineStore((state) => state.draftSavedAt);
  const diff = usePipelineStore((state) => state.diff);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);

  const open = async (flowId: string) => {
    if (!flowId) return;
    // 아직 서버 초안에 저장되지 않은 편집은 먼저 저장한다(적용 전 편집은 초안으로 남는다).
    if (dirty && !draftSaved) await store().saveDraft(undefined, { silent: true });
    void store().openFlow(flowId);
  };

  const flow = current?.flow;
  const production = !!flow?.isProduction;
  const dirtyText = t('lf.editor.dirty', {
    diff: diff ? ` · ${describeDiff(diff)}` : '',
    draft: draftSaved
      ? draftSavedAt
        ? t('lf.editor.draftSavedAt', { time: new Date(draftSavedAt).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR') })
        : t('lf.editor.draftSaved')
      : t('lf.editor.draftPending'),
  });

  return (
    <header className="pipeline-toolbar">
      <label className="pipeline-flow-select">
        flow
        <select value={flow?.id ?? ''} onChange={(event) => void open(event.target.value)}>
          <option value="">{t('lf.editor.selectFlow')}</option>
          {flows.map((item) => (
            <option key={item.id} value={item.id}>
              {item.isProduction ? t('lf.editor.tagProduction') : item.isWorkingCopy ? t('lf.editor.tagWorking') : ''}
              {item.name}
              {item.isAnalysisFlow ? t('lf.editor.tagAnalysis') : ''}
              {item.hasDraft ? t('lf.editor.tagDraft') : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => void store().reload()} disabled={!!busy} title={t('lf.editor.reload.title')}>
        {t('lf.editor.reload')}
      </button>
      <span
        className={`run-chip ${mode === 'live' ? 'is-succeeded' : ''}`}
        title={mode === 'mock' ? t('lf.editor.mock.title') : t('lf.editor.live.title')}
      >
        {mode ?? '?'}
      </span>

      <span className="toolbar-divider" />

      <button
        type="button"
        disabled={!flow || !!busy}
        onClick={() => {
          const name = window.prompt(
            t('lf.editor.clonePrompt'),
            t('lf.editor.cloneDefault', { name: flow?.name ?? 'flow' }),
          );
          if (name !== null) void store().cloneFlow(name.trim() || undefined);
        }}
        title={t('lf.editor.clone.title')}
      >
        {t('lf.editor.clone')}
      </button>
      <button
        type="button"
        disabled={!flow || !dirty || !!busy}
        onClick={() => void store().saveDraft()}
        title={t('lf.editor.saveDraft.title')}
      >
        {t('lf.editor.saveDraft')}
      </button>
      {/* 초안 유무에 따라 버튼을 넣고 빼면 뒤 버튼들이 밀려 잘못 누르기 쉬우므로 항상 두고 비활성화만 한다. */}
      <button
        type="button"
        disabled={!current?.draft || !!busy}
        onClick={() => void store().loadDraft()}
        title={current?.draft ? t('lf.editor.loadDraft.title') : t('lf.editor.noDraft')}
      >
        {t('lf.editor.loadDraft')}
      </button>
      <button
        type="button"
        disabled={!current?.draft || !!busy}
        onClick={() => window.confirm(t('lf.editor.discardDraft.confirm')) && void store().discardDraft()}
        title={current?.draft ? t('lf.editor.discardDraft.title') : t('lf.editor.noDraft')}
      >
        {t('lf.editor.discardDraft')}
      </button>
      <button
        type="button"
        disabled={!flow || !!busy}
        onClick={() => void store().validate(mode === 'live')}
        title={t('lf.editor.validate.title')}
      >
        {t('lf.editor.validate')}
      </button>
      <button
        type="button"
        className="is-primary"
        disabled={!flow || production || !!busy}
        onClick={() => setApplyOpen(true)}
        title={production ? t('lf.editor.apply.blocked') : t('lf.editor.apply.title')}
      >
        {t('lf.editor.apply')}
      </button>
      <button type="button" disabled={!flow} onClick={() => setVersionsOpen(true)}>
        {t('lf.editor.versions')}
      </button>
      <button
        type="button"
        disabled={!flow || !!busy}
        onClick={() => void store().setAnalysisFlow(flow?.id === analysisFlowId && !production ? null : flow!.id)}
        title={t('lf.editor.useForAnalysis.title')}
      >
        {flow && flow.id === analysisFlowId ? t('lf.editor.analysisFlow') : t('lf.editor.useForAnalysis')}
      </button>

      <span className="toolbar-divider" />

      <button type="button" disabled={!canUndo} onClick={() => store().undo()} title={t('lf.editor.undo.title')}>
        {t('lf.editor.undo')}
      </button>
      <button type="button" disabled={!canRedo} onClick={() => store().redo()} title={t('lf.editor.redo.title')}>
        {t('lf.editor.redo')}
      </button>
      <button type="button" disabled={!!busy} onClick={() => void store().runDiagnostics()} title={t('lf.editor.diagnostics.title')}>
        {t('lf.editor.diagnostics')}
      </button>
      {/* 상태 표시는 남는 폭만 쓰고 넘치면 말줄임한다 — 길이가 바뀌어도 툴바가 줄바꿈되지 않게 한다. */}
      <span className="pipeline-toolbar-status">
        {busy ? (
          <span className="run-chip is-active" title={busy}>
            <span className="run-spinner" aria-hidden="true" />
            <span className="run-chip-text">{busy}</span>
          </span>
        ) : dirty ? (
          <span className="run-chip is-failed" title={dirtyText}>
            <span className="run-chip-text">{dirtyText}</span>
          </span>
        ) : null}
      </span>
      {versionsOpen ? <VersionsDialog onClose={() => setVersionsOpen(false)} /> : null}
      {applyOpen ? <ApplyDialog onClose={() => setApplyOpen(false)} /> : null}
    </header>
  );
}

function PipelineBanner() {
  const t = useT();
  const current = usePipelineStore((state) => state.current);
  const message = usePipelineStore((state) => state.message);
  const connection = usePipelineStore((state) => state.connection);
  const clearMessage = usePipelineStore((state) => state.clearMessage);
  const flow = current?.flow;

  return (
    <>
      {flow?.isProduction ? (
        <div className="pipeline-banner is-protected">{t('lf.editor.productionBanner')}</div>
      ) : flow?.isWorkingCopy ? (
        <div className="pipeline-banner">
          {t('lf.editor.workingBanner')}
          {flow.sourceFlowId ? t('lf.editor.workingBanner.source', { flowId: flow.sourceFlowId }) : ''}
          {t('lf.editor.workingBanner.tail')}
        </div>
      ) : null}
      {message ? (
        <div className={`pipeline-banner is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          <span>{message.text}</span>
          {message.details && message.details.length > 0 ? (
            <ul>
              {message.details.slice(0, 10).map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          ) : null}
          <button type="button" className="icon-button" onClick={clearMessage} aria-label={t('lf.editor.closeNotice')}>
            &#10005;
          </button>
        </div>
      ) : null}
      {current?.relay.errors && current.relay.errors.length > 0 ? (
        <div className="pipeline-banner is-error">{t('lf.editor.relayError', { errors: current.relay.errors.join(' / ') })}</div>
      ) : null}
      {connection ? (
        <div className="pipeline-banner">
          {t('lf.editor.connection', { mode: connection.mode })}
          {connection.checks.map((check) => (
            <span key={check.name} className={`diag is-${check.ok === null ? 'na' : check.ok ? 'ok' : 'fail'}`} title={check.detail}>
              {check.name} {check.ok === null ? '–' : check.ok ? t('lf.editor.checkOk') : t('lf.editor.checkFailed')}: {check.detail}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
