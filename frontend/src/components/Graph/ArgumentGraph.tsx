import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';
import { nodeAnnotationOf } from '../../store/reviewLogic';
import type { ArgumentCase, ArgumentNodeType } from '../../types/argument';
import type { Annotation, EdgeAnnotation, NodeAnnotation } from '../../types/annotation';
import { measureNode } from '../../layout/elkLayout';
import { INode } from './nodes/INode';
import { RANode } from './nodes/RANode';
import { CANode } from './nodes/CANode';
import { IssueNode } from './nodes/IssueNode';
import type { ArgumentNodeData } from './nodes/NodeShell';
import { GraphContextMenu, type ContextMenuState } from './GraphContextMenu';

const nodeTypes = {
  I: INode,
  RA: RANode,
  CA: CANode,
  ISSUE: IssueNode,
};

const NODE_TYPE_LABEL: Record<ArgumentNodeType, string> = {
  I: '진술(I)',
  RA: '추론(RA)',
  CA: '반박(CA)',
  ISSUE: '쟁점(ISSUE)',
};

/** 쟁점 노드에 도달하는 모든 조상 노드(하위 논증)를 찾는다. */
function collectAncestors(argumentCase: ArgumentCase, rootId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of argumentCase.edges) {
    const list = incoming.get(edge.target);
    if (list) list.push(edge.source);
    else incoming.set(edge.target, [edge.source]);
  }

  const visited = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const source of incoming.get(current) ?? []) {
      if (!visited.has(source)) {
        visited.add(source);
        queue.push(source);
      }
    }
  }
  return visited;
}

export const DRAFT_EDGE_PREFIX = 'draft:';

/** 초안 레이어에 표시할 제안: 활성 실행의 pending (옵션으로 rejected 포함) */
function draftAnnotations(
  annotations: Annotation[],
  activeRunId: string | null,
  showRejected: boolean,
): { nodes: NodeAnnotation[]; edges: EdgeAnnotation[] } {
  const scoped = annotations.filter(
    (annotation) =>
      (!activeRunId || annotation.runId === activeRunId) &&
      (annotation.status === 'pending' || (showRejected && annotation.status === 'rejected')),
  );
  return {
    nodes: scoped.filter((a): a is NodeAnnotation => a.kind === 'node'),
    edges: scoped.filter((a): a is EdgeAnnotation => a.kind === 'edge'),
  };
}

function toFlowNodes(
  argumentCase: ArgumentCase,
  highlighted: Set<string> | null,
  drafts: NodeAnnotation[],
  annotations: Annotation[],
  selectedAnnotationId: string | null,
): Node<ArgumentNodeData>[] {
  const accepted: Node<ArgumentNodeData>[] = argumentCase.nodes
    .filter((node) => node.visible)
    .map((node) => {
      const annotation = nodeAnnotationOf(annotations, node.id);
      return {
        id: node.id,
        type: node.type,
        position: { x: node.x, y: node.y },
        data: {
          text: node.text,
          nodeType: node.type,
          draft: false,
          status: annotation?.status,
          origin: annotation?.origin,
          annotationId: annotation?.id,
          hasEvidence: annotation ? annotation.evidence.some((span) => span.start !== null) : undefined,
        },
        className: [
          highlighted && !highlighted.has(node.id) ? 'is-dimmed' : '',
          annotation && annotation.id === selectedAnnotationId ? 'is-annotation-selected' : '',
        ]
          .filter(Boolean)
          .join(' ') || undefined,
      };
    });
  const acceptedIds = new Set(accepted.map((node) => node.id));
  const draftNodes: Node<ArgumentNodeData>[] = drafts
    .filter((annotation) => !acceptedIds.has(annotation.nodeId))
    .map((annotation) => ({
      id: annotation.nodeId,
      type: annotation.currentValue.type,
      position: { x: annotation.currentValue.x ?? 0, y: annotation.currentValue.y ?? 0 },
      data: {
        text: annotation.currentValue.text,
        nodeType: annotation.currentValue.type,
        draft: true,
        status: annotation.status,
        origin: annotation.origin,
        annotationId: annotation.id,
        hasEvidence: annotation.evidence.some((span) => span.start !== null),
      },
      className: [
        'is-draft',
        `is-draft-${annotation.status}`,
        highlighted ? 'is-dimmed' : '',
        annotation.id === selectedAnnotationId ? 'is-annotation-selected' : '',
      ]
        .filter(Boolean)
        .join(' '),
    }));
  return [...accepted, ...draftNodes];
}

function toFlowEdges(
  argumentCase: ArgumentCase,
  highlighted: Set<string> | null,
  drafts: EdgeAnnotation[],
  visibleNodeIds: Set<string>,
): Edge[] {
  const accepted: Edge[] = argumentCase.edges
    .filter((edge) => edge.visible)
    .map((edge) => ({
      id: String(edge.id),
      source: edge.source,
      target: edge.target,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      className:
        highlighted && !(highlighted.has(edge.source) && highlighted.has(edge.target))
          ? 'is-dimmed'
          : undefined,
    }));
  const draftEdges: Edge[] = drafts
    .filter((edge) => visibleNodeIds.has(edge.currentValue.source) && visibleNodeIds.has(edge.currentValue.target))
    .map((edge) => ({
      id: `${DRAFT_EDGE_PREFIX}${edge.id}`,
      source: edge.currentValue.source,
      target: edge.currentValue.target,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      className: `is-draft is-draft-${edge.status}${highlighted ? ' is-dimmed' : ''}`,
      data: { annotationId: edge.id },
    }));
  return [...accepted, ...draftEdges];
}

export function ArgumentGraph() {
  const caseData = useGraphStore((state) => state.caseData);
  const graphVersion = useGraphStore((state) => state.graphVersion);
  const fitViewToken = useGraphStore((state) => state.fitViewToken);
  const focusRequest = useGraphStore((state) => state.focusRequest);
  const highlightIssueId = useGraphStore((state) => state.highlightIssueId);

  const addNode = useGraphStore((state) => state.addNode);
  const addEdgeToStore = useGraphStore((state) => state.addEdge);
  const deleteNodes = useGraphStore((state) => state.deleteNodes);
  const deleteEdges = useGraphStore((state) => state.deleteEdges);
  const commitNodePositions = useGraphStore((state) => state.commitNodePositions);
  const setSelection = useGraphStore((state) => state.setSelection);
  const setHighlightIssue = useGraphStore((state) => state.setHighlightIssue);
  const setErrorMessage = useGraphStore((state) => state.setErrorMessage);
  const annotations = useGraphStore((state) => state.annotations);

  const activeRunId = useAnnotationStore((state) => state.activeRunId);
  const showRejected = useAnnotationStore((state) => state.showRejected);
  const selectedAnnotationId = useAnnotationStore((state) => state.selectedAnnotationId);
  const selectAnnotation = useAnnotationStore((state) => state.select);
  const moveDraft = useAnnotationStore((state) => state.moveDraft);
  const rejectAnnotation = useAnnotationStore((state) => state.reject);

  const { fitView, setCenter, screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ArgumentNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const highlighted = useMemo(() => {
    if (!caseData || !highlightIssueId) return null;
    return collectAncestors(caseData, highlightIssueId);
  }, [caseData, highlightIssueId]);

  // 스토어 -> React Flow 동기화. 구조/좌표/초안 레이어가 바뀔 때만 다시 만든다.
  useEffect(() => {
    if (!caseData) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const drafts = draftAnnotations(annotations, activeRunId, showRejected);
    const flowNodes = toFlowNodes(caseData, highlighted, drafts.nodes, annotations, selectedAnnotationId);
    const flowEdges = toFlowEdges(caseData, highlighted, drafts.edges, new Set(flowNodes.map((node) => node.id)));
    // 다시 만들 때 React Flow 의 선택 상태는 유지한다 (카드 선택 동기화로 재빌드되어도 선택이 풀리지 않게).
    setNodes((previous) => {
      const selected = new Set(previous.filter((node) => node.selected).map((node) => node.id));
      return flowNodes.map((node) => (selected.has(node.id) ? { ...node, selected: true } : node));
    });
    setEdges((previous) => {
      const selected = new Set(previous.filter((edge) => edge.selected).map((edge) => edge.id));
      return flowEdges.map((edge) => (selected.has(edge.id) ? { ...edge, selected: true } : edge));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion, highlighted, caseData === null, activeRunId, showRejected, selectedAnnotationId]);

  // Fit view 요청
  useEffect(() => {
    if (fitViewToken === 0) return;
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.15, duration: 400 });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [fitViewToken, fitView]);

  // 특정 노드로 이동 요청 (확정 노드와 초안 노드 모두)
  useEffect(() => {
    if (!focusRequest || !caseData) return;
    const accepted = caseData.nodes.find((node) => node.id === focusRequest.nodeId);
    const draft = accepted ? null : nodeAnnotationOf(annotations, focusRequest.nodeId);
    const target = accepted
      ? accepted
      : draft
        ? {
            id: draft.nodeId,
            type: draft.currentValue.type,
            text: draft.currentValue.text,
            x: draft.currentValue.x ?? 0,
            y: draft.currentValue.y ?? 0,
            visible: true,
          }
        : null;
    if (!target) return;
    const { width, height } = measureNode(target);
    void setCenter(target.x + width / 2, target.y + height / 2, { zoom: 1, duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, setCenter]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<ArgumentNodeData>>[]) => {
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const acceptedIds = new Set(useGraphStore.getState().caseData?.nodes.map((node) => node.id) ?? []);
      if (!acceptedIds.has(connection.source) || !acceptedIds.has(connection.target)) {
        setErrorMessage('초안(미검토) 노드에는 관계를 연결할 수 없습니다. 먼저 노드 제안을 수락하세요.');
        return;
      }
      addEdgeToStore(connection.source, connection.target);
    },
    [addEdgeToStore, setErrorMessage],
  );

  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
      setSelection(
        selectedNodes.map((node) => node.id),
        selectedEdges.map((edge) => Number(edge.id)).filter((id) => Number.isFinite(id)),
      );
      // 그래프 선택 -> 검토 카드 동기화 (노드 1개 또는 초안 엣지 1개일 때)
      if (selectedNodes.length === 1 && selectedEdges.length === 0) {
        const data = selectedNodes[0].data as ArgumentNodeData;
        selectAnnotation(data.annotationId ?? null);
      } else if (selectedEdges.length === 1 && selectedNodes.length === 0) {
        const edge = selectedEdges[0];
        const annotationId = edge.id.startsWith(DRAFT_EDGE_PREFIX)
          ? edge.id.slice(DRAFT_EDGE_PREFIX.length)
          : (useGraphStore
              .getState()
              .annotations.find((a) => a.kind === 'edge' && a.acceptedEdgeId === Number(edge.id))?.id ?? null);
        selectAnnotation(annotationId);
      }
    },
    [setSelection, selectAnnotation],
  );

  const isDraftNode = useCallback((id: string) => {
    const node = nodes.find((item) => item.id === id);
    return !!node && !!(node.data as ArgumentNodeData).draft;
  }, [nodes]);

  const handleAddNode = useCallback(
    (type: ArgumentNodeType, flowX: number, flowY: number) => {
      // RA / CA 는 별도 텍스트가 필요 없고, I / ISSUE 만 내용을 입력받는다.
      let text: string = type;
      if (type === 'I' || type === 'ISSUE') {
        const input = window.prompt(`${NODE_TYPE_LABEL[type]} 텍스트를 입력하세요.`, '');
        if (input === null) return;
        text = input.trim();
      }
      addNode(type, text, { x: flowX, y: flowY });
    },
    [addNode],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = useCallback(
    (event: React.MouseEvent, target: ContextMenuState['target']) => {
      event.preventDefault();
      const bounds = wrapperRef.current?.getBoundingClientRect();
      setMenu({
        screenX: event.clientX - (bounds?.left ?? 0),
        screenY: event.clientY - (bounds?.top ?? 0),
        target,
      });
    },
    [],
  );

  if (!caseData) {
    return (
      <div className="graph-empty">
        <p>판결문을 입력하거나 JSON 파일을 불러오면 논증 그래프가 여기에 표시됩니다.</p>
        <p className="graph-empty-hint">상단의 [판결문 입력] 또는 [JSON 불러오기] 버튼을 사용하세요.</p>
      </div>
    );
  }

  return (
    <div className="graph-wrapper" ref={wrapperRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onSelectionChange={handleSelectionChange}
        onNodeDragStop={(_event, _node, dragged) => {
          const accepted = dragged.filter((node) => !(node.data as ArgumentNodeData).draft);
          commitNodePositions(
            accepted.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
          );
          for (const node of dragged) {
            const data = node.data as ArgumentNodeData;
            if (data.draft && data.annotationId) moveDraft(data.annotationId, node.position.x, node.position.y);
          }
        }}
        onNodesDelete={(deleted) => {
          // 초안 노드 삭제 = 제안 거절, 확정 노드 삭제 = 그래프에서 제거(AI 제안이면 거절로 기록)
          const acceptedIds = deleted.filter((node) => !isDraftNode(node.id)).map((node) => node.id);
          if (acceptedIds.length > 0) deleteNodes(acceptedIds);
          for (const node of deleted) {
            const data = node.data as ArgumentNodeData;
            if (data.draft && data.annotationId) rejectAnnotation(data.annotationId);
          }
        }}
        onEdgesDelete={(deleted) => {
          const acceptedIds = deleted.map((edge) => Number(edge.id)).filter((id) => Number.isFinite(id));
          if (acceptedIds.length > 0) deleteEdges(acceptedIds);
          for (const edge of deleted) {
            if (edge.id.startsWith(DRAFT_EDGE_PREFIX)) rejectAnnotation(edge.id.slice(DRAFT_EDGE_PREFIX.length));
          }
        }}
        onPaneContextMenu={(event) => {
          const position = screenToFlowPosition({
            x: (event as React.MouseEvent).clientX,
            y: (event as React.MouseEvent).clientY,
          });
          openMenu(event as React.MouseEvent, {
            kind: 'pane',
            flowX: position.x,
            flowY: position.y,
          });
        }}
        onNodeContextMenu={(event, node) =>
          openMenu(event, {
            kind: 'node',
            nodeId: node.id,
            draftAnnotationId: (node.data as ArgumentNodeData).draft
              ? (node.data as ArgumentNodeData).annotationId
              : undefined,
          })
        }
        onEdgeContextMenu={(event, edge) =>
          edge.id.startsWith(DRAFT_EDGE_PREFIX)
            ? openMenu(event, { kind: 'edge', edgeId: NaN, draftAnnotationId: edge.id.slice(DRAFT_EDGE_PREFIX.length) })
            : openMenu(event, { kind: 'edge', edgeId: Number(edge.id) })
        }
        onPaneClick={() => {
          closeMenu();
          if (highlightIssueId) setHighlightIssue(null);
        }}
        onMoveStart={closeMenu}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        deleteKeyCode={['Delete', 'Backspace']}
        minZoom={0.05}
        maxZoom={2.5}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
      </ReactFlow>

      {menu ? (
        <GraphContextMenu
          menu={menu}
          onClose={closeMenu}
          onAddNode={handleAddNode}
          onDeleteNode={(nodeId) => deleteNodes([nodeId])}
          onDeleteEdge={(edgeId) => deleteEdges([edgeId])}
          onFocusNode={(nodeId) => useGraphStore.getState().requestFocus(nodeId)}
          onAcceptDraft={(annotationId) =>
            useAnnotationStore.getState().accept(annotationId, { withDependencies: true, withConnectableEdges: true })
          }
          onRejectDraft={(annotationId) => rejectAnnotation(annotationId)}
        />
      ) : null}
    </div>
  );
}
