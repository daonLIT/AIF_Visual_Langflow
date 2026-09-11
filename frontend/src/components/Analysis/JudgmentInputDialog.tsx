import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';

interface Props {
  onClose: () => void;
}

/**
 * 판결문 입력 대화상자. TXT 업로드 또는 붙여넣기.
 * 이미 프로젝트가 있으면 "원문 교체"(문서 버전 증가) 와 "새 프로젝트" 중 선택한다.
 */
export function JudgmentInputDialog({ onClose }: Props) {
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
    const content = (await file.text()).replace(/^﻿/, '');
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
          <h2 id="judgment-input-title">판결문 입력</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
            &#10005;
          </button>
        </header>

        <div className="dialog-body">
          <div className="dialog-row">
            <button type="button" onClick={() => fileRef.current?.click()}>
              TXT 파일 열기
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
            <span className="dialog-hint">{fileName ? `파일: ${fileName}` : '또는 아래에 붙여넣기'}</span>
            <label className="dialog-inline">
              사건 ID(선택)
              <input type="text" value={caseId} onChange={(event) => setCaseId(event.target.value)} placeholder="예: 2026고합123" />
            </label>
          </div>

          <textarea
            ref={textareaRef}
            className="dialog-textarea"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="판결문 원문을 붙여넣으세요. 줄바꿈과 공백은 그대로 보존됩니다."
            spellCheck={false}
          />
          <div className="dialog-hint">{text.length.toLocaleString()}자</div>

          {caseData ? (
            <fieldset className="dialog-modes">
              <legend>기존 프로젝트가 있습니다</legend>
              <label>
                <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                원문 교체 — 확정 그래프·검토 상태는 유지하고 문서 버전을 올립니다. 위치를 잃은 근거는 재검토 대상이 됩니다.
              </label>
              <label>
                <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} />
                새 프로젝트 — 현재 그래프와 검토 상태를 버리고 새로 시작합니다.
              </label>
            </fieldset>
          ) : null}

          <p className="dialog-note">
            현재 Langflow flow 는 쟁점을 정확히 3개로 분해하도록 고정되어 있습니다. 쟁점 수가 다른 판결문은 분석이 실패하거나
            일부 쟁점이 합쳐질 수 있습니다.
          </p>
        </div>

        <footer className="dialog-footer">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="is-primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {mode === 'replace' && caseData ? '원문 교체' : '프로젝트 시작'}
          </button>
        </footer>
      </div>
    </div>
  );
}
