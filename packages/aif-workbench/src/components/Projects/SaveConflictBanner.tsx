import { useState } from 'react';
import { useAnnotationStore } from '../../store/annotationStore';
import { downloadJson } from '../../io/download';
import { useT } from '../../i18n';

/**
 * 저장 충돌(409): 다른 곳에서 먼저 저장했다. 화면의 편집은 그대로 두고 사용자가 고른다.
 * - 내 편집을 파일로 내려받기(잃지 않게)
 * - 서버 최신본 불러오기(화면의 편집은 버림, 확인 후)
 */
export function SaveConflictBanner() {
  const t = useT();
  const conflict = useAnnotationStore((state) => state.saveConflict);
  const buildProjectFile = useAnnotationStore((state) => state.buildProjectFile);
  const reloadServerCopy = useAnnotationStore((state) => state.reloadServerCopy);
  const dismiss = useAnnotationStore((state) => state.dismissSaveConflict);
  const [busy, setBusy] = useState(false);
  if (!conflict) return null;

  const saveMine = () => {
    const project = buildProjectFile();
    if (project) downloadJson(`${project.title || project.projectId}.r${project.revision}.local.project.json`, project);
  };
  const reload = async () => {
    if (!window.confirm(t('conflict.reload.confirm'))) return;
    setBusy(true);
    await reloadServerCopy();
    setBusy(false);
  };

  return (
    <div className="save-conflict" role="alert" data-testid="aif-save-conflict">
      <strong>{t('conflict.title')}</strong>
      <span>{t('conflict.body')}</span>
      <span className="save-conflict-actions">
        <button type="button" onClick={saveMine} data-action="conflict-download">
          {t('conflict.download')}
        </button>
        <button type="button" className="is-danger" disabled={busy} onClick={() => void reload()} data-action="conflict-reload">
          {t('conflict.reload')}
        </button>
        <button type="button" onClick={dismiss} data-action="conflict-dismiss">
          {t('conflict.dismiss')}
        </button>
      </span>
    </div>
  );
}
