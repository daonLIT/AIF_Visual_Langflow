import { NodeShell, type ArgumentNodeProps } from './NodeShell';

/**
 * 프로젝트 고유 확장 노드. 법적 쟁점을 나타내며 I 노드와 시각적으로 구분한다.
 * 내부/내보내기 모두에서 type 은 "ISSUE" 로 유지된다.
 */
export function IssueNode({ id, data, selected }: ArgumentNodeProps) {
  return (
    <NodeShell
      id={id}
      className="arg-node-issue"
      text={data.text}
      editable
      selected={selected}
      draft={data.draft}
      status={data.status}
      origin={data.origin}
      annotationId={data.annotationId}
      hasEvidence={data.hasEvidence}
      badge="ISSUE"
      placeholder="(쟁점 없음)"
    />
  );
}
