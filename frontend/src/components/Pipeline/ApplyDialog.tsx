import { useEffect, useState } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';
import { useGraphStore } from '../../store/graphStore';
import { describeDiff } from '../../pipeline/flowUtils';

/**
 * Langflow 적용 확인: 적용 메모 + (선택) 적용이 확인되면 바로 테스트 실행.
 * 적용은 서버에서 검증 → 충돌 검사 → 백업 → 저장 → 재조회 확인 순서로 진행되고, 확인되지 않으면 실패로 표시한다.
 */
export function ApplyDialog({ onClose }: { onClose: () => void }) {
  const current = usePipelineStore((state) => state.current);
  const diff = usePipelineStore((state) => state.diff);
  const busy = usePipelineStore((state) => state.busy);
  const mode = usePipelineStore((state) => state.mode);
  const documentText = useGraphStore((state) => state.caseData?.text ?? '');
  const [note, setNote] = useState('');
  const [runTest, setRunTest] = useState(!!documentText);
  const [customText, setCustomText] = useState('');

  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const testText = documentText || customText;

  const submit = async () => {
    const store = usePipelineStore.getState();
    const ok = await store.validate(mode === 'live');
    if (!ok) {
      onClose();
      return;
    }
    const applied = await store.apply(note.trim() || undefined, runTest && testText.trim() ? { text: testText } : null);
    if (applied) onClose();
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="apply-title">
        <header className="dialog-header">
          <h2 id="apply-title">Langflow 에 적용 — {current?.flow.name}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
            &#10005;
          </button>
        </header>
        <form
          className="dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="dialog-note">
            서버 검증 → 편집 기준 이후 원격 변경 여부 확인 → 적용 직전 원격 flow 백업 → 저장 → Langflow 에서 다시 읽어 저장 내용 확인 순서로
            진행합니다. 확인되지 않으면 성공으로 표시하지 않습니다.
          </p>
          {diff ? <p className="dialog-note">변경 내용: {describeDiff(diff)}</p> : null}
          <label className="field">
            <span>적용 메모 (버전 기록에 남습니다)</span>
            <input type="text" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} autoFocus placeholder="예: Main Claim 프롬프트 수정" />
          </label>
          <label className="chip-toggle">
            <input type="checkbox" checked={runTest} onChange={(event) => setRunTest(event.target.checked)} />
            적용이 확인되면 바로 테스트 실행
          </label>
          {runTest ? (
            documentText ? (
              <p className="dialog-note">논증 그래프 탭의 판결문({documentText.length.toLocaleString()}자)으로 실행합니다.</p>
            ) : (
              <textarea value={customText} onChange={(event) => setCustomText(event.target.value)} rows={4} placeholder="테스트할 판결문 원문" aria-label="테스트 원문" />
            )
          ) : null}
          <footer className="dialog-footer">
            <button type="submit" className="is-primary" disabled={!!busy || (runTest && !testText.trim())}>
              {busy ? busy : runTest ? '검증 후 적용 · 테스트' : '검증 후 적용'}
            </button>
            <button type="button" onClick={onClose}>
              취소
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
