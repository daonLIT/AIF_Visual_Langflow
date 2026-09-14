import type { ArgumentCase } from '../types/argument';
import { CONTENT_FIELDS } from '../types/argument';
import type { SchemeCatalog } from '../types/scheme';
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
export interface ExportOptions {
  /** 검증된 외부 schemeID(aifdbSchemeId) 가 있는 scheme 만 schemefulfillments 로 내보낸다. */
  schemeCatalog?: SchemeCatalog | null;
}

/** 앱이 관리하는 노드 필드. 원본 raw 값 대신 현재 값으로 쓴다(`scheme` 은 이전 형식이라 내보내지 않는다). */
const MANAGED_NODE_KEYS = new Set<string>(['nodeID', 'text', 'type', 'scheme', ...CONTENT_FIELDS]);

export function exportAifOva(argumentCase: ArgumentCase, options: ExportOptions = {}): RawCaseJson {
  const base = (argumentCase.rawMetadata ?? {}) as RawCaseJson;
  const baseAif = (typeof base.AIF === 'object' && base.AIF !== null ? base.AIF : {}) as NonNullable<
    RawCaseJson['AIF']
  >;
  const baseOva = (typeof base.OVA === 'object' && base.OVA !== null ? base.OVA : {}) as NonNullable<
    RawCaseJson['OVA']
  >;

  const aifNodes: RawAifNode[] = argumentCase.nodes.map((node) => {
    // 원본의 알 수 없는 필드는 보존하되, 앱이 관리하는 필드는 현재 값으로 덮어쓴다(지웠으면 제거).
    // text 는 전체 본문이고 summary 는 추가 필드다.
    const rest = Object.fromEntries(Object.entries(node.raw ?? {}).filter(([key]) => !MANAGED_NODE_KEYS.has(key)));
    const content = Object.fromEntries(CONTENT_FIELDS.filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));
    return { ...rest, nodeID: node.id, text: node.text, type: node.type, ...content };
  });

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
  // AIF 표준 schemefulfillments / descriptor 항목:
  // - 기존(외부) 항목은 노드가 확정 그래프에 남아 있는 한 그대로 둔다. 미검토·거절 노드의 항목은 남지 않는다.
  // - 앱의 schemeApplication 은 카탈로그에 검증된 외부 schemeID 가 있을 때만, 그 노드에 기존 항목이 없으면 추가한다.
  //   숫자 ID 를 추측하지 않으며 불명확한 기존 항목을 덮어쓰지 않는다.
  const nodeIds = new Set(argumentCase.nodes.map((node) => node.id));
  for (const key of ['schemefulfillments', 'descriptorfulfillments', 'cqdescriptorfulfillments'] as const) {
    const entries = Array.isArray(baseAif[key]) ? (baseAif[key] as unknown[]) : [];
    aif[key] = entries.filter((entry) => {
      const id = (entry as { nodeID?: unknown })?.nodeID;
      return typeof id !== 'string' || nodeIds.has(id);
    });
  }
  const fulfillments = aif.schemefulfillments as unknown[];
  const covered = new Set(fulfillments.map((entry) => (entry as { nodeID?: unknown })?.nodeID));
  for (const node of argumentCase.nodes) {
    if (node.type !== 'RA' || !node.schemeApplication || covered.has(node.id)) continue;
    const external = options.schemeCatalog?.schemes.find((item) => item.schemeKey === node.schemeApplication!.schemeKey)?.aifdbSchemeId;
    if (typeof external === 'number') fulfillments.push({ nodeID: node.id, schemeID: external });
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

export function serializeCase(argumentCase: ArgumentCase, options: ExportOptions = {}): string {
  return JSON.stringify(exportAifOva(argumentCase, options), null, 2);
}

/** 브라우저에서 JSON 파일을 내려받는다. */
export function downloadCaseJson(argumentCase: ArgumentCase, fileName?: string, options: ExportOptions = {}): void {
  const source = argumentCase.fileName ?? 'argument-case.json';
  const name = fileName ?? source.replace(/\.json$/i, '') + '.edited.json';

  const blob = new Blob([serializeCase(argumentCase, options)], {
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
