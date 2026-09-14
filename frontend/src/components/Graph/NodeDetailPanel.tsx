import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';
import { activeIssues, findIssue, useCatalogStore } from '../../store/catalogStore';
import { issueOptionState } from '../../store/graphRules';
import { nodeAnnotationOf } from '../../store/reviewLogic';
import type { ArgumentNodeType, NodeFieldsPatch } from '../../types/argument';
import { copyNodeContent, summaryStateOf } from '../../types/argument';
import type { NodeAnnotation, NodeValue } from '../../types/annotation';
import { MATCH_LABEL, ORIGIN_LABEL, STATUS_LABEL } from '../../types/annotation';
import { MAX_SELECTED_ISSUES, sameValue, schemeContent, type IssueRef } from '../../types/scheme';
import { SchemePanel, type NeighborNode } from './SchemePanel';

const TYPE_TITLE: Record<ArgumentNodeType, string> = {
  I: '진술 (I)',
  RA: '추론 (RA)',
  CA: '반박 (CA)',
  ISSUE: '쟁점 (ISSUE)',
};

export const SUMMARY_SOFT_LIMIT = 40;

interface Resolved {
  nodeId: string;
  value: NodeValue;
  /** 확정 그래프에 있는 노드인지 (아니면 초안 제안) */
  accepted: boolean;
  annotation?: NodeAnnotation;
}

/** 선택된 노드의 현재 값을 확정 그래프 또는 초안 제안에서 찾는다. */
function useSelectedNode(): Resolved | null {
  const selectedNodeIds = useGraphStore((state) => state.selectedNodeIds);
  const caseData = useGraphStore((state) => state.caseData);
  const annotations = useGraphStore((state) => state.annotations);
  return useMemo(() => {
    if (!caseData || selectedNodeIds.length !== 1) return null;
    const nodeId = selectedNodeIds[0];
    const node = caseData.nodes.find((item) => item.id === nodeId);
    const annotation = nodeAnnotationOf(annotations, nodeId);
    if (node) {
      return { nodeId, accepted: true, annotation, value: copyNodeContent({ type: node.type, text: node.text } as NodeValue, node) };
    }
    if (annotation) return { nodeId, accepted: false, annotation, value: annotation.currentValue };
    return null;
  }, [caseData, annotations, selectedNodeIds]);
}

/** RA 의 전제(들어오는 노드)와 결론(나가는 노드). 확정 관계와 화면에 보이는 초안 관계를 함께 본다. */
function useNeighbors(nodeId: string | null): { premises: NeighborNode[]; conclusions: NeighborNode[] } {
  const caseData = useGraphStore((state) => state.caseData);
  const annotations = useGraphStore((state) => state.annotations);
  return useMemo(() => {
    if (!caseData || !nodeId) return { premises: [], conclusions: [] };
    const describe = (id: string): NeighborNode => {
      const node = caseData.nodes.find((item) => item.id === id);
      if (node) return { nodeId: id, type: node.type, text: node.text, summary: node.summary, accepted: true };
      const proposal = nodeAnnotationOf(annotations, id);
      return {
        nodeId: id,
        type: proposal?.currentValue.type ?? null,
        text: proposal?.currentValue.text ?? id,
        summary: proposal?.currentValue.summary,
        accepted: false,
      };
    };
    const incoming = new Set<string>();
    const outgoing = new Set<string>();
    for (const edge of caseData.edges) {
      if (edge.target === nodeId) incoming.add(edge.source);
      if (edge.source === nodeId) outgoing.add(edge.target);
    }
    for (const annotation of annotations) {
      if (annotation.kind !== 'edge' || annotation.status === 'rejected') continue;
      if (annotation.currentValue.target === nodeId) incoming.add(annotation.currentValue.source);
      if (annotation.currentValue.source === nodeId) outgoing.add(annotation.currentValue.target);
    }
    return { premises: [...incoming].map(describe), conclusions: [...outgoing].map(describe) };
  }, [caseData, annotations, nodeId]);
}

export function NodeDetailPanel() {
  const selected = useSelectedNode();
  const { setNodes } = useReactFlow();
  const loadCatalogs = useCatalogStore((state) => state.load);

  useEffect(() => {
    void loadCatalogs();
  }, [loadCatalogs]);

  if (!selected) return null;

  const close = () => setNodes((nodes) => nodes.map((node) => (node.selected ? { ...node, selected: false } : node)));

  return (
    <aside className="node-detail" aria-label="노드 상세" key={selected.nodeId}>
      <NodeDetailBody selected={selected} onClose={close} />
    </aside>
  );
}

const CHANGE_LABEL = { text: '본문', summary: '요약', schemeApplication: 'scheme', issueRef: '분류' } as const;

function NodeDetailBody({ selected, onClose }: { selected: Resolved; onClose: () => void }) {
  const { value, annotation, accepted, nodeId } = selected;
  const updateNodeFields = useGraphStore((state) => state.updateNodeFields);
  const editDraft = useAnnotationStore((state) => state.editDraft);
  const accept = useAnnotationStore((state) => state.accept);
  const reject = useAnnotationStore((state) => state.reject);
  const neighbors = useNeighbors(value.type === 'RA' ? nodeId : null);

  const save = (patch: NodeFieldsPatch) => {
    if (accepted) {
      updateNodeFields(nodeId, patch);
      useAnnotationStore.setState({ dirty: true });
    } else if (annotation) {
      editDraft(annotation.id, patch);
    }
  };

  const status = annotation?.status;
  const modifiedKeys =
    annotation && annotation.origin !== 'human'
      ? (Object.keys(CHANGE_LABEL) as Array<keyof typeof CHANGE_LABEL>).filter((key) =>
          key === 'schemeApplication'
            ? !sameValue(schemeContent(annotation.originalValue.schemeApplication), schemeContent(annotation.currentValue.schemeApplication))
            : !sameValue(annotation.originalValue[key], annotation.currentValue[key]),
        )
      : [];

  return (
    <>
      <header className="node-detail-header">
        <div>
          <div className="node-detail-type">{TYPE_TITLE[value.type]}</div>
          <div className="node-detail-badges">
            {annotation ? (
              <span className={`badge badge-origin is-${annotation.origin}`} title={annotation.origin === 'rule' ? 'RA/CA 구조는 규칙으로 만들어졌습니다' : undefined}>
                {ORIGIN_LABEL[annotation.origin]}
              </span>
            ) : null}
            {status ? <span className={`badge badge-status is-${status}`}>{accepted ? STATUS_LABEL[status] : `초안 · ${STATUS_LABEL[status]}`}</span> : null}
            {modifiedKeys.length > 0 ? (
              <span className="badge badge-note" title="AI 원안과 달라진 항목">
                변경: {modifiedKeys.map((key) => CHANGE_LABEL[key]).join('·')}
              </span>
            ) : null}
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="상세 닫기" title="닫기 (Esc)">
          &#10005;
        </button>
      </header>

      {value.type === 'RA' ? (
        <SchemePanel
          raNodeId={nodeId}
          application={value.schemeApplication}
          original={annotation?.origin !== 'human' ? annotation?.originalValue.schemeApplication : undefined}
          premises={neighbors.premises}
          conclusions={neighbors.conclusions}
          onSave={(schemeApplication) => save({ schemeApplication })}
        />
      ) : value.type === 'I' || value.type === 'ISSUE' ? (
        <ContentPanel nodeId={nodeId} value={value} annotation={annotation} onSave={save} />
      ) : (
        <div className="node-detail-section">
          <div className="node-detail-text">{value.text || '(내용 없음)'}</div>
        </div>
      )}

      {!accepted && annotation && annotation.origin !== 'human' ? (
        <footer className="node-detail-footer">
          {status === 'pending' ? (
            <>
              <button type="button" className="is-primary" onClick={() => accept(annotation.id, { withConnectableEdges: true })}>
                제안 수락
              </button>
              <button type="button" className="is-danger" onClick={() => reject(annotation.id)}>
                거절
              </button>
            </>
          ) : (
            <span className="annotation-hint">거절된 제안입니다. 검토 패널에서 미검토로 되돌릴 수 있습니다.</span>
          )}
        </footer>
      ) : null}
    </>
  );
}

function ContentPanel({
  nodeId,
  value,
  annotation,
  onSave,
}: {
  nodeId: string;
  value: NodeValue;
  annotation?: NodeAnnotation;
  onSave: (patch: NodeFieldsPatch) => void;
}) {
  const [editing, setEditing] = useState(false);
  const issueCatalog = useCatalogStore((state) => state.issues);
  const focusEvidence = useAnnotationStore((state) => state.focusEvidence);
  const confirmEvidenceReview = useAnnotationStore((state) => state.confirmEvidenceReview);
  const generateSummaries = useAnnotationStore((state) => state.generateSummaries);
  const summarizing = useAnnotationStore((state) => state.summarizing.includes(nodeId));
  const issue = value.type === 'ISSUE' ? findIssue(issueCatalog, value.issueRef?.issueId) : undefined;

  if (editing) {
    return (
      <ContentEditor
        nodeId={nodeId}
        value={value}
        onCancel={() => setEditing(false)}
        onSave={(patch) => {
          onSave(patch);
          setEditing(false);
        }}
      />
    );
  }

  const original = annotation && annotation.origin !== 'human' ? annotation.originalValue : null;
  const summaryState = summaryStateOf(value);
  const needsEvidenceReview = annotation?.evidence.some((span) => span.reviewReason);

  return (
    <>
      <section className="node-detail-section">
        <h3>
          요약
          {value.summary ? (
            <span className="node-detail-badges">
              <span className={`badge badge-origin is-${value.summaryOrigin === 'human' ? 'human' : 'ai'}`}>{value.summaryOrigin === 'human' ? '사람 작성' : 'AI 요약'}</span>
              {summaryState === 'stale' ? (
                <span className="badge scheme-status is-needs_review" title="요약을 만든 뒤 본문이 바뀌었습니다">
                  본문 변경됨
                </span>
              ) : (
                <span className="badge badge-note">최신</span>
              )}
            </span>
          ) : null}
        </h3>
        {value.summary ? (
          <p className="node-detail-summary">{value.summary}</p>
        ) : (
          <p className="node-detail-empty">요약이 없습니다. 그래프에는 본문 앞부분이 임시로 표시됩니다.</p>
        )}
        <div className="node-detail-actions">
          <button
            type="button"
            disabled={summarizing || !value.text.trim()}
            onClick={() => void generateSummaries([nodeId])}
            title="분석 flow 의 요약 설정으로 현재 본문을 요약합니다. 요청 뒤 본문·요약을 고치면 결과를 덮어쓰지 않습니다."
          >
            {summarizing ? '요약 생성 중…' : value.summary ? 'AI 요약 다시 생성' : 'AI 요약 생성'}
          </button>
        </div>
      </section>
      <section className="node-detail-section">
        <h3>본문</h3>
        <div className="node-detail-text">{value.text || '(본문 없음)'}</div>
        {original && original.text !== value.text ? (
          <details className="node-detail-original">
            <summary>AI 원안 보기</summary>
            <div className="node-detail-text">{original.text}</div>
          </details>
        ) : null}
      </section>
      {value.type === 'ISSUE' ? (
        <section className="node-detail-section">
          <h3>세부 쟁점 (카탈로그)</h3>
          {value.issueRef ? (
            <div className="node-detail-issue">
              <div>
                <span className="node-detail-muted">{issue?.categoryName ?? value.issueRef.categoryId ?? ''}</span>
                {issue ? ' › ' : ''}
                <strong>{issue?.label ?? value.issueRef.issueId}</strong>
                <span className="node-detail-code">{value.issueRef.issueId}</span>
              </div>
              {value.issueRef.selectionReason ? <div className="node-detail-text">선택 이유: {value.issueRef.selectionReason}</div> : null}
              {issue ? (
                <div className="node-detail-criteria" title="분류 참고 정보(법률 기준 아님)">
                  비교·판단 기준(참고): {issue.criteria}
                </div>
              ) : null}
              {issue?.retired ? <div className="annotation-warning">현재 카탈로그에서 폐기된 항목입니다.</div> : null}
            </div>
          ) : (
            <p className="node-detail-empty">카탈로그 세부 쟁점이 연결되어 있지 않습니다.</p>
          )}
        </section>
      ) : value.issueRefs && value.issueRefs.length > 0 ? (
        <section className="node-detail-section">
          <h3>관련 세부 쟁점</h3>
          <ul className="scheme-premises">
            {value.issueRefs.map((ref) => (
              <li key={`${ref.issueId}-${ref.instanceId}`}>
                <span className="scheme-role">{ref.issueId}</span>
                {findIssue(issueCatalog, ref.issueId)?.label ?? '(카탈로그에 없음)'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {annotation && annotation.evidence.length > 0 ? (
        <section className="node-detail-section">
          <h3>판결문 근거</h3>
          {needsEvidenceReview ? (
            <div className="annotation-warning" role="status">
              {annotation.evidence.find((span) => span.reviewReason)?.reviewReason}
              <div className="node-detail-actions">
                <button type="button" onClick={() => confirmEvidenceReview(annotation.id)}>
                  근거 확인 완료
                </button>
              </div>
            </div>
          ) : null}
          <ul className="node-detail-evidence">
            {annotation.evidence.map((span, index) => (
              <li key={index}>
                <span className={`evidence-badge is-${span.match}`}>{MATCH_LABEL[span.match]}</span>
                {span.derived ? <span className="badge badge-note" title="인용문이 아니라 노드 문장으로 찾은 위치">문장 매칭</span> : null}
                <button
                  type="button"
                  className="evidence-quote"
                  disabled={span.start === null}
                  onClick={() => focusEvidence(span)}
                  title={span.start === null ? '원문 위치가 확정되지 않았습니다' : '원문 위치로 이동'}
                >
                  “{span.quote.length > 120 ? `${span.quote.slice(0, 120)}…` : span.quote}”
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="node-detail-actions">
        <button type="button" className="is-primary" onClick={() => setEditing(true)}>
          수정
        </button>
      </div>
    </>
  );
}

function ContentEditor({
  nodeId,
  value,
  onSave,
  onCancel,
}: {
  nodeId: string;
  value: NodeValue;
  onSave: (patch: NodeFieldsPatch) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value.text);
  const [summary, setSummary] = useState(value.summary ?? '');
  const [issueId, setIssueId] = useState(value.issueRef?.issueId ?? '');
  const issueCatalog = useCatalogStore((state) => state.issues);
  const caseData = useGraphStore((state) => state.caseData);
  const annotations = useGraphStore((state) => state.annotations);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const grouped = useMemo(() => {
    const list = activeIssues(issueCatalog);
    const groups = new Map<string, Array<(typeof list)[number] & { state: ReturnType<typeof issueOptionState> }>>();
    for (const item of list) {
      if (!groups.has(item.categoryName)) groups.set(item.categoryName, []);
      const state = caseData ? issueOptionState(caseData, annotations, nodeId, item.issueId) : { disabled: false };
      groups.get(item.categoryName)!.push({ ...item, state });
    }
    return [...groups.entries()];
  }, [issueCatalog, caseData, annotations, nodeId]);

  const textChanged = text.trim() !== value.text;
  const summaryChanged = summary.trim() !== (value.summary ?? '');

  const submit = () => {
    const trimmedText = text.trim();
    if (!trimmedText) return;
    const patch: NodeFieldsPatch = {};
    if (textChanged) patch.text = trimmedText;
    // 요약을 직접 고친 경우만 사람 요약으로 기록한다. 본문만 고치면 기존 요약은 stale 로 표시된다.
    if (summaryChanged) patch.summary = summary.trim() || null;
    if (value.type === 'ISSUE' && issueId !== (value.issueRef?.issueId ?? '')) {
      const item = findIssue(issueCatalog, issueId);
      const ref: IssueRef | null = issueId
        ? {
            issueId,
            ...(item ? { categoryId: item.categoryId } : {}),
            ...(issueCatalog ? { catalogVersion: issueCatalog.catalogVersion } : {}),
            ...(value.issueRef?.instanceId ? { instanceId: value.issueRef.instanceId } : {}),
          }
        : null;
      patch.issueRef = ref;
    }
    if (Object.keys(patch).length > 0) onSave(patch);
    else onCancel();
  };

  return (
    <form
      className="node-detail-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <label className="field">
        <span>본문</span>
        <textarea ref={textRef} value={text} onChange={(event) => setText(event.target.value)} rows={6} required />
      </label>
      {textChanged ? (
        <div className="annotation-hint">
          본문을 바꾸면 판결문 원문은 그대로이며, 이 노드의 근거와 연결된 RA scheme 이 재검토 대상으로 표시됩니다.
          {value.summary && !summaryChanged ? ' 기존 요약은 "본문 변경됨"으로 표시됩니다.' : ''}
        </div>
      ) : null}
      <label className="field">
        <span>
          요약{' '}
          <span className={summary.trim().length > SUMMARY_SOFT_LIMIT ? 'field-count is-over' : 'field-count'}>
            {summary.trim().length}/{SUMMARY_SOFT_LIMIT}
          </span>
        </span>
        <input type="text" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="그래프에 표시할 짧은 요약 (비우면 본문 앞부분 임시 표시)" />
      </label>
      {value.type === 'ISSUE' ? (
        <label className="field">
          <span>세부 쟁점 (중복 없이 최대 {MAX_SELECTED_ISSUES}개)</span>
          <select value={issueId} onChange={(event) => setIssueId(event.target.value)}>
            <option value="">(분류 없음)</option>
            {value.issueRef && !findIssue(issueCatalog, value.issueRef.issueId) ? (
              <option value={value.issueRef.issueId}>{value.issueRef.issueId} (카탈로그에 없음)</option>
            ) : null}
            {grouped.map(([category, items]) => (
              <optgroup key={category} label={category}>
                {items.map((item) => (
                  <option key={item.issueId} value={item.issueId} disabled={item.state.disabled && item.issueId !== value.issueRef?.issueId}>
                    {item.label}
                    {item.state.disabled && item.issueId !== value.issueRef?.issueId ? ` — ${item.state.reason}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {issueId ? <small className="node-detail-criteria">기준(참고): {findIssue(issueCatalog, issueId)?.criteria ?? ''}</small> : null}
        </label>
      ) : null}
      <div className="node-detail-actions">
        <button type="submit" className="is-primary" disabled={!text.trim()}>
          저장
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
        <span className="annotation-hint">Ctrl+Enter 저장 · Esc 취소</span>
      </div>
    </form>
  );
}
