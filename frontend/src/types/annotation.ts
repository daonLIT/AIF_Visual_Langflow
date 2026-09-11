/**
 * AI 제안 검토(annotation) 데이터 계약. backend/app/schemas/models.py 와 맞춰야 한다.
 *
 * - 근거 범위 [start, end) 는 UTF-16 code unit 기준(JS 문자열 인덱스와 동일).
 * - 확정 그래프(caseData)는 accepted/modified 항목만 포함한다. pending/rejected 는 초안 레이어에만 있다.
 */
import type { ArgumentNodeType } from './argument';
import type { RawCaseJson } from './rawJson';

export const PROJECT_SCHEMA_VERSION = 1 as const;

export type AnnotationOrigin = 'ai' | 'rule' | 'human';
export type AnnotationStatus = 'pending' | 'accepted' | 'modified' | 'rejected';
export type AnnotationKind = 'node' | 'edge';
export type EvidenceMatchState =
  | 'exact'
  | 'normalized'
  | 'ambiguous'
  | 'unmatched'
  | 'manual'
  | 'stale';

export interface EvidenceCandidate {
  start: number;
  end: number;
}

export interface EvidenceSpan {
  quote: string;
  start: number | null;
  end: number | null;
  match: EvidenceMatchState;
  documentVersion: number;
  candidates?: EvidenceCandidate[];
  /** 인용문이 아니라 노드 문장으로 서버가 매칭을 시도한 경우 */
  derived?: boolean;
}

export interface NodeValue {
  type: ArgumentNodeType;
  text: string;
  x?: number;
  y?: number;
}

export interface EdgeValue {
  source: string;
  target: string;
  /** Langflow 결과의 원래 edgeID (참고용) */
  proposedEdgeId?: number;
}

interface AnnotationBase {
  id: string;
  runId: string;
  origin: AnnotationOrigin;
  status: AnnotationStatus;
  evidence: EvidenceSpan[];
  createdAt: string;
  updatedAt: string;
  note?: string | null;
}

export interface NodeAnnotation extends AnnotationBase {
  kind: 'node';
  nodeId: string;
  originalValue: NodeValue;
  currentValue: NodeValue;
}

export interface EdgeAnnotation extends AnnotationBase {
  kind: 'edge';
  /** `${runId}:${proposedEdgeId}` 형태의 안정적인 키 */
  edgeId: string;
  originalValue: EdgeValue;
  currentValue: EdgeValue;
  /** 확정 그래프에 들어갔을 때 부여된 실제 edge id */
  acceptedEdgeId?: number | null;
}

export type Annotation = NodeAnnotation | EdgeAnnotation;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface RunError {
  code: string;
  message: string;
  details: string[];
}

export interface RunSummary {
  nodeCount: number;
  edgeCount: number;
  issueCount: number;
  evidenceCounts: Record<string, number>;
}

/** 서버 실행 기록 중 클라이언트가 보존하는 부분 */
export interface AnalysisRunRecord {
  runId: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  documentId: string;
  documentVersion: number;
  documentHash: string;
  namespace: string;
  mode: 'live' | 'mock' | string;
  flowId?: string | null;
  error?: RunError | null;
  summary?: RunSummary | null;
  warnings?: string[];
  constraints?: { issueCount?: number; cancelStopsComputation?: boolean };
  /** 결과 도착 시점에 원문이 바뀌어 있어 자동 반영하지 않은 실행 */
  stale?: boolean;
  /** 제안이 annotation 으로 들어갔는지 */
  imported?: boolean;
}

export interface DocumentMeta {
  id: string;
  version: number;
  hash: string;
  caseId?: string | null;
}

export type ReviewEventType =
  | 'run-imported'
  | 'accept'
  | 'accept-modified'
  | 'reject'
  | 'reset'
  | 'edit-draft'
  | 'evidence-link'
  | 'evidence-unlink'
  | 'human-node'
  | 'graph-delete'
  | 'document-changed'
  | 'bulk-accept';

export interface ReviewEvent {
  id: string;
  at: string;
  type: ReviewEventType;
  annotationId?: string;
  runId?: string;
  detail?: string;
}

export interface ProjectFile {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  projectId: string;
  revision: number;
  title?: string | null;
  document: { id: string; text: string; hash: string; version: number; caseId?: string | null };
  acceptedGraph: RawCaseJson;
  analysisRuns: AnalysisRunRecord[];
  annotations: Annotation[];
  reviewEvents: ReviewEvent[];
  savedAt?: string | null;
}

export function isNodeAnnotation(annotation: Annotation): annotation is NodeAnnotation {
  return annotation.kind === 'node';
}

export function isEdgeAnnotation(annotation: Annotation): annotation is EdgeAnnotation {
  return annotation.kind === 'edge';
}

export const STATUS_LABEL: Record<AnnotationStatus, string> = {
  pending: '미검토',
  accepted: '수락',
  modified: '수정 수락',
  rejected: '거절',
};

export const ORIGIN_LABEL: Record<AnnotationOrigin, string> = {
  ai: 'AI',
  rule: '규칙',
  human: '사람',
};

export const MATCH_LABEL: Record<EvidenceMatchState, string> = {
  exact: '원문 일치',
  normalized: '공백 차이 일치',
  ambiguous: '위치 불명확',
  unmatched: '원문에 없음',
  manual: '수동 지정',
  stale: '재검토 필요',
};
