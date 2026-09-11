import type {
  ArgumentCase,
  ArgumentEdge,
  ArgumentNode,
  ArgumentNodeType,
} from '../types/argument';
import { isArgumentNodeType } from '../types/argument';
import type {
  RawAifEdge,
  RawAifNode,
  RawCaseJson,
  RawOvaEdge,
  RawOvaNode,
} from '../types/rawJson';

export interface ImportResult {
  case: ArgumentCase;
  /** 좌표가 없는 노드가 있어 자동 레이아웃이 필요한지 여부 */
  needsLayout: boolean;
  warnings: string[];
}

export class ImportError extends Error {}

const DEFAULT_X = 0;
const DEFAULT_Y = 0;

/** AIF 의 type 문자열을 내부 노드 타입으로 정규화한다. */
function normalizeType(rawType: unknown): ArgumentNodeType {
  if (typeof rawType !== 'string') return 'I';
  const upper = rawType.trim().toUpperCase();
  if (isArgumentNodeType(upper)) return upper;
  // AIF 표준의 다른 S-node(MA, PA, TA 등)는 추론 노드로 취급한다.
  if (upper === 'MA' || upper === 'PA' || upper === 'TA') return 'RA';
  return 'I';
}

function edgeKey(fromID: string, toID: string): string {
  return `${fromID} ${toID}`;
}

export function importAifOva(input: unknown, fileName?: string): ImportResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ImportError('최상위 구조가 JSON 객체가 아닙니다.');
  }

  const raw = input as RawCaseJson;
  const aif = raw.AIF;
  if (typeof aif !== 'object' || aif === null) {
    throw new ImportError('AIF 섹션이 없습니다.');
  }
  if (!Array.isArray(aif.nodes)) {
    throw new ImportError('AIF.nodes 가 배열이 아닙니다.');
  }
  if (aif.edges !== undefined && !Array.isArray(aif.edges)) {
    throw new ImportError('AIF.edges 가 배열이 아닙니다.');
  }

  const warnings: string[] = [];

  const ova = (typeof raw.OVA === 'object' && raw.OVA !== null ? raw.OVA : {}) as NonNullable<
    RawCaseJson['OVA']
  >;
  const ovaNodes: RawOvaNode[] = Array.isArray(ova.nodes) ? ova.nodes : [];
  const ovaEdges: RawOvaEdge[] = Array.isArray(ova.edges) ? ova.edges : [];

  const ovaByNodeId = new Map<string, RawOvaNode>();
  for (const ovaNode of ovaNodes) {
    if (ovaNode && typeof ovaNode.nodeID === 'string') {
      ovaByNodeId.set(ovaNode.nodeID, ovaNode);
    }
  }

  const ovaEdgeByEndpoints = new Map<string, RawOvaEdge>();
  for (const ovaEdge of ovaEdges) {
    if (ovaEdge && typeof ovaEdge.fromID === 'string' && typeof ovaEdge.toID === 'string') {
      ovaEdgeByEndpoints.set(edgeKey(ovaEdge.fromID, ovaEdge.toID), ovaEdge);
    }
  }

  // ---- 노드 ----
  const nodes: ArgumentNode[] = [];
  const seenNodeIds = new Set<string>();
  let missingPosition = 0;

  for (const rawNode of aif.nodes as RawAifNode[]) {
    if (!rawNode || typeof rawNode.nodeID !== 'string') {
      warnings.push('nodeID 가 없는 AIF 노드를 건너뛰었습니다.');
      continue;
    }
    if (seenNodeIds.has(rawNode.nodeID)) {
      // 중복이라도 버리지 않는다. 검증 단계(RULE 08)에서 보고된다.
      warnings.push(`중복된 nodeID: ${rawNode.nodeID}`);
    }
    seenNodeIds.add(rawNode.nodeID);

    const ovaNode = ovaByNodeId.get(rawNode.nodeID);
    const hasX = typeof ovaNode?.x === 'number' && Number.isFinite(ovaNode.x);
    const hasY = typeof ovaNode?.y === 'number' && Number.isFinite(ovaNode.y);
    if (!hasX || !hasY) missingPosition += 1;

    nodes.push({
      id: rawNode.nodeID,
      type: normalizeType(rawNode.type),
      text: typeof rawNode.text === 'string' ? rawNode.text : '',
      x: hasX ? (ovaNode!.x as number) : DEFAULT_X,
      y: hasY ? (ovaNode!.y as number) : DEFAULT_Y,
      visible: ovaNode?.visible === undefined ? true : Boolean(ovaNode.visible),
      raw: { ...rawNode },
      rawOva: ovaNode ? { ...ovaNode } : undefined,
    });
  }

  // ---- 엣지 ----
  const edges: ArgumentEdge[] = [];
  let fallbackEdgeId = 0;
  for (const rawEdge of (aif.edges ?? []) as RawAifEdge[]) {
    const numeric =
      typeof rawEdge?.edgeID === 'number' ? rawEdge.edgeID : Number(rawEdge?.edgeID);
    if (Number.isFinite(numeric) && numeric > fallbackEdgeId) fallbackEdgeId = numeric;
  }

  for (const rawEdge of (aif.edges ?? []) as RawAifEdge[]) {
    if (!rawEdge || typeof rawEdge.fromID !== 'string' || typeof rawEdge.toID !== 'string') {
      warnings.push('fromID/toID 가 없는 AIF 엣지를 건너뛰었습니다.');
      continue;
    }
    let id = typeof rawEdge.edgeID === 'number' ? rawEdge.edgeID : Number(rawEdge.edgeID);
    if (!Number.isFinite(id)) {
      fallbackEdgeId += 1;
      id = fallbackEdgeId;
      warnings.push(`edgeID 가 없는 엣지에 임시 ID ${id} 를 부여했습니다.`);
    }

    const ovaEdge = ovaEdgeByEndpoints.get(edgeKey(rawEdge.fromID, rawEdge.toID));

    edges.push({
      id,
      // fromID -> toID 를 그대로 source -> target 으로 사용한다(방향 반전 금지).
      source: rawEdge.fromID,
      target: rawEdge.toID,
      visible: ovaEdge?.visible === undefined ? true : Boolean(ovaEdge.visible),
      raw: { ...rawEdge },
      rawOva: ovaEdge ? { ...ovaEdge } : undefined,
    });
  }

  const argumentCase: ArgumentCase = {
    fileName,
    text: typeof raw.text === 'string' ? raw.text : '',
    nodes,
    edges,
    rawMetadata: { ...(raw as Record<string, unknown>) },
  };

  return {
    case: argumentCase,
    needsLayout: nodes.length > 0 && missingPosition === nodes.length,
    warnings,
  };
}

export function parseCaseJson(source: string, fileName?: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ImportError(`JSON 파싱 실패: ${(error as Error).message}`);
  }
  return importAifOva(parsed, fileName);
}
