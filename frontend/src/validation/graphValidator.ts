import type { ArgumentCase, ValidationResult } from '../types/argument';
import { summaryStateOf } from '../types/argument';
import { CUSTOM, UNCLASSIFIED } from '../types/scheme';
import { issueSelectionProblems } from '../store/graphRules';

export interface ValidationSummary {
  results: ValidationResult[];
  errorCount: number;
  warningCount: number;
  nodeCount: number;
  edgeCount: number;
}

/**
 * RULE 01 엣지가 존재하지 않는 노드를 참조 (error)
 * RULE 02 자기 자신을 가리키는 엣지 (error)
 * RULE 03 I -> I 직접 연결 (error)
 * RULE 04 RA 노드에 들어오는 엣지 없음 (error)
 * RULE 05 RA 노드에서 나가는 엣지 없음 (error)
 * RULE 06 CA 노드의 in/out 이 각각 1개 미만 (error)
 * RULE 07 고립 노드 (warning)
 * RULE 08 중복 nodeID (error)
 * RULE 09 중복 edgeID (error)
 * RULE 10 OVA/AIF 불일치 (warning)
 * RULE 11 scheme 을 쓰는 그래프에서 RA scheme 정보 없음 / 미분류 (warning)
 * RULE 12 scheme 의 전제·결론 참조가 실제 연결과 다름 (warning)
 * RULE 13 카탈로그를 쓰는 그래프에서 쟁점 분류 없음 (warning)
 * RULE 14 세부 쟁점 중복 선택 또는 3개 초과 (error)
 * RULE 15 scheme 재검토 필요 / 결과 검증 오류 (warning)
 * RULE 16 요약을 만든 뒤 본문이 바뀜 (warning)
 */
export function validateCase(argumentCase: ArgumentCase): ValidationSummary {
  const results: ValidationResult[] = [];
  const { nodes, edges } = argumentCase;

  const nodeById = new Map<string, (typeof nodes)[number]>();
  const duplicateNodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) duplicateNodeIds.add(node.id);
    else nodeById.set(node.id, node);
  }

  // RULE 08
  for (const id of duplicateNodeIds) {
    results.push({
      level: 'error',
      code: 'RULE_08_DUPLICATE_NODE_ID',
      nodeId: id,
      message: `노드 ID 가 중복되었습니다: ${id}`,
    });
  }

  // RULE 09
  const seenEdgeIds = new Set<number>();
  for (const edge of edges) {
    if (seenEdgeIds.has(edge.id)) {
      results.push({
        level: 'error',
        code: 'RULE_09_DUPLICATE_EDGE_ID',
        edgeId: edge.id,
        message: `엣지 ID 가 중복되었습니다: ${edge.id}`,
      });
    }
    seenEdgeIds.add(edge.id);
  }

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);

    // RULE 01
    if (!source) {
      results.push({
        level: 'error',
        code: 'RULE_01_INVALID_NODE_REFERENCE',
        edgeId: edge.id,
        message: `엣지 ${edge.id} 의 fromID(${edge.source}) 에 해당하는 노드가 없습니다.`,
      });
    }
    if (!target) {
      results.push({
        level: 'error',
        code: 'RULE_01_INVALID_NODE_REFERENCE',
        edgeId: edge.id,
        message: `엣지 ${edge.id} 의 toID(${edge.target}) 에 해당하는 노드가 없습니다.`,
      });
    }

    // RULE 02
    if (edge.source === edge.target) {
      results.push({
        level: 'error',
        code: 'RULE_02_SELF_EDGE',
        edgeId: edge.id,
        nodeId: edge.source,
        message: `엣지 ${edge.id}: 노드가 자기 자신을 가리킵니다.`,
      });
    }

    // RULE 03
    if (source && target && source.type === 'I' && target.type === 'I') {
      results.push({
        level: 'error',
        code: 'RULE_03_I_TO_I',
        edgeId: edge.id,
        nodeId: source.id,
        message: `엣지 ${edge.id}: I 노드끼리 직접 연결할 수 없습니다. I → RA → I 형태로 연결하세요.`,
      });
    }

    bump(outgoing, edge.source);
    bump(incoming, edge.target);
  }

  for (const node of nodeById.values()) {
    const inCount = incoming.get(node.id) ?? 0;
    const outCount = outgoing.get(node.id) ?? 0;

    if (node.type === 'RA') {
      // RULE 04
      if (inCount === 0) {
        results.push({
          level: 'error',
          code: 'RULE_04_RA_NO_INCOMING',
          nodeId: node.id,
          message: 'RA 노드에 전제(들어오는 엣지)가 없습니다.',
        });
      }
      // RULE 05
      if (outCount === 0) {
        results.push({
          level: 'error',
          code: 'RULE_05_RA_NO_OUTGOING',
          nodeId: node.id,
          message: 'RA 노드에 결론(나가는 엣지)이 없습니다.',
        });
      }
    }

    // RULE 06
    if (node.type === 'CA' && (inCount === 0 || outCount === 0)) {
      results.push({
        level: 'error',
        code: 'RULE_06_CA_CONNECTIVITY',
        nodeId: node.id,
        message: `CA 노드는 들어오는 엣지와 나가는 엣지가 각각 1개 이상이어야 합니다. (in ${inCount} / out ${outCount})`,
      });
    }

    // RULE 07
    if (inCount === 0 && outCount === 0) {
      results.push({
        level: 'warning',
        code: 'RULE_07_ISOLATED_NODE',
        nodeId: node.id,
        message: '연결되지 않은 고립 노드입니다.',
      });
    }
  }

  // RULE 10: 불러온 원본 파일의 OVA / AIF 정합성.
  // 편집 중 삭제한 노드까지 경고로 잡히지 않도록, 현재 그래프가 아니라
  // import 당시의 AIF 노드 목록을 기준으로 판단한다.
  const rawMetadata = argumentCase.rawMetadata as
    | { AIF?: { nodes?: unknown }; OVA?: { nodes?: unknown; edges?: unknown } }
    | undefined;
  const originalAifIds = new Set<string>();
  if (Array.isArray(rawMetadata?.AIF?.nodes)) {
    for (const rawNode of rawMetadata!.AIF!.nodes as Array<Record<string, unknown>>) {
      if (typeof rawNode?.nodeID === 'string') originalAifIds.add(rawNode.nodeID);
    }
  }

  if (originalAifIds.size > 0) {
    const rawOvaNodes = Array.isArray(rawMetadata?.OVA?.nodes)
      ? (rawMetadata!.OVA!.nodes as Array<Record<string, unknown>>)
      : [];
    const rawOvaEdges = Array.isArray(rawMetadata?.OVA?.edges)
      ? (rawMetadata!.OVA!.edges as Array<Record<string, unknown>>)
      : [];

    for (const ovaNode of rawOvaNodes) {
      const id = ovaNode?.nodeID;
      if (typeof id === 'string' && ovaNode?.visible !== false && !originalAifIds.has(id)) {
        results.push({
          level: 'warning',
          code: 'RULE_10_OVA_AIF_MISMATCH',
          nodeId: id,
          message: `불러온 파일의 OVA 노드 ${id} 에 대응하는 AIF 노드가 없습니다.`,
        });
      }
    }

    for (const ovaEdge of rawOvaEdges) {
      for (const endpoint of [ovaEdge?.fromID, ovaEdge?.toID]) {
        if (typeof endpoint === 'string' && !originalAifIds.has(endpoint)) {
          results.push({
            level: 'warning',
            code: 'RULE_10_OVA_AIF_MISMATCH',
            nodeId: endpoint,
            message: `불러온 파일의 OVA 엣지가 존재하지 않는 노드 ${endpoint} 를 참조합니다.`,
          });
        }
      }
    }
  }

  // RULE 11~13: scheme·쟁점 카탈로그를 쓰는 그래프에서만 확인한다(이전 형식 파일에 경고가 쏟아지지 않게).
  const schemeAware = nodes.some((node) => node.type === 'RA' && node.schemeApplication);
  const catalogAware = nodes.some((node) => node.type === 'ISSUE' && node.issueRef);
  const sources = new Map<string, Set<string>>();
  const targets = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!sources.has(edge.target)) sources.set(edge.target, new Set());
    sources.get(edge.target)!.add(edge.source);
    if (!targets.has(edge.source)) targets.set(edge.source, new Set());
    targets.get(edge.source)!.add(edge.target);
  }
  for (const node of nodeById.values()) {
    const application = node.type === 'RA' ? node.schemeApplication : undefined;
    if (node.type === 'RA' && schemeAware) {
      if (!application) {
        // RULE 11
        results.push({ level: 'warning', code: 'RULE_11_RA_SCHEME_MISSING', nodeId: node.id, message: 'RA 노드에 scheme 정보가 없습니다.' });
      } else {
        if (application.schemeKey === UNCLASSIFIED) {
          results.push({ level: 'warning', code: 'RULE_11_RA_UNCLASSIFIED', nodeId: node.id, message: 'RA 가 미분류(적절한 scheme 없음) 상태입니다.' });
        }
        if (application.schemeKey === CUSTOM && !application.customSchemeName) {
          results.push({ level: 'warning', code: 'RULE_11_RA_CUSTOM_NAME', nodeId: node.id, message: '직접 작성 scheme 의 이름이 없습니다.' });
        }
        // RULE 12
        const incomingIds = sources.get(node.id) ?? new Set<string>();
        const outgoingIds = targets.get(node.id) ?? new Set<string>();
        const stale = application.premiseBindings.flatMap((binding) => binding.nodeIds).filter((id) => !incomingIds.has(id));
        if (stale.length > 0) {
          results.push({
            level: 'warning',
            code: 'RULE_12_SCHEME_REFERENCE',
            nodeId: node.id,
            message: `scheme 전제 참조 ${stale.length}개가 이 RA 로 연결된 노드가 아닙니다. scheme 을 다시 확인하세요.`,
          });
        }
        const badConclusions = application.conclusionNodeIds.filter((id) => !outgoingIds.has(id));
        if (badConclusions.length > 0) {
          results.push({ level: 'warning', code: 'RULE_12_SCHEME_REFERENCE', nodeId: node.id, message: 'scheme 의 결론 노드가 이 RA 가 가리키는 노드와 다릅니다.' });
        }
        // RULE 15
        if (application.status === 'needs_review') {
          results.push({
            level: 'warning',
            code: 'RULE_15_SCHEME_NEEDS_REVIEW',
            nodeId: node.id,
            message: `scheme 재검토 필요: ${(application.reviewReasons ?? []).join(' / ') || '연결 또는 본문 변경'}`,
          });
        }
        if (application.errors && application.errors.length > 0) {
          results.push({ level: 'warning', code: 'RULE_15_SCHEME_ERRORS', nodeId: node.id, message: `scheme 결과 검증 오류: ${application.errors.join(' / ')}` });
        }
      }
    }
    // RULE 13
    if (node.type === 'ISSUE' && catalogAware && !node.issueRef) {
      results.push({ level: 'warning', code: 'RULE_13_ISSUE_UNCLASSIFIED', nodeId: node.id, message: '쟁점 노드에 카탈로그 쟁점 분류가 없습니다.' });
    }
    // RULE 16
    if ((node.type === 'I' || node.type === 'ISSUE') && summaryStateOf(node) === 'stale') {
      results.push({ level: 'warning', code: 'RULE_16_SUMMARY_STALE', nodeId: node.id, message: '요약을 만든 뒤 본문이 바뀌었습니다. 요약을 다시 만들거나 고치세요.' });
    }
  }

  // RULE 14
  for (const problem of issueSelectionProblems(nodes)) {
    results.push({ level: 'error', code: 'RULE_14_ISSUE_SELECTION', message: problem });
  }

  const errorCount = results.filter((r) => r.level === 'error').length;

  return {
    results,
    errorCount,
    warningCount: results.length - errorCount,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}
