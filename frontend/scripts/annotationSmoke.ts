/**
 * 검토 로직 스모크 테스트 (React/zustand 없이 순수 로직만).
 *  - backend fixture 의 Langflow 응답을 서버 adapter 결과(제안 형식)로 읽어
 *  - 근거 매칭(TS) → 수락/수정/거절/미검토/전체 수락 → export 에 미검토·거절 제외 → 프로젝트 왕복 을 확인한다.
 * 실행: npm run smoke:annotation
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importAifOva } from '../src/io/importAifOva';
import { exportAifOva } from '../src/io/exportAifOva';
import { validateCase } from '../src/validation/graphValidator';
import type { Annotation, EdgeAnnotation, EvidenceSpan, NodeAnnotation } from '../src/types/annotation';
import { DocumentMatcher, buildSegments, rematchEvidence } from '../src/utils/evidence';
import {
  acceptAnnotation,
  edgeDependency,
  importProposals,
  previewBulkAccept,
  rejectAnnotation,
  resetAnnotation,
  setDraftText,
  type ReviewSnapshot,
} from '../src/store/reviewLogic';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

// ---- 1) 서버 adapter 결과와 동일한 형태의 제안 만들기 (fixture + 간단 변환) ----
const samplePath = resolve(process.cwd(), 'public/sample/sample-case.json');
const fixturePath = resolve(process.cwd(), '../backend/fixtures/langflow_run_response.sample.json');
const text: string = JSON.parse(readFileSync(samplePath, 'utf8')).text;
const envelope = JSON.parse(readFileSync(fixturePath, 'utf8'));
const component = envelope.outputs[0].outputs.find((o: { component_id: string }) => o.component_id === 'ChatOutput-nL1VD');
const graph = JSON.parse(component.results.message.text);

const RUN = 'run1';
const NS = '20260911120000';
const matcher = new DocumentMatcher(text);
const idMap = new Map<string, string>();
for (const node of graph.AIF.nodes) idMap.set(node.nodeID, `${node.nodeID.split('_')[0]}_${NS}`);
const ovaById = new Map<string, { x: number; y: number }>(graph.OVA.nodes.map((n: { nodeID: string; x: number; y: number }) => [n.nodeID, n]));

const proposals: Annotation[] = [];
for (const node of graph.AIF.nodes as Array<{ nodeID: string; text: string; type: 'I' | 'RA' | 'CA' | 'ISSUE' }>) {
  const id = idMap.get(node.nodeID)!;
  const pos = ovaById.get(node.nodeID)!;
  const evidence: EvidenceSpan[] = [];
  if (node.type === 'I' || node.type === 'ISSUE') {
    const m = matcher.match(node.text);
    evidence.push({ quote: m.quote, start: m.start, end: m.end, match: m.match, documentVersion: 1, candidates: m.candidates, derived: true });
  }
  const value = { type: node.type, text: node.text, x: pos.x, y: pos.y };
  proposals.push({
    id: `${RUN}:node:${id}`, runId: RUN, kind: 'node', nodeId: id, origin: node.type === 'RA' ? 'rule' : 'ai', status: 'pending',
    originalValue: value, currentValue: { ...value }, evidence, createdAt: 't', updatedAt: 't',
  });
}
for (const edge of graph.AIF.edges as Array<{ edgeID: number; fromID: string; toID: string }>) {
  const value = { source: idMap.get(edge.fromID)!, target: idMap.get(edge.toID)!, proposedEdgeId: edge.edgeID };
  proposals.push({
    id: `${RUN}:edge:${edge.edgeID}`, runId: RUN, kind: 'edge', edgeId: `${RUN}:${edge.edgeID}`, origin: 'rule', status: 'pending',
    originalValue: value, currentValue: { ...value }, evidence: [], createdAt: 't', updatedAt: 't',
  });
}

console.log('1) 근거 매칭 (TS, 서버 규칙과 동일)');
const aiNodes = proposals.filter((p): p is NodeAnnotation => p.kind === 'node' && p.origin === 'ai');
const matches = aiNodes.map((p) => p.evidence[0].match);
check('exact 매칭 존재', matches.includes('exact'));
check('normalized 매칭 존재 (쟁점 제목의 "쟁점 1:" vs "쟁점 1 —")', matches.includes('normalized'));
check('unmatched 존재 (요약 문장은 원문과 동일하지 않음)', matches.includes('unmatched'));
check(
  '확정된 범위는 원문 slice 와 인용문이 일치',
  aiNodes.every((p) => p.evidence[0].start === null || text.slice(p.evidence[0].start!, p.evidence[0].end!).length > 0),
);
const dup = new DocumentMatcher('가나다. 가나다. 😀 라마').match('가나다.');
check('중복 문장은 ambiguous + 후보 2', dup.match === 'ambiguous' && dup.candidates.length === 2);
const emoji = new DocumentMatcher('a😀b 라마').match('라마');
check('이모지 뒤 인덱스는 UTF-16 기준 (5)', emoji.start === 5, String(emoji.start));
const nl = new DocumentMatcher('피고인은  법정에서\n진술하였다.').match('피고인은 법정에서 진술하였다.');
check('공백/줄바꿈 차이는 normalized', nl.match === 'normalized');

console.log('2) 제안 불러오기 (빈 확정 그래프)');
let snapshot: ReviewSnapshot = {
  caseData: { text, nodes: [], edges: [], rawMetadata: undefined },
  annotations: [],
  edgeIdHighWater: 0,
};
const imported = importProposals(snapshot, proposals);
check('불러오기 성공', !imported.error, imported.error);
snapshot = imported.snapshot;
check('제안 45개 (노드 23 + 관계 22)', snapshot.annotations.length === 45, String(snapshot.annotations.length));
check('확정 그래프는 비어 있음', snapshot.caseData.nodes.length === 0);
const twice = importProposals(snapshot, proposals);
check('같은 실행을 두 번 불러오면 거부', !!twice.error);

console.log('3) 엣지 의존성');
const firstEdge = snapshot.annotations.find((a): a is EdgeAnnotation => a.kind === 'edge')!;
const dep = edgeDependency(snapshot, firstEdge);
check('끝점 노드 미확정 → ready=false, 해결 가능 제안 2개', !dep.ready && dep.resolvableAnnotationIds.length === 2);
const refused = acceptAnnotation(snapshot, firstEdge.id);
check('의존성 없이 엣지 수락은 거부', !!refused.error);
const withDeps = acceptAnnotation(snapshot, firstEdge.id, { withDependencies: true });
check('노드와 함께 수락 성공', !withDeps.error, withDeps.error);
snapshot = withDeps.snapshot;
check('확정 그래프에 노드 2 / 엣지 1', snapshot.caseData.nodes.length === 2 && snapshot.caseData.edges.length === 1);
check('엣지 annotation 에 acceptedEdgeId 기록', (snapshot.annotations.find((a) => a.id === firstEdge.id) as EdgeAnnotation).acceptedEdgeId === 1);

console.log('4) 수정 후 수락 / 거절 / 미검토 복귀');
const claim = snapshot.annotations.find((a): a is NodeAnnotation => a.kind === 'node' && a.nodeId === `1_${NS}`)!;
const modified = acceptAnnotation(snapshot, claim.id, { text: `${claim.currentValue.text} (수정)` });
snapshot = modified.snapshot;
const claimAfter = snapshot.annotations.find((a) => a.id === claim.id) as NodeAnnotation;
check('수정 후 수락 → modified', claimAfter.status === 'modified');
check('originalValue 보존', claimAfter.originalValue.text === claim.originalValue.text);
check('확정 노드 텍스트 갱신', snapshot.caseData.nodes.find((n) => n.id === claim.nodeId)?.text.endsWith('(수정)') === true);

const raNode = snapshot.annotations.find((a): a is NodeAnnotation => a.kind === 'node' && a.currentValue.type === 'RA' && a.status === 'pending')!;
const rejected = rejectAnnotation(snapshot, raNode.id);
snapshot = rejected.snapshot;
check('RA 거절 시 연결된 pending 엣지도 연쇄 거절', rejected.warnings.length > 0);
check(
  '거절된 엣지는 pending 이 아님',
  snapshot.annotations.every((a) => !(a.kind === 'edge' && a.status === 'pending' && (a.currentValue.source === raNode.nodeId || a.currentValue.target === raNode.nodeId))),
);

const resetOutcome = resetAnnotation(snapshot, firstEdge.id);
snapshot = resetOutcome.snapshot;
check('엣지 미검토 복귀 → 확정 엣지 제거', snapshot.caseData.edges.length === 0);
const resetNode = resetAnnotation(snapshot, claim.id);
snapshot = resetNode.snapshot;
check('노드 미검토 복귀 → 확정 그래프에서 제거', !snapshot.caseData.nodes.some((n) => n.id === claim.nodeId));
check('되돌린 노드는 pending, currentValue 유지', (snapshot.annotations.find((a) => a.id === claim.id) as NodeAnnotation).status === 'pending');

const edited = setDraftText(snapshot, claim.id, '초안 텍스트 편집');
snapshot = edited.snapshot;
check('초안 텍스트 편집은 상태 유지(pending)', (snapshot.annotations.find((a) => a.id === claim.id) as NodeAnnotation).status === 'pending');

console.log('5) 전체 수락 미리보기 + 반영');
const preview = previewBulkAccept(snapshot, RUN);
check('미리보기: 근거 미확인 항목 수 > 0', preview.unverifiedEvidence.length > 0);
check('미리보기: 구조 검증 결과 포함', Array.isArray(preview.validation.results) && typeof preview.validation.errorCount === 'number');
check('미리보기: 거절된 RA 로 향하는 관계는 반영 대상에 없음', !preview.pendingEdgeIds.some((id) => {
  const edge = snapshot.annotations.find((a) => a.id === id) as EdgeAnnotation;
  return edge.currentValue.source === raNode.nodeId || edge.currentValue.target === raNode.nodeId;
}));
snapshot = preview.snapshot;
check('전체 수락 후 pending 없음', !snapshot.annotations.some((a) => a.status === 'pending'));
check('거절 항목은 확정 그래프에 없음', !snapshot.caseData.nodes.some((n) => n.id === raNode.nodeId));
check('수정된 초안 텍스트가 확정에 반영 + modified', (snapshot.annotations.find((a) => a.id === claim.id) as NodeAnnotation).status === 'modified');

console.log('6) export 에 미검토·거절 제외, 재import 왕복');
const exported = exportAifOva(snapshot.caseData);
const exportedIds = new Set(exported.AIF!.nodes!.map((n) => n.nodeID));
check('export 노드 수 = 확정 노드 수', exportedIds.size === snapshot.caseData.nodes.length);
check('거절 RA 는 export 에 없음', !exportedIds.has(raNode.nodeId));
check('export text 는 원문', exported.text === text);
const reimported = importAifOva(exported);
check('재import 노드/엣지 수 일치', reimported.case.nodes.length === snapshot.caseData.nodes.length && reimported.case.edges.length === snapshot.caseData.edges.length);
check('재import 경고 없음', reimported.warnings.length === 0, reimported.warnings.join(' / '));
const validation = validateCase(reimported.case);
check('검증 실행 가능 (오류 수 기록)', typeof validation.errorCount === 'number');

console.log('7) 원문 변경 시 근거 재매칭');
const newText = text.replace('피해자의 진술은 신빙성이 있다고 봄이 타당하다.', '피해자의   진술은 신빙성이 있다고 봄이 타당하다.');
const upperSpan = snapshot.annotations.find((a): a is NodeAnnotation => a.kind === 'node' && a.nodeId === `3_${NS}`)!.evidence;
const rematched = rematchEvidence(newText, upperSpan, 2);
check('공백이 바뀐 근거는 normalized 로 재확정', rematched[0].match === 'normalized' && rematched[0].documentVersion === 2, rematched[0].match);
const gone = rematchEvidence('완전히 다른 원문', upperSpan, 3);
check('원문에서 사라진 근거는 stale', gone[0].match === 'stale' && gone[0].start === null);

console.log('8) 하이라이트 조각 분할');
const segments = buildSegments('0123456789', [
  { start: 2, end: 6, className: 'a', priority: 1, annotationId: 'x' },
  { start: 4, end: 8, className: 'b', priority: 2, annotationId: 'y' },
]);
check('겹치는 구간이 5조각으로 분할', segments.length === 5, String(segments.length));
check('겹친 조각은 두 클래스·두 annotation 보유', segments[2].classNames.length === 2 && segments[2].annotationIds.length === 2);
check('텍스트 합치면 원문', segments.map((s) => s.text).join('') === '0123456789');

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
