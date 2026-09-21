/**
 * 화면 문구의 한국어/영어 전환.
 *
 * - 컴포넌트는 useT() 로 번역 함수를 받는다(언어가 바뀌면 다시 그려진다).
 * - 스토어·검증기처럼 리액트 밖에서는 t() 를 부른다(호출 시점의 언어를 읽는다).
 * - 선택한 언어는 localStorage 에 남고, 저장소를 못 쓰면 한국어로 시작한다.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { ko } from './ko';
import { en } from './en';

export type Lang = 'ko' | 'en';
export type MessageKey = keyof typeof ko;
export type MessageParams = Record<string, string | number>;

export const LANGS: Lang[] = ['ko', 'en'];
const STORAGE_KEY = 'aif.lang';

const tables: Record<Lang, Record<MessageKey, string>> = { ko, en };

function isLang(value: unknown): value is Lang {
  return value === 'ko' || value === 'en';
}

function readStoredLang(): Lang {
  try {
    // 브라우저가 아닌 곳(스모크 테스트 등)에서도 불러올 수 있어야 한다.
    if (typeof window === 'undefined') return 'ko';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // 시크릿 창 등 localStorage 를 못 쓰는 환경
  }
  return 'ko';
}

function writeStoredLang(lang: Lang) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 저장하지 못해도 이번 세션에는 적용된다
  }
}

/** `{name}` 자리표시자를 채운다. 값이 없는 자리표시자는 그대로 둔다. */
export function format(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const template = tables[lang][key] ?? tables.ko[key] ?? key;
  return format(template, params);
}

interface I18nState {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggle: () => void;
}

export const useI18nStore = create<I18nState>((set, get) => ({
  lang: readStoredLang(),
  setLang(lang) {
    if (get().lang === lang) return;
    writeStoredLang(lang);
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    set({ lang });
  },
  toggle() {
    get().setLang(get().lang === 'ko' ? 'en' : 'ko');
  },
}));

if (typeof document !== 'undefined') {
  document.documentElement.lang = useI18nStore.getState().lang;
}

/** 지금 언어. 리액트 밖에서도 쓴다. */
export function currentLang(): Lang {
  return useI18nStore.getState().lang;
}

/** 리액트 밖(스토어·검증기·io)에서 쓰는 번역. 부르는 시점의 언어를 읽는다. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(currentLang(), key, params);
}

export function useLang(): Lang {
  return useI18nStore((state) => state.lang);
}

/** 컴포넌트용 번역 함수. 언어가 바뀌면 새 함수가 나와 다시 그려진다. */
export function useT(): (key: MessageKey, params?: MessageParams) => string {
  const lang = useLang();
  return useMemo(() => (key: MessageKey, params?: MessageParams) => translate(lang, key, params), [lang]);
}

/** 카탈로그처럼 한국어/영어 값이 따로 담긴 데이터에서 지금 언어에 맞는 쪽을 고른다. */
export function pickLocalized(lang: Lang, korean: string | null | undefined, english: string | null | undefined): string {
  const value = lang === 'en' ? english || korean : korean || english;
  return value ?? '';
}
