import { Handle, Position } from '@xyflow/react';
import type { ArgumentNodeProps } from './NodeShell';

/** 충돌 / 공격 관계 노드. RA 와 색상으로 구분한다. */
export function CANode({ data, selected }: ArgumentNodeProps) {
  return (
    <div
      className={`arg-node arg-node-scheme arg-node-ca ${selected ? 'is-selected' : ''} ${data.draft ? `is-draft is-draft-${data.status ?? 'pending'}` : ''}`}
      title={data.text || 'CA (반박)'}
    >
      <Handle type="source" position={Position.Top} className="arg-handle arg-handle-source" />
      <span className="arg-node-scheme-label">CA</span>
      {data.draft ? <span className="arg-node-scheme-draft" aria-label="초안">초안</span> : null}
      <Handle type="target" position={Position.Bottom} className="arg-handle arg-handle-target" />
    </div>
  );
}
