import { useCallback, useEffect, useMemo, useRef } from 'react';
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
} from '@xyflow/react';
import { usePipelineStore } from '../../store/pipelineStore';
import { canConnect, connectedFields, parseHandle } from '../../pipeline/flowUtils';
import type { LfSourceHandle, LfTargetHandle, PipelineIssue } from '@aif/workbench/types/pipeline';
import { LfNodeView, type LfFlowNode } from './LfNodeView';
import { t, useT } from '@aif/workbench/i18n';

const nodeTypes = { lf: LfNodeView };

export const PALETTE_MIME = 'application/x-aif-pipeline-template';

export function PipelineCanvas() {
  const tr = useT();
  const data = usePipelineStore((state) => state.data);
  const current = usePipelineStore((state) => state.current);
  const version = usePipelineStore((state) => state.version);
  const localIssues = usePipelineStore((state) => state.localIssues);
  const serverIssues = usePipelineStore((state) => state.serverIssues);
  const selectedNodeId = usePipelineStore((state) => state.selectedNodeId);
  const select = usePipelineStore((state) => state.select);
  const moveNodes = usePipelineStore((state) => state.moveNodes);
  const connect = usePipelineStore((state) => state.connect);
  const deleteNodes = usePipelineStore((state) => state.deleteNodes);
  const deleteEdges = usePipelineStore((state) => state.deleteEdges);
  const addComponent = usePipelineStore((state) => state.addComponent);

  const { fitView, screenToFlowPosition } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<LfFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const lastFlowId = useRef<string | null>(null);

  const issueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of [...localIssues, ...(serverIssues ?? [])] as PipelineIssue[]) {
      if (issue.level === 'error' && issue.nodeId) counts.set(issue.nodeId, (counts.get(issue.nodeId) ?? 0) + 1);
    }
    return counts;
  }, [localIssues, serverIssues]);

  // 스토어 → React Flow. 필드 값만 바뀌면 node data 만 갱신한다.
  useEffect(() => {
    if (!data || !current) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes((previous) => {
      const selected = new Set(previous.filter((node) => node.selected).map((node) => node.id));
      return data.nodes.map((node) => ({
        id: node.id,
        type: 'lf' as const,
        position: { ...node.position },
        selected: selected.has(node.id) || node.id === selectedNodeId,
        data: {
          lfNode: node,
          support: current.support[node.id],
          connected: [...connectedFields(data, node.id).keys()],
          errorCount: issueCounts.get(node.id) ?? 0,
          isRelayInput: node.id === current.relay.inputComponentId,
          isRelayOutput: node.id === current.relay.outputComponentId,
        },
      }));
    });
    setEdges(
      data.edges.map((edge) => {
        const sourceHandle = parseHandle<LfSourceHandle>(edge.data?.sourceHandle ?? edge.sourceHandle);
        const targetHandle = parseHandle<LfTargetHandle>(edge.data?.targetHandle ?? edge.targetHandle);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: sourceHandle?.name ?? null,
          targetHandle: targetHandle?.fieldName ?? null,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          className: 'lf-edge',
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, current, issueCounts, version]);

  useEffect(() => {
    const flowId = current?.flow.id ?? null;
    if (flowId && flowId !== lastFlowId.current) {
      lastFlowId.current = flowId;
      const timer = window.setTimeout(() => void fitView({ padding: 0.12, duration: 300 }), 60);
      return () => window.clearTimeout(timer);
    }
  }, [current, fitView]);

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const state = usePipelineStore.getState();
      if (!state.data || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return false;
      return canConnect(state.data, connection.source, connection.sourceHandle, connection.target, connection.targetHandle).ok;
    },
    [],
  );

  if (!data || !current) {
    return (
      <div className="graph-empty">
        <p>{tr('lf.canvas.empty')}</p>
        <p className="graph-empty-hint">{tr('lf.canvas.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div
      className="graph-wrapper pipeline-canvas"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(PALETTE_MIME)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event) => {
        const key = event.dataTransfer.getData(PALETTE_MIME);
        if (!key) return;
        event.preventDefault();
        addComponent(key, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        isValidConnection={isValidConnection}
        onConnect={(connection) => {
          if (connection.source && connection.target && connection.sourceHandle && connection.targetHandle) {
            connect(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
          }
        }}
        onNodeClick={(_event, node) => select(node.id)}
        onPaneClick={() => select(null)}
        onNodeDragStop={(_event, _node, dragged) => moveNodes(dragged.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })))}
        onBeforeDelete={async ({ nodes: deleting, edges: deletingEdges }) => {
          // 중계 서버 입력·출력 컴포넌트는 캔버스에서도 지워지지 않게 미리 걸러 낸다.
          const relay = [current.relay.inputComponentId, current.relay.outputComponentId];
          const kept = deleting.filter((node) => !relay.includes(node.id));
          if (kept.length !== deleting.length) {
            usePipelineStore.setState({
              message: { kind: 'error', text: t('lf.canvas.relayProtected') },
            });
          }
          const blocked = new Set(deleting.filter((node) => relay.includes(node.id)).map((node) => node.id));
          return {
            nodes: kept,
            // 막힌 노드에 딸려 지워질 뻔한 연결은 남기고, 사용자가 직접 고른 연결만 지운다.
            edges: deletingEdges.filter((edge) => edge.selected || !(blocked.has(edge.source) || blocked.has(edge.target))),
          };
        }}
        onNodesDelete={(deleted) => deleteNodes(deleted.map((node) => node.id))}
        onEdgesDelete={(deleted) => deleteEdges(deleted.map((edge) => edge.id))}
        deleteKeyCode={['Delete', 'Backspace']}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
      </ReactFlow>
    </div>
  );
}
