/** 앱 내부에서 사용하는 정규화된 논증 그래프 모델. */
import type { IssueRef, IssueRefLink, SchemeApplication } from './scheme';
import { textHash } from '../utils/textHash';

export const NODE_TYPES = ['I', 'RA', 'CA', 'ISSUE'] as const;

export type ArgumentNodeType = (typeof NODE_TYPES)[number];

export type SummaryOrigin = 'ai' | 'human';
export type SummaryStatus = 'current' | 'stale';

/** 노드의 편집 가능한 내용. 확정 노드(ArgumentNode)와 제안 값(NodeValue)이 같은 필드를 쓴다. */
export interface NodeContent {
  text: string;
  /** I / ISSUE 노드의 짧은 요약 (그래프 표시용). text 를 대체하지 않는다. */
  summary?: string;
  summaryOrigin?: SummaryOrigin;
  /** 요약을 만든 뒤 본문이 바뀌었으면 stale */
  summaryStatus?: SummaryStatus;
  /** 요약을 만든 본문의 해시 (utils/textHash) */
  summarySourceHash?: string;
  /** RA 노드의 Walton scheme 적용 정보 */
  schemeApplication?: SchemeApplication;
  /** ISSUE 노드의 쟁점 카탈로그 참조 */
  issueRef?: IssueRef;
  /** I / RA 노드가 속한 선택 쟁점 가지 */
  issueRefs?: IssueRefLink[];
}

export const CONTENT_FIELDS = [
  'summary',
  'summaryOrigin',
  'summaryStatus',
  'summarySourceHash',
  'schemeApplication',
  'issueRef',
  'issueRefs',
] as const;

export interface ArgumentNode extends NodeContent {
  id: string;
  type: ArgumentNodeType;
  x: number;
  y: number;
  visible: boolean;
  /** 원본 AIF 노드(알 수 없는 필드 보존용) */
  raw?: Record<string, unknown>;
  /** 원본 OVA 노드(알 수 없는 필드 보존용) */
  rawOva?: Record<string, unknown>;
}

export interface ArgumentEdge {
  id: number;
  source: string;
  target: string;
  visible: boolean;
  raw?: Record<string, unknown>;
  rawOva?: Record<string, unknown>;
}

export interface ArgumentCase {
  fileName?: string;
  text: string;
  nodes: ArgumentNode[];
  edges: ArgumentEdge[];
  /** import 원본 JSON 전체. export 시 base 로 사용한다. */
  rawMetadata?: Record<string, unknown>;
}

export type ValidationLevel = 'error' | 'warning';

export interface ValidationResult {
  level: ValidationLevel;
  code: string;
  nodeId?: string;
  edgeId?: number;
  message: string;
}

export function isArgumentNodeType(value: unknown): value is ArgumentNodeType {
  return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value);
}

/** 노드 편집으로 바꿀 수 있는 값. undefined 가 아닌 키만 반영하고, null 은 값을 지운다. */
export interface NodeFieldsPatch {
  text?: string;
  /** 요약 설정(기본은 사람이 쓴 요약). null 또는 빈 문자열이면 요약 제거 */
  summary?: string | null;
  /** summary 를 줄 때 출처 (AI 요약 반영 시 'ai') */
  summaryOrigin?: SummaryOrigin;
  schemeApplication?: SchemeApplication | null;
  issueRef?: IssueRef | null;
  issueRefs?: IssueRefLink[] | null;
}

function deleteSummary(target: NodeContent): void {
  delete target.summary;
  delete target.summaryOrigin;
  delete target.summaryStatus;
  delete target.summarySourceHash;
}

/**
 * 편집을 반영한다.
 * - 요약을 새로 주면 현재 본문 해시로 current 가 된다.
 * - 본문만 바꾸면 기존 요약은 지우지 않고, 요약을 만든 본문과 다르면 stale 로 표시한다.
 */
export function applyNodePatch<T extends NodeContent>(target: T, patch: NodeFieldsPatch): T {
  const next = { ...target };
  const previousText = target.text;
  if (patch.text !== undefined) next.text = patch.text;

  if (patch.summary !== undefined) {
    const summary = patch.summary?.trim();
    if (!summary) deleteSummary(next);
    else {
      next.summary = summary;
      next.summaryOrigin = patch.summaryOrigin ?? 'human';
      next.summarySourceHash = textHash(next.text);
      next.summaryStatus = 'current';
    }
  } else if (patch.text !== undefined && patch.text !== previousText && next.summary) {
    const source = next.summarySourceHash ?? textHash(previousText);
    next.summarySourceHash = source;
    next.summaryStatus = source === textHash(next.text) ? 'current' : 'stale';
  }

  for (const key of ['schemeApplication', 'issueRef', 'issueRefs'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** 내용 필드를 그대로 복사한다(출처·상태 메타 포함). 없는 필드는 지운다. */
export function copyNodeContent<T extends NodeContent>(target: T, source: NodeContent): T {
  const next = { ...target, text: source.text };
  for (const key of CONTENT_FIELDS) {
    if (source[key] === undefined) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = source[key];
  }
  return next;
}

/** 현재 본문 기준 요약 상태 (요약이 없으면 null) */
export function summaryStateOf(content: NodeContent): SummaryStatus | null {
  if (!content.summary) return null;
  if (content.summarySourceHash) return content.summarySourceHash === textHash(content.text) ? 'current' : 'stale';
  return content.summaryStatus ?? 'current';
}
