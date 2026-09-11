import { NodeShell, type ArgumentNodeProps } from './NodeShell';

/** 사실 / 주장 / 증거 / 평가 / 결론을 나타내는 진술 노드. */
export function INode({ id, data, selected }: ArgumentNodeProps) {
  return (
    <NodeShell
      id={id}
      className="arg-node-i"
      text={data.text}
      editable
      selected={selected}
      draft={data.draft}
      status={data.status}
      origin={data.origin}
      annotationId={data.annotationId}
      hasEvidence={data.hasEvidence}
      placeholder="(진술 없음)"
    />
  );
}
