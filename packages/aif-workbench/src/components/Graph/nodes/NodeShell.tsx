import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ArgumentNodeType } from '../../../types/argument';
import type { AnnotationOrigin, AnnotationStatus } from '../../../types/annotation';
import { STATUS_KEY } from '../../../types/annotation';
import { useT } from '../../../i18n';
import type { SchemeStatus } from '../../../types/scheme';

export interface ArgumentNodeData extends Record<string, unknown> {
  text: string;
  nodeType: ArgumentNodeType;
  /** I / ISSUE 요약. 그래프에는 요약을 보여주고 본문은 상세 패널에서 본다. */
  summary?: string;
  /** 요약을 만든 뒤 본문이 바뀜 */
  summaryStale?: boolean;
  /** RA scheme 짧은 이름 (scheme 정보가 없으면 null) */
  schemeLabel?: string | null;
  schemeStatus?: SchemeStatus | null;
  /** ISSUE 카탈로그 세부 쟁점 이름 */
  issueLabel?: string | null;
  /** 초안 레이어(미검토/거절 제안) 노드 */
  draft?: boolean;
  status?: AnnotationStatus;
  origin?: AnnotationOrigin;
  annotationId?: string;
  hasEvidence?: boolean;
}

interface NodeShellProps {
  className: string;
  text: string;
  summary?: string;
  summaryStale?: boolean;
  selected?: boolean;
  /** ISSUE 노드처럼 머리말을 표시할 때 사용 */
  badge?: string;
  /** 머리말 옆 보조 표시 (카탈로그 쟁점 이름 등) */
  subBadge?: string | null;
  placeholder?: string;
  /** 초안/검토 상태 표시용 */
  draft?: boolean;
  status?: AnnotationStatus;
  origin?: AnnotationOrigin;
  hasEvidence?: boolean;
}

const FALLBACK_LENGTH = 48;

/**
 * 모든 논증 노드의 공통 껍데기.
 * 흐름은 아래(전제) -> 위(결론) 이므로 source 핸들은 위, target 핸들은 아래에 둔다.
 * 노드에는 요약만 보이고, 클릭하면 상세 패널에서 본문을 확인하고 [수정] 버튼으로 편집한다.
 */
export function NodeShell({
  className,
  text,
  summary,
  summaryStale,
  selected,
  badge,
  subBadge,
  placeholder,
  draft,
  status,
  origin,
  hasEvidence,
}: NodeShellProps) {
  const t = useT();
  // 상태 배지: 색뿐 아니라 텍스트로도 구분한다.
  const statusBadge =
    draft && status
      ? t('node.status.draft', { status: t(STATUS_KEY[status]) })
      : status === 'modified'
        ? t('node.status.modifiedAccepted')
        : origin === 'ai' && status === 'accepted'
          ? t('node.status.aiAccepted')
          : null;

  const trimmedSummary = summary?.trim();
  const display = trimmedSummary
    ? trimmedSummary
    : text.length > FALLBACK_LENGTH
      ? `${text.slice(0, FALLBACK_LENGTH)}…`
      : text;

  return (
    <div
      className={`arg-node ${className} ${selected ? 'is-selected' : ''} ${draft ? `is-draft is-draft-${status ?? 'pending'}` : ''}`}
      title={text ? t('node.title.hint', { text }) : undefined}
    >
      <Handle type="source" position={Position.Top} className="arg-handle arg-handle-source" />

      {badge || subBadge ? (
        <div className="arg-node-badge">
          {badge}
          {subBadge ? <span className="arg-node-subbadge">{subBadge}</span> : null}
        </div>
      ) : null}
      {statusBadge ? (
        <div className={`arg-node-status is-${status ?? 'pending'}`}>
          {statusBadge}
          {hasEvidence === false && origin === 'ai' ? (
            <span className="arg-node-noevidence" title={t('node.noEvidence.title')}>
              {t('node.noEvidence')}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={`arg-node-text ${trimmedSummary ? 'is-summary' : 'is-fallback'}`}>
        {display || <span className="arg-node-placeholder">{placeholder ?? t('node.placeholder')}</span>}
      </div>
      {trimmedSummary && summaryStale ? (
        <div className="arg-node-stale" title={t('node.stale.title')}>
          {t('node.stale')}
        </div>
      ) : null}

      <Handle type="target" position={Position.Bottom} className="arg-handle arg-handle-target" />
    </div>
  );
}

export type ArgumentNodeProps = NodeProps & { data: ArgumentNodeData };
