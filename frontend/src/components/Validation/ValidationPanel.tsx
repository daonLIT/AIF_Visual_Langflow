import { useGraphStore } from '../../store/graphStore';

/** 검증 결과 패널. 항목을 클릭하면 관련 노드로 이동한다. */
export function ValidationPanel() {
  const validation = useGraphStore((state) => state.validation);
  const open = useGraphStore((state) => state.validationOpen);
  const setOpen = useGraphStore((state) => state.setValidationOpen);
  const requestFocus = useGraphStore((state) => state.requestFocus);
  const caseData = useGraphStore((state) => state.caseData);

  if (!open || !validation) return null;

  const nodeById = new Map((caseData?.nodes ?? []).map((node) => [node.id, node]));
  const edgeById = new Map((caseData?.edges ?? []).map((edge) => [edge.id, edge]));

  const focusTargetOf = (nodeId?: string, edgeId?: number): string | undefined => {
    if (nodeId && nodeById.has(nodeId)) return nodeId;
    if (edgeId !== undefined) {
      const edge = edgeById.get(edgeId);
      if (edge && nodeById.has(edge.source)) return edge.source;
    }
    return undefined;
  };

  const errors = validation.results.filter((result) => result.level === 'error');
  const warnings = validation.results.filter((result) => result.level === 'warning');

  return (
    <div className="validation-panel">
      <header className="validation-header">
        <h2>검증 결과</h2>
        <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="닫기">
          &#10005;
        </button>
      </header>

      <div className="validation-summary">
        <span>노드 {validation.nodeCount}개 검사</span>
        <span>엣지 {validation.edgeCount}개 검사</span>
        <span className={validation.errorCount > 0 ? 'is-error' : 'is-ok'}>
          오류 {validation.errorCount}
        </span>
        <span className={validation.warningCount > 0 ? 'is-warning' : 'is-ok'}>
          경고 {validation.warningCount}
        </span>
      </div>

      {validation.results.length === 0 ? (
        <p className="validation-clean">구조 오류가 발견되지 않았습니다.</p>
      ) : (
        <ul className="validation-list">
          {[...errors, ...warnings].map((result, index) => {
            const target = focusTargetOf(result.nodeId, result.edgeId);
            const node = result.nodeId ? nodeById.get(result.nodeId) : undefined;
            return (
              <li key={`${result.code}-${index}`} className={`validation-item is-${result.level}`}>
                <button
                  type="button"
                  className="validation-item-button"
                  disabled={!target}
                  onClick={() => target && requestFocus(target)}
                >
                  <span className={`validation-badge is-${result.level}`}>
                    {result.level === 'error' ? 'ERROR' : 'WARN'}
                  </span>
                  <span className="validation-body">
                    <span className="validation-code">{result.code}</span>
                    <span className="validation-message">{result.message}</span>
                    {node ? <span className="validation-context">{node.text}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
