import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';
import { useT } from '../../i18n';

interface Props {
  onClose: () => void;
}

/**
 * 판결문 입력 대화상자. TXT 업로드 또는 붙여넣기.
 * 이미 프로젝트가 있으면 "원문 교체"(문서 버전 증가) 와 "새 프로젝트" 중 선택한다.
 */
export function JudgmentInputDialog({ onClose }: Props) {
  const t = useT();
  const caseData = useGraphStore((state) => state.caseData);
  const newDocument = useAnnotationStore((state) => state.newDocument);
  const replaceDocumentText = useAnnotationStore((state) => state.replaceDocumentText);

  const [text, setText] = useState('');
  const [caseId, setCaseId] = useState('');
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<'new' | 'replace'>(caseData ? 'replace' : 'new');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const readFile = async (file: File) => {
    // 줄바꿈·공백을 그대로 보존한다. BOM 만 제거.
    const content = (await file.text()).replace(/^\uFEFF/, '');
    setText(content);
    setFileName(file.name);
  };

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (mode === 'replace' && caseData) {
        await replaceDocumentText(text);
      } else {
        await newDocument(text, { fileName, caseId: caseId.trim() || null });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="judgment-input-title">
        <header className="dialog-header">
          <h2 id="judgment-input-title">{t('judgment.dialog.title')}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('judgment.dialog.close')}>
            &#10005;
          </button>
        </header>

        <div className="dialog-body">
          <div className="dialog-row">
            <button type="button" onClick={() => fileRef.current?.click()}>
              {t('judgment.dialog.openTxt')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="text/plain,.txt,.md"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
                event.target.value = '';
              }}
            />
            <span className="dialog-hint">
              {fileName ? t('judgment.dialog.file', { name: fileName }) : t('judgment.dialog.orPaste')}
            </span>
            <label className="dialog-inline">
              {t('judgment.dialog.caseId')}
              <input
                type="text"
                value={caseId}
                onChange={(event) => setCaseId(event.target.value)}
                placeholder={t('judgment.dialog.caseIdPlaceholder')}
              />
            </label>
          </div>

          <textarea
            ref={textareaRef}
            className="dialog-textarea"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('judgment.dialog.placeholder')}
            spellCheck={false}
          />
          <div className="dialog-hint">{t('judgment.dialog.charCount', { count: text.length.toLocaleString() })}</div>

          {caseData ? (
            <fieldset className="dialog-modes">
              <legend>{t('judgment.dialog.existing')}</legend>
              <label>
                <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                {t('judgment.dialog.replaceOption')}
              </label>
              <label>
                <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} />
                {t('judgment.dialog.newOption')}
              </label>
            </fieldset>
          ) : null}

          <p className="dialog-note">{t('judgment.dialog.note')}</p>
        </div>

        <footer className="dialog-footer">
          <button type="button" onClick={onClose}>
            {t('judgment.dialog.cancel')}
          </button>
          <button type="button" className="is-primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {mode === 'replace' && caseData ? t('judgment.dialog.replace') : t('judgment.dialog.create')}
          </button>
        </footer>
      </div>
    </div>
  );
}
