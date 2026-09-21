import { Handle, Position } from '@xyflow/react';
import type { ArgumentNodeProps } from './NodeShell';
import { useT } from '../../../i18n';

/** 추론 관계 노드. I 노드보다 작은 중간 요소로 유지하고 "RA · scheme 짧은 이름" 배지를 붙인다. */
export function RANode({ data, selected }: ArgumentNodeProps) {
  const t = useT();
  const label = data.schemeLabel;
  const review = data.schemeStatus === 'needs_review';
  const title = label
    ? t('node.ra.title', {
        scheme: label,
        status: review
          ? t('node.ra.title.needsReview')
          : data.schemeStatus === 'confirmed'
            ? t('node.ra.title.confirmed')
            : t('node.ra.title.suggested'),
      })
    : t('node.ra.title.noScheme');
  return (
    <div
      className={`arg-node arg-node-scheme arg-node-ra ${label ? 'has-scheme' : 'no-scheme'} ${review ? 'needs-review' : ''} ${selected ? 'is-selected' : ''} ${data.draft ? `is-draft is-draft-${data.status ?? 'pending'}` : ''}`}
      title={title}
    >
      <Handle type="source" position={Position.Top} className="arg-handle arg-handle-source" />
      <span className="arg-node-scheme-label">RA</span>
      <span className={`arg-node-scheme-name ${label ? '' : 'is-missing'}`}>· {label ?? t('node.ra.noScheme')}</span>
      {review ? (
        <span className="arg-node-scheme-review" aria-label={t('node.ra.review.aria')}>
          {t('node.ra.review')}
        </span>
      ) : null}
      {data.draft ? (
        <span className="arg-node-scheme-draft" aria-label={t('node.draft')}>
          {t('node.draft')}
        </span>
      ) : null}
      <Handle type="target" position={Position.Bottom} className="arg-handle arg-handle-target" />
    </div>
  );
}
