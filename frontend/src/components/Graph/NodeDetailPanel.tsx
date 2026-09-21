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
import { MATCH_KEY, ORIGIN_KEY, STATUS_KEY } from '../../types/annotation';
import {
  MAX_SELECTED_ISSUES,
  issueCategoryName,
  issueCriteria,
  issueLabel,
  sameValue,
  schemeContent,
  type IssueRef,
} from '../../types/scheme';
import { SchemePanel, type NeighborNode } from './SchemePanel';
import { useLang, useT, type MessageKey } from '../../i18n';

const TYPE_TITLE_KEY: Record<ArgumentNodeType, MessageKey> = {
  I: 'detail.type.i',
  RA: 'detail.type.ra',
  CA: 'detail.type.ca',
  ISSUE: 'detail.type.issue',
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
  const t = useT();
  const selected = useSelectedNode();
  const { setNodes } = useReactFlow();
  const loadCatalogs = useCatalogStore((state) => state.load);

  useEffect(() => {
    void loadCatalogs();
  }, [loadCatalogs]);

  if (!selected) return null;

  const close = () => setNodes((nodes) => nodes.map((node) => (node.selected ? { ...node, selected: false } : node)));

  return (
    <aside className="node-detail" aria-label={t('detail.aria')} key={selected.nodeId}>
      <NodeDetailBody selected={selected} onClose={close} />
    </aside>
  );
}

const CHANGE_LABEL_KEY = {
  text: 'detail.change.text',
  summary: 'detail.change.summary',
  schemeApplication: 'detail.change.scheme',
  issueRef: 'detail.change.issueRef',
} as const satisfies Record<string, MessageKey>;

function NodeDetailBody({ selected, onClose }: { selected: Resolved; onClose: () => void }) {
  const t = useT();
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
      ? (Object.keys(CHANGE_LABEL_KEY) as Array<keyof typeof CHANGE_LABEL_KEY>).filter((key) =>
          key === 'schemeApplication'
            ? !sameValue(schemeContent(annotation.originalValue.schemeApplication), schemeContent(annotation.currentValue.schemeApplication))
            : !sameValue(annotation.originalValue[key], annotation.currentValue[key]),
        )
      : [];

  return (
    <>
      <header className="node-detail-header">
        <div>
          <div className="node-detail-type">{t(TYPE_TITLE_KEY[value.type])}</div>
          <div className="node-detail-badges">
            {annotation ? (
              <span
                className={`badge badge-origin is-${annotation.origin}`}
                title={annotation.origin === 'rule' ? t('detail.origin.rule.title') : undefined}
              >
                {t(ORIGIN_KEY[annotation.origin])}
              </span>
            ) : null}
            {status ? (
              <span className={`badge badge-status is-${status}`}>
                {accepted ? t(STATUS_KEY[status]) : t('detail.status.draft', { status: t(STATUS_KEY[status]) })}
              </span>
            ) : null}
            {modifiedKeys.length > 0 ? (
              <span className="badge badge-note" title={t('detail.changed.title')}>
                {t('detail.changed', { fields: modifiedKeys.map((key) => t(CHANGE_LABEL_KEY[key])).join('·') })}
              </span>
            ) : null}
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('detail.close.aria')} title={t('detail.close.title')}>
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
          <div className="node-detail-text">{value.text || t('detail.noContent')}</div>
        </div>
      )}

      {!accepted && annotation && annotation.origin !== 'human' ? (
        <footer className="node-detail-footer">
          {status === 'pending' ? (
            <>
              <button type="button" className="is-primary" onClick={() => accept(annotation.id, { withConnectableEdges: true })}>
                {t('detail.acceptProposal')}
              </button>
              <button type="button" className="is-danger" onClick={() => reject(annotation.id)}>
                {t('detail.reject')}
              </button>
            </>
          ) : (
            <span className="annotation-hint">{t('detail.rejectedHint')}</span>
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
  const t = useT();
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
          {t('detail.summary')}
          {value.summary ? (
            <span className="node-detail-badges">
              <span className={`badge badge-origin is-${value.summaryOrigin === 'human' ? 'human' : 'ai'}`}>
                {value.summaryOrigin === 'human' ? t('detail.summary.human') : t('detail.summary.ai')}
              </span>
              {summaryState === 'stale' ? (
                <span className="badge scheme-status is-needs_review" title={t('detail.summary.stale.title')}>
                  {t('detail.summary.stale')}
                </span>
              ) : (
                <span className="badge badge-note">{t('detail.summary.current')}</span>
              )}
            </span>
          ) : null}
        </h3>
        {value.summary ? (
          <p className="node-detail-summary">{value.summary}</p>
        ) : (
          <p className="node-detail-empty">{t('detail.summary.empty')}</p>
        )}
        <div className="node-detail-actions">
          <button
            type="button"
            disabled={summarizing || !value.text.trim()}
            onClick={() => void generateSummaries([nodeId])}
            title={t('detail.summary.generate.title')}
          >
            {summarizing
              ? t('detail.summary.generating')
              : value.summary
                ? t('detail.summary.regenerate')
                : t('detail.summary.generate')}
          </button>
        </div>
      </section>
      <section className="node-detail-section">
        <h3>{t('detail.text')}</h3>
        <div className="node-detail-text">{value.text || t('detail.text.empty')}</div>
        {original && original.text !== value.text ? (
          <details className="node-detail-original">
            <summary>{t('detail.original')}</summary>
            <div className="node-detail-text">{original.text}</div>
          </details>
        ) : null}
      </section>
      {value.type === 'ISSUE' ? (
        <section className="node-detail-section">
          <h3>{t('detail.issue.title')}</h3>
          {value.issueRef ? (
            <div className="node-detail-issue">
              <div>
                <span className="node-detail-muted">{issueCategoryName(issue) || value.issueRef.categoryId || ''}</span>
                {issue ? ' › ' : ''}
                <strong>{issueLabel(issue) || value.issueRef.issueId}</strong>
                <span className="node-detail-code">{value.issueRef.issueId}</span>
              </div>
              {value.issueRef.selectionReason ? (
                <div className="node-detail-text">
                  {t('detail.issue.reason', { reason: value.issueRef.selectionReason })}
                </div>
              ) : null}
              {issue ? (
                <div className="node-detail-criteria" title={t('detail.issue.criteria.title')}>
                  {t('detail.issue.criteria', { criteria: issueCriteria(issue) })}
                </div>
              ) : null}
              {issue?.retired ? <div className="annotation-warning">{t('detail.issue.retired')}</div> : null}
            </div>
          ) : (
            <p className="node-detail-empty">{t('detail.issue.empty')}</p>
          )}
        </section>
      ) : value.issueRefs && value.issueRefs.length > 0 ? (
        <section className="node-detail-section">
          <h3>{t('detail.relatedIssues')}</h3>
          <ul className="scheme-premises">
            {value.issueRefs.map((ref) => (
              <li key={`${ref.issueId}-${ref.instanceId}`}>
                <span className="scheme-role">{ref.issueId}</span>
                {issueLabel(findIssue(issueCatalog, ref.issueId)) || t('detail.issue.notInCatalog')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {annotation && annotation.evidence.length > 0 ? (
        <section className="node-detail-section">
          <h3>{t('detail.evidence.title')}</h3>
          {needsEvidenceReview ? (
            <div className="annotation-warning" role="status">
              {annotation.evidence.find((span) => span.reviewReason)?.reviewReason}
              <div className="node-detail-actions">
                <button type="button" onClick={() => confirmEvidenceReview(annotation.id)}>
                  {t('detail.evidence.confirm')}
                </button>
              </div>
            </div>
          ) : null}
          <ul className="node-detail-evidence">
            {annotation.evidence.map((span, index) => (
              <li key={index}>
                <span className={`evidence-badge is-${span.match}`}>{t(MATCH_KEY[span.match])}</span>
                {span.derived ? (
                  <span className="badge badge-note" title={t('detail.evidence.derived.title')}>
                    {t('detail.evidence.derived')}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="evidence-quote"
                  disabled={span.start === null}
                  onClick={() => focusEvidence(span)}
                  title={span.start === null ? t('detail.evidence.noPosition') : t('detail.evidence.goTo')}
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
          {t('detail.edit')}
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
  const t = useT();
  const lang = useLang();
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
      const category = issueCategoryName(item);
      if (!groups.has(category)) groups.set(category, []);
      const state = caseData ? issueOptionState(caseData, annotations, nodeId, item.issueId) : { disabled: false };
      groups.get(category)!.push({ ...item, state });
    }
    return [...groups.entries()];
    // lang 이 바뀌면 분류 이름도 바뀌므로 다시 묶는다.
  }, [issueCatalog, caseData, annotations, nodeId, lang]);

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
        <span>{t('detail.text')}</span>
        <textarea ref={textRef} value={text} onChange={(event) => setText(event.target.value)} rows={6} required />
      </label>
      {textChanged ? (
        <div className="annotation-hint">
          {t('detail.editor.textChanged')}
          {value.summary && !summaryChanged ? t('detail.editor.summaryStale') : ''}
        </div>
      ) : null}
      <label className="field">
        <span>
          {t('detail.summary')}{' '}
          <span className={summary.trim().length > SUMMARY_SOFT_LIMIT ? 'field-count is-over' : 'field-count'}>
            {summary.trim().length}/{SUMMARY_SOFT_LIMIT}
          </span>
        </span>
        <input
          type="text"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder={t('detail.editor.summaryPlaceholder')}
        />
      </label>
      {value.type === 'ISSUE' ? (
        <label className="field">
          <span>{t('detail.editor.issueLabel', { max: MAX_SELECTED_ISSUES })}</span>
          <select value={issueId} onChange={(event) => setIssueId(event.target.value)}>
            <option value="">{t('detail.editor.noIssue')}</option>
            {value.issueRef && !findIssue(issueCatalog, value.issueRef.issueId) ? (
              <option value={value.issueRef.issueId}>
                {t('detail.editor.issueMissing', { issueId: value.issueRef.issueId })}
              </option>
            ) : null}
            {grouped.map(([category, items]) => (
              <optgroup key={category} label={category}>
                {items.map((item) => (
                  <option key={item.issueId} value={item.issueId} disabled={item.state.disabled && item.issueId !== value.issueRef?.issueId}>
                    {issueLabel(item)}
                    {item.state.disabled && item.issueId !== value.issueRef?.issueId ? ` — ${item.state.reason}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {issueId ? (
            <small className="node-detail-criteria">
              {t('detail.editor.criteria', { criteria: issueCriteria(findIssue(issueCatalog, issueId)) })}
            </small>
          ) : null}
        </label>
      ) : null}
      <div className="node-detail-actions">
        <button type="submit" className="is-primary" disabled={!text.trim()}>
          {t('detail.editor.save')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('detail.editor.cancel')}
        </button>
        <span className="annotation-hint">{t('detail.editor.shortcuts')}</span>
      </div>
    </form>
  );
}
