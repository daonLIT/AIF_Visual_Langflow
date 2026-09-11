import { useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useGraphStore } from '../../../store/graphStore';
import { useAnnotationStore } from '../../../store/annotationStore';
import type { ArgumentNodeType } from '../../../types/argument';
import type { AnnotationOrigin, AnnotationStatus } from '../../../types/annotation';
import { STATUS_LABEL } from '../../../types/annotation';

export interface ArgumentNodeData extends Record<string, unknown> {
  text: string;
  nodeType: ArgumentNodeType;
  /** 초안 레이어(미검토/거절 제안) 노드 */
  draft?: boolean;
  status?: AnnotationStatus;
  origin?: AnnotationOrigin;
  annotationId?: string;
  hasEvidence?: boolean;
}

interface NodeShellProps {
  id: string;
  className: string;
  text: string;
  editable: boolean;
  selected?: boolean;
  /** ISSUE 노드처럼 머리말을 표시할 때 사용 */
  badge?: string;
  placeholder?: string;
  /** 초안/검토 상태 표시용 */
  draft?: boolean;
  status?: AnnotationStatus;
  origin?: AnnotationOrigin;
  annotationId?: string;
  hasEvidence?: boolean;
}

/**
 * 모든 논증 노드의 공통 껍데기.
 * 흐름은 아래(전제) -> 위(결론) 이므로 source 핸들은 위, target 핸들은 아래에 둔다.
 */
export function NodeShell({
  id,
  className,
  text,
  editable,
  selected,
  badge,
  placeholder,
  draft,
  status,
  origin,
  annotationId,
  hasEvidence,
}: NodeShellProps) {
  const updateNodeText = useGraphStore((state) => state.updateNodeText);
  const editDraftText = useAnnotationStore((state) => state.editDraftText);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 편집기가 열린 직후 포커스 + 전체 선택
  useEffect(() => {
    if (!editing) return;
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    setDraftText(text);
    setEditing(true);
  };

  const finish = (save: boolean) => {
    if (save && draftText !== text) {
      if (draft && annotationId) editDraftText(annotationId, draftText);
      else updateNodeText(id, draftText);
    }
    setEditing(false);
  };

  // 상태 배지: 색뿐 아니라 텍스트로도 구분한다.
  const statusBadge =
    draft && status
      ? `초안 · ${STATUS_LABEL[status]}`
      : status === 'modified'
        ? '수정 수락'
        : origin === 'ai' && status === 'accepted'
          ? 'AI 수락'
          : null;

  return (
    <div
      className={`arg-node ${className} ${selected ? 'is-selected' : ''} ${draft ? `is-draft is-draft-${status ?? 'pending'}` : ''}`}
      onDoubleClick={editable ? startEditing : undefined}
      title={editable ? '더블클릭하여 텍스트 편집' : undefined}
    >
      <Handle type="source" position={Position.Top} className="arg-handle arg-handle-source" />

      {badge ? <div className="arg-node-badge">{badge}</div> : null}
      {statusBadge ? (
        <div className={`arg-node-status is-${status ?? 'pending'}`}>
          {statusBadge}
          {hasEvidence === false && origin === 'ai' ? <span className="arg-node-noevidence" title="근거 위치 미확인"> · 근거?</span> : null}
        </div>
      ) : null}

      {editing ? (
        <textarea
          ref={textareaRef}
          className="arg-node-editor nodrag nowheel"
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              finish(false);
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              finish(true);
            }
            // 편집 중 Delete/Backspace 가 노드 삭제로 전파되지 않도록 막는다.
            event.stopPropagation();
          }}
        />
      ) : (
        <div className="arg-node-text">
          {text || <span className="arg-node-placeholder">{placeholder ?? '(빈 텍스트)'}</span>}
        </div>
      )}

      <Handle type="target" position={Position.Bottom} className="arg-handle arg-handle-target" />
    </div>
  );
}

export type ArgumentNodeProps = NodeProps & { data: ArgumentNodeData };
