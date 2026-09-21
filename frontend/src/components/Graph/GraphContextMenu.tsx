import { useEffect, useRef } from 'react';
import type { ArgumentNodeType } from '../../types/argument';
import { useT, type MessageKey } from '../../i18n';

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

const ADDABLE: Array<{ type: ArgumentNodeType; labelKey: MessageKey }> = [
  { type: 'I', labelKey: 'menu.add.i' },
  { type: 'RA', labelKey: 'menu.add.ra' },
  { type: 'CA', labelKey: 'menu.add.ca' },
  { type: 'ISSUE', labelKey: 'menu.add.issue' },
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
  const t = useT();
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
          <div className="context-menu-title">{t('menu.addNode')}</div>
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
              {t(item.labelKey)}
            </button>
          ))}
        </>
      ) : null}

      {menu.target.kind === 'node' && menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">{t('menu.draftNode')}</div>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onAcceptDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            {t('menu.acceptProposal')}
          </button>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onRejectDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            {t('menu.rejectProposal')}
          </button>
          <div className="context-menu-hint">{t('menu.editHint')}</div>
        </>
      ) : null}

      {menu.target.kind === 'edge' && menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">{t('menu.draftEdge')}</div>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onAcceptDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            {t('menu.acceptEdge')}
          </button>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onRejectDraft((menu.target as { draftAnnotationId: string }).draftAnnotationId);
              onClose();
            }}
          >
            {t('menu.rejectEdge')}
          </button>
        </>
      ) : null}

      {menu.target.kind === 'node' && !menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">{t('menu.node')}</div>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              onFocusNode((menu.target as { nodeId: string }).nodeId);
              onClose();
            }}
          >
            {t('menu.focusNode')}
          </button>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onDeleteNode((menu.target as { nodeId: string }).nodeId);
              onClose();
            }}
          >
            {t('menu.deleteNode')}
          </button>
          <div className="context-menu-hint">{t('menu.editHint')}</div>
        </>
      ) : null}

      {menu.target.kind === 'edge' && !menu.target.draftAnnotationId ? (
        <>
          <div className="context-menu-title">{t('menu.edge')}</div>
          <button
            type="button"
            className="context-menu-item is-danger"
            onClick={() => {
              onDeleteEdge((menu.target as { edgeId: number }).edgeId);
              onClose();
            }}
          >
            {t('menu.deleteEdge')}
          </button>
        </>
      ) : null}
    </div>
  );
}
