/**
 * import -> 편집 -> validate -> export -> 재import 왕복 스모크 테스트.
 * 실행: npm run smoke
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importAifOva } from '@aif/workbench/io/importAifOva';
import { exportAifOva } from '@aif/workbench/io/exportAifOva';
import { validateCase } from '@aif/workbench/validation/graphValidator';
import { generateNodeId } from '@aif/workbench/utils/generateNodeId';
import { generateEdgeId } from '@aif/workbench/utils/generateEdgeId';
import { layoutCase } from '@aif/workbench/layout/elkLayout';
import type { ArgumentCase } from '@aif/workbench/types/argument';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

const samplePath = resolve(process.cwd(), '../packages/aif-workbench/fixtures/sample-case.json');
const raw = JSON.parse(readFileSync(samplePath, 'utf8'));

console.log('1) import');
const imported = importAifOva(raw, 'sample-case.json');
const original = imported.case;
check('노드 37개', original.nodes.length === 37, String(original.nodes.length));
check('엣지 39개', original.edges.length === 39, String(original.edges.length));
check(
  'ISSUE 4개',
  original.nodes.filter((n) => n.type === 'ISSUE').length === 4,
  String(original.nodes.filter((n) => n.type === 'ISSUE').length),
);
check('판결문 텍스트 존재', original.text.length > 500);
check('import 경고 없음', imported.warnings.length === 0, imported.warnings.join(' / '));
check('자동 레이아웃 불필요(좌표 보존)', imported.needsLayout === false);
check(
  'OVA 좌표 반영',
  original.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
);
check(
  '엣지 방향 보존 (fromID -> source)',
  original.edges.every((edge, index) => {
    const rawEdge = raw.AIF.edges[index];
    return edge.source === rawEdge.fromID && edge.target === rawEdge.toID;
  }),
);

console.log('2) validate (원본)');
const baseline = validateCase(original);
check('오류 0', baseline.errorCount === 0, JSON.stringify(baseline.results.slice(0, 3)));
check('경고 0', baseline.warningCount === 0, JSON.stringify(baseline.results.slice(0, 3)));

console.log('3) 편집: 노드 추가 / 엣지 추가 / 엣지 삭제 / 텍스트 수정 / 이동');
const newNodeId = generateNodeId(original.nodes.map((n) => n.id));
check('새 노드 ID 형식', /^\d+_\d{14}$/.test(newNodeId), newNodeId);
check('새 노드 ID 중복 없음', !original.nodes.some((n) => n.id === newNodeId));

const raNode = original.nodes.find((n) => n.type === 'RA')!;
const newEdgeId = generateEdgeId(original.edges.map((e) => e.id));
check('새 엣지 ID = max + 1', newEdgeId === 40, String(newEdgeId));

const edited: ArgumentCase = {
  ...original,
  nodes: [
    ...original.nodes.map((n) =>
      n.id === original.nodes[0].id
        ? { ...n, text: `${n.text} (수정됨)`, x: n.x + 25, y: n.y - 15 }
        : n,
    ),
    {
      id: newNodeId,
      type: 'I' as const,
      text: '판결문에서 선택한 문장으로 만든 새 I 노드',
      x: -400,
      y: 1000,
      visible: true,
    },
  ],
  // 새 I 노드를 기존 RA 에 연결하고, 첫 엣지는 삭제한다.
  edges: [
    ...original.edges.slice(1),
    { id: newEdgeId, source: newNodeId, target: raNode.id, visible: true },
  ],
};

const afterEdit = validateCase(edited);
check('편집 후 노드 38 / 엣지 39', edited.nodes.length === 38 && edited.edges.length === 39);
check(
  '삭제된 엣지의 영향이 검증에 잡힘',
  afterEdit.results.length > 0,
  '엣지 삭제로 고립/RA 규칙 위반이 발생해야 한다',
);

console.log('4) export');
const exported = exportAifOva(edited);
check('AIF 노드 38', exported.AIF!.nodes!.length === 38);
check('AIF 엣지 39', exported.AIF!.edges!.length === 39);
check('OVA 노드 38', exported.OVA!.nodes!.length === 38);
check('OVA 엣지 39', exported.OVA!.edges!.length === 39);
check('판결문 텍스트 보존', exported.text === original.text);
check(
  'schemefulfillments 등 부가 배열 유지',
  Array.isArray(exported.AIF!.schemefulfillments) &&
    Array.isArray(exported.AIF!.participants) &&
    Array.isArray(exported.AIF!.locutions) &&
    Array.isArray(exported.AIF!.descriptorfulfillments) &&
    Array.isArray(exported.AIF!.cqdescriptorfulfillments),
);
check(
  'ISSUE 타입이 그대로 내보내짐',
  exported.AIF!.nodes!.filter((n) => n.type === 'ISSUE').length === 4,
);
check('OVA 메타 보존', exported.OVA!.firstname === 'Anon' && exported.OVA!.surname === 'User');
const movedOva = exported.OVA!.nodes!.find((n) => n.nodeID === original.nodes[0].id)!;
check(
  '이동한 좌표가 OVA 에 반영',
  movedOva.x === original.nodes[0].x + 25 && movedOva.y === original.nodes[0].y - 15,
  JSON.stringify(movedOva),
);

console.log('5) 재import (왕복)');
const reimported = importAifOva(JSON.parse(JSON.stringify(exported)), 'roundtrip.json');
check('재import 노드 38', reimported.case.nodes.length === 38);
check('재import 엣지 39', reimported.case.edges.length === 39);
check('재import 경고 없음', reimported.warnings.length === 0, reimported.warnings.join(' / '));
check(
  '노드 ID / 타입 / 텍스트 동일',
  reimported.case.nodes.every((node, index) => {
    const before = edited.nodes[index];
    return node.id === before.id && node.type === before.type && node.text === before.text;
  }),
);
check(
  '엣지 ID / 방향 동일',
  reimported.case.edges.every((edge, index) => {
    const before = edited.edges[index];
    return (
      edge.id === before.id && edge.source === before.source && edge.target === before.target
    );
  }),
);
check(
  '좌표 동일',
  reimported.case.nodes.every((node, index) => {
    const before = edited.nodes[index];
    return node.x === Math.round(before.x) && node.y === Math.round(before.y);
  }),
);
check(
  '재import 검증 결과 동일',
  JSON.stringify(validateCase(reimported.case).results) === JSON.stringify(afterEdit.results),
);

console.log('6) 좌표 없는 파일 -> 자동 레이아웃 필요 플래그');
const noPositions = {
  AIF: raw.AIF,
  text: raw.text,
  OVA: { firstname: 'Anon', surname: 'User', url: '', nodes: [], edges: [] },
};
const withoutOva = importAifOva(noPositions, 'no-ova.json');
check('needsLayout = true', withoutOva.needsLayout === true);
check('노드는 그대로 파싱', withoutOva.case.nodes.length === 37);

console.log('7) 잘못된 입력 처리');
let threw = false;
try {
  importAifOva({ text: 'x' }, 'bad.json');
} catch {
  threw = true;
}
check('AIF 섹션 없으면 예외', threw);

async function main(): Promise<void> {
  console.log('8) ELK 자동 레이아웃');
  const positions = await layoutCase(withoutOva.case);
  check('모든 노드에 좌표 계산', positions.size === 37, String(positions.size));
  check(
    '좌표가 유한한 값',
    [...positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  );
  const ys = [...positions.values()].map((p) => p.y);
  check('세로로 계층이 분리됨', Math.max(...ys) - Math.min(...ys) > 200);
  const conclusion = positions.get('1_20260907124500')!;
  const premise = positions.get('12_20260907124500')!;
  check(
    '결론이 전제보다 위쪽 (direction UP)',
    conclusion.y < premise.y,
    `conclusion.y=${conclusion.y} premise.y=${premise.y}`,
  );

  console.log('');
  if (failures > 0) {
    console.error(`${failures}개 항목 실패`);
    process.exit(1);
  }
  console.log('모든 스모크 테스트 통과');
}

void main();
