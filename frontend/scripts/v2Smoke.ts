/**
 * v2(계획서 전체본) 기능 스모크 테스트 (브라우저 없이 순수 로직 + 스토어).
 *  1) v11 결과(최대 3개 세부 쟁점·요약 메타·schemeApplication) import·export 왕복, schemefulfillments 규칙
 *  2) 본문 해시가 서버·flow 와 같음, 본문 수정 → 요약 stale, 사람 요약 current
 *  3) RA scheme 재검토 표시 (연결 추가·삭제, 연결 노드 본문 수정), 근거 재검토 표시
 *  4) 세부 쟁점 중복 없이 최대 3개 (편집 선택지·수락 차단·검증 규칙)
 *  5) 늦게 도착한 AI 요약이 최신 본문·사람 요약을 덮어쓰지 않음
 *  6) 검토 로직: scheme 수정·검토 확정의 modified 판정, 사람 수정 이력
 *  7) 검증 규칙 11·12·14·15·16
 *  8) 프로젝트 마이그레이션 (v1, v10 시절 scheme 필드)
 *  9) 파이프라인 flow 유틸 (handle 왕복, 프롬프트 변수, 연결 가능성, 템플릿, 차이 계산)
 * 10) 파이프라인 스토어 편집과 undo/redo (네트워크 없이)
 * 실행: npm run smoke:v2
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importAifOva } from '../src/io/importAifOva';
import { exportAifOva } from '../src/io/exportAifOva';
import { validateCase } from '../src/validation/graphValidator';
import type { Annotation, NodeAnnotation, ProjectFile } from '../src/types/annotation';
import { migrateProjectFile } from '../src/types/annotation';
import { applyNodePatch, summaryStateOf, type ArgumentCase } from '../src/types/argument';
import {
  confirmScheme,
  humanSchemeEdit,
  schemeShortName,
  shortKoreanName,
  type SchemeApplication,
  type SchemeCatalog,
} from '../src/types/scheme';
import { textHash } from '../src/utils/textHash';
import { acceptAnnotation, importProposals, setDraftValue, type ReviewSnapshot } from '../src/store/reviewLogic';
import {
  applyGeneratedSummaries,
  expectationFor,
  flagSchemesForReview,
  issueAcceptProblem,
  issueOptionState,
  issueSelectionProblems,
} from '../src/store/graphRules';
import { useGraphStore } from '../src/store/graphStore';
import {
  canConnect,
  diffFlowData,
  handleString,
  instantiateTemplate,
  makeEdge,
  promptVariables,
  removeDanglingEdges,
  syncPromptFields,
  validateLocal,
} from '../src/pipeline/flowUtils';
import type { ComponentTemplate, FlowView, LfFlowData, LfNode } from '../src/types/pipeline';
import { SECRET_SENTINEL } from '../src/types/pipeline';
import { usePipelineStore } from '../src/store/pipelineStore';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

const root = process.cwd();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const envelope = JSON.parse(readFileSync(resolve(root, '../backend/fixtures/langflow_run_response.sample.json'), 'utf8'));
const graph = JSON.parse(envelope.outputs[0].outputs[0].results.message.text);
const schemes: SchemeCatalog = JSON.parse(readFileSync(resolve(root, '../backend/catalog/walton_schemes.json'), 'utf8'));
const flow = JSON.parse(readFileSync(resolve(root, '../langflow/TopDown_Judgment_to_AIF_v11_Top3Issues.json'), 'utf8'));
const v9flow = JSON.parse(readFileSync(resolve(root, '../langflow/TopDown_Judgment_to_AIF_3Issue_v9_Evidence.json'), 'utf8'));

console.log('1) v11 결과 import / export');
const imported = importAifOva(graph, 'v11.json', { schemeCatalog: schemes }).case;
const ra = imported.nodes.filter((node) => node.type === 'RA');
const issues = imported.nodes.filter((node) => node.type === 'ISSUE');
check('세부 쟁점 3개, RA 9개', issues.length === 3 && ra.length === 9, `${issues.length}/${ra.length}`);
check('I/ISSUE 요약 모두 current', imported.nodes.filter((n) => n.type !== 'RA').every((n) => !!n.summary && summaryStateOf(n) === 'current' && n.summaryOrigin === 'ai'));
check('RA schemeApplication 모두 있음 (미분류 1)', ra.every((n) => !!n.schemeApplication) && ra.filter((n) => n.schemeApplication!.schemeKey === 'unclassified').length === 1);
check('ISSUE issueRef + 선택 이유', issues[0].issueRef?.issueId === 'ISS-007' && !!issues[0].issueRef?.selectionReason && issues[0].issueRef?.instanceId === 'issue-1');
check('I 노드 issueRefs', imported.nodes.some((n) => n.type === 'I' && n.issueRefs?.[0]?.issueId));
const exported = exportAifOva(imported, { schemeCatalog: schemes });
const exportedNodes = exported.AIF!.nodes!;
check('export: text 는 전체 본문, summary 는 추가 필드', exportedNodes.every((n) => n.text === imported.nodes.find((m) => m.id === n.nodeID)!.text) && exportedNodes.some((n) => n.summary && n.summarySourceHash));
check('export: schemeApplication 보존, 이전 scheme 필드 없음', exportedNodes.some((n) => n.schemeApplication) && !exportedNodes.some((n) => 'scheme' in n));
check('검증된 외부 ID 대응이 없으면 schemefulfillments 를 만들지 않음', (exported.AIF!.schemefulfillments ?? []).length === 0);
const again = importAifOva(clone(exported), undefined, { schemeCatalog: schemes }).case;
const content = (nodes: ArgumentCase['nodes']) =>
  JSON.stringify(nodes.map((node) => ({ ...node, raw: undefined, rawOva: undefined })));
check('왕복 후 노드 값 동일', content(again.nodes) === content(imported.nodes));
const mapped = clone(schemes);
mapped.schemes.find((s) => s.schemeKey === 'witness_testimony')!.aifdbSchemeId = 72;
const withExternal = clone(graph);
const extRa = withExternal.AIF.nodes.find((n: { type: string; schemeApplication?: { schemeKey: string } }) => n.type === 'RA' && n.schemeApplication?.schemeKey === 'abduction');
withExternal.AIF.schemefulfillments = [{ nodeID: extRa.nodeID, schemeID: 999 }];
const extCase = importAifOva(withExternal, undefined, { schemeCatalog: mapped }).case;
const extExport = exportAifOva(extCase, { schemeCatalog: mapped });
const witnessRa = extCase.nodes.find((n) => n.schemeApplication?.schemeKey === 'witness_testimony')!;
check(
  '대응이 있으면 추가, 외부 항목은 덮어쓰지 않고 보존',
  extExport.AIF!.schemefulfillments!.length === 2 &&
    extExport.AIF!.schemefulfillments!.some((e) => JSON.stringify(e) === JSON.stringify({ nodeID: extRa.nodeID, schemeID: 999 })) &&
    extExport.AIF!.schemefulfillments!.some((e) => JSON.stringify(e) === JSON.stringify({ nodeID: witnessRa.id, schemeID: 72 })),
);
const withoutNode = exportAifOva({ ...extCase, nodes: extCase.nodes.filter((n) => n.id !== extRa.nodeID) }, { schemeCatalog: mapped });
check('노드가 확정 그래프에 없으면 외부 항목도 내보내지 않음', !withoutNode.AIF!.schemefulfillments!.some((e) => (e as { nodeID: string }).nodeID === extRa.nodeID));
const unmappedImport = clone(graph);
const bareRa = unmappedImport.AIF.nodes.find((n: { type: string }) => n.type === 'RA');
delete bareRa.schemeApplication;
unmappedImport.AIF.schemefulfillments = [{ nodeID: bareRa.nodeID, schemeID: 72 }];
check('외부 schemeID 를 알려진 대응으로 가져옴', importAifOva(unmappedImport, undefined, { schemeCatalog: mapped }).case.nodes.find((n) => n.id === bareRa.nodeID)!.schemeApplication?.schemeKey === 'witness_testimony');
const legacyGraph = clone(graph);
const legacyRa = legacyGraph.AIF.nodes.find((n: { type: string }) => n.type === 'RA');
const application = legacyRa.schemeApplication;
delete legacyRa.schemeApplication;
legacyRa.scheme = { schemeId: 'other', schemeName: '경험칙', premises: [{ nodeId: application.premiseBindings[0].nodeIds[0], role: null }], conclusion: { nodeId: application.conclusionNodeIds[0] }, rationale: 'r', criticalQuestions: [], source: 'ai' };
legacyGraph.AIF.schemefulfillments = [{ nodeID: legacyRa.nodeID, schemeID: 'other' }];
const legacyImport = importAifOva(legacyGraph);
const converted = legacyImport.case.nodes.find((n) => n.id === legacyRa.nodeID)!.schemeApplication!;
check('v10 scheme 필드 → schemeApplication(custom)', converted.schemeKey === 'custom' && converted.customSchemeName === '경험칙' && converted.premiseBindings[0].nodeIds.length === 1);
check('이전 편집기의 추측 schemefulfillments 제외', exportAifOva(legacyImport.case).AIF!.schemefulfillments!.length === 0 && legacyImport.warnings.some((w) => w.includes('비표준')));
check('짧은 scheme 이름', schemeShortName(ra[0].schemeApplication, schemes) === '증인 진술' && shortKoreanName('원인에서 결과로의 논증') === '원인에서 결과로' && schemeShortName(ra[4].schemeApplication, schemes) === '미분류');

console.log('2) 본문 해시와 요약 상태');
const fixtureIssue = graph.AIF.nodes.find((n: { type: string }) => n.type === 'ISSUE');
check('프런트 textHash == 서버·flow summarySourceHash', textHash(fixtureIssue.text) === fixtureIssue.summarySourceHash, `${textHash(fixtureIssue.text)} vs ${fixtureIssue.summarySourceHash}`);
check('빈 문자열 해시', textHash('') === 'fnv1a64:cbf29ce484222325');
const iNode = imported.nodes.find((n) => n.type === 'I')!;
const edited = applyNodePatch(iNode, { text: `${iNode.text} (수정)` });
check('본문만 수정 → 요약 유지 + stale', edited.summary === iNode.summary && edited.summaryStatus === 'stale' && summaryStateOf(edited) === 'stale');
check('본문을 되돌리면 다시 current', summaryStateOf(applyNodePatch(edited, { text: iNode.text })) === 'current');
const humanSummary = applyNodePatch(edited, { summary: '사람 요약' });
check('요약 직접 수정 → 사람·current', humanSummary.summaryOrigin === 'human' && summaryStateOf(humanSummary) === 'current');
check('요약 삭제(null) → 요약 메타 모두 제거', !('summarySourceHash' in applyNodePatch(humanSummary, { summary: null })));

console.log('3) scheme·근거 재검토 표시');
const raNode = ra[0];
const premiseId = raNode.schemeApplication!.premiseBindings[0].nodeIds[0];
useGraphStore.getState().loadSnapshot({ caseData: clone(imported), annotations: [] });
useGraphStore.getState().updateNodeFields(premiseId, { text: '전제 본문을 사람이 고침' });
const afterText = useGraphStore.getState().caseData!;
const flaggedRa = afterText.nodes.find((n) => n.id === raNode.id)!.schemeApplication!;
check('연결 노드 본문 수정 → RA 재검토 필요 (scheme 유지)', flaggedRa.status === 'needs_review' && flaggedRa.schemeKey === raNode.schemeApplication!.schemeKey && !!flaggedRa.reviewReasons?.length);
check('재검토 이력 기록', flaggedRa.history?.at(-1)?.action === 'needs_review');
check('다른 RA 는 그대로', afterText.nodes.find((n) => n.id === ra[3].id)!.schemeApplication!.status === 'suggested');
const edgeToDelete = afterText.edges.find((e) => e.target === ra[3].id)!;
useGraphStore.getState().deleteEdges([edgeToDelete.id]);
check('RA 전제 연결 삭제 → 재검토 필요', useGraphStore.getState().caseData!.nodes.find((n) => n.id === ra[3].id)!.schemeApplication!.status === 'needs_review');
useGraphStore.getState().undo();
check('undo → 재검토 표시도 되돌림', useGraphStore.getState().caseData!.nodes.find((n) => n.id === ra[3].id)!.schemeApplication!.status === 'suggested');
useGraphStore.getState().addEdge(issues[2].id, ra[5].id);
check('RA 연결 추가 → 재검토 필요', useGraphStore.getState().caseData!.nodes.find((n) => n.id === ra[5].id)!.schemeApplication!.status === 'needs_review');
check('scheme 없는 RA 는 표시하지 않음', flagSchemesForReview({ ...imported, nodes: imported.nodes.map((n) => ({ ...n, schemeApplication: undefined })) }, [], [raNode.id], 'x').flagged.length === 0);

console.log('4) 세부 쟁점 최대 3개');
check('현재 3개는 문제 없음', issueSelectionProblems(imported.nodes).length === 0);
const dupNodes = imported.nodes.map((n) => (n.id === issues[1].id ? { ...n, issueRef: { issueId: 'ISS-007' } } : n));
check('중복 선택 감지', issueSelectionProblems(dupNodes).some((p) => p.includes('중복')));
const fourth = { ...issues[0], id: '99_x', issueRef: { issueId: 'ISS-001' } };
check('4개 감지', issueSelectionProblems([...imported.nodes, fourth]).some((p) => p.includes('최대 3개')));
check('편집 선택지: 다른 확정 쟁점과 같은 ID 금지', issueOptionState(imported, [], issues[1].id, 'ISS-007').disabled);
check('편집 선택지: 자기 자리 교체는 허용', !issueOptionState(imported, [], issues[1].id, 'ISS-001').disabled);
check('확정 그래프에 4번째 쟁점 수락 차단', !!issueAcceptProblem(imported, '99_x', { type: 'ISSUE', text: 't', issueRef: { issueId: 'ISS-001' } }));
const graphCodes = (c: ArgumentCase) => validateCase(c).results.map((r) => r.code);
check('검증 RULE_14 (error)', graphCodes({ ...imported, nodes: dupNodes }).includes('RULE_14_ISSUE_SELECTION') && validateCase({ ...imported, nodes: dupNodes }).errorCount > 0);

console.log('5) 요약 생성 결과 반영 규칙');
const target = imported.nodes.find((n) => n.type === 'I' && n.id !== premiseId)!;
const expectation = expectationFor(target.id, target);
const generated = [{ nodeId: target.id, summary: 'AI 새 요약', textHash: textHash(target.text) }];
const applied = applyGeneratedSummaries(imported, [], generated, [expectation]);
check('요청 뒤 변화가 없으면 반영 (ai·current)', applied.applied.length === 1 && applied.caseData.nodes.find((n) => n.id === target.id)!.summary === 'AI 새 요약');
const textChangedCase = { ...imported, nodes: imported.nodes.map((n) => (n.id === target.id ? applyNodePatch(n, { text: '요청 뒤 바뀐 본문' }) : n)) };
const lateText = applyGeneratedSummaries(textChangedCase, [], generated, [expectation]);
check('늦게 도착: 본문이 바뀌었으면 반영하지 않음', lateText.applied.length === 0 && lateText.skipped[0].reason.includes('본문'));
const humanChangedCase = { ...imported, nodes: imported.nodes.map((n) => (n.id === target.id ? applyNodePatch(n, { summary: '사람이 쓴 요약' }) : n)) };
const lateHuman = applyGeneratedSummaries(humanChangedCase, [], generated, [expectation]);
check('늦게 도착: 사람 요약을 덮어쓰지 않음', lateHuman.applied.length === 0 && lateHuman.caseData.nodes.find((n) => n.id === target.id)!.summary === '사람이 쓴 요약');

console.log('6) 검토 로직');
const proposals: Annotation[] = imported.nodes.map((node) => {
  const value = { type: node.type, text: node.text, summary: node.summary, summaryOrigin: node.summaryOrigin, summaryStatus: node.summaryStatus, summarySourceHash: node.summarySourceHash, schemeApplication: node.schemeApplication, issueRef: node.issueRef, issueRefs: node.issueRefs, x: node.x, y: node.y };
  return {
    id: `r:node:${node.id}`, runId: 'r', kind: 'node', nodeId: node.id, origin: node.type === 'RA' ? 'rule' : 'ai', status: 'pending',
    originalValue: clone(value), currentValue: clone(value), evidence: [{ quote: 'q', start: 0, end: 1, match: 'exact', documentVersion: 1 }], createdAt: 't', updatedAt: 't',
  } as NodeAnnotation;
});
const edgeProposals: Annotation[] = imported.edges.map((edge) => ({
  id: `r:edge:${edge.id}`, runId: 'r', kind: 'edge', edgeId: `r:${edge.id}`, origin: 'rule', status: 'pending',
  originalValue: { source: edge.source, target: edge.target, proposedEdgeId: edge.id }, currentValue: { source: edge.source, target: edge.target, proposedEdgeId: edge.id },
  evidence: [], createdAt: 't', updatedAt: 't',
}));
let snapshot: ReviewSnapshot = importProposals({ caseData: { text: '', nodes: [], edges: [] }, annotations: [], edgeIdHighWater: 0 }, [...proposals, ...edgeProposals]).snapshot;
const raId = `r:node:${raNode.id}`;
const premiseAnnotationId = `r:node:${premiseId}`;
let outcome = setDraftValue(snapshot, premiseAnnotationId, { text: '초안 전제 본문 수정' });
snapshot = outcome.snapshot;
const draftRa = snapshot.annotations.find((a) => a.id === raId) as NodeAnnotation;
const draftPremise = snapshot.annotations.find((a) => a.id === premiseAnnotationId) as NodeAnnotation;
check('초안 본문 수정 → 연결 RA 초안 재검토 필요, 상태 pending 유지', draftRa.currentValue.schemeApplication!.status === 'needs_review' && draftRa.status === 'pending');
check('초안 본문 수정 → 근거 재검토 표시, 요약 stale', !!draftPremise.evidence[0].reviewReason && summaryStateOf(draftPremise.currentValue) === 'stale');
outcome = acceptAnnotation(snapshot, raId);
snapshot = outcome.snapshot;
check('재검토 표시만 달라진 RA 수락 → accepted (내용 변경 아님)', (snapshot.annotations.find((a) => a.id === raId) as NodeAnnotation).status === 'accepted');
const currentApp = (snapshot.annotations.find((a) => a.id === raId) as NodeAnnotation).currentValue.schemeApplication!;
outcome = setDraftValue(snapshot, raId, { schemeApplication: confirmScheme(currentApp, 't') });
snapshot = outcome.snapshot;
check('검토 확정도 내용 변경 아님', (snapshot.annotations.find((a) => a.id === raId) as NodeAnnotation).status === 'accepted');
const humanApp: SchemeApplication = humanSchemeEdit(currentApp, { ...currentApp, schemeKey: 'expert_opinion', rationale: '감정 의견' }, 't2');
outcome = setDraftValue(snapshot, raId, { schemeApplication: humanApp });
snapshot = outcome.snapshot;
const modifiedRa = snapshot.annotations.find((a) => a.id === raId) as NodeAnnotation;
check('scheme 사람 수정 → modified + 그래프 반영', modifiedRa.status === 'modified' && snapshot.caseData.nodes.find((n) => n.id === raNode.id)!.schemeApplication!.schemeKey === 'expert_opinion');
check('사람 수정은 origin human·confirmed·이력에 이전 key', humanApp.origin === 'human' && humanApp.status === 'confirmed' && humanApp.history!.at(-1)!.previousKey === 'witness_testimony');
check('AI 원안은 originalValue 에 보존', modifiedRa.originalValue.schemeApplication!.schemeKey === 'witness_testimony');
outcome = setDraftValue(snapshot, raId, { schemeApplication: null });
check('scheme 삭제(null) → 값 제거', !(outcome.snapshot.annotations.find((a) => a.id === raId) as NodeAnnotation).currentValue.schemeApplication);
check('빈 본문 수정은 거부', !!setDraftValue(snapshot, premiseAnnotationId, { text: '   ' }).error);
for (const issue of issues) snapshot = acceptAnnotation(snapshot, `r:node:${issue.id}`).snapshot;
const extraIssue: NodeAnnotation = { ...(proposals.find((p) => p.kind === 'node' && p.nodeId === issues[0].id) as NodeAnnotation), id: 'r2:node:99_x', runId: 'r2', nodeId: '99_x' };
extraIssue.currentValue = { ...extraIssue.currentValue, issueRef: { issueId: 'ISS-001' } };
snapshot = importProposals(snapshot, [extraIssue]).snapshot;
check('수락: 4번째 세부 쟁점은 오류', !!acceptAnnotation(snapshot, 'r2:node:99_x').error);
const summaryOnly = setDraftValue(snapshot, `r:node:${target.id}`, { summary: '초안 사람 요약' });
check('초안 요약 수정 → pending 유지', (summaryOnly.snapshot.annotations.find((a) => a.id === `r:node:${target.id}`) as NodeAnnotation).status === 'pending');

console.log('7) 검증 규칙');
const codes = (c: ArgumentCase) => validateCase(c).results.map((r) => r.code);
check('v11 결과는 미분류 경고(RULE_11_RA_UNCLASSIFIED)만', codes(imported).filter((c) => /RULE_1[1-6]/.test(c)).join() === 'RULE_11_RA_UNCLASSIFIED', codes(imported).join(','));
const cleared = { ...imported, nodes: imported.nodes.map((n) => (n.id === ra[0].id ? { ...n, schemeApplication: undefined } : n)) };
check('scheme 정보 없음 → RULE_11', codes(cleared).includes('RULE_11_RA_SCHEME_MISSING'));
const badRef = {
  ...imported,
  nodes: imported.nodes.map((n) => (n.id === ra[1].id ? { ...n, schemeApplication: { ...n.schemeApplication!, premiseBindings: [{ roleId: null, nodeIds: [issues[2].id] }] } } : n)),
};
check('끊긴 전제 참조 → RULE_12', codes(badRef).includes('RULE_12_SCHEME_REFERENCE'));
check('재검토 필요 → RULE_15', codes(afterText).includes('RULE_15_SCHEME_NEEDS_REVIEW'));
check('요약 stale → RULE_16', codes(textChangedCase).includes('RULE_16_SUMMARY_STALE'));
const legacy = importAifOva(JSON.parse(JSON.parse(readFileSync(resolve(root, '../backend/fixtures/langflow_run_response.v9.sample.json'), 'utf8')).outputs[0].outputs[0].results.message.text)).case;
check('v9 결과(scheme 없음)에는 11~13 경고를 내지 않음', !codes(legacy).some((c) => /RULE_1[123]/.test(c)));

console.log('8) 프로젝트 마이그레이션');
const v1 = { schemaVersion: 1, projectId: 'p', revision: 0, document: { id: 'd', text: '', hash: '', version: 1 }, acceptedGraph: {}, analysisRuns: [], annotations: [], reviewEvents: [], analysisSettings: { issueScope: ['ISS-001'] } } as unknown as ProjectFile;
const migrated = migrateProjectFile(v1);
check('v1 → v2, 사전 선택 범위 제거', migrated.schemaVersion === 2 && migrated.analysisSettings === null);
const legacyAnnotation = clone(proposals[2]) as NodeAnnotation & { currentValue: Record<string, unknown> };
const oldValue = { type: 'RA', text: 'RA', scheme: { schemeId: 'witness_testimony', schemeName: '', premises: [], conclusion: { nodeId: null }, rationale: 'x', criticalQuestions: [], source: 'ai' } };
const v2old = { ...v1, schemaVersion: 2, annotations: [{ ...legacyAnnotation, originalValue: oldValue, currentValue: { type: 'I', text: '본문', summary: '예전 요약' } }] } as unknown as ProjectFile;
const migratedOld = migrateProjectFile(v2old).annotations[0] as NodeAnnotation;
check('v10 시절 scheme → schemeApplication', migratedOld.originalValue.schemeApplication?.schemeKey === 'witness_testimony' && !('scheme' in migratedOld.originalValue));
check('해시 없는 요약 → 본문 해시 기록', migratedOld.currentValue.summarySourceHash === textHash('본문') && migratedOld.currentValue.summaryStatus === 'current');
let threw = false;
try {
  migrateProjectFile({ ...v1, schemaVersion: 9 } as unknown as ProjectFile);
} catch {
  threw = true;
}
check('모르는 버전은 오류', threw);

console.log('9) 파이프라인 flow 유틸');
const data: LfFlowData = flow.data;
const byId = new Map<string, LfNode>(data.nodes.map((node) => [node.id, node]));
check('모든 엣지 handle 문자열 재현', data.edges.every((edge) => handleString(edge.data!.sourceHandle!) === edge.sourceHandle && handleString(edge.data!.targetHandle!) === edge.targetHandle));
check(
  'makeEdge 가 같은 id 를 만듦',
  data.edges.every((edge) => makeEdge(byId.get(edge.source)!, edge.data!.sourceHandle!.name, byId.get(edge.target)!, edge.data!.targetHandle!.fieldName).id === edge.id),
);
const claimPrompt = byId.get('Prompt Template-8w7OV')!;
const original = String((claimPrompt.data.node.template.template as { value: string }).value);
check('Main Claim 프롬프트 변수', promptVariables(original).error === null && promptVariables(original).variables.join(',') === 'judgment');
const v9prompt = v9flow.data.nodes.find((n: LfNode) => n.id === 'Prompt Template-s9yHj');
check('v9 I-node 프롬프트의 단일 중괄호 JSON 은 오류로 잡음', promptVariables(v9prompt.data.node.template.template.value).error !== null);
check('{{ }} 는 변수 아님', promptVariables('a {{"x": 1}} {y}').variables.join() === 'y');
check('짝 없는 } 오류', promptVariables('a } b').error !== null);
check('v11 flow 즉시 검사 오류 없음', validateLocal(data, { inputComponentId: 'CustomComponent-k5fj9', outputComponentId: 'ChatOutput-nL1VD' }).filter((i) => i.level === 'error').length === 0);

const added = syncPromptFields(claimPrompt, `${original}\n{extra_context}`);
check('변수 추가 → 필드·custom_fields 추가', !!added.node.data.node.template.extra_context && added.node.data.node.custom_fields!.template.includes('extra_context'));
check('기존 변수 필드는 유지', !!added.node.data.node.template.judgment);
const removed = syncPromptFields(added.node, original.replace('{judgment}', '(판결문)'));
check('변수 삭제 → 필드 제거 보고', removed.removedFields.sort().join() === 'extra_context,judgment' && !removed.node.data.node.template.judgment);
const withRemoved = { ...data, nodes: data.nodes.map((n) => (n.id === claimPrompt.id ? removed.node : n)) };
const dangling = removeDanglingEdges(withRemoved);
check('없어진 필드의 연결 제거', dangling.removed.length === 1 && dangling.removed[0].target === claimPrompt.id);
check('문법 오류면 필드는 그대로', syncPromptFields(claimPrompt, 'broken {').node.data.node.template.judgment !== undefined);

check('형식 불일치 연결 거부', !canConnect(data, 'CustomComponent-k5fj9', 'message', 'ext:ollama:ChatOllamaComponent@official-pQanT', 'temperature').ok);
check('이미 연결된 필드 거부', !canConnect(data, 'CustomComponent-Spl11', 'judgment', 'Prompt Template-8w7OV', 'judgment').ok);
check('순환 연결 거부', !canConnect(data, 'ChatOutput-nL1VD', 'message', 'CustomComponent-Spl11', 'payload').ok);
const llm = byId.get('ext:ollama:ChatOllamaComponent@official-pQanT')!;
const template: ComponentTemplate = {
  key: 'llm', type: String(llm.data.type), displayName: 'LLM', description: '', kind: 'llm', source: 'flow',
  node: { ...clone(llm.data.node), template: { ...llm.data.node.template, api_key: { ...(llm.data.node.template.api_key as object), value: SECRET_SENTINEL } } },
};
const instance = instantiateTemplate(template, { x: 1, y: 2 }, data.nodes.map((n) => n.id));
check('새 컴포넌트 id 형식·비밀 값 비움', instance.id.startsWith(`${llm.data.type}-`) && instance.id.length === String(llm.data.type).length + 6 && (instance.data.node.template.api_key as { value: string }).value === '');
const moved = { ...data, nodes: data.nodes.map((n) => (n.id === llm.id ? { ...n, position: { x: n.position.x + 10, y: n.position.y } } : n)) };
check('위치 이동만 → 실행 내용 동일', diffFlowData(data, moved).sameExecution === true && diffFlowData(data, moved).nodesMoved.length === 1);
check('프롬프트 변경 → 변경 1', diffFlowData(data, withRemoved).nodesChanged.join() === claimPrompt.id && diffFlowData(data, withRemoved).sameExecution === false);

console.log('10) 파이프라인 스토어 편집');
const view: FlowView = {
  flow: { id: flow.id, name: flow.name, description: '', updatedAt: 't0', tags: [], isProduction: false, isAnalysisFlow: false, isWorkingCopy: true, hasDraft: false },
  data: clone(data),
  hash: 'sha256:base',
  models: [],
  support: {},
  secretFields: [],
  summary: { nodeCount: data.nodes.length, edgeCount: data.edges.length, kinds: {} },
  relay: { inputComponentId: 'CustomComponent-k5fj9', outputComponentId: 'ChatOutput-nL1VD' },
  draft: null,
};
usePipelineStore.setState({ current: view, data: clone(data), baseUpdatedAt: 't0', baseHash: 'sha256:base', past: [], future: [], dirty: false, templates: [template] });
const store = usePipelineStore.getState();
const edgeCount = data.edges.length;
const targetEdge = data.edges.find((edge) => edge.target === 'Prompt Template-8w7OV')!;
store.deleteEdges([targetEdge.id]);
check('연결 삭제 → dirty·초안 저장 대기·차이 계산', usePipelineStore.getState().data!.edges.length === edgeCount - 1 && usePipelineStore.getState().dirty && !usePipelineStore.getState().draftSaved && usePipelineStore.getState().diff?.edgesRemoved === 1);
check('연결 복원(connect)', usePipelineStore.getState().connect('CustomComponent-Spl11', 'judgment', 'Prompt Template-8w7OV', 'judgment'));
check('연결 id 원래와 같음', usePipelineStore.getState().data!.edges.some((edge) => edge.id === targetEdge.id));
check('되돌린 편집은 실행 내용 동일', usePipelineStore.getState().diff?.sameExecution === true);
const llmId = 'ext:ollama:ChatOllamaComponent@official-pQanT';
store.updateField(llmId, 'temperature', 0.4);
const temp = () => (usePipelineStore.getState().data!.nodes.find((n) => n.id === llmId)!.data.node.template.temperature as { value: number }).value;
check('모델 필드 값 편집', temp() === 0.4);
store.undo();
check('undo → 값 복원', temp() === 0.1);
store.redo();
check('redo → 다시 적용', temp() === 0.4);
store.updatePrompt('Prompt Template-8w7OV', '요약만: {claim_text}');
const promptNode = usePipelineStore.getState().data!.nodes.find((n) => n.id === 'Prompt Template-8w7OV')!;
check('프롬프트 변경 → 새 변수 필드, 옛 연결 제거', !!promptNode.data.node.template.claim_text && !usePipelineStore.getState().data!.edges.some((e) => e.target === 'Prompt Template-8w7OV' && e.targetHandle.includes('judgment')));
store.deleteNodes(['CustomComponent-k5fj9']);
check('중계 입력 컴포넌트는 삭제되지 않음', usePipelineStore.getState().data!.nodes.some((n) => n.id === 'CustomComponent-k5fj9'));
const addedId = store.addComponent('llm', { x: 10, y: 10 });
check('팔레트로 컴포넌트 추가 + 선택', !!addedId && usePipelineStore.getState().selectedNodeId === addedId);
store.deleteNodes([addedId!]);
check('추가한 컴포넌트 삭제', !usePipelineStore.getState().data!.nodes.some((n) => n.id === addedId));

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
