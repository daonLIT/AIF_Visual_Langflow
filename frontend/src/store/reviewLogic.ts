/**
 * 검토(수락·수정·거절) 순수 로직. 스토어와 분리해 두어 smoke 테스트에서 바로 검증한다.
 *
 * 규칙 요약
 * - 노드 수락: 확정 그래프에 노드 추가. 텍스트가 원안과 다르면 'modified'.
 * - 엣지 수락: 양 끝 노드가 확정 그래프에 있어야 한다. 없으면 의존 노드 제안을 함께 수락하거나 실패.
 * - 거절: 확정 그래프에 있던 항목은 제거. 노드를 거절하면 그 노드에 붙은 제안 엣지도 거절(연쇄).
 * - 미검토 복귀: 확정 그래프에서 제거하고 pending 으로. 붙어 있던 확정 엣지 제안은 pending 으로 돌아간다.
 */
import type { ArgumentCase, ArgumentEdge, ArgumentNode, NodeFieldsPatch, ValidationResult } from '../types/argument';
import { applyNodePatch, copyNodeContent } from '../types/argument';
import type {
  Annotation,
  EdgeAnnotation,
  EvidenceSpan,
  NodeAnnotation,
  NodeValue,
  ReviewEvent,
  ReviewEventType,
} from '../types/annotation';
import { sameValue, schemeContent } from '../types/scheme';
import { afterTextEdit, issueAcceptProblem } from './graphRules';
import { generateEdgeId } from '../utils/generateEdgeId';
import { validateCase } from '../validation/graphValidator';

export interface ReviewSnapshot {
  caseData: ArgumentCase;
  annotations: Annotation[];
  edgeIdHighWater: number;
}

export interface ReviewOutcome {
  snapshot: ReviewSnapshot;
  events: ReviewEvent[];
  /** 진행은 했지만 사용자에게 알릴 사항 */
  warnings: string[];
  /** 진행하지 못한 이유 */
  error?: string;
}

let eventCounter = 0;
export function makeEvent(type: ReviewEventType, extra: Partial<ReviewEvent> = {}): ReviewEvent {
  eventCounter += 1;
  return {
    id: `${Date.now().toString(36)}-${eventCounter}`,
    at: new Date().toISOString(),
    type,
    ...extra,
  };
}

const at = () => new Date().toISOString();

export function findAnnotation(annotations: Annotation[], id: string): Annotation | undefined {
  return annotations.find((annotation) => annotation.id === id);
}

export function nodeAnnotationOf(annotations: Annotation[], nodeId: string): NodeAnnotation | undefined {
  return annotations.find(
    (annotation): annotation is NodeAnnotation => annotation.kind === 'node' && annotation.nodeId === nodeId,
  );
}

export function isInAcceptedGraph(annotation: Annotation): boolean {
  return annotation.status === 'accepted' || annotation.status === 'modified';
}

function replace(annotations: Annotation[], next: Annotation): Annotation[] {
  return annotations.map((annotation) => (annotation.id === next.id ? next : annotation));
}

const CONTENT_KEYS = ['text', 'summary', 'issueRef', 'issueRefs'] as const;

/**
 * AI 원안과 내용(본문·요약·scheme·쟁점 참조)이 다른지. 좌표·요약 상태·scheme 검토 상태/이력은 내용이 아니다.
 */
export function isContentModified(original: NodeValue, current: NodeValue): boolean {
  return (
    CONTENT_KEYS.some((key) => !sameValue(original[key], current[key])) ||
    !sameValue(schemeContent(original.schemeApplication), schemeContent(current.schemeApplication))
  );
}

/** 확정 상태 annotation 의 accepted/modified 를 현재 값에 맞춘다. */
export function recomputeAcceptedStatus(annotation: Annotation): Annotation {
  if (annotation.kind !== 'node' || !isInAcceptedGraph(annotation) || annotation.origin === 'human') return annotation;
  const status = isContentModified(annotation.originalValue, annotation.currentValue) ? 'modified' : 'accepted';
  return status === annotation.status ? annotation : { ...annotation, status };
}

/** 확정 그래프 노드에 annotation 값(본문·요약 메타·scheme·쟁점 참조)을 그대로 반영한다. */
export function nodeWithValue(node: ArgumentNode, value: NodeValue): ArgumentNode {
  return copyNodeContent(node, value);
}

/** 엣지 제안의 양 끝 노드가 확정 그래프에 있는지, 없으면 어떤 제안을 먼저 수락해야 하는지 */
export interface EdgeDependency {
  ready: boolean;
  /** 확정 그래프에 없는 끝점 노드 ID */
  missingNodeIds: string[];
  /** 함께 수락하면 해결되는 pending 노드 제안 */
  resolvableAnnotationIds: string[];
  /** 제안에도 없고 확정에도 없는 노드(해결 불가) */
  unresolvableNodeIds: string[];
}

export function edgeDependency(snapshot: ReviewSnapshot, annotation: EdgeAnnotation): EdgeDependency {
  const accepted = new Set(snapshot.caseData.nodes.map((node) => node.id));
  const missing = [annotation.currentValue.source, annotation.currentValue.target].filter(
    (id) => !accepted.has(id),
  );
  const resolvable: string[] = [];
  const unresolvable: string[] = [];
  for (const nodeId of missing) {
    const nodeAnnotation = nodeAnnotationOf(snapshot.annotations, nodeId);
    if (nodeAnnotation && nodeAnnotation.status === 'pending') resolvable.push(nodeAnnotation.id);
    else unresolvable.push(nodeId);
  }
  return {
    ready: missing.length === 0,
    missingNodeIds: missing,
    resolvableAnnotationIds: resolvable,
    unresolvableNodeIds: unresolvable,
  };
}

/** 노드 제안을 수락했을 때 함께 완성되는 pending 엣지 제안(다른 끝이 이미 확정) */
export function connectableEdges(snapshot: ReviewSnapshot, nodeId: string): EdgeAnnotation[] {
  const accepted = new Set(snapshot.caseData.nodes.map((node) => node.id));
  accepted.add(nodeId);
  return snapshot.annotations.filter(
    (annotation): annotation is EdgeAnnotation =>
      annotation.kind === 'edge' &&
      annotation.status === 'pending' &&
      (annotation.currentValue.source === nodeId || annotation.currentValue.target === nodeId) &&
      accepted.has(annotation.currentValue.source) &&
      accepted.has(annotation.currentValue.target),
  );
}

function addNodeToGraph(snapshot: ReviewSnapshot, annotation: NodeAnnotation): ReviewSnapshot {
  if (snapshot.caseData.nodes.some((node) => node.id === annotation.nodeId)) return snapshot;
  const value = annotation.currentValue;
  const node: ArgumentNode = nodeWithValue(
    {
      id: annotation.nodeId,
      type: value.type,
      text: value.text,
      x: value.x ?? 0,
      y: value.y ?? 0,
      visible: true,
      raw: { nodeID: annotation.nodeId, text: value.text, type: value.type },
    },
    value,
  );
  return { ...snapshot, caseData: { ...snapshot.caseData, nodes: [...snapshot.caseData.nodes, node] } };
}

function removeNodeFromGraph(snapshot: ReviewSnapshot, nodeId: string): { snapshot: ReviewSnapshot; removedEdgeIds: number[] } {
  const removedEdges = snapshot.caseData.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
  const removedIds = new Set(removedEdges.map((edge) => edge.id));
  return {
    snapshot: {
      ...snapshot,
      caseData: {
        ...snapshot.caseData,
        nodes: snapshot.caseData.nodes.filter((node) => node.id !== nodeId),
        edges: snapshot.caseData.edges.filter((edge) => !removedIds.has(edge.id)),
      },
    },
    removedEdgeIds: [...removedIds],
  };
}

function addEdgeToGraph(snapshot: ReviewSnapshot, annotation: EdgeAnnotation): { snapshot: ReviewSnapshot; edgeId: number } {
  const { source, target } = annotation.currentValue;
  const existing = snapshot.caseData.edges.find((edge) => edge.source === source && edge.target === target);
  if (existing) return { snapshot, edgeId: existing.id };
  const edgeId = generateEdgeId([snapshot.edgeIdHighWater, ...snapshot.caseData.edges.map((edge) => edge.id)]);
  const edge: ArgumentEdge = { id: edgeId, source, target, visible: true };
  return {
    snapshot: {
      ...snapshot,
      caseData: { ...snapshot.caseData, edges: [...snapshot.caseData.edges, edge] },
      edgeIdHighWater: Math.max(snapshot.edgeIdHighWater, edgeId),
    },
    edgeId,
  };
}

/** 확정 엣지 id 가 제거되었을 때 해당 엣지 제안을 pending 으로 되돌린다. */
function revertEdgeAnnotations(annotations: Annotation[], removedEdgeIds: number[], events: ReviewEvent[]): Annotation[] {
  if (removedEdgeIds.length === 0) return annotations;
  const removed = new Set(removedEdgeIds);
  return annotations.map((annotation) => {
    if (
      annotation.kind === 'edge' &&
      annotation.acceptedEdgeId !== undefined &&
      annotation.acceptedEdgeId !== null &&
      removed.has(annotation.acceptedEdgeId)
    ) {
      events.push(makeEvent('reset', { annotationId: annotation.id, detail: '끝점 노드가 확정 그래프에서 빠져 미검토로 되돌림' }));
      return { ...annotation, status: 'pending', acceptedEdgeId: null, updatedAt: at() };
    }
    return annotation;
  });
}

export interface AcceptOptions {
  /** 엣지 수락 시 필요한 pending 노드를 함께 수락 */
  withDependencies?: boolean;
  /** 노드 수락 시 완성되는 pending 엣지를 함께 수락 */
  withConnectableEdges?: boolean;
  /** 수정 후 수락: 이 텍스트로 currentValue 를 바꾼 뒤 수락 */
  text?: string;
  /** 수정 후 수락: 요약·스킴·쟁점 참조까지 바꾼 뒤 수락 */
  patch?: NodeFieldsPatch;
}

export function acceptAnnotation(snapshot: ReviewSnapshot, id: string, options: AcceptOptions = {}): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation) return { snapshot, events: [], warnings: [], error: '제안을 찾을 수 없습니다.' };
  if (annotation.kind === 'node') return acceptNode(snapshot, annotation, options);
  return acceptEdge(snapshot, annotation, options);
}

function acceptNode(snapshot: ReviewSnapshot, annotation: NodeAnnotation, options: AcceptOptions): ReviewOutcome {
  const events: ReviewEvent[] = [];
  const warnings: string[] = [];
  const patch: NodeFieldsPatch = { ...(options.patch ?? {}) };
  if (options.text !== undefined) patch.text = options.text;
  if (patch.text !== undefined) patch.text = patch.text.trim();
  const value = applyNodePatch(annotation.currentValue, patch);
  if (!value.text && (value.type === 'I' || value.type === 'ISSUE')) {
    return { snapshot, events, warnings, error: '빈 텍스트로는 수락할 수 없습니다.' };
  }
  const issueProblem = issueAcceptProblem(snapshot.caseData, annotation.nodeId, value);
  if (issueProblem) return { snapshot, events, warnings, error: issueProblem };
  const textChanged = value.text !== annotation.currentValue.text;
  const modified = annotation.origin !== 'human' && isContentModified(annotation.originalValue, value);
  const next: NodeAnnotation = {
    ...annotation,
    status: modified ? 'modified' : 'accepted',
    currentValue: value,
    updatedAt: at(),
  };
  let result: ReviewSnapshot = { ...snapshot, annotations: replace(snapshot.annotations, next) };
  // 이미 확정에 있으면 내용만 갱신
  if (result.caseData.nodes.some((node) => node.id === next.nodeId)) {
    result = {
      ...result,
      caseData: {
        ...result.caseData,
        nodes: result.caseData.nodes.map((node) => (node.id === next.nodeId ? nodeWithValue(node, value) : node)),
      },
    };
  } else {
    result = addNodeToGraph(result, next);
  }
  events.push(makeEvent(modified ? 'accept-modified' : 'accept', { annotationId: next.id, runId: next.runId }));
  if (textChanged) {
    const effects = afterTextEdit(result.caseData, result.annotations, next.nodeId);
    result = { ...result, caseData: effects.caseData, annotations: effects.annotations.map(recomputeAcceptedStatus) };
  }

  if (options.withConnectableEdges) {
    for (const edge of connectableEdges(result, next.nodeId)) {
      const outcome = acceptEdge(result, edge, {});
      if (!outcome.error) {
        result = outcome.snapshot;
        events.push(...outcome.events);
      }
    }
  }
  return { snapshot: result, events, warnings };
}

function acceptEdge(snapshot: ReviewSnapshot, annotation: EdgeAnnotation, options: AcceptOptions): ReviewOutcome {
  const events: ReviewEvent[] = [];
  const warnings: string[] = [];
  let result = snapshot;
  let dependency = edgeDependency(result, annotation);
  if (!dependency.ready) {
    if (dependency.unresolvableNodeIds.length > 0) {
      return {
        snapshot,
        events,
        warnings,
        error: `끝점 노드가 없어 관계를 수락할 수 없습니다: ${dependency.unresolvableNodeIds.join(', ')}`,
      };
    }
    if (!options.withDependencies) {
      return {
        snapshot,
        events,
        warnings,
        error: `먼저 끝점 노드 제안을 수락해야 합니다 (${dependency.missingNodeIds.length}개 미수락).`,
      };
    }
    for (const nodeAnnotationId of dependency.resolvableAnnotationIds) {
      const nodeAnnotation = findAnnotation(result.annotations, nodeAnnotationId) as NodeAnnotation;
      const outcome = acceptNode(result, nodeAnnotation, {});
      if (outcome.error) return { snapshot, events: [], warnings, error: outcome.error };
      result = outcome.snapshot;
      events.push(...outcome.events);
    }
    dependency = edgeDependency(result, annotation);
    if (!dependency.ready) return { snapshot, events: [], warnings, error: '의존 노드를 수락하지 못했습니다.' };
  }
  const { source, target } = annotation.currentValue;
  if (source === target) return { snapshot, events, warnings, error: '자기 자신을 가리키는 관계입니다.' };
  const added = addEdgeToGraph(result, annotation);
  result = added.snapshot;
  const next: EdgeAnnotation = { ...annotation, status: 'accepted', acceptedEdgeId: added.edgeId, updatedAt: at() };
  result = { ...result, annotations: replace(result.annotations, next) };
  events.push(makeEvent('accept', { annotationId: next.id, runId: next.runId }));
  return { snapshot: result, events, warnings };
}

export function rejectAnnotation(snapshot: ReviewSnapshot, id: string): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation) return { snapshot, events: [], warnings: [], error: '제안을 찾을 수 없습니다.' };
  const events: ReviewEvent[] = [];
  const warnings: string[] = [];
  let result = snapshot;

  if (annotation.kind === 'node') {
    let removedEdgeIds: number[] = [];
    if (isInAcceptedGraph(annotation)) {
      const removed = removeNodeFromGraph(result, annotation.nodeId);
      result = removed.snapshot;
      removedEdgeIds = removed.removedEdgeIds;
    }
    let annotations = revertEdgeAnnotations(result.annotations, removedEdgeIds, events);
    // 연쇄: 이 노드를 끝점으로 하는 pending 엣지 제안은 함께 거절
    annotations = annotations.map((item) => {
      if (
        item.kind === 'edge' &&
        item.status === 'pending' &&
        (item.currentValue.source === annotation.nodeId || item.currentValue.target === annotation.nodeId)
      ) {
        events.push(makeEvent('reject', { annotationId: item.id, runId: item.runId, detail: '끝점 노드 거절에 따른 연쇄 거절' }));
        warnings.push(`관계 제안 ${item.id} 도 함께 거절되었습니다.`);
        return { ...item, status: 'rejected', updatedAt: at() };
      }
      return item;
    });
    const next: NodeAnnotation = { ...annotation, status: 'rejected', updatedAt: at() };
    result = { ...result, annotations: replace(annotations, next) };
  } else {
    if (isInAcceptedGraph(annotation) && annotation.acceptedEdgeId !== undefined && annotation.acceptedEdgeId !== null) {
      const edgeId = annotation.acceptedEdgeId;
      result = {
        ...result,
        caseData: { ...result.caseData, edges: result.caseData.edges.filter((edge) => edge.id !== edgeId) },
      };
    }
    const next: EdgeAnnotation = { ...annotation, status: 'rejected', acceptedEdgeId: null, updatedAt: at() };
    result = { ...result, annotations: replace(result.annotations, next) };
  }
  events.push(makeEvent('reject', { annotationId: annotation.id, runId: annotation.runId }));
  return { snapshot: result, events, warnings };
}

/** 미검토로 되돌리기. 확정 그래프에 있던 항목은 제거된다. */
export function resetAnnotation(snapshot: ReviewSnapshot, id: string): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation) return { snapshot, events: [], warnings: [], error: '제안을 찾을 수 없습니다.' };
  if (annotation.origin === 'human') {
    return { snapshot, events: [], warnings: [], error: '사람이 만든 항목은 미검토 상태가 없습니다. 그래프에서 삭제하세요.' };
  }
  const events: ReviewEvent[] = [];
  let result = snapshot;
  if (annotation.kind === 'node') {
    let removedEdgeIds: number[] = [];
    if (isInAcceptedGraph(annotation)) {
      const removed = removeNodeFromGraph(result, annotation.nodeId);
      result = removed.snapshot;
      removedEdgeIds = removed.removedEdgeIds;
    }
    const annotations = revertEdgeAnnotations(result.annotations, removedEdgeIds, events);
    const next: NodeAnnotation = { ...annotation, status: 'pending', updatedAt: at() };
    result = { ...result, annotations: replace(annotations, next) };
  } else {
    if (annotation.acceptedEdgeId !== undefined && annotation.acceptedEdgeId !== null) {
      const edgeId = annotation.acceptedEdgeId;
      result = {
        ...result,
        caseData: { ...result.caseData, edges: result.caseData.edges.filter((edge) => edge.id !== edgeId) },
      };
    }
    const next: EdgeAnnotation = { ...annotation, status: 'pending', acceptedEdgeId: null, updatedAt: at() };
    result = { ...result, annotations: replace(result.annotations, next) };
  }
  events.push(makeEvent('reset', { annotationId: annotation.id, runId: annotation.runId }));
  return { snapshot: result, events, warnings: [] };
}

/**
 * 노드 제안의 내용(본문·요약·스킴·쟁점 참조) 수정. 미검토 제안은 상태를 유지하고,
 * 확정 상태면 확정 그래프도 갱신하며 원안과 다르면 modified 로 표시한다.
 */
export function setDraftValue(snapshot: ReviewSnapshot, id: string, patch: NodeFieldsPatch): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation || annotation.kind !== 'node') return { snapshot, events: [], warnings: [], error: '노드 제안이 아닙니다.' };
  const value = applyNodePatch(annotation.currentValue, patch);
  if (!value.text.trim() && (value.type === 'I' || value.type === 'ISSUE')) {
    return { snapshot, events: [], warnings: [], error: '본문은 비울 수 없습니다.' };
  }
  const inGraph = isInAcceptedGraph(annotation);
  if (inGraph && patch.issueRef) {
    const issueProblem = issueAcceptProblem(snapshot.caseData, annotation.nodeId, value);
    if (issueProblem) return { snapshot, events: [], warnings: [], error: issueProblem };
  }
  const modified = annotation.origin !== 'human' && isContentModified(annotation.originalValue, value);
  const next: NodeAnnotation = {
    ...annotation,
    status: inGraph ? (modified ? 'modified' : 'accepted') : annotation.status,
    currentValue: value,
    updatedAt: at(),
  };
  let result: ReviewSnapshot = { ...snapshot, annotations: replace(snapshot.annotations, next) };
  if (inGraph) {
    result = {
      ...result,
      caseData: {
        ...result.caseData,
        nodes: result.caseData.nodes.map((node) => (node.id === next.nodeId ? nodeWithValue(node, value) : node)),
      },
    };
  }
  if (patch.text !== undefined && patch.text !== annotation.currentValue.text) {
    const effects = afterTextEdit(result.caseData, result.annotations, annotation.nodeId);
    result = { ...result, caseData: effects.caseData, annotations: effects.annotations.map(recomputeAcceptedStatus) };
  }
  const detail = Object.keys(patch)
    .filter((key) => patch[key as keyof NodeFieldsPatch] !== undefined)
    .join(',');
  return { snapshot: result, events: [makeEvent('edit-draft', { annotationId: id, runId: annotation.runId, detail })], warnings: [] };
}

/** 초안 노드의 텍스트 수정 (setDraftValue 의 텍스트 전용 형태) */
export function setDraftText(snapshot: ReviewSnapshot, id: string, text: string): ReviewOutcome {
  return setDraftValue(snapshot, id, { text });
}

export function setDraftPosition(snapshot: ReviewSnapshot, id: string, x: number, y: number): ReviewSnapshot {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation || annotation.kind !== 'node') return snapshot;
  const next: NodeAnnotation = { ...annotation, currentValue: { ...annotation.currentValue, x, y } };
  return { ...snapshot, annotations: replace(snapshot.annotations, next) };
}

export function linkEvidence(snapshot: ReviewSnapshot, id: string, span: EvidenceSpan): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation) return { snapshot, events: [], warnings: [], error: '제안을 찾을 수 없습니다.' };
  const next: Annotation = { ...annotation, evidence: [...annotation.evidence, span], updatedAt: at() } as Annotation;
  return {
    snapshot: { ...snapshot, annotations: replace(snapshot.annotations, next) },
    events: [makeEvent('evidence-link', { annotationId: id, runId: annotation.runId })],
    warnings: [],
  };
}

export function unlinkEvidence(snapshot: ReviewSnapshot, id: string, index: number): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation) return { snapshot, events: [], warnings: [], error: '제안을 찾을 수 없습니다.' };
  const evidence = annotation.evidence.filter((_, i) => i !== index);
  const next = { ...annotation, evidence, updatedAt: at() } as Annotation;
  return {
    snapshot: { ...snapshot, annotations: replace(snapshot.annotations, next) },
    events: [makeEvent('evidence-unlink', { annotationId: id, runId: annotation.runId })],
    warnings: [],
  };
}

/** 근거 후보 중 하나를 선택해 위치를 확정한다 (ambiguous / stale 해소). */
export function resolveEvidenceCandidate(
  snapshot: ReviewSnapshot,
  id: string,
  index: number,
  candidate: { start: number; end: number },
): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation) return { snapshot, events: [], warnings: [], error: '제안을 찾을 수 없습니다.' };
  const evidence = annotation.evidence.map((span, i) =>
    i === index ? { ...span, start: candidate.start, end: candidate.end, match: 'manual' as const, candidates: [], reviewReason: null } : span,
  );
  const next = { ...annotation, evidence, updatedAt: at() } as Annotation;
  return {
    snapshot: { ...snapshot, annotations: replace(snapshot.annotations, next) },
    events: [makeEvent('evidence-link', { annotationId: id, runId: annotation.runId, detail: '후보 위치 선택' })],
    warnings: [],
  };
}

export interface BulkAcceptPreview {
  pendingNodeIds: string[];
  pendingEdgeIds: string[];
  /** 근거가 확정되지 않은(ambiguous/unmatched/stale/없음) 노드 제안 */
  unverifiedEvidence: string[];
  /** 전체 수락 후 예상되는 구조 검증 결과 */
  validation: { errorCount: number; warningCount: number; results: ValidationResult[] };
  snapshot: ReviewSnapshot;
}

/** 본문 수정으로 붙은 근거 재검토 표시를 확인 완료로 지운다. */
export function clearEvidenceReview(snapshot: ReviewSnapshot, id: string): ReviewOutcome {
  const annotation = findAnnotation(snapshot.annotations, id);
  if (!annotation) return { snapshot, events: [], warnings: [], error: '제안을 찾을 수 없습니다.' };
  const next = { ...annotation, evidence: annotation.evidence.map((span) => ({ ...span, reviewReason: null })), updatedAt: at() } as Annotation;
  return {
    snapshot: { ...snapshot, annotations: replace(snapshot.annotations, next) },
    events: [makeEvent('evidence-link', { annotationId: id, runId: annotation.runId, detail: '근거 재검토 확인' })],
    warnings: [],
  };
}

export function hasVerifiedEvidence(annotation: Annotation): boolean {
  return annotation.evidence.some(
    (span) => span.start !== null && (span.match === 'exact' || span.match === 'normalized' || span.match === 'manual'),
  );
}

/** 전체 수락을 미리 계산한다. 실제 반영은 반환된 snapshot 을 커밋해서 한다. */
export function previewBulkAccept(snapshot: ReviewSnapshot, runId: string | null): BulkAcceptPreview {
  const pending = snapshot.annotations.filter(
    (annotation) => annotation.status === 'pending' && (runId === null || annotation.runId === runId),
  );
  const nodes = pending.filter((a): a is NodeAnnotation => a.kind === 'node');
  const edges = pending.filter((a): a is EdgeAnnotation => a.kind === 'edge');
  let result = snapshot;
  for (const node of nodes) {
    const outcome = acceptNode(result, node, {});
    if (!outcome.error) result = outcome.snapshot;
  }
  for (const edge of edges) {
    const outcome = acceptEdge(result, edge, {});
    if (!outcome.error) result = outcome.snapshot;
  }
  const validation = validateCase(result.caseData);
  return {
    pendingNodeIds: nodes.map((node) => node.id),
    pendingEdgeIds: edges.map((edge) => edge.id),
    unverifiedEvidence: nodes
      .filter((node) => node.origin === 'ai' && !hasVerifiedEvidence(node))
      .map((node) => node.id),
    validation: { errorCount: validation.errorCount, warningCount: validation.warningCount, results: validation.results },
    snapshot: result,
  };
}

/** 노드 제안 수락 뒤 예상되는 구조 경고(RA 에 전제/결론이 없는 등) */
export function structuralWarningsFor(snapshot: ReviewSnapshot, nodeId: string): ValidationResult[] {
  const validation = validateCase(snapshot.caseData);
  return validation.results.filter((result) => result.nodeId === nodeId);
}

/** 새 실행 제안을 기존 검토 데이터에 추가한다. 사람 편집은 그대로 둔다. */
export function importProposals(
  snapshot: ReviewSnapshot,
  proposals: Annotation[],
): { snapshot: ReviewSnapshot; duplicates: Map<string, string>; error?: string } {
  const existingIds = new Set(snapshot.annotations.map((a) => a.id));
  const existingNodeIds = new Set([
    ...snapshot.caseData.nodes.map((node) => node.id),
    ...snapshot.annotations.filter((a): a is NodeAnnotation => a.kind === 'node').map((a) => a.nodeId),
  ]);
  for (const proposal of proposals) {
    if (existingIds.has(proposal.id)) return { snapshot, duplicates: new Map(), error: `이미 불러온 제안입니다: ${proposal.id}` };
    if (proposal.kind === 'node' && existingNodeIds.has(proposal.nodeId)) {
      return { snapshot, duplicates: new Map(), error: `노드 ID 충돌: ${proposal.nodeId}` };
    }
  }
  // 명시적 비교: 확정 그래프에 같은 문장의 노드가 있으면 표시한다.
  const byText = new Map<string, string>();
  for (const node of snapshot.caseData.nodes) {
    if (node.type === 'I' || node.type === 'ISSUE') byText.set(`${node.type} ${node.text.trim()}`, node.id);
  }
  const duplicates = new Map<string, string>();
  const stamped = proposals.map((proposal) => {
    if (proposal.kind === 'node') {
      const match = byText.get(`${proposal.currentValue.type} ${proposal.currentValue.text.trim()}`);
      if (match) duplicates.set(proposal.id, match);
    }
    return proposal;
  });
  return { snapshot: { ...snapshot, annotations: [...snapshot.annotations, ...stamped] }, duplicates };
}
