import { NodeShell, type ArgumentNodeProps } from './NodeShell';

/** 사실 / 주장 / 증거 / 평가 / 결론을 나타내는 진술 노드. 그래프에는 요약을 보여준다. */
export function INode({ data, selected }: ArgumentNodeProps) {
  return (
    <NodeShell
      className="arg-node-i"
      text={data.text}
      summary={data.summary}
      summaryStale={data.summaryStale}
      selected={selected}
      draft={data.draft}
      status={data.status}
      origin={data.origin}
      hasEvidence={data.hasEvidence}
      placeholder="(진술 없음)"
    />
  );
}
