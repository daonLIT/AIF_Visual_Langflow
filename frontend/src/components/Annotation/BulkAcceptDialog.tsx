import { useEffect } from 'react';
import type { BulkAcceptPreview } from '../../store/reviewLogic';

interface Props {
  preview: BulkAcceptPreview;
  onConfirm: () => void;
  onClose: () => void;
}

/** 전체 수락 전에 구조 검증 결과와 근거 미확인 항목을 확인시킨다. */
export function BulkAcceptDialog({ preview, onConfirm, onClose }: Props) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const errors = preview.validation.results.filter((r) => r.level === 'error');
  const warnings = preview.validation.results.filter((r) => r.level === 'warning');
  const nothing = preview.pendingNodeIds.length === 0 && preview.pendingEdgeIds.length === 0;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog dialog-narrow" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <header className="dialog-header">
          <h2 id="bulk-title">미검토 제안 전체 수락</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
            &#10005;
          </button>
        </header>
        <div className="dialog-body">
          {nothing ? (
            <p>수락할 미검토 제안이 없습니다.</p>
          ) : (
            <>
              <p>
                노드 <strong>{preview.pendingNodeIds.length}</strong>개, 관계 <strong>{preview.pendingEdgeIds.length}</strong>개를 확정 그래프에
                추가합니다.
              </p>
              <p className={preview.unverifiedEvidence.length > 0 ? 'is-warning-text' : ''}>
                근거 위치가 확정되지 않은 AI 노드 제안: <strong>{preview.unverifiedEvidence.length}</strong>개
                {preview.unverifiedEvidence.length > 0 ? ' — 수락 뒤에도 카드에서 근거를 확인할 수 있습니다.' : ''}
              </p>
              <p>
                수락 후 구조 검증 예상: 오류 <strong className={errors.length ? 'is-error-text' : ''}>{errors.length}</strong> / 경고{' '}
                <strong>{warnings.length}</strong>
              </p>
              {errors.length > 0 ? (
                <ul className="dialog-list">
                  {errors.slice(0, 8).map((error, index) => (
                    <li key={index}>{error.message}</li>
                  ))}
                  {errors.length > 8 ? <li>… 외 {errors.length - 8}건</li> : null}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <footer className="dialog-footer">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="is-primary" disabled={nothing} onClick={onConfirm}>
            전체 수락
          </button>
        </footer>
      </div>
    </div>
  );
}
