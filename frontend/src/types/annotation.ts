/**
 * AI 제안 검토(annotation) 데이터 계약. backend/app/schemas/models.py 와 맞춰야 한다.
 *
 * - 근거 범위 [start, end) 는 UTF-16 code unit 기준(JS 문자열 인덱스와 동일).
 * - 확정 그래프(caseData)는 accepted/modified 항목만 포함한다. pending/rejected 는 초안 레이어에만 있다.
 */
import type { ArgumentNodeType, NodeContent } from './argument';
import { summaryStateOf } from './argument';
import type { RawCaseJson } from './rawJson';
import { legacySchemeToApplication, migrateSchemeApplication, type SchemeCatalog } from './scheme';
import { textHash } from '../utils/textHash';

/**
 * v2: 노드 값에 summary(+출처·상태·본문 해시) / schemeApplication / issueRef·issueRefs 가 선택적으로 추가됨.
 * v1 파일과 v10 시절의 `scheme` 필드는 불러올 때 v2 형식으로 올린다.
 */
export const PROJECT_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_PROJECT_SCHEMA_VERSIONS = [1, 2] as const;

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
  /** 노드 본문을 고친 뒤 이 근거가 여전히 맞는지 다시 봐야 할 때의 사유 */
  reviewReason?: string | null;
}

export interface NodeValue extends NodeContent {
  type: ArgumentNodeType;
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

export interface IssueSelectionItem {
  issueId: string;
  instanceId?: string | null;
  label: string | null;
  categoryName: string | null;
  selectionReason?: string | null;
  nodeId: string;
  /** 판결문 원문에서 이 선택의 근거 인용을 찾았는지 */
  evidenceStatus: 'found' | 'not_found';
  branchStatus?: string | null;
  branchError?: string | null;
}

/** 52개 세부 쟁점 중 최대 3개 자동 선택 결과 */
export interface IssueSelectionReport {
  status: 'ok' | 'no_issues' | null;
  selected: IssueSelectionItem[];
  /** 0개 선택 시 사유 */
  reason?: string;
  attempts?: number | null;
  model?: string | null;
}

export interface RunSummary {
  nodeCount: number;
  edgeCount: number;
  issueCount: number;
  evidenceCounts: Record<string, number>;
  schemeCounts?: { classified: number; unclassified: number; custom: number; missing: number; withErrors: number };
  summaryCounts?: { withSummary: number; withoutSummary: number; stale: number };
  issueSelection?: IssueSelectionReport | null;
  validation?: { ok: boolean; errors: string[]; warnings: string[] } | null;
  pipeline?: string | null;
}

export interface CatalogVersions {
  issueCatalogVersion: number | null;
  issueCatalogSha256?: string | null;
  /** 원본 엑셀 파일 sha256 (프로젝트 저장 시점) */
  issueCatalogSourceSha256?: string | null;
  schemeCatalogVersion: number | null;
  schemeCatalogSha256?: string | null;
}

/** 실행에 고정된 flow 버전 (backend PipelineService.pin_run_flow) */
export interface RunPipelinePin {
  flowId: string | null;
  flowName?: string | null;
  flowUpdatedAt?: string | null;
  flowHash?: string | null;
  pipelineVersion?: string | null;
  models?: Array<Record<string, unknown>>;
  relay?: { inputComponentId: string | null; outputComponentId: string | null; notes?: string[] };
  /** 실제로 실행한 flow (live 에서는 해시별 실행용 스냅샷) */
  runFlowId?: string | null;
  snapshot?: boolean;
  mock?: boolean;
  note?: string;
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
  constraints?: { maxSelectedIssues?: number; cancelStopsComputation?: boolean; [key: string]: unknown };
  /** 실행에 쓴 쟁점·scheme 카탈로그 버전 */
  catalogs?: CatalogVersions | null;
  /** 실행에 고정된 flow 버전·모델 설정 */
  pipeline?: RunPipelinePin | null;
  /** graph: 제안 그래프 생성, no_issues: 근거 있는 세부 쟁점이 없어 그래프를 만들지 않음 */
  outcome?: 'graph' | 'no_issues' | null;
  purpose?: 'analysis' | 'pipeline-test' | string;
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
  | 'bulk-accept'
  | 'edit-node'
  | 'summary-generated'
  | 'scheme-review';

export interface ReviewEvent {
  id: string;
  at: string;
  type: ReviewEventType;
  annotationId?: string;
  runId?: string;
  detail?: string;
}

export interface AnalysisSettings {
  [key: string]: unknown;
}

export interface ProjectFile {
  schemaVersion: (typeof SUPPORTED_PROJECT_SCHEMA_VERSIONS)[number];
  projectId: string;
  revision: number;
  title?: string | null;
  document: { id: string; text: string; hash: string; version: number; caseId?: string | null };
  acceptedGraph: RawCaseJson;
  analysisRuns: AnalysisRunRecord[];
  annotations: Annotation[];
  reviewEvents: ReviewEvent[];
  analysisSettings?: AnalysisSettings | null;
  /** 저장 시점의 카탈로그 버전 */
  catalogs?: CatalogVersions | null;
  savedAt?: string | null;
}

export interface ProjectMigrationOptions {
  /** 있으면 이전 카탈로그 버전의 scheme 을 대응표로 옮긴다 */
  schemeCatalog?: SchemeCatalog | null;
  /** 전환 이력에 남길 시각 */
  migratedAt?: string;
}

/**
 * 이전 형식의 노드 값을 현재 형식으로: `scheme` → schemeApplication, 이전 카탈로그 scheme → 현재 카탈로그,
 * 해시 없는 요약에 본문 해시 기록
 */
export function migrateNodeValue(value: NodeValue, options: ProjectMigrationOptions = {}): NodeValue {
  const raw = value as NodeValue & { scheme?: unknown };
  let next: NodeValue = value;
  if (raw.scheme !== undefined) {
    const { scheme, ...rest } = raw;
    next = rest;
    if (!rest.schemeApplication && rest.type === 'RA') {
      const application = legacySchemeToApplication(scheme);
      if (application) next = { ...next, schemeApplication: application };
    }
  }
  if (next.schemeApplication && options.schemeCatalog) {
    const outcome = migrateSchemeApplication(next.schemeApplication, options.schemeCatalog, options.migratedAt ?? new Date().toISOString());
    if (outcome.migrated) next = { ...next, schemeApplication: outcome.application };
  }
  if (next.summary && !next.summarySourceHash) {
    next = { ...next, summaryOrigin: next.summaryOrigin ?? 'ai', summarySourceHash: textHash(next.text), summaryStatus: 'current' };
  } else if (next.summary) {
    const state = summaryStateOf(next);
    if (state && state !== next.summaryStatus) next = { ...next, summaryStatus: state };
  }
  return next;
}

/** 이전 버전 프로젝트 파일을 현재 형식으로 올린다. 지원하지 않는 버전이면 오류. */
export function migrateProjectFile(project: ProjectFile, options: ProjectMigrationOptions = {}): ProjectFile {
  const version = (project as { schemaVersion?: unknown }).schemaVersion;
  if (version !== PROJECT_SCHEMA_VERSION && version !== 1) {
    throw new Error(`지원하지 않는 프로젝트 schemaVersion: ${String(version)}`);
  }
  // v1 → v2 는 새 필드가 모두 선택 사항이다. v2 파일도 v10 시절 scheme 필드가 있을 수 있어 노드 값을 정리한다.
  const annotations = project.annotations.map((annotation) =>
    annotation.kind === 'node'
      ? {
          ...annotation,
          // AI 원안과 현재 값을 같은 규칙으로 옮겨 내용 비교(수락/수정 수락 판정)가 바뀌지 않게 한다.
          originalValue: migrateNodeValue(annotation.originalValue, options),
          currentValue: migrateNodeValue(annotation.currentValue, options),
        }
      : annotation,
  );
  const settings = { ...(project.analysisSettings ?? {}) };
  delete settings.issueScope; // 사용자 사전 선택 범위는 더 이상 쓰지 않는다(쟁점은 flow 가 자동 선택).
  return {
    ...project,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    annotations,
    analysisSettings: Object.keys(settings).length > 0 ? settings : null,
    catalogs: project.catalogs ?? null,
  };
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
