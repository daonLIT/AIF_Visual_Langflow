/**
 * RA 노드의 Walton scheme 적용 정보(schemeApplication)와 쟁점 카탈로그 참조.
 * backend/app/services/aif_adapter.py 의 normalize_scheme_application / issueRef 정규화 결과와 같은 형식이다.
 * 프로젝트 확장 스키마이며 AIF 표준 필드가 아니다.
 */
import { currentLang, pickLocalized, t, type MessageKey } from '../i18n';


export type CriticalQuestionStatus = 'open' | 'satisfied' | 'challenged';
export type SchemeStatus = 'suggested' | 'confirmed' | 'needs_review';
export type SchemeOrigin = 'ai' | 'human';

export const UNCLASSIFIED = 'unclassified';
export const CUSTOM = 'custom';
/** 확정 그래프의 세부 쟁점 수 상한. 몇 개를 고를지는 판결문이 정하고 이 값은 천장일 뿐이다(정답 범위 1~4). */
export const MAX_SELECTED_ISSUES = 3;
/** 카탈로그의 이 group 은 Walton 논증 도식이 아니라 쟁점 그래프의 구조 관계다(쟁점 판단·쟁점 종합). */
export const ISSUE_RELATION_GROUP = '쟁점 구조';

export interface PremiseBinding {
  /** 카탈로그 scheme 의 전제 역할. 역할을 정하지 않은 전제는 null */
  roleId: string | null;
  nodeIds: string[];
}

export interface CriticalQuestionResponse {
  questionId: string;
  status: CriticalQuestionStatus;
  answer: string;
}

export interface SchemeAlternative {
  schemeKey: string;
  rationale: string;
}

/** 사용자 수정·재검토 표시·카탈로그 전환 이력 (직전 상태를 남긴다) */
export interface SchemeHistoryEntry {
  at: string;
  by: 'human' | 'system';
  action: 'edit' | 'confirm' | 'needs_review' | 'catalog_migration';
  /** 이 동작 전의 scheme */
  previousKey: string;
  previousStatus: SchemeStatus;
  previousCustomName?: string | null;
  previousRationale?: string;
  /** catalog_migration: 전환 전 카탈로그 버전과 옮기거나 버린 역할 배정·CQ 응답·대안 후보 */
  previousCatalogVersion?: number | null;
  previousPremiseBindings?: PremiseBinding[];
  previousCriticalQuestionResponses?: CriticalQuestionResponse[];
  previousAlternatives?: SchemeAlternative[];
  detail?: string;
}

export interface SchemeApplication {
  /** 카탈로그 schemeKey 또는 'unclassified' / 'custom' */
  schemeKey: string;
  catalogVersion: number | null;
  status: SchemeStatus;
  origin: SchemeOrigin;
  /** 전제에서 결론을 도출하는 방식에 대한 설명 */
  rationale: string;
  premiseBindings: PremiseBinding[];
  conclusionNodeIds: string[];
  criticalQuestionResponses: CriticalQuestionResponse[];
  /** 사용자가 자유롭게 쓰는 적용 메모 */
  notes: string;
  /** schemeKey 가 custom 일 때의 이름 */
  customSchemeName: string | null;
  alternatives: SchemeAlternative[];
  /** 재검토가 필요한 이유 (연결·본문 변경 등) */
  reviewReasons?: string[];
  /** 서버·AI 결과 검증에서 발견한 문제 (추측으로 채우지 않은 부분) */
  errors?: string[];
  history?: SchemeHistoryEntry[];
}

export interface IssueRef {
  issueId: string;
  categoryId?: string;
  catalogVersion?: number;
  /** 이 사건에서의 쟁점 instance (예: issue-1) */
  instanceId?: string;
  /** 모델이 이 세부 쟁점을 고른 이유 */
  selectionReason?: string;
}

/** I / RA 노드가 어떤 선택 쟁점 가지에 속하는지 */
export interface IssueRefLink {
  issueId: string;
  instanceId: string | null;
}

// ---- 카탈로그 ----
export interface SchemeRole {
  roleId: string;
  label: string;
  /** 영어 화면용 역할 이름 (카탈로그가 주면 쓴다) */
  labelEn?: string;
  template: string;
  templateEn?: string;
}

export interface SchemeDefinition {
  schemeKey: string;
  /** Walton 원문 이름(영어) */
  name: string;
  nameKo: string;
  group: string;
  groupEn?: string;
  description: string;
  descriptionEn?: string;
  premiseRoles: SchemeRole[];
  conclusionRole: SchemeRole;
  criticalQuestions: Array<{ id: string; text: string; textEn?: string }>;
  /** 검증된 외부(AIFdb) scheme ID. 없으면 schemefulfillments 를 만들지 않는다. */
  aifdbSchemeId: number | null;
  /** 형식·비판적 질문의 출처 */
  sourceNote?: string;
  /** source-checked: 공개 자료와 대조함, needs-book-check: 원서 대조 필요 */
  verification?: string;
}

/** 이전 카탈로그 key 한 개의 전환 규칙 (backend/catalog/scheme_catalog_migrations.json) */
export interface SchemeMigrationRule {
  action: 'keep' | 'replace' | 'unclassify';
  /** replace 의 새 key */
  to?: string;
  /** 이전 역할 ID → 새 역할 ID. keep 에서 없으면 같은 ID 를 쓴다 */
  roleMap?: Record<string, string>;
  /** 이전 CQ ID → 새 CQ ID. keep 에서 없으면 같은 ID 를 쓴다 */
  questionMap?: Record<string, string>;
  /** keep 이어도 항상 재검토 필요로 표시 */
  review?: boolean;
  candidates?: SchemeAlternative[];
  note?: string;
}

export interface SchemeCatalogMigration {
  fromVersion: number;
  toVersion: number;
  schemes: Record<string, SchemeMigrationRule>;
}

export interface SchemeCatalog {
  schemeCatalogVersion: number;
  status?: string;
  reviewNote?: string;
  sources?: string[];
  note?: string;
  reservedKeys?: Record<string, string>;
  verificationLabels?: Record<string, string>;
  schemes: SchemeDefinition[];
  /** 서버가 카탈로그와 함께 내보내는 이전 버전 대응표 */
  migrations?: SchemeCatalogMigration[];
}

export interface IssueCatalogItem {
  issueId: string;
  categoryId: string;
  categoryName: string;
  categoryNameEn?: string;
  label: string;
  labelEn?: string;
  criteria: string;
  criteriaEn?: string;
  order: number;
  sourceSheet: string;
  sourceRow: number;
  retired?: boolean;
}

export interface IssueCatalog {
  catalogVersion: number;
  source: { fileName: string; sheet: string; range: string; sha256: string; importedAt: string };
  note?: string;
  categories: Array<{ categoryId: string; name: string; nameEn?: string; order: number; issueIds: string[] }>;
  issues: IssueCatalogItem[];
}

export const CQ_STATUS_KEY: Record<CriticalQuestionStatus, MessageKey> = {
  open: 'cq.status.open',
  satisfied: 'cq.status.satisfied',
  challenged: 'cq.status.challenged',
};

export const SCHEME_STATUS_KEY: Record<SchemeStatus, MessageKey> = {
  suggested: 'scheme.status.suggested',
  confirmed: 'scheme.status.confirmed',
  needs_review: 'scheme.status.needsReview',
};

/** 카탈로그 scheme 이름 (영어 화면에서는 Walton 원문 이름) */
export function schemeName(definition: SchemeDefinition): string {
  return currentLang() === 'en' ? definition.name || definition.nameKo : definition.nameKo || definition.name;
}

export function schemeDescription(definition: SchemeDefinition): string {
  return pickLocalized(currentLang(), definition.description, definition.descriptionEn);
}

export function schemeGroupName(definition: SchemeDefinition): string {
  return pickLocalized(currentLang(), definition.group, definition.groupEn);
}

export function roleLabel(role: SchemeRole): string {
  return pickLocalized(currentLang(), role.label, role.labelEn);
}

export function roleTemplate(role: SchemeRole): string {
  return pickLocalized(currentLang(), role.template, role.templateEn);
}

export function questionText(question: { text: string; textEn?: string }): string {
  return pickLocalized(currentLang(), question.text, question.textEn);
}

export function issueLabel(issue: IssueCatalogItem | null | undefined): string {
  return issue ? pickLocalized(currentLang(), issue.label, issue.labelEn) : '';
}

export function issueCategoryName(issue: IssueCatalogItem | null | undefined): string {
  return issue ? pickLocalized(currentLang(), issue.categoryName, issue.categoryNameEn) : '';
}

export function issueCriteria(issue: IssueCatalogItem | null | undefined): string {
  return issue ? pickLocalized(currentLang(), issue.criteria, issue.criteriaEn) : '';
}

export function emptySchemeApplication(catalogVersion: number | null = null): SchemeApplication {
  return {
    schemeKey: UNCLASSIFIED,
    catalogVersion,
    status: 'suggested',
    origin: 'human',
    rationale: '',
    premiseBindings: [],
    conclusionNodeIds: [],
    criticalQuestionResponses: [],
    notes: '',
    customSchemeName: null,
    alternatives: [],
  };
}

export function findSchemeDefinition(catalog: SchemeCatalog | null, schemeKey: string | null | undefined): SchemeDefinition | undefined {
  if (!catalog || !schemeKey) return undefined;
  return catalog.schemes.find((scheme) => scheme.schemeKey === schemeKey);
}

/** 그래프 RA 배지에 붙일 짧은 이름. scheme 정보가 없으면 null */
export function schemeShortName(application: SchemeApplication | null | undefined, catalog: SchemeCatalog | null): string | null {
  if (!application) return null;
  if (application.schemeKey === UNCLASSIFIED) return t('scheme.unclassified.short');
  if (application.schemeKey === CUSTOM) return application.customSchemeName || t('scheme.custom.short');
  const definition = findSchemeDefinition(catalog, application.schemeKey);
  if (!definition) return application.schemeKey;
  return currentLang() === 'en' ? shortEnglishName(definition.name) : shortKoreanName(definition.nameKo);
}

/** 상세 패널 제목용 전체 이름 */
export function schemeFullName(application: SchemeApplication | null | undefined, catalog: SchemeCatalog | null): string {
  if (!application || application.schemeKey === UNCLASSIFIED) return t('scheme.unclassified.full');
  if (application.schemeKey === CUSTOM) {
    return t('scheme.custom.full', { name: application.customSchemeName || t('scheme.custom.noName') });
  }
  const definition = findSchemeDefinition(catalog, application.schemeKey);
  return definition ? schemeName(definition) : application.schemeKey;
}

/** "증인 진술에 의한 논증" → "증인 진술", "원인에서 결과로의 논증" → "원인에서 결과로" */
export function shortKoreanName(nameKo: string): string {
  if (nameKo.endsWith('에 의한 논증')) return nameKo.slice(0, -'에 의한 논증'.length);
  if (nameKo.endsWith('로의 논증')) return nameKo.slice(0, -'의 논증'.length);
  if (nameKo.endsWith(' 논증')) return nameKo.slice(0, -' 논증'.length);
  return nameKo;
}

/** "Argument from Witness Testimony" → "Witness Testimony" */
export function shortEnglishName(name: string): string {
  const prefixes = ['Argument from an ', 'Argument from a ', 'Argument from ', 'Argument to '];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : []);

/** 가져온 JSON 의 schemeApplication 을 안전한 형식으로 읽는다. 모르는 값은 기본값으로 채우되 참조는 추측하지 않는다. */
export function readSchemeApplication(value: unknown): SchemeApplication | undefined {
  if (!isPlainObject(value)) return undefined;
  const status = str(value.status);
  const result: SchemeApplication = {
    schemeKey: str(value.schemeKey) || UNCLASSIFIED,
    catalogVersion: typeof value.catalogVersion === 'number' ? value.catalogVersion : null,
    status: (['suggested', 'confirmed', 'needs_review'].includes(status) ? status : 'suggested') as SchemeStatus,
    origin: value.origin === 'human' ? 'human' : 'ai',
    rationale: str(value.rationale),
    premiseBindings: (Array.isArray(value.premiseBindings) ? value.premiseBindings : [])
      .filter(isPlainObject)
      .map((item) => ({ roleId: str(item.roleId) || null, nodeIds: strList(item.nodeIds) }))
      .filter((item) => item.nodeIds.length > 0),
    conclusionNodeIds: strList(value.conclusionNodeIds),
    criticalQuestionResponses: (Array.isArray(value.criticalQuestionResponses) ? value.criticalQuestionResponses : [])
      .filter(isPlainObject)
      .filter((item) => !!str(item.questionId))
      .map((item) => ({
        questionId: str(item.questionId),
        status: (['open', 'satisfied', 'challenged'].includes(str(item.status)) ? str(item.status) : 'open') as CriticalQuestionStatus,
        answer: str(item.answer),
      })),
    notes: typeof value.notes === 'string' ? value.notes : '',
    customSchemeName: str(value.customSchemeName) || null,
    alternatives: (Array.isArray(value.alternatives) ? value.alternatives : [])
      .filter(isPlainObject)
      .filter((item) => !!str(item.schemeKey))
      .map((item) => ({ schemeKey: str(item.schemeKey), rationale: str(item.rationale) })),
  };
  const reasons = strList(value.reviewReasons);
  if (reasons.length > 0) result.reviewReasons = reasons;
  const errors = strList(value.errors);
  if (errors.length > 0) result.errors = errors;
  if (Array.isArray(value.history)) {
    const history = value.history.filter(isPlainObject).filter((item) => typeof item.at === 'string') as unknown as SchemeHistoryEntry[];
    if (history.length > 0) result.history = history;
  }
  if (result.schemeKey !== CUSTOM) result.customSchemeName = null;
  return result;
}

/** v10 결과·프로젝트의 `scheme` 필드를 schemeApplication 으로 옮긴다 (backend legacy_scheme_to_application 과 같은 규칙). */
export function legacySchemeToApplication(value: unknown): SchemeApplication | undefined {
  if (!isPlainObject(value)) return undefined;
  const key = str(value.schemeId);
  const bindings = new Map<string | null, string[]>();
  for (const premise of Array.isArray(value.premises) ? value.premises : []) {
    if (!isPlainObject(premise) || typeof premise.nodeId !== 'string') continue;
    const role = str(premise.role) || null;
    bindings.set(role, [...(bindings.get(role) ?? []), premise.nodeId]);
  }
  const conclusion = isPlainObject(value.conclusion) ? value.conclusion : {};
  return readSchemeApplication({
    schemeKey: key === 'other' ? CUSTOM : key || UNCLASSIFIED,
    status: 'suggested',
    origin: value.source === 'human' ? 'human' : 'ai',
    rationale: value.rationale,
    premiseBindings: [...bindings.entries()].map(([roleId, nodeIds]) => ({ roleId, nodeIds })),
    conclusionNodeIds: typeof conclusion.nodeId === 'string' ? [conclusion.nodeId] : [],
    criticalQuestionResponses: (Array.isArray(value.criticalQuestions) ? value.criticalQuestions : [])
      .filter(isPlainObject)
      .map((item) => ({ questionId: item.id, status: item.status, answer: item.answer })),
    notes: '',
    customSchemeName: key === 'other' ? str(value.schemeName) || null : null,
    alternatives: [],
  });
}

export function readIssueRef(value: unknown): IssueRef | undefined {
  if (!isPlainObject(value) || !str(value.issueId)) return undefined;
  return {
    issueId: str(value.issueId),
    ...(typeof value.categoryId === 'string' && value.categoryId ? { categoryId: value.categoryId } : {}),
    ...(typeof value.catalogVersion === 'number' ? { catalogVersion: value.catalogVersion } : {}),
    ...(str(value.instanceId) ? { instanceId: str(value.instanceId) } : {}),
    ...(str(value.selectionReason) ? { selectionReason: str(value.selectionReason) } : {}),
  };
}

export function readIssueRefs(value: unknown): IssueRefLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .filter(isPlainObject)
    .filter((item) => !!str(item.issueId))
    .map((item) => ({ issueId: str(item.issueId), instanceId: str(item.instanceId) || null }));
  return refs.length > 0 ? refs : undefined;
}

/** 순서까지 같은 값인지 (JSON 직렬화 기준) */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 내용 비교용: 검토 상태·재검토 사유·이력은 내용이 아니다. */
export function schemeContent(application: SchemeApplication | undefined): Omit<SchemeApplication, 'status' | 'reviewReasons' | 'history'> | null {
  if (!application) return null;
  const { status: _status, reviewReasons: _reasons, history: _history, ...rest } = application;
  void _status;
  void _reasons;
  void _history;
  return rest;
}

const HISTORY_LIMIT = 30;

function pushHistory(application: SchemeApplication, entry: Omit<SchemeHistoryEntry, 'previousKey' | 'previousStatus' | 'previousCustomName' | 'previousRationale'>): SchemeHistoryEntry[] {
  return [
    ...(application.history ?? []),
    {
      ...entry,
      previousKey: application.schemeKey,
      previousStatus: application.status,
      previousCustomName: application.customSchemeName,
      previousRationale: application.rationale,
    },
  ].slice(-HISTORY_LIMIT);
}

/** RA 연결·연결 노드 본문이 바뀌었을 때: scheme 을 지우지 않고 재검토 필요로 표시한다. */
export function markSchemeNeedsReview(application: SchemeApplication, reason: string, at: string): SchemeApplication {
  if (application.status === 'needs_review' && application.reviewReasons?.includes(reason)) return application;
  return {
    ...application,
    status: 'needs_review',
    reviewReasons: [...(application.reviewReasons ?? []).filter((item) => item !== reason), reason],
    history: pushHistory(application, { at, by: 'system', action: 'needs_review', detail: reason }),
  };
}

export interface SchemeMigrationOutcome {
  application: SchemeApplication;
  /** 카탈로그 버전을 올렸는지 (내용이 같아도 버전만 올린 경우 포함) */
  migrated: boolean;
  needsReview: boolean;
}

/** 같은 역할로 옮겨진 전제를 하나로 합친다 (역할 순서는 처음 나온 순서) */
function mergeBindings(bindings: PremiseBinding[]): PremiseBinding[] {
  const merged = new Map<string | null, string[]>();
  for (const binding of bindings) {
    const nodeIds = merged.get(binding.roleId) ?? [];
    merged.set(binding.roleId, [...nodeIds, ...binding.nodeIds.filter((id) => !nodeIds.includes(id))]);
  }
  return [...merged.entries()].map(([roleId, nodeIds]) => ({ roleId, nodeIds }));
}

/**
 * 이전 카탈로그 버전으로 저장된 schemeApplication 을 카탈로그의 대응표(migrations)로 현재 버전까지 옮긴다.
 * 자동으로 확정하지 않으며, key 를 바꾸거나 옮기지 못한 값이 있으면 재검토 필요로 표시하고 원래 값을 이력에 남긴다.
 * 카탈로그 버전을 모르는(null) 값과 대응표가 없는 버전은 추측하지 않고 그대로 둔다.
 */
export function migrateSchemeApplication(application: SchemeApplication, catalog: SchemeCatalog | null, at: string): SchemeMigrationOutcome {
  let current = application;
  let migrated = false;
  let needsReview = false;
  const reservedKeys: string[] = [UNCLASSIFIED, CUSTOM];
  while (catalog && current.catalogVersion !== null && current.catalogVersion < catalog.schemeCatalogVersion) {
    const migration = catalog.migrations?.find((item) => item.fromVersion === current.catalogVersion);
    if (!migration) break;
    const toCurrent = migration.toVersion === catalog.schemeCatalogVersion;
    const existsInTarget = (key: string) => !toCurrent || !!findSchemeDefinition(catalog, key);
    const reserved = reservedKeys.includes(current.schemeKey);
    // 대응표에 없는 key: 새 카탈로그에 있으면 그대로, 없으면 미분류
    const rule: SchemeMigrationRule = reserved
      ? { action: 'keep' }
      : (migration.schemes[current.schemeKey] ?? {
          action: existsInTarget(current.schemeKey) ? 'keep' : 'unclassify',
          note: t('scheme.migration.unknownKey'),
        });
    const schemeKey = rule.action === 'replace' && rule.to ? rule.to : rule.action === 'unclassify' ? UNCLASSIFIED : current.schemeKey;
    const definition = toCurrent ? findSchemeDefinition(catalog, schemeKey) : undefined;
    const identity = rule.action === 'keep';

    let lostRoles = 0;
    const premiseBindings = mergeBindings(
      current.premiseBindings.map((binding) => {
        if (binding.roleId === null || reserved) return binding;
        const mapped = rule.action === 'unclassify' ? null : (rule.roleMap?.[binding.roleId] ?? (identity && !rule.roleMap ? binding.roleId : null));
        const valid = mapped !== null && (!definition || definition.premiseRoles.some((role) => role.roleId === mapped));
        if (!valid) lostRoles += 1;
        return { roleId: valid ? mapped : null, nodeIds: binding.nodeIds };
      }),
    );

    let droppedQuestions = 0;
    let remappedQuestions = 0;
    const criticalQuestionResponses: CriticalQuestionResponse[] = reserved ? current.criticalQuestionResponses : [];
    for (const response of reserved ? [] : current.criticalQuestionResponses) {
      const mapped = rule.action === 'unclassify' ? undefined : (rule.questionMap?.[response.questionId] ?? (identity && !rule.questionMap ? response.questionId : undefined));
      if (!mapped || (definition && !definition.criticalQuestions.some((question) => question.id === mapped))) {
        droppedQuestions += 1;
        continue;
      }
      if (mapped !== response.questionId) remappedQuestions += 1;
      criticalQuestionResponses.push({ ...response, questionId: mapped });
    }

    // 대안 후보도 같은 규칙으로 옮기고, 새 key 와 같거나 새 카탈로그에 없는 후보는 뺀다.
    const alternatives: SchemeAlternative[] = [];
    const addAlternative = (alternative: SchemeAlternative) => {
      if (alternative.schemeKey === schemeKey || alternatives.some((item) => item.schemeKey === alternative.schemeKey)) return;
      if (!existsInTarget(alternative.schemeKey)) return;
      alternatives.push(alternative);
    };
    for (const alternative of current.alternatives) {
      const altRule = migration.schemes[alternative.schemeKey];
      if (altRule?.action === 'replace' && altRule.to) addAlternative({ ...alternative, schemeKey: altRule.to });
      else if (altRule?.action !== 'unclassify') addAlternative(alternative);
    }
    for (const candidate of rule.candidates ?? []) addAlternative(candidate);

    const keyChanged = schemeKey !== current.schemeKey;
    const review = !reserved && (keyChanged || !!rule.review || lostRoles > 0 || droppedQuestions > 0 || remappedQuestions > 0);
    const next: SchemeApplication = {
      ...current,
      schemeKey,
      catalogVersion: migration.toVersion,
      premiseBindings,
      criticalQuestionResponses,
      alternatives,
    };
    const contentChanged = !sameValue(schemeContent({ ...next, catalogVersion: current.catalogVersion }), schemeContent(current));
    if (review || contentChanged) {
      const parts = [
        keyChanged
          ? t('scheme.migration.keyChanged', {
              from: current.schemeKey,
              to: schemeKey === UNCLASSIFIED ? t('scheme.unclassified.short') : schemeKey,
            })
          : t('scheme.migration.keyKept', { key: current.schemeKey }),
        lostRoles > 0 ? t('scheme.migration.lostRoles', { count: lostRoles }) : '',
        remappedQuestions > 0 ? t('scheme.migration.remappedQuestions', { count: remappedQuestions }) : '',
        droppedQuestions > 0 ? t('scheme.migration.droppedQuestions', { count: droppedQuestions }) : '',
        rule.candidates?.length ? t('scheme.migration.candidates', { count: rule.candidates.length }) : '',
      ].filter(Boolean);
      const detail =
        t('scheme.migration.detail', {
          from: current.catalogVersion,
          to: migration.toVersion,
          parts: parts.join(', '),
        }) + (rule.note ? ` (${rule.note})` : '');
      next.history = [
        ...(current.history ?? []),
        {
          at,
          by: 'system' as const,
          action: 'catalog_migration' as const,
          previousKey: current.schemeKey,
          previousStatus: current.status,
          previousCustomName: current.customSchemeName,
          previousRationale: current.rationale,
          previousCatalogVersion: current.catalogVersion,
          previousPremiseBindings: current.premiseBindings,
          previousCriticalQuestionResponses: current.criticalQuestionResponses,
          previousAlternatives: current.alternatives,
          detail,
        },
      ].slice(-HISTORY_LIMIT);
      if (review) {
        next.status = 'needs_review';
        next.reviewReasons = [...(current.reviewReasons ?? []), detail];
        needsReview = true;
      }
    }
    current = next;
    migrated = true;
  }
  return { application: current, migrated, needsReview };
}

/** 사람이 scheme 을 저장: 사람 수정으로 기록하고 확정한다. 이전 상태는 이력에 남긴다. */
export function humanSchemeEdit(previous: SchemeApplication | undefined, next: SchemeApplication, at: string): SchemeApplication {
  const base = previous ?? next;
  const { reviewReasons: _reasons, ...rest } = next;
  void _reasons;
  return {
    ...rest,
    origin: 'human',
    status: 'confirmed',
    history: previous ? pushHistory(base, { at, by: 'human', action: 'edit' }) : next.history,
  };
}

/** 내용은 그대로 두고 검토 완료(확정)로 표시 */
export function confirmScheme(application: SchemeApplication, at: string): SchemeApplication {
  const { reviewReasons: _reasons, ...rest } = application;
  void _reasons;
  return { ...rest, status: 'confirmed', history: pushHistory(application, { at, by: 'human', action: 'confirm' }) };
}
