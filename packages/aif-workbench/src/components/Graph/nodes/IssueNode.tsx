import { NodeShell, type ArgumentNodeProps } from './NodeShell';
import { useT } from '../../../i18n';

/**
 * 프로젝트 고유 확장 노드. 법적 쟁점을 나타내며 I 노드와 시각적으로 구분한다.
 * 내부/내보내기 모두에서 type 은 "ISSUE" 로 유지된다. 카탈로그 쟁점이 연결되어 있으면 이름을 함께 보여준다.
 */
export function IssueNode({ data, selected }: ArgumentNodeProps) {
  const t = useT();
  return (
    <NodeShell
      className="arg-node-issue"
      text={data.text}
      summary={data.summary}
      summaryStale={data.summaryStale}
      selected={selected}
      draft={data.draft}
      status={data.status}
      origin={data.origin}
      hasEvidence={data.hasEvidence}
      badge="ISSUE"
      subBadge={data.issueLabel}
      placeholder={t('node.issue.placeholder')}
    />
  );
}
