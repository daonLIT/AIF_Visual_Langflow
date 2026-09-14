import { Handle, Position } from '@xyflow/react';
import type { ArgumentNodeProps } from './NodeShell';

/** 추론 관계 노드. I 노드보다 작은 중간 요소로 유지하고 "RA · scheme 짧은 이름" 배지를 붙인다. */
export function RANode({ data, selected }: ArgumentNodeProps) {
  const label = data.schemeLabel;
  const review = data.schemeStatus === 'needs_review';
  const title = label
    ? `RA · ${label}${review ? ' (재검토 필요)' : data.schemeStatus === 'confirmed' ? ' (확정)' : ' (제안)'} — 클릭: scheme 보기`
    : 'RA (scheme 정보 없음 · 클릭하여 지정)';
  return (
    <div
      className={`arg-node arg-node-scheme arg-node-ra ${label ? 'has-scheme' : 'no-scheme'} ${review ? 'needs-review' : ''} ${selected ? 'is-selected' : ''} ${data.draft ? `is-draft is-draft-${data.status ?? 'pending'}` : ''}`}
      title={title}
    >
      <Handle type="source" position={Position.Top} className="arg-handle arg-handle-source" />
      <span className="arg-node-scheme-label">RA</span>
      <span className={`arg-node-scheme-name ${label ? '' : 'is-missing'}`}>· {label ?? 'scheme 없음'}</span>
      {review ? (
        <span className="arg-node-scheme-review" aria-label="재검토 필요">
          재검토
        </span>
      ) : null}
      {data.draft ? <span className="arg-node-scheme-draft" aria-label="초안">초안</span> : null}
      <Handle type="target" position={Position.Bottom} className="arg-handle arg-handle-target" />
    </div>
  );
}
