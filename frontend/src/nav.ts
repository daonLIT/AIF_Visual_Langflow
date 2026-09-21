/**
 * 웹 주소 ↔ 화면. 라우터 없이 쿼리 문자열만 쓴다.
 *   /                    사건 목록 (기본 진입)
 *   /?projectId=<id>     그 프로젝트 검토 (Desktop 의 viewerUrl·[웹에서 열기]가 여는 주소)
 *   /?view=argument      사이트에서 직접 입력·분석하는 논증 화면 (보조)
 *   /?view=pipeline      파이프라인 편집 (보조)
 * 새로고침·직접 접근·뒤로 가기(popstate)를 지원한다.
 */
import { useSyncExternalStore } from 'react';

export type View = 'projects' | 'argument' | 'pipeline';
export type Place = { view: View; projectId: string | null };

const EVENT = 'aif:navigate';

function read(): Place {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('projectId');
  const view = params.get('view');
  if (projectId) return { view: 'argument', projectId };
  if (view === 'argument' || view === 'pipeline') return { view, projectId: null };
  return { view: 'projects', projectId: null };
}

let cached = read();
let cachedSearch = window.location.search;

function snapshot(): Place {
  if (window.location.search !== cachedSearch) {
    cachedSearch = window.location.search;
    cached = read();
  }
  return cached;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener(EVENT, callback);
  };
}

export function usePlace(): Place {
  return useSyncExternalStore(subscribe, snapshot);
}

export function navigate(place: Partial<Place> & { view: View }, replace = false): void {
  const params = new URLSearchParams();
  if (place.view === 'argument' && place.projectId) params.set('projectId', place.projectId);
  else if (place.view !== 'projects') params.set('view', place.view);
  const search = params.toString();
  const url = `${window.location.pathname}${search ? `?${search}` : ''}`;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(EVENT));
}
