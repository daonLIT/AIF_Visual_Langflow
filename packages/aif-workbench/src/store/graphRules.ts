/**
 * 그래프 편집이 다른 정보에 미치는 영향 (순수 함수, smoke 테스트 대상).
 *
 * - RA 의 전제·결론 연결 또는 연결 노드 본문이 바뀌면 scheme 을 지우지 않고 '재검토 필요'로 표시한다.
 * - 노드 본문을 고치면 그 노드의 근거 연결도 재검토 대상으로 표시한다(판결문 원문은 바뀌지 않는다).
 * - 한 사건의 확정 그래프에서 세부 쟁점(ISSUE issueRef)은 중복 없이 최대 3개다.
 * - 늦게 도착한 AI 요약은 요청 이후 본문·요약이 바뀐 노드에 반영하지 않는다.
 */
import type { ArgumentCase, ArgumentNode, NodeContent } from '../types/argument';
import { applyNodePatch } from '../types/argument';
import type { Annotation, NodeAnnotation } from '../types/annotation';
import { MAX_SELECTED_ISSUES, markSchemeNeedsReview } from '../types/scheme';
import { textHash } from '../utils/textHash';
import { t } from '../i18n';

const nowIso = () => new Date().toISOString();

/** 노드 타입: 확정 그래프 → 초안 제안 순서로 찾는다. */
function nodeTypeOf(caseData: ArgumentCase, annotations: Annotation[], nodeId: string): string | undefined {
  const node = caseData.nodes.find((item) => item.id === nodeId);
  if (node) return node.type;
  const proposal = annotations.find((item): item is NodeAnnotation => item.kind === 'node' && item.nodeId === nodeId);
  return proposal?.currentValue.type;
}

/** 이 노드와 직접 연결된 RA (확정 관계 + 거절되지 않은 초안 관계) */
export function adjacentRaIds(caseData: ArgumentCase, annotations: Annotation[], nodeId: string): string[] {
  const neighbors = new Set<string>();
  for (const edge of caseData.edges) {
    if (edge.source === nodeId) neighbors.add(edge.target);
    if (edge.target === nodeId) neighbors.add(edge.source);
  }
  for (const annotation of annotations) {
    if (annotation.kind !== 'edge' || annotation.status === 'rejected') continue;
    if (annotation.currentValue.source === nodeId) neighbors.add(annotation.currentValue.target);
    if (annotation.currentValue.target === nodeId) neighbors.add(annotation.currentValue.source);
  }
  return [...neighbors].filter((id) => nodeTypeOf(caseData, annotations, id) === 'RA');
}

/** 관계 양 끝 중 RA 인 노드 */
export function raEndpoints(caseData: ArgumentCase, annotations: Annotation[], source: string, target: string): string[] {
  return [source, target].filter((id) => nodeTypeOf(caseData, annotations, id) === 'RA');
}

/** 지정한 RA 들의 scheme 을 재검토 필요로 표시 (확정 노드와 그 제안 값 모두). scheme 이 없는 RA 는 그대로 둔다. */
export function flagSchemesForReview(
  caseData: ArgumentCase,
  annotations: Annotation[],
  raIds: Iterable<string>,
  reason: string,
): { caseData: ArgumentCase; annotations: Annotation[]; flagged: string[] } {
  const targets = new Set(raIds);
  if (targets.size === 0) return { caseData, annotations, flagged: [] };
  const at = nowIso();
  const flagged = new Set<string>();
  const nodes = caseData.nodes.map((node) => {
    if (!targets.has(node.id) || node.type !== 'RA' || !node.schemeApplication) return node;
    const next = markSchemeNeedsReview(node.schemeApplication, reason, at);
    if (next === node.schemeApplication) return node;
    flagged.add(node.id);
    return { ...node, schemeApplication: next };
  });
  const nextAnnotations = annotations.map((annotation) => {
    if (annotation.kind !== 'node' || annotation.status === 'rejected' || !targets.has(annotation.nodeId)) return annotation;
    const application = annotation.currentValue.schemeApplication;
    if (annotation.currentValue.type !== 'RA' || !application) return annotation;
    const next = markSchemeNeedsReview(application, reason, at);
    if (next === application) return annotation;
    flagged.add(annotation.nodeId);
    return { ...annotation, currentValue: { ...annotation.currentValue, schemeApplication: next }, updatedAt: at };
  });
  if (flagged.size === 0) return { caseData, annotations, flagged: [] };
  return { caseData: { ...caseData, nodes }, annotations: nextAnnotations, flagged: [...flagged] };
}

/** 노드 본문 수정 후 그 노드의 근거를 재검토 대상으로 표시한다. */
export function flagEvidenceForReview(annotations: Annotation[], nodeId: string, reason: string): Annotation[] {
  return annotations.map((annotation) => {
    if (annotation.kind !== 'node' || annotation.nodeId !== nodeId || annotation.evidence.length === 0) return annotation;
    return { ...annotation, evidence: annotation.evidence.map((span) => ({ ...span, reviewReason: reason })) };
  });
}

/** 본문 수정의 파급 효과(연결 RA scheme 재검토, 근거 재검토)를 한 번에 적용 */
export function afterTextEdit(
  caseData: ArgumentCase,
  annotations: Annotation[],
  nodeId: string,
): { caseData: ArgumentCase; annotations: Annotation[] } {
  const withEvidence = flagEvidenceForReview(annotations, nodeId, t('rules.review.textEdited'));
  const flagged = flagSchemesForReview(
    caseData,
    withEvidence,
    adjacentRaIds(caseData, withEvidence, nodeId),
    t('rules.review.neighborTextChanged', { nodeId }),
  );
  return { caseData: flagged.caseData, annotations: flagged.annotations };
}

// ---- 세부 쟁점 최대 3개 ----

export interface IssueOptionState {
  disabled: boolean;
  reason?: string;
}

/** 확정 그래프의 ISSUE 노드별 카탈로그 issueId */
function acceptedIssueIds(nodes: ArgumentNode[], excludeNodeId?: string): string[] {
  return nodes
    .filter((node) => node.type === 'ISSUE' && node.id !== excludeNodeId && node.issueRef?.issueId)
    .map((node) => node.issueRef!.issueId);
}

/** 확정 그래프의 쟁점 선택 제약 위반 목록 */
export function issueSelectionProblems(nodes: ArgumentNode[]): string[] {
  const ids = acceptedIssueIds(nodes);
  const problems: string[] = [];
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) problems.push(t('rules.issue.duplicate', { ids: duplicates.join(', ') }));
  const distinct = new Set(ids).size;
  if (distinct > MAX_SELECTED_ISSUES) problems.push(t('rules.issue.tooMany', { max: MAX_SELECTED_ISSUES, count: distinct }));
  return problems;
}

/**
 * ISSUE 노드에 이 issueId 를 붙일 수 있는지.
 * - 확정 노드: 다른 확정 ISSUE 와 중복 금지, 확정 그래프의 서로 다른 세부 쟁점 ≤ 3.
 * - 초안 노드: 같은 실행의 다른 초안 ISSUE 와 중복 금지, 확정 그래프에 이미 있으면 수락할 수 없어 금지.
 */
export function issueOptionState(
  caseData: ArgumentCase,
  annotations: Annotation[],
  nodeId: string,
  issueId: string,
): IssueOptionState {
  const acceptedNode = caseData.nodes.find((node) => node.id === nodeId);
  const others = acceptedIssueIds(caseData.nodes, nodeId);
  if (others.includes(issueId)) return { disabled: true, reason: t('issue.option.alreadyAccepted') };
  if (acceptedNode) {
    if (new Set([...others, issueId]).size > MAX_SELECTED_ISSUES) {
      return { disabled: true, reason: t('issue.option.max', { max: MAX_SELECTED_ISSUES }) };
    }
    return { disabled: false };
  }
  const draft = annotations.find((item): item is NodeAnnotation => item.kind === 'node' && item.nodeId === nodeId);
  if (draft) {
    const sameRun = annotations.some(
      (item) =>
        item.kind === 'node' &&
        item.runId === draft.runId &&
        item.nodeId !== nodeId &&
        item.status !== 'rejected' &&
        item.currentValue.type === 'ISSUE' &&
        item.currentValue.issueRef?.issueId === issueId,
    );
    if (sameRun) return { disabled: true, reason: t('issue.option.sameRun') };
  }
  return { disabled: false };
}

/** ISSUE 제안을 확정 그래프에 넣으면 제약을 어기는지 (위반 사유, 없으면 null) */
export function issueAcceptProblem(caseData: ArgumentCase, nodeId: string, value: NodeContent & { type: string }): string | null {
  if (value.type !== 'ISSUE' || !value.issueRef?.issueId) return null;
  const others = acceptedIssueIds(caseData.nodes, nodeId);
  if (others.includes(value.issueRef.issueId)) {
    return t('rules.issue.alreadyAccepted', { issueId: value.issueRef.issueId });
  }
  if (new Set([...others, value.issueRef.issueId]).size > MAX_SELECTED_ISSUES) {
    return t('rules.issue.maxAccepted', { max: MAX_SELECTED_ISSUES });
  }
  return null;
}

// ---- 요약 생성 결과 반영 ----

export interface SummaryRequestExpectation {
  nodeId: string;
  /** 요청 시점 본문 해시 */
  textHash: string;
  /** 요청 시점 요약·출처 (그 사이 사람이 고쳤으면 덮어쓰지 않는다) */
  summary: string | null;
  summaryOrigin: string | null;
}

export interface GeneratedSummary {
  nodeId: string;
  summary: string;
  textHash: string;
}

export function expectationFor(nodeId: string, content: NodeContent): SummaryRequestExpectation {
  return { nodeId, textHash: textHash(content.text), summary: content.summary ?? null, summaryOrigin: content.summaryOrigin ?? null };
}

/** 이 AI 요약을 지금 반영해도 되는지. 본문이 바뀌었거나 요청 뒤 요약이 바뀌었으면 거절 사유를 준다. */
export function summaryApplyProblem(current: NodeContent, generated: GeneratedSummary, expected: SummaryRequestExpectation | undefined): string | null {
  if (textHash(current.text) !== generated.textHash) return t('rules.summary.textChanged');
  if (!expected) return t('rules.summary.noRequest');
  if ((current.summary ?? null) !== expected.summary || (current.summaryOrigin ?? null) !== expected.summaryOrigin) {
    return t('rules.summary.summaryChanged');
  }
  return null;
}

/** 확정 노드·초안 제안에 AI 요약을 반영한다. 반영하지 않은 항목은 사유와 함께 돌려준다. */
export function applyGeneratedSummaries(
  caseData: ArgumentCase,
  annotations: Annotation[],
  generated: GeneratedSummary[],
  expectations: SummaryRequestExpectation[],
): { caseData: ArgumentCase; annotations: Annotation[]; applied: string[]; skipped: Array<{ nodeId: string; reason: string }> } {
  const expectedById = new Map(expectations.map((item) => [item.nodeId, item]));
  const applied: string[] = [];
  const skipped: Array<{ nodeId: string; reason: string }> = [];
  let nodes = caseData.nodes;
  let nextAnnotations = annotations;
  const at = nowIso();
  for (const item of generated) {
    const node = nodes.find((candidate) => candidate.id === item.nodeId);
    const proposal = nextAnnotations.find((candidate): candidate is NodeAnnotation => candidate.kind === 'node' && candidate.nodeId === item.nodeId);
    const current: NodeContent | undefined = node ?? proposal?.currentValue;
    if (!current) {
      skipped.push({ nodeId: item.nodeId, reason: t('rules.summary.noNode') });
      continue;
    }
    const problem = summaryApplyProblem(current, item, expectedById.get(item.nodeId));
    if (problem) {
      skipped.push({ nodeId: item.nodeId, reason: problem });
      continue;
    }
    const patch = { summary: item.summary, summaryOrigin: 'ai' as const };
    if (node) nodes = nodes.map((candidate) => (candidate.id === item.nodeId ? applyNodePatch(candidate, patch) : candidate));
    if (proposal && proposal.status !== 'rejected') {
      nextAnnotations = nextAnnotations.map((candidate) =>
        candidate === proposal ? { ...proposal, currentValue: applyNodePatch(proposal.currentValue, patch), updatedAt: at } : candidate,
      );
    }
    applied.push(item.nodeId);
  }
  return { caseData: applied.length > 0 ? { ...caseData, nodes } : caseData, annotations: nextAnnotations, applied, skipped };
}
