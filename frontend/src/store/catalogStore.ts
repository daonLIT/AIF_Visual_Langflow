/** 쟁점 카탈로그(엑셀 변환본)와 Walton 스킴 카탈로그. 서버에서 한 번 읽어 둔다. */
import { create } from 'zustand';
import { api } from '../api/client';
import type { IssueCatalog, IssueCatalogItem, SchemeCatalog, SchemeDefinition } from '../types/scheme';
import { findSchemeDefinition } from '../types/scheme';
import { t } from '../i18n';

interface CatalogState {
  issues: IssueCatalog | null;
  schemes: SchemeCatalog | null;
  loading: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  /** 테스트·오프라인용 직접 주입 */
  setCatalogs: (issues: IssueCatalog | null, schemes: SchemeCatalog | null) => void;
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  issues: null,
  schemes: null,
  loading: false,
  error: null,

  async load(force = false) {
    const state = get();
    if (state.loading || (!force && state.issues && state.schemes)) return;
    set({ loading: true, error: null });
    const [issues, schemes] = await Promise.allSettled([api.issueCatalog(), api.schemeCatalog()]);
    const errors = [issues, schemes]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason as Error).message);
    set({
      issues: issues.status === 'fulfilled' ? issues.value : state.issues,
      schemes: schemes.status === 'fulfilled' ? schemes.value : state.schemes,
      loading: false,
      error: errors.length > 0 ? t('catalog.loadFailed', { errors: errors.join(' / ') }) : null,
    });
  },

  setCatalogs(issues, schemes) {
    set({ issues, schemes, error: null });
  },
}));

export function activeIssues(catalog: IssueCatalog | null): IssueCatalogItem[] {
  return catalog ? catalog.issues.filter((issue) => !issue.retired) : [];
}

export function findIssue(catalog: IssueCatalog | null, issueId: string | undefined | null): IssueCatalogItem | undefined {
  if (!catalog || !issueId) return undefined;
  return catalog.issues.find((issue) => issue.issueId === issueId);
}

export function findScheme(catalog: SchemeCatalog | null, schemeKey: string | null | undefined): SchemeDefinition | undefined {
  return findSchemeDefinition(catalog, schemeKey);
}
