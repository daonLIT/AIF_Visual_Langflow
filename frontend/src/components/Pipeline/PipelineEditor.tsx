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

  return (
    <header className="pipeline-toolbar">
      <label className="pipeline-flow-select">
        flow
        <select value={flow?.id ?? ''} onChange={(event) => void open(event.target.value)}>
          <option value="">— 선택 —</option>
          {flows.map((item) => (
            <option key={item.id} value={item.id}>
              {item.isProduction ? '[프로덕션] ' : item.isWorkingCopy ? '[작업용] ' : ''}
              {item.name}
              {item.isAnalysisFlow ? ' ★분석' : ''}
              {item.hasDraft ? ' (초안 있음)' : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => void store().reload()} disabled={!!busy} title="Langflow 에서 목록과 현재 flow 를 다시 읽습니다">
        새로고침
      </button>
      <span className={`run-chip ${mode === 'live' ? 'is-succeeded' : ''}`} title={mode === 'mock' ? '실제 Langflow 대신 로컬 사본을 편집합니다' : '실제 Langflow 서버'}>
        {mode ?? '?'}
      </span>

      <span className="toolbar-divider" />

      <button
        type="button"
        disabled={!flow || !!busy}
        onClick={() => {
          const name = window.prompt('작업용 flow 이름', `${flow?.name ?? 'flow'} (작업용)`);
          if (name !== null) void store().cloneFlow(name.trim() || undefined);
        }}
        title="원본을 보존하고 편집·적용할 복제본을 Langflow 에 만듭니다. 편집 중인 내용은 복제본으로 옮겨집니다."
      >
        작업용 복제
      </button>
      <button type="button" disabled={!flow || !dirty || !!busy} onClick={() => void store().saveDraft()} title="서버에 초안으로 저장 (Langflow 에는 적용하지 않음) · Ctrl+S">
        초안 저장
      </button>
      {current?.draft ? (
        <>
          <button type="button" disabled={!!busy} onClick={() => void store().loadDraft()}>
            초안 불러오기
          </button>
          <button type="button" disabled={!!busy} onClick={() => window.confirm('저장된 초안을 버릴까요?') && void store().discardDraft()}>
            초안 버리기
          </button>
        </>
      ) : null}
      <button type="button" disabled={!flow || !!busy} onClick={() => void store().validate(mode === 'live')} title="서버 규칙으로 연결·형식·프롬프트 변수·중계 계약을 검사합니다 (live 모드는 바뀐 코드도 검사)">
        검증
      </button>
      <button
        type="button"
        className="is-primary"
        disabled={!flow || production || !!busy}
        onClick={() => setApplyOpen(true)}
        title={
          production
            ? '프로덕션 flow 에는 적용할 수 없습니다. 작업용 복제 후 적용하세요.'
            : '검증 후 Langflow 에 저장하고 다시 읽어 확인합니다. 적용 전 원격 flow 는 백업됩니다.'
        }
      >
        Langflow 에 적용…
      </button>
      <button type="button" disabled={!flow} onClick={() => setVersionsOpen(true)}>
        버전 기록
      </button>
      <button
        type="button"
        disabled={!flow || !!busy}
        onClick={() => void store().setAnalysisFlow(flow?.id === analysisFlowId && !production ? null : flow!.id)}
        title="논증 그래프 탭의 AI 분석이 이 flow 를 사용하게 합니다"
      >
        {flow && flow.id === analysisFlowId ? '분석 flow ★' : '분석에 사용'}
      </button>

      <span className="toolbar-divider" />

      <button type="button" disabled={!canUndo} onClick={() => store().undo()} title="실행 취소 (Ctrl+Z)">
        되돌리기
      </button>
      <button type="button" disabled={!canRedo} onClick={() => store().redo()} title="다시 실행 (Ctrl+Shift+Z)">
        다시 실행
      </button>
      <button type="button" disabled={!!busy} onClick={() => void store().runDiagnostics()} title="설정 존재 여부와 별개로 Langflow·분석 flow·Ollama·모델에 실제로 연결되는지 확인합니다">
        연결 확인
      </button>
      <span className="status-spacer" />
      {busy ? (
        <span className="run-chip is-active">
          <span className="run-spinner" aria-hidden="true" />
          {busy}
        </span>
      ) : dirty ? (
        <span className="run-chip is-failed" title={diff ? describeDiff(diff) : undefined}>
          적용 안 된 편집{diff ? ` · ${describeDiff(diff)}` : ''} ·{' '}
          {draftSaved ? `초안 저장됨${draftSavedAt ? ` ${new Date(draftSavedAt).toLocaleTimeString()}` : ''}` : '초안 저장 대기'}
        </span>
      ) : null}
      {versionsOpen ? <VersionsDialog onClose={() => setVersionsOpen(false)} /> : null}
      {applyOpen ? <ApplyDialog onClose={() => setApplyOpen(false)} /> : null}
    </header>
  );
}

function PipelineBanner() {
  const current = usePipelineStore((state) => state.current);
  const message = usePipelineStore((state) => state.message);
  const connection = usePipelineStore((state) => state.connection);
  const clearMessage = usePipelineStore((state) => state.clearMessage);
  const flow = current?.flow;

  return (
    <>
      {flow?.isProduction ? (
        <div className="pipeline-banner is-protected">
          프로덕션 flow(LANGFLOW_FLOW_ID)입니다. 편집·초안 저장·검증은 할 수 있지만 Langflow 에 적용하려면 [작업용 복제]로 복제본을 만드세요. 편집
          중인 내용은 복제본으로 옮겨집니다.
        </div>
      ) : flow?.isWorkingCopy ? (
        <div className="pipeline-banner">작업용 복제본입니다{flow.sourceFlowId ? ` (원본 ${flow.sourceFlowId})` : ''}. 적용 전 원격 flow 는 자동으로 백업됩니다.</div>
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
          <button type="button" className="icon-button" onClick={clearMessage} aria-label="알림 닫기">
            &#10005;
          </button>
        </div>
      ) : null}
      {current?.relay.errors && current.relay.errors.length > 0 ? (
        <div className="pipeline-banner is-error">중계 입력·출력 컴포넌트 문제: {current.relay.errors.join(' / ')}</div>
      ) : null}
      {connection ? (
        <div className="pipeline-banner">
          연결 확인 ({connection.mode}):{' '}
          {connection.checks.map((check) => (
            <span key={check.name} className={`diag is-${check.ok === null ? 'na' : check.ok ? 'ok' : 'fail'}`} title={check.detail}>
              {check.name} {check.ok === null ? '–' : check.ok ? '정상' : '실패'}: {check.detail}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
