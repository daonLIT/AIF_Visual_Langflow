/**
 * 스토어 통합 스모크: 검토 액션과 그래프 편집이 같은 undo/redo 히스토리로 묶이는지,
 * 프로젝트 파일 저장 → 불러오기 뒤 원문·그래프·검토 상태·이력이 유지되는지 확인한다.
 * 실행: npm run smoke:store   (zustand 가 설치되어 있어야 한다)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useGraphStore } from '@aif/workbench/store/graphStore';
import { useAnnotationStore } from '@aif/workbench/store/annotationStore';
import type { Annotation, EdgeAnnotation, NodeAnnotation } from '@aif/workbench/types/annotation';
import { DocumentMatcher } from '@aif/workbench/utils/evidence';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function main() {
  const text: string = JSON.parse(readFileSync(resolve(process.cwd(), '../packages/aif-workbench/fixtures/sample-case.json'), 'utf8')).text;
  const envelope = JSON.parse(readFileSync(resolve(process.cwd(), '../backend/fixtures/langflow_run_response.v9.sample.json'), 'utf8'));
  const graph = JSON.parse(envelope.outputs[0].outputs[0].results.message.text);


  const annotationStore = useAnnotationStore.getState();

  console.log('1) 새 문서 시작');
  await annotationStore.newDocument(text, { fileName: 'sample.txt', caseId: 'SAMPLE' });
  check('caseData 생성, 노드 0', useGraphStore.getState().caseData?.nodes.length === 0);
  check('문서 메타 v1 + sha256', useAnnotationStore.getState().document?.version === 1 && (useAnnotationStore.getState().document?.hash.length ?? 0) === 64);

  console.log('2) 제안 불러오기 (서버 adapter 결과를 흉내)');
  const NS = '20260911130000';
  const matcher = new DocumentMatcher(text);
  const idMap = new Map<string, string>(graph.AIF.nodes.map((n: { nodeID: string }) => [n.nodeID, `${n.nodeID.split('_')[0]}_${NS}`]));
  const proposals: Annotation[] = [];
  for (const node of graph.AIF.nodes as Array<{ nodeID: string; text: string; type: 'I' | 'RA' | 'ISSUE' | 'CA' }>) {
    const id = idMap.get(node.nodeID)!;
    const m = matcher.match(node.text);
    const value = { type: node.type, text: node.text, x: 0, y: 0 };
    proposals.push({
      id: `r1:node:${id}`, runId: 'r1', kind: 'node', nodeId: id, origin: node.type === 'RA' ? 'rule' : 'ai', status: 'pending',
      originalValue: value, currentValue: { ...value },
      evidence: node.type === 'RA' ? [] : [{ quote: m.quote, start: m.start, end: m.end, match: m.match, documentVersion: 1 }],
      createdAt: 't', updatedAt: 't',
    });
  }
  for (const edge of graph.AIF.edges as Array<{ edgeID: number; fromID: string; toID: string }>) {
    const value = { source: idMap.get(edge.fromID)!, target: idMap.get(edge.toID)!, proposedEdgeId: edge.edgeID };
    proposals.push({ id: `r1:edge:${edge.edgeID}`, runId: 'r1', kind: 'edge', edgeId: `r1:${edge.edgeID}`, origin: 'rule', status: 'pending', originalValue: value, currentValue: { ...value }, evidence: [], createdAt: 't', updatedAt: 't' });
  }
  // importRun 은 내부 함수이므로 graphStore.commit 으로 직접 넣는다 (annotationStore.importStaleRun 과 같은 경로).
  useAnnotationStore.setState({
    runs: [{ runId: 'r1', status: 'succeeded', createdAt: 't', documentId: 'd', documentVersion: 1, documentHash: useAnnotationStore.getState().document!.hash, namespace: NS, mode: 'mock', stale: true, imported: false }],
    pendingProposals: { r1: proposals },
  });
  useAnnotationStore.getState().importStaleRun('r1');
  check('annotations 45개', useGraphStore.getState().annotations.length === 45, String(useGraphStore.getState().annotations.length));
  check('활성 실행 r1', useAnnotationStore.getState().activeRunId === 'r1');
  check('run imported 표시', useAnnotationStore.getState().runs[0].imported === true);

  console.log('3) 수락 → undo → redo');
  const pastBefore = useGraphStore.getState().past.length;
  const edge = useGraphStore.getState().annotations.find((a): a is EdgeAnnotation => a.kind === 'edge')!;
  useAnnotationStore.getState().accept(edge.id, { withDependencies: true });
  check('수락 후 확정 노드 2 / 엣지 1', useGraphStore.getState().caseData!.nodes.length === 2 && useGraphStore.getState().caseData!.edges.length === 1);
  check('히스토리 1단계 증가', useGraphStore.getState().past.length === pastBefore + 1);
  useGraphStore.getState().undo();
  check('undo: 확정 그래프 비움', useGraphStore.getState().caseData!.nodes.length === 0);
  check('undo: annotation 상태도 pending 으로', useGraphStore.getState().annotations.find((a) => a.id === edge.id)!.status === 'pending');
  useGraphStore.getState().redo();
  check('redo: 다시 수락 상태', useGraphStore.getState().annotations.find((a) => a.id === edge.id)!.status === 'accepted');

  console.log('4) 그래프 편집이 검토 상태에 반영');
  const acceptedNode = useGraphStore.getState().caseData!.nodes[0];
  useGraphStore.getState().updateNodeText(acceptedNode.id, `${acceptedNode.text} 수정`);
  const nodeAnn = useGraphStore.getState().annotations.find((a): a is NodeAnnotation => a.kind === 'node' && a.nodeId === acceptedNode.id)!;
  check('그래프에서 텍스트 수정 → modified', nodeAnn.status === 'modified' && nodeAnn.currentValue.text.endsWith('수정'));
  useGraphStore.getState().deleteNodes([acceptedNode.id]);
  const afterDelete = useGraphStore.getState().annotations.find((a) => a.id === nodeAnn.id)!;
  check('그래프에서 삭제 → rejected 기록', afterDelete.status === 'rejected' && afterDelete.note === 'graph-delete');
  check('붙어 있던 확정 엣지의 annotation 은 rejected', useGraphStore.getState().annotations.find((a) => a.id === edge.id)!.status === 'rejected');
  useGraphStore.getState().undo();
  check('삭제 undo → 노드·annotation 복구', useGraphStore.getState().caseData!.nodes.some((n) => n.id === acceptedNode.id) && useGraphStore.getState().annotations.find((a) => a.id === nodeAnn.id)!.status === 'modified');

  console.log('5) 사람 노드 (원문 범위 저장)');
  const start = text.indexOf('피고인의 진술은 신빙성이 낮다.');
  const humanId = useGraphStore.getState().addNode('I', '피고인의 진술은 신빙성이 낮다.', { x: 0, y: 0 }, {
    evidence: [{ quote: '피고인의 진술은 신빙성이 낮다.', start, end: start + 17, match: 'manual', documentVersion: 1 }],
  });
  const human = useGraphStore.getState().annotations.find((a) => a.id === `human:node:${humanId}`) as NodeAnnotation;
  check('human annotation 생성 + accepted + manual 근거', human.origin === 'human' && human.status === 'accepted' && human.evidence[0].match === 'manual');

  console.log('6) 프로젝트 파일 왕복');
  const project = useAnnotationStore.getState().buildProjectFile()!;
  check('acceptedGraph 에 pending 제안 없음', project.acceptedGraph.AIF!.nodes!.length === useGraphStore.getState().caseData!.nodes.length);
  check('annotations/reviewEvents 포함', project.annotations.length === 46 && project.reviewEvents.length > 0);
  const serialized = JSON.stringify(project);
  useAnnotationStore.getState().resetProject();
  useGraphStore.getState().startDocument('다른 문서');
  await useAnnotationStore.getState().loadProjectFile(JSON.parse(serialized), 'roundtrip.project.json');
  const g = useGraphStore.getState();
  const a = useAnnotationStore.getState();
  check('원문 복구', g.caseData!.text === text);
  check('확정 그래프 복구', g.caseData!.nodes.length === project.acceptedGraph.AIF!.nodes!.length && g.caseData!.edges.length === project.acceptedGraph.AIF!.edges!.length);
  check('검토 상태 복구 (modified 1, accepted human 1)', g.annotations.filter((x) => x.status === 'modified').length === 1 && g.annotations.some((x) => x.origin === 'human'));
  check('이력·실행 복구', a.reviewEvents.length === project.reviewEvents.length && a.runs.length === 1);
  check('문서 버전/해시 복구', a.document?.version === 1 && a.document?.hash === project.document.hash);
  check('불러온 직후 dirty=false', a.dirty === false);

  console.log('7) 원문 교체 → 문서 버전 증가, 근거 재검토');
  await useAnnotationStore.getState().replaceDocumentText(text.replace('피고인의 진술은 신빙성이 낮다.', '(삭제됨)'));
  const a2 = useAnnotationStore.getState();
  const humanAfter = useGraphStore.getState().annotations.find((x) => x.id === human.id) as NodeAnnotation;
  check('문서 v2', a2.document?.version === 2);
  check('사라진 근거는 stale', humanAfter.evidence[0].match === 'stale' && humanAfter.evidence[0].documentVersion === 2);
  useGraphStore.getState().undo();
  check('원문 교체도 undo 가능 (텍스트 복구)', useGraphStore.getState().caseData!.text === text);

  console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
