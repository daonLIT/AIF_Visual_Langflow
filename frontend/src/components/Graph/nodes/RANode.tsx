import { Handle, Position } from '@xyflow/react';
import type { ArgumentNodeProps } from './NodeShell';

/** 추론 관계 노드. I 노드보다 훨씬 작은 중간 요소로 유지한다. */
export function RANode({ data, selected }: ArgumentNodeProps) {
  return (
    <div
      className={`arg-node arg-node-scheme arg-node-ra ${selected ? 'is-selected' : ''} ${data.draft ? `is-draft is-draft-${data.status ?? 'pending'}` : ''}`}
      title={data.text || 'RA (추론)'}
    >
      <Handle type="source" position={Position.Top} className="arg-handle arg-handle-source" />
      <span className="arg-node-scheme-label">RA</span>
      {data.draft ? <span className="arg-node-scheme-draft" aria-label="초안">초안</span> : null}
      <Handle type="target" position={Position.Bottom} className="arg-handle arg-handle-target" />
    </div>
  );
}
