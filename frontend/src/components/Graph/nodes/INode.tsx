import { NodeShell, type ArgumentNodeProps } from './NodeShell';
import { useT } from '../../../i18n';

/** 사실 / 주장 / 증거 / 평가 / 결론을 나타내는 진술 노드. 그래프에는 요약을 보여준다. */
export function INode({ data, selected }: ArgumentNodeProps) {
  const t = useT();
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
      placeholder={t('node.i.placeholder')}
    />
  );
}
