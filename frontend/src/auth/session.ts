/**
 * 웹 로그인 세션. 세션 값은 HttpOnly 쿠키라 화면 코드가 읽지 못하고, CSRF 토큰만 메모리에 둔다.
 * 새로고침하면 GET /api/auth/session 으로 다시 받는다(저장소에 남기지 않음).
 */
import { create } from 'zustand';
import { currentLang } from '@aif/workbench/i18n';

export type SessionUser = { username: string | null; principal: string };

type SessionState = {
  status: 'checking' | 'signedIn' | 'signedOut';
  authMode: 'off' | 'token' | null;
  user: SessionUser | null;
  csrfToken: string | null;
  scopes: string[];
  /** 로그인 중 서버 401 로 끊겼는지(만료 안내) */
  expired: boolean;
  check: () => Promise<void>;
  login: (username: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  markSignedOut: () => void;
};

type SessionBody = { authMode: 'off' | 'token'; user: SessionUser; csrfToken: string | null; scopes: string[] };

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': currentLang(), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: parseJson(text) };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'checking',
  authMode: null,
  user: null,
  csrfToken: null,
  scopes: [],
  expired: false,

  async check() {
    try {
      const { status, body } = await call('/api/auth/session');
      if (status === 200) {
        const session = body as SessionBody;
        set({ status: 'signedIn', authMode: session.authMode, user: session.user, csrfToken: session.csrfToken, scopes: session.scopes ?? [], expired: false });
      } else {
        set({ status: 'signedOut', user: null, csrfToken: null });
      }
    } catch {
      set({ status: 'signedOut', user: null, csrfToken: null });
    }
  },

  async login(username, password) {
    try {
      const { status, body } = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (status === 200) {
        const session = body as SessionBody;
        set({ status: 'signedIn', authMode: session.authMode, user: session.user, csrfToken: session.csrfToken, scopes: session.scopes ?? [], expired: false });
        return null;
      }
      return (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${status}`;
    } catch (error) {
      return (error as Error).message;
    }
  },

  async logout() {
    await call('/api/auth/logout', { method: 'POST' }).catch(() => null);
    set({ status: 'signedOut', user: null, csrfToken: null, expired: false });
  },

  markSignedOut() {
    // 인증을 끈 서버(로컬 개발)에서는 401 이 오지 않는다. 로그인 중이던 세션이 끊긴 경우만 안내한다.
    if (get().status === 'signedIn' && get().authMode === 'token') set({ status: 'signedOut', user: null, csrfToken: null, expired: true });
  },
}));

/** 이 세션이 그 권한을 가졌는지(admin 은 모두). 인증을 끈 로컬 개발 서버는 모든 권한. */
export function hasScope(state: Pick<SessionState, 'authMode' | 'scopes'>, scope: string): boolean {
  return state.authMode === 'off' || state.scopes.includes(scope) || state.scopes.includes('admin');
}
