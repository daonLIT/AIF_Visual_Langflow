import { useEffect, useState } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';
import { useGraphStore } from '../../store/graphStore';
import { describeDiff } from '../../pipeline/flowUtils';
import { useT } from '../../i18n';

/**
 * Langflow 적용 확인: 적용 메모 + (선택) 적용이 확인되면 바로 테스트 실행.
 * 적용은 서버에서 검증 → 충돌 검사 → 백업 → 저장 → 재조회 확인 순서로 진행되고, 확인되지 않으면 실패로 표시한다.
 */
export function ApplyDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
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
          <h2 id="apply-title">{t('lf.apply.title', { name: current?.flow.name ?? '' })}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('lf.close')}>
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
          <p className="dialog-note">{t('lf.apply.note')}</p>
          {diff ? <p className="dialog-note">{t('lf.apply.diff', { diff: describeDiff(diff) })}</p> : null}
          <label className="field">
            <span>{t('lf.apply.memo')}</span>
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              autoFocus
              placeholder={t('lf.apply.memo.placeholder')}
            />
          </label>
          <label className="chip-toggle">
            <input type="checkbox" checked={runTest} onChange={(event) => setRunTest(event.target.checked)} />
            {t('lf.apply.runTest')}
          </label>
          {runTest ? (
            documentText ? (
              <p className="dialog-note">{t('lf.apply.useDocument', { count: documentText.length.toLocaleString() })}</p>
            ) : (
              <textarea
                value={customText}
                onChange={(event) => setCustomText(event.target.value)}
                rows={4}
                placeholder={t('lf.test.placeholder')}
                aria-label={t('lf.test.aria')}
              />
            )
          ) : null}
          <footer className="dialog-footer">
            <button type="submit" className="is-primary" disabled={!!busy || (runTest && !testText.trim())}>
              {busy ? busy : runTest ? t('lf.apply.submitWithTest') : t('lf.apply.submit')}
            </button>
            <button type="button" onClick={onClose}>
              {t('lf.cancel')}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
