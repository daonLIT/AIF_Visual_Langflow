import { useEffect, useState } from 'react';
import { useAnnotationStore } from '../store/annotationStore';
import { describeApiError } from '../api/errors';
import { useT } from '../i18n';

export type ServerProjectState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

/**
 * 호스트 주소의 projectId 로 서버 프로젝트를 연다(웹 ?projectId=, Langflow /aif/projects/:id 가 같이 쓴다).
 * - 같은 프로젝트를 이미 편집 중이면 다시 불러오지 않는다(목록에 다녀와도 편집 유지).
 * - 다른 프로젝트에 저장 안 한 편집이 있으면 확인하고, 취소하면 onCancel(편집 중인 projectId)을 부른다.
 * - 늦게 도착한 이전 요청의 응답은 store 가 버린다.
 */
export function useServerProject(projectId: string | null, onCancel: (editingProjectId: string) => void): ServerProjectState {
  const t = useT();
  const [state, setState] = useState<ServerProjectState>({ kind: projectId ? 'loading' : 'idle' });

  useEffect(() => {
    if (!projectId) return;
    const store = useAnnotationStore.getState();
    if (store.projectId === projectId && store.document) {
      queueMicrotask(() => setState({ kind: 'ready' }));
      return;
    }
    const editing = store.document ? store.projectId : null;
    if (store.dirty && editing && !window.confirm(t('projects.discardConfirm'))) {
      onCancel(editing);
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setState({ kind: 'loading' });
    });
    void store.loadFromServer(projectId).then((result) => {
      if (cancelled || ('stale' in result && result.stale)) return;
      if (result.ok) setState({ kind: 'ready' });
      else setState({ kind: 'error', message: describeApiError(t, 'error' in result ? result.error : null, projectId) });
    });
    return () => {
      cancelled = true;
    };
    // 언어 전환(t)이나 onCancel 이 바뀌어도 다시 불러오지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return projectId ? state : { kind: 'idle' };
}
