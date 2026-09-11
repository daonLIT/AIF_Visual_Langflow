import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { ArgumentCase, ArgumentNode, ArgumentNodeType } from '../types/argument';

const elk = new ELK();

/** 레이아웃 계산에 사용할 노드 크기. 실제 렌더 크기와 맞춰야 한다. */
export const NODE_SIZE: Record<ArgumentNodeType, { width: number; height: number }> = {
  I: { width: 230, height: 96 },
  RA: { width: 52, height: 52 },
  CA: { width: 52, height: 52 },
  ISSUE: { width: 280, height: 110 },
};

export function measureNode(node: ArgumentNode): { width: number; height: number } {
  const base = NODE_SIZE[node.type];
  if (node.type === 'RA' || node.type === 'CA') return base;

  // 텍스트 길이에 따라 높이를 늘려 겹침을 줄인다.
  const charsPerLine = node.type === 'ISSUE' ? 18 : 16;
  const lines = Math.max(1, Math.ceil(node.text.length / charsPerLine));
  const height = Math.min(320, Math.max(base.height, 40 + lines * 22));
  return { width: base.width, height };
}

/**
 * 계층형(layered) 레이아웃. 방향은 아래에서 위(UP): 증거 → 추론 → 결론.
 * ISSUE 노드는 같은 계층에 모이므로 자연스럽게 가로로 배치된다.
 */
export async function layoutCase(argumentCase: ArgumentCase): Promise<Map<string, { x: number; y: number }>> {
  const visibleNodes = argumentCase.nodes.filter((node) => node.visible);
  if (visibleNodes.length === 0) return new Map();

  const visibleIds = new Set(visibleNodes.map((node) => node.id));

  const children: ElkNode[] = visibleNodes.map((node) => {
    const { width, height } = measureNode(node);
    return { id: node.id, width, height };
  });

  const edges: ElkExtendedEdge[] = argumentCase.edges
    .filter(
      (edge) =>
        edge.visible &&
        visibleIds.has(edge.source) &&
        visibleIds.has(edge.target) &&
        edge.source !== edge.target,
    )
    .map((edge) => ({
      id: `e${edge.id}`,
      sources: [edge.source],
      targets: [edge.target],
    }));

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      // 전제(아래) 에서 결론(위) 으로 향하게 한다.
      'elk.direction': 'UP',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '48',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.edgeRouting': 'POLYLINE',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '120',
    },
    children,
    edges,
  };

  const result = await elk.layout(graph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    if (typeof child.x === 'number' && typeof child.y === 'number') {
      positions.set(child.id, { x: child.x, y: child.y });
    }
  }
  return positions;
}
