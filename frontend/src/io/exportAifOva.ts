import type { ArgumentCase } from '../types/argument';
import type {
  RawAifEdge,
  RawAifNode,
  RawCaseJson,
  RawOvaEdge,
  RawOvaNode,
} from '../types/rawJson';

const AIF_ARRAY_KEYS = [
  'schemefulfillments',
  'participants',
  'locutions',
  'descriptorfulfillments',
  'cqdescriptorfulfillments',
] as const;

/**
 * import 한 원본 JSON 을 base 로 삼아 노드/엣지/좌표만 갱신한다.
 * 앱이 다루지 않는 필드는 그대로 보존한다.
 */
export function exportAifOva(argumentCase: ArgumentCase): RawCaseJson {
  const base = (argumentCase.rawMetadata ?? {}) as RawCaseJson;
  const baseAif = (typeof base.AIF === 'object' && base.AIF !== null ? base.AIF : {}) as NonNullable<
    RawCaseJson['AIF']
  >;
  const baseOva = (typeof base.OVA === 'object' && base.OVA !== null ? base.OVA : {}) as NonNullable<
    RawCaseJson['OVA']
  >;

  const aifNodes: RawAifNode[] = argumentCase.nodes.map((node) => ({
    ...(node.raw ?? {}),
    nodeID: node.id,
    text: node.text,
    type: node.type,
  }));

  const aifEdges: RawAifEdge[] = argumentCase.edges.map((edge) => ({
    ...(edge.raw ?? {}),
    edgeID: edge.id,
    fromID: edge.source,
    toID: edge.target,
  }));

  const ovaNodes: RawOvaNode[] = argumentCase.nodes.map((node) => ({
    timestamp: '',
    ...(node.rawOva ?? {}),
    nodeID: node.id,
    visible: node.visible,
    x: Math.round(node.x),
    y: Math.round(node.y),
  }));

  const ovaEdges: RawOvaEdge[] = argumentCase.edges.map((edge) => ({
    ...(edge.rawOva ?? {}),
    fromID: edge.source,
    toID: edge.target,
    visible: edge.visible,
  }));

  const aif: NonNullable<RawCaseJson['AIF']> = {
    ...baseAif,
    nodes: aifNodes,
    edges: aifEdges,
  };
  for (const key of AIF_ARRAY_KEYS) {
    if (!Array.isArray(aif[key])) aif[key] = [];
  }

  const ova: NonNullable<RawCaseJson['OVA']> = {
    firstname: 'Anon',
    surname: 'User',
    url: '',
    ...baseOva,
    nodes: ovaNodes,
    edges: ovaEdges,
  };

  return {
    ...base,
    AIF: aif,
    text: argumentCase.text,
    OVA: ova,
  };
}

export function serializeCase(argumentCase: ArgumentCase): string {
  return JSON.stringify(exportAifOva(argumentCase), null, 2);
}

/** 브라우저에서 JSON 파일을 내려받는다. */
export function downloadCaseJson(argumentCase: ArgumentCase, fileName?: string): void {
  const source = argumentCase.fileName ?? 'argument-case.json';
  const name = fileName ?? source.replace(/\.json$/i, '') + '.edited.json';

  const blob = new Blob([serializeCase(argumentCase)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
