import { create } from 'zustand';
import type {
  ArgumentCase,
  ArgumentEdge,
  ArgumentNode,
  ArgumentNodeType,
  NodeFieldsPatch,
} from '../types/argument';
import { applyNodePatch } from '../types/argument';
import { isContentModified } from './reviewLogic';
import { afterTextEdit, flagSchemesForReview, issueAcceptProblem, raEndpoints } from './graphRules';
import type { Annotation, EvidenceSpan, NodeAnnotation } from '../types/annotation';
import { parseCaseJson } from '../io/importAifOva';
import { useCatalogStore } from './catalogStore';
import { layoutCase } from '../layout/elkLayout';
import { validateCase } from '../validation/graphValidator';
import type { ValidationSummary } from '../validation/graphValidator';
import { generateNodeId } from '../utils/generateNodeId';
import { generateEdgeId } from '../utils/generateEdgeId';
import { t } from '../i18n';

const HISTORY_LIMIT = 50;

export interface FocusRequest {
  nodeId: string;
  /** 같은 노드를 반복 클릭해도 반응하도록 매번 증가시키는 토큰 */
  token: number;
}

/**
 * undo/redo 단위. 확정 그래프와 검토 상태(annotations)는 항상 함께 되돌린다.
 * 검토 액션(수락/거절)은 annotationStore 가 아니라 이 스토어의 commit 을 통해 기록된다.
 */
export interface Snapshot {
  caseData: ArgumentCase;
  annotations: Annotation[];
}

export interface CommitOptions {
  /** false 면 구조가 바뀌지 않은 변경(좌표 등)이라 검증 결과를 유지한다. */
  structural?: boolean;
  /** 이 커밋에서 annotations 도 함께 바꾼다. */
  annotations?: Annotation[];
}

interface GraphState {
  caseData: ArgumentCase | null;
  fileName: string | null;
  /** 검토 데이터. caseData 와 같은 히스토리로 관리된다. */
  annotations: Annotation[];

  selectedNodeIds: string[];
  selectedEdgeIds: number[];

  validation: ValidationSummary | null;
  validationOpen: boolean;

  importWarnings: string[];
  errorMessage: string | null;
  isLayouting: boolean;

  /** 구조 변경 시마다 증가. 그래프 뷰가 스토어와 재동기화하는 기준. */
  graphVersion: number;
  /** 자동 레이아웃/불러오기 직후 fitView 를 트리거하기 위한 토큰 */
  fitViewToken: number;
  focusRequest: FocusRequest | null;
  /** 선택된 쟁점의 하위 논증만 강조하고 나머지는 흐리게 표시 */
  highlightIssueId: string | null;

  /** 삭제된 엣지 ID 재사용을 막기 위한 세션 하이워터마크 */
  edgeIdHighWater: number;

  past: Snapshot[];
  future: Snapshot[];
}

export interface AddNodeOptions {
  /** 원문 드래그로 만든 노드의 실제 선택 범위 */
  evidence?: EvidenceSpan[];
  /** 사람 annotation 을 만들지 않는다(불러오기 등) */
  skipAnnotation?: boolean;
}

interface GraphActions {
  loadFromJsonText: (source: string, fileName?: string) => Promise<void>;
  /** 새 판결문으로 빈 프로젝트를 시작한다. */
  startDocument: (text: string, fileName?: string) => void;
  /** 원문을 교체한다(문서 버전 증가는 annotationStore 가 담당). */
  replaceText: (text: string, annotations: Annotation[]) => void;
  /** 프로젝트 불러오기: 확정 그래프와 검토 상태를 한 번에 교체 */
  loadSnapshot: (snapshot: Snapshot, fileName?: string | null) => void;
  setErrorMessage: (message: string | null) => void;
  clearError: () => void;

  /** 확정 그래프·검토 상태를 한 번에 바꾸는 중앙 커밋 (undo 1단계) */
  commit: (next: ArgumentCase, options?: CommitOptions) => void;
  /** 검토 상태만 바꾸는 커밋 */
  commitAnnotations: (annotations: Annotation[], structural?: boolean) => void;

  addNode: (
    type: ArgumentNodeType,
    text: string,
    position: { x: number; y: number },
    options?: AddNodeOptions,
  ) => string;
  updateNodeText: (nodeId: string, text: string) => void;
  /** 확정 노드의 본문·요약·스킴·쟁점 참조 수정 (undo 1단계) */
  updateNodeFields: (nodeId: string, patch: NodeFieldsPatch) => void;
  deleteNodes: (nodeIds: string[]) => void;

  addEdge: (source: string, target: string) => number | null;
  deleteEdges: (edgeIds: number[]) => void;

  commitNodePositions: (positions: Array<{ id: string; x: number; y: number }>) => void;

  setSelection: (nodeIds: string[], edgeIds: number[]) => void;

  runValidation: () => void;
  setValidationOpen: (open: boolean) => void;

  runAutoLayout: () => Promise<void>;
  requestFitView: () => void;
  requestFocus: (nodeId: string) => void;
  setHighlightIssue: (nodeId: string | null) => void;

  undo: () => void;
  redo: () => void;
}

export type GraphStore = GraphState & GraphActions;

const initialState: GraphState = {
  caseData: null,
  fileName: null,
  annotations: [],
  selectedNodeIds: [],
  selectedEdgeIds: [],
  validation: null,
  validationOpen: false,
  importWarnings: [],
  errorMessage: null,
  isLayouting: false,
  graphVersion: 0,
  fitViewToken: 0,
  focusRequest: null,
  highlightIssueId: null,
  edgeIdHighWater: 0,
  past: [],
  future: [],
};

export function nowIso(): string {
  return new Date().toISOString();
}

function maxEdgeId(edges: ArgumentEdge[]): number {
  return edges.reduce((max, edge) => Math.max(max, edge.id), 0);
}

/** 그래프 편집이 검토 상태에 미치는 영향을 반영한다 (내용 수정 → modified, 삭제 → rejected). */
function annotationsAfterNodeEdit(annotations: Annotation[], nodeId: string, patch: NodeFieldsPatch): Annotation[] {
  return annotations.map((annotation) => {
    if (annotation.kind !== 'node' || annotation.nodeId !== nodeId) return annotation;
    if (annotation.status === 'rejected' || annotation.status === 'pending') return annotation;
    const currentValue = applyNodePatch(annotation.currentValue, patch);
    const modified = annotation.origin !== 'human' && isContentModified(annotation.originalValue, currentValue);
    return {
      ...annotation,
      status: modified ? 'modified' : annotation.status === 'modified' ? 'accepted' : annotation.status,
      currentValue,
      updatedAt: nowIso(),
    };
  });
}

function annotationsAfterDelete(
  annotations: Annotation[],
  removedNodeIds: Set<string>,
  removedEdgeIds: Set<number>,
): Annotation[] {
  const at = nowIso();
  return annotations
    .map((annotation): Annotation | null => {
      if (annotation.kind === 'node' && removedNodeIds.has(annotation.nodeId)) {
        // 사람이 만든 노드는 흔적 없이 지우고, AI 제안은 거절로 기록한다.
        if (annotation.origin === 'human') return null;
        return { ...annotation, status: 'rejected', note: 'graph-delete', updatedAt: at };
      }
      if (
        annotation.kind === 'edge' &&
        annotation.acceptedEdgeId !== undefined &&
        annotation.acceptedEdgeId !== null &&
        removedEdgeIds.has(annotation.acceptedEdgeId)
      ) {
        if (annotation.origin === 'human') return null;
        return { ...annotation, status: 'rejected', acceptedEdgeId: null, note: 'graph-delete', updatedAt: at };
      }
      return annotation;
    })
    .filter((annotation): annotation is Annotation => annotation !== null);
}

export const useGraphStore = create<GraphStore>((set, get) => {
  const commit: GraphActions['commit'] = (next, options = {}) => {
    const { caseData, annotations, past, graphVersion } = get();
    if (!caseData) return;
    set({
      caseData: next,
      annotations: options.annotations ?? annotations,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), { caseData, annotations }],
      future: [],
      graphVersion: graphVersion + 1,
      // 구조가 바뀌면 이전 검증 결과는 신뢰할 수 없다.
      validation: options.structural === false ? get().validation : null,
    });
  };

  const resetFor = (caseData: ArgumentCase, annotations: Annotation[], fileName: string | null, warnings: string[]) => {
    set({
      caseData,
      fileName,
      annotations,
      importWarnings: warnings,
      errorMessage: null,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      validation: null,
      validationOpen: false,
      highlightIssueId: null,
      edgeIdHighWater: maxEdgeId(caseData.edges),
      past: [],
      future: [],
      graphVersion: get().graphVersion + 1,
      fitViewToken: get().fitViewToken + 1,
    });
  };

  return {
    ...initialState,

    async loadFromJsonText(source, fileName) {
      try {
        const result = parseCaseJson(source, fileName, { schemeCatalog: useCatalogStore.getState().schemes });
        resetFor(result.case, [], fileName ?? null, result.warnings);
        if (result.needsLayout) {
          await get().runAutoLayout();
        }
      } catch (error) {
        set({ errorMessage: (error as Error).message });
      }
    },

    startDocument(text, fileName) {
      resetFor({ fileName, text, nodes: [], edges: [], rawMetadata: undefined }, [], fileName ?? null, []);
    },

    replaceText(text, annotations) {
      const { caseData } = get();
      if (!caseData) return;
      commit({ ...caseData, text }, { annotations, structural: false });
    },

    loadSnapshot(snapshot, fileName) {
      resetFor(snapshot.caseData, snapshot.annotations, fileName ?? null, []);
    },

    setErrorMessage(message) {
      set({ errorMessage: message });
    },

    clearError() {
      set({ errorMessage: null });
    },

    commit,

    commitAnnotations(annotations, structural = false) {
      const { caseData } = get();
      if (!caseData) return;
      commit(caseData, { annotations, structural });
    },

    addNode(type, text, position, options = {}) {
      const { caseData, annotations } = get();
      if (!caseData) return '';

      const id = generateNodeId(caseData.nodes.map((node) => node.id));
      const node: ArgumentNode = {
        id,
        type,
        text,
        x: position.x,
        y: position.y,
        visible: true,
      };
      let nextAnnotations = annotations;
      if (!options.skipAnnotation) {
        const at = nowIso();
        const value = { type, text, x: position.x, y: position.y };
        const human: NodeAnnotation = {
          id: `human:node:${id}`,
          runId: 'human',
          kind: 'node',
          nodeId: id,
          origin: 'human',
          status: 'accepted',
          originalValue: value,
          currentValue: { ...value },
          evidence: options.evidence ?? [],
          createdAt: at,
          updatedAt: at,
        };
        nextAnnotations = [...annotations, human];
      }
      commit({ ...caseData, nodes: [...caseData.nodes, node] }, { annotations: nextAnnotations });
      return id;
    },

    updateNodeText(nodeId, text) {
      get().updateNodeFields(nodeId, { text });
    },

    updateNodeFields(nodeId, patch) {
      const { caseData, annotations } = get();
      if (!caseData) return;
      const previous = caseData.nodes.find((node) => node.id === nodeId);
      if (!previous) return;
      if (patch.issueRef) {
        const problem = issueAcceptProblem(caseData, nodeId, { ...previous, issueRef: patch.issueRef });
        if (problem) {
          set({ errorMessage: problem });
          return;
        }
      }
      const nodes = caseData.nodes.map((node) => (node.id === nodeId ? applyNodePatch(node, patch) : node));
      let nextCase: ArgumentCase = { ...caseData, nodes };
      let nextAnnotations = annotationsAfterNodeEdit(annotations, nodeId, patch);
      // 본문이 바뀌면 연결된 RA scheme 과 이 노드의 근거를 재검토 대상으로 표시한다.
      if (patch.text !== undefined && patch.text !== previous.text) {
        const effects = afterTextEdit(nextCase, nextAnnotations, nodeId);
        nextCase = effects.caseData;
        nextAnnotations = effects.annotations;
      }
      commit(nextCase, { annotations: nextAnnotations });
    },

    deleteNodes(nodeIds) {
      const { caseData, annotations } = get();
      if (!caseData || nodeIds.length === 0) return;
      const removing = new Set(nodeIds);
      const removedEdgeList = caseData.edges.filter((edge) => removing.has(edge.source) || removing.has(edge.target));
      const removedEdges = new Set(removedEdgeList.map((edge) => edge.id));
      // 남는 RA 의 전제·결론이 사라지면 scheme 을 재검토 대상으로 둔다.
      const affectedRas = removedEdgeList
        .flatMap((edge) => raEndpoints(caseData, annotations, edge.source, edge.target))
        .filter((id) => !removing.has(id));
      const flagged = flagSchemesForReview(
        {
          ...caseData,
          nodes: caseData.nodes.filter((node) => !removing.has(node.id)),
          // 노드를 지우면 그 노드에 붙은 엣지도 함께 지운다.
          edges: caseData.edges.filter((edge) => !removedEdges.has(edge.id)),
        },
        annotationsAfterDelete(annotations, removing, removedEdges),
        affectedRas,
        t('rules.review.nodeDeleted'),
      );
      commit(flagged.caseData, { annotations: flagged.annotations });
      set({
        selectedNodeIds: get().selectedNodeIds.filter((id) => !removing.has(id)),
      });
    },

    addEdge(source, target) {
      const { caseData, edgeIdHighWater } = get();
      if (!caseData) return null;
      if (source === target) return null;
      const exists = caseData.edges.some(
        (edge) => edge.source === source && edge.target === target,
      );
      if (exists) return null;

      const id = generateEdgeId([
        edgeIdHighWater,
        ...caseData.edges.map((edge) => edge.id),
      ]);
      const edge: ArgumentEdge = { id, source, target, visible: true };
      const { annotations } = get();
      const flagged = flagSchemesForReview(
        { ...caseData, edges: [...caseData.edges, edge] },
        annotations,
        raEndpoints(caseData, annotations, source, target),
        t('rules.review.edgeAdded'),
      );
      commit(flagged.caseData, { annotations: flagged.annotations });
      set({ edgeIdHighWater: Math.max(edgeIdHighWater, id) });
      return id;
    },

    deleteEdges(edgeIds) {
      const { caseData, annotations } = get();
      if (!caseData || edgeIds.length === 0) return;
      const removing = new Set(edgeIds);
      const affectedRas = caseData.edges
        .filter((edge) => removing.has(edge.id))
        .flatMap((edge) => raEndpoints(caseData, annotations, edge.source, edge.target));
      const flagged = flagSchemesForReview(
        { ...caseData, edges: caseData.edges.filter((edge) => !removing.has(edge.id)) },
        annotationsAfterDelete(annotations, new Set(), removing),
        affectedRas,
        t('rules.review.edgeRemoved'),
      );
      commit(flagged.caseData, { annotations: flagged.annotations });
      set({
        selectedEdgeIds: get().selectedEdgeIds.filter((id) => !removing.has(id)),
      });
    },

    commitNodePositions(positions) {
      const { caseData } = get();
      if (!caseData || positions.length === 0) return;
      const byId = new Map(positions.map((position) => [position.id, position]));
      const moved = caseData.nodes.some((node) => {
        const next = byId.get(node.id);
        return next !== undefined && (next.x !== node.x || next.y !== node.y);
      });
      if (!moved) return;

      const nodes = caseData.nodes.map((node) => {
        const next = byId.get(node.id);
        return next ? { ...node, x: next.x, y: next.y } : node;
      });
      // 위치 변경은 그래프 구조를 바꾸지 않으므로 검증 결과를 유지한다.
      commit({ ...caseData, nodes }, { structural: false });
    },

    setSelection(nodeIds, edgeIds) {
      set({ selectedNodeIds: nodeIds, selectedEdgeIds: edgeIds });
    },

    runValidation() {
      const { caseData } = get();
      if (!caseData) return;
      set({ validation: validateCase(caseData), validationOpen: true });
    },

    setValidationOpen(open) {
      set({ validationOpen: open });
    },

    async runAutoLayout() {
      const { caseData } = get();
      if (!caseData) return;
      set({ isLayouting: true });
      try {
        const positions = await layoutCase(caseData);
        if (positions.size === 0) return;
        const nodes = caseData.nodes.map((node) => {
          const next = positions.get(node.id);
          return next ? { ...node, x: next.x, y: next.y } : node;
        });
        commit({ ...caseData, nodes }, { structural: false });
        set({ fitViewToken: get().fitViewToken + 1 });
      } catch (error) {
        set({ errorMessage: t('graph.layoutFailed', { message: (error as Error).message }) });
      } finally {
        set({ isLayouting: false });
      }
    },

    requestFitView() {
      set({ fitViewToken: get().fitViewToken + 1 });
    },

    requestFocus(nodeId) {
      const previous = get().focusRequest;
      set({ focusRequest: { nodeId, token: (previous?.token ?? 0) + 1 } });
    },

    setHighlightIssue(nodeId) {
      set({ highlightIssueId: nodeId });
    },

    undo() {
      const { past, caseData, annotations, future, graphVersion } = get();
      if (past.length === 0 || !caseData) return;
      const previous = past[past.length - 1];
      set({
        caseData: previous.caseData,
        annotations: previous.annotations,
        past: past.slice(0, -1),
        future: [{ caseData, annotations }, ...future].slice(0, HISTORY_LIMIT),
        graphVersion: graphVersion + 1,
        validation: null,
      });
    },

    redo() {
      const { future, caseData, annotations, past, graphVersion } = get();
      if (future.length === 0 || !caseData) return;
      const [next, ...rest] = future;
      set({
        caseData: next.caseData,
        annotations: next.annotations,
        future: rest,
        past: [...past, { caseData, annotations }].slice(-HISTORY_LIMIT),
        graphVersion: graphVersion + 1,
        validation: null,
      });
    },
  };
});

/** 파생 셀렉터 */
export const selectIssueNodes = (state: GraphStore): ArgumentNode[] =>
  state.caseData ? state.caseData.nodes.filter((node) => node.type === 'ISSUE') : [];
