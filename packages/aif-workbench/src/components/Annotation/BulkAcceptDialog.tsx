import { useEffect } from 'react';
import type { BulkAcceptPreview } from '../../store/reviewLogic';
import { useT } from '../../i18n';

interface Props {
  preview: BulkAcceptPreview;
  onConfirm: () => void;
  onClose: () => void;
}

/** 전체 수락 전에 구조 검증 결과와 근거 미확인 항목을 확인시킨다. */
export function BulkAcceptDialog({ preview, onConfirm, onClose }: Props) {
  const t = useT();
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
          <h2 id="bulk-title">{t('bulk.title')}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('bulk.close')}>
            &#10005;
          </button>
        </header>
        <div className="dialog-body">
          {nothing ? (
            <p>{t('bulk.nothing')}</p>
          ) : (
            <>
              <p>{t('bulk.counts', { nodes: preview.pendingNodeIds.length, edges: preview.pendingEdgeIds.length })}</p>
              <p className={preview.unverifiedEvidence.length > 0 ? 'is-warning-text' : ''}>
                {t('bulk.unverified', { count: preview.unverifiedEvidence.length })}
                {preview.unverifiedEvidence.length > 0 ? t('bulk.unverified.hint') : ''}
              </p>
              <p className={errors.length ? 'is-error-text' : ''}>
                {t('bulk.validation', { errors: errors.length, warnings: warnings.length })}
              </p>
              {errors.length > 0 ? (
                <ul className="dialog-list">
                  {errors.slice(0, 8).map((error, index) => (
                    <li key={index}>{error.message}</li>
                  ))}
                  {errors.length > 8 ? <li>{t('bulk.more', { count: errors.length - 8 })}</li> : null}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <footer className="dialog-footer">
          <button type="button" onClick={onClose}>
            {t('bulk.cancel')}
          </button>
          <button type="button" className="is-primary" disabled={nothing} onClick={onConfirm}>
            {t('bulk.confirm')}
          </button>
        </footer>
      </div>
    </div>
  );
}
