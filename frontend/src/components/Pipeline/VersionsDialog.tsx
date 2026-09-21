import { useEffect } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';
import { useLang, useT, type MessageKey } from '../../i18n';

const VERSION_KIND_KEY: Record<string, MessageKey> = {
  backup: 'lf.versions.backup',
  applied: 'lf.versions.applied',
  restored: 'lf.versions.restored',
  cloned: 'lf.versions.cloned',
  'applied-unverified': 'lf.versions.appliedUnverified',
  'restored-unverified': 'lf.versions.restoredUnverified',
};

export function VersionsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const versions = usePipelineStore((state) => state.versions);
  const current = usePipelineStore((state) => state.current);
  const busy = usePipelineStore((state) => state.busy);
  const loadVersions = usePipelineStore((state) => state.loadVersions);
  const restoreVersion = usePipelineStore((state) => state.restoreVersion);
  const dirty = usePipelineStore((state) => state.dirty);

  useEffect(() => {
    void loadVersions();
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [loadVersions, onClose]);

  const protectedFlow = current?.flow.isProduction;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="versions-title">
        <header className="dialog-header">
          <h2 id="versions-title">{t('lf.versions.title', { name: current?.flow.name ?? '' })}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('lf.close')}>
            &#10005;
          </button>
        </header>
        <div className="dialog-body">
          <p className="dialog-note">
            {t('lf.versions.note')}
            {dirty ? t('lf.versions.note.dirty') : ''}
          </p>
          {protectedFlow ? <div className="annotation-warning">{t('lf.versions.protected')}</div> : null}
          {versions.length === 0 ? (
            <div className="judgment-empty">{t('lf.versions.empty')}</div>
          ) : (
            <table className="lf-versions">
              <thead>
                <tr>
                  <th>{t('lf.versions.time')}</th>
                  <th>{t('lf.versions.kind')}</th>
                  <th>{t('lf.versions.note.column')}</th>
                  <th>{t('lf.versions.size')}</th>
                  <th>{t('lf.versions.hash')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.versionId}>
                    <td>{new Date(version.createdAt).toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR')}</td>
                    <td>{VERSION_KIND_KEY[version.kind] ? t(VERSION_KIND_KEY[version.kind]) : version.kind}</td>
                    <td>{version.note ?? ''}</td>
                    <td>
                      {version.nodeCount ?? '?'} / {version.edgeCount ?? '?'}
                    </td>
                    <td title={version.dataHash ?? undefined}>
                      {version.dataHash ? version.dataHash.slice(0, 19) : '-'}
                      {current && version.dataHash === current.hash ? t('lf.versions.current') : ''}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={!!busy || protectedFlow}
                        onClick={() => {
                          if (window.confirm(t('lf.versions.restore.confirm'))) {
                            void restoreVersion(version.versionId);
                          }
                        }}
                      >
                        {t('lf.versions.restore')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <footer className="dialog-footer">
          <button type="button" onClick={onClose}>
            {t('lf.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
