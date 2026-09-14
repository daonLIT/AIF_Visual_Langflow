import { useEffect } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';

const KIND_LABEL: Record<string, string> = {
  backup: '적용 전 백업',
  applied: '적용본',
  restored: '복원본',
  cloned: '복제 시점',
  'applied-unverified': '적용 요청 (재조회 불일치)',
  'restored-unverified': '복원 요청 (재조회 불일치)',
};

export function VersionsDialog({ onClose }: { onClose: () => void }) {
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
          <h2 id="versions-title">버전 기록 — {current?.flow.name}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
            &#10005;
          </button>
        </header>
        <div className="dialog-body">
          <p className="dialog-note">
            Langflow 에 적용할 때마다 적용 직전의 원격 flow 가 백업됩니다. 복원도 같은 방식으로 적용되며, 비밀 값은 저장하지 않고 현재 Langflow 의
            값을 유지합니다.{dirty ? ' 편집 중인 변경은 복원하면 사라집니다.' : ''}
          </p>
          {protectedFlow ? <div className="annotation-warning">프로덕션 flow 에는 복원할 수 없습니다. 작업용 복제본에서 복원하세요.</div> : null}
          {versions.length === 0 ? (
            <div className="judgment-empty">아직 기록이 없습니다. 이 편집기에서 적용·복제한 뒤에 생깁니다.</div>
          ) : (
            <table className="lf-versions">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>종류</th>
                  <th>메모</th>
                  <th>규모</th>
                  <th>실행 해시</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.versionId}>
                    <td>{new Date(version.createdAt).toLocaleString()}</td>
                    <td>{KIND_LABEL[version.kind] ?? version.kind}</td>
                    <td>{version.note ?? ''}</td>
                    <td>
                      {version.nodeCount ?? '?'} / {version.edgeCount ?? '?'}
                    </td>
                    <td title={version.dataHash ?? undefined}>
                      {version.dataHash ? version.dataHash.slice(0, 19) : '-'}
                      {current && version.dataHash === current.hash ? ' (현재)' : ''}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={!!busy || protectedFlow}
                        onClick={() => {
                          if (window.confirm('이 버전으로 복원해 Langflow 에 적용할까요? 현재 원격 상태는 먼저 백업됩니다.')) {
                            void restoreVersion(version.versionId);
                          }
                        }}
                      >
                        이 버전으로 복원
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
            닫기
          </button>
        </footer>
      </div>
    </div>
  );
}
