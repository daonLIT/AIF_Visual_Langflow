import { ApiError } from './client';
import type { MessageKey, MessageParams } from '../i18n';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** 서버 오류를 사용자에게 보일 문장으로 바꾼다(인증 필요·권한 없음·설정 없음·연결 실패·없음 구분). */
export function describeApiError(t: Translate, error: unknown, projectId?: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return t('projects.error.auth');
    if (error.status === 403) return t('projects.error.forbidden');
    if (error.status === 404 && projectId) return t('projects.error.notFound', { projectId });
    if (error.code === 'BRIDGE_NOT_CONFIGURED') return t('projects.error.notConfigured');
    if (error.status === 0 || error.code === 'BRIDGE_UNREACHABLE') return t('projects.error.network');
    return t('projects.error.other', { message: `${error.message} (${error.code})` });
  }
  return t('projects.error.other', { message: (error as Error)?.message ?? String(error) });
}
