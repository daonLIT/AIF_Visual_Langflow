import { useEffect, useRef } from 'react';
import type { ArgumentNodeType } from '../../types/argument';

export type ContextMenuTarget =
  | { kind: 'pane'; flowX: number; flowY: number }
  | { kind: 'node'; nodeId: string; draftAnnotationId?: string }
  | { kind: 'edge'; edgeId: number; draftAnnotationId?: string };

export interface ContextMenuState {
  screenX: number;
  screenY: number;
  target: ContextMenuTarget;
}

interface GraphContextMenuProps {
  menu: ContextMenuState;
  onClose: () => void;
  onAddNode: (type: ArgumentNodeType, flowX: number, flowY: number) => void;
  onDeleteNode: (nodeId: string) => void;
  onDeleteEdge: (edgeId: number) => void;
  onFocusNode: (nodeId: string) => void;
  onAcceptDraft: (annotationId: string) => void;
  onRejectDraft: (annotationId: string) => void;
}

const ADDABLE: Array<{ type: ArgumentNodeType; label: string }> = [
  { type: 'I', label: 'I  진술 노드' },
  { type: 'RA', label: 'RA  추론 노드' },
  { type: 'CA', label: 'CA  반박 노드' },
  { type: 'ISSUE', label: 'ISSUE  쟁점 노드' },
];

export function GraphContextMenu({
  menu,
  onClose,
  onAddNode,
  onDeleteNode,
  onDeleteEdge,
  onFocusNode,
  onAcceptDraft,
  onRejectDraft,
}: GraphContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: menu.screenX, top: menu.screenY }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.target.kind === 'pane' ? (
        <>
          <div className="context-menu-title">노드 추가</div>
          {ADDABLE.map((item) => (
            <button
              key={item.type}
              type="button"
              className="context-menu-item"
              onClick={() => {
                const target = menu.target as Extract<ContextMenuTarget, { kind: 'pane' }>;
                onAddNode(item.type, target.flowX, target.flowY);
                onClose();
              }}
            >
              {item.label}
            </button>
          ))}
        </>
      ) : null}

      {menu.target.kind === 'node' && menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">초안 노드 (AI 제안)</div>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onAcceptDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            제안 수락
          </button>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onRejectDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            제안 거절
          </button>
          <div className="context-menu-hint">텍스트 편집: 노드 더블클릭</div>
        </>
      ) : null}

      {menu.target.kind === 'edge' && menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">초안 관계 (제안)</div>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onAcceptDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            관계 수락 (필요한 노드와 함께)
          </button>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onRejectDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            관계 거절
          </button>
        </>
      ) : null}

      {menu.target.kind === 'node' && !menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">노드</div>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onFocusNode((menu.target as { nodeId: string }).nodeId);
              onClose();
            }}
          >
            이 노드로 이동
          </button>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onDeleteNode((menu.target as { nodeId: string }).nodeId);
              onClose();
            }}
          >
            노드 삭제
          </button>
          <div className="context-menu-hint">텍스트 편집: 노드 더블클릭</div>
        </>
      ) : null}

      {menu.target.kind === 'edge' && !menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">엣지</div>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onDeleteEdge((menu.target as { edgeId: number }).edgeId);
              onClose();
            }}
          >
            엣지 삭제
          </button>
        </>
      ) : null}
    </div>
  );
}
