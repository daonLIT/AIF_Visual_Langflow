import { useMemo, useState } from 'react';
import { findScheme, useCatalogStore } from '../../store/catalogStore';
import type { ArgumentNodeType } from '../../types/argument';
import {
  CQ_STATUS_LABEL,
  CUSTOM,
  SCHEME_STATUS_LABEL,
  UNCLASSIFIED,
  confirmScheme,
  emptySchemeApplication,
  humanSchemeEdit,
  schemeFullName,
  type CriticalQuestionStatus,
  type SchemeApplication,
  type SchemeDefinition,
} from '../../types/scheme';

export interface NeighborNode {
  nodeId: string;
  type: ArgumentNodeType | null;
  text: string;
  summary?: string;
  accepted: boolean;
}

interface Props {
  raNodeId: string;
  application?: SchemeApplication;
  /** AI 원안 (사람이 만든 노드면 없음) */
  original?: SchemeApplication;
  premises: NeighborNode[];
  conclusions: NeighborNode[];
  onSave: (application: SchemeApplication | null) => void;
}

function label(node: NeighborNode | undefined, fallbackId: string | null): string {
  if (!node) return fallbackId ? `(연결되지 않은 노드 ${fallbackId})` : '(노드 없음)';
  const base = node.summary?.trim() || node.text;
  return `${base.length > 70 ? `${base.slice(0, 70)}…` : base}${node.accepted ? '' : ' · 초안'}`;
}

const nowIso = () => new Date().toISOString();

/** RA 상세: scheme 보기 → [수정] → 저장/취소. AI 원안과 수정 이력을 함께 보여준다. */
export function SchemePanel(props: Props) {
  const [editing, setEditing] = useState<{ initialKey?: string } | null>(null);
  if (editing) {
    return (
      <SchemeEditor
        {...props}
        initialKey={editing.initialKey}
        onCancel={() => setEditing(null)}
        onSubmit={(application) => {
          props.onSave(application);
          setEditing(null);
        }}
      />
    );
  }
  return <SchemeView {...props} onEdit={(initialKey) => setEditing({ initialKey })} />;
}

function SchemeView({ application, original, premises, conclusions, onEdit, onSave }: Props & { onEdit: (initialKey?: string) => void }) {
  const catalog = useCatalogStore((state) => state.schemes);

  if (!application) {
    return (
      <>
        <section className="node-detail-section">
          <h3>Walton scheme</h3>
          <p className="node-detail-empty">이 추론(RA)에 scheme 정보가 없습니다.</p>
          <NeighborSummary premises={premises} conclusions={conclusions} />
        </section>
        <div className="node-detail-actions">
          <button type="button" className="is-primary" onClick={() => onEdit()}>
            scheme 지정
          </button>
        </div>
      </>
    );
  }

  const definition = findScheme(catalog, application.schemeKey);
  const roleLabel = (roleId: string | null) =>
    roleId ? (definition?.premiseRoles.find((role) => role.roleId === roleId)?.label ?? roleId) : '역할 미지정';
  const premiseById = new Map(premises.map((node) => [node.nodeId, node]));
  const conclusionById = new Map(conclusions.map((node) => [node.nodeId, node]));
  const bound = new Set(application.premiseBindings.flatMap((binding) => binding.nodeIds));
  const unbound = premises.filter((node) => !bound.has(node.nodeId));
  const staleRefs = [...bound].filter((id) => !premiseById.has(id));
  const staleConclusions = application.conclusionNodeIds.filter((id) => !conclusionById.has(id));
  const answers = new Map(application.criticalQuestionResponses.map((item) => [item.questionId, item]));
  const questions = definition?.criticalQuestions ?? application.criticalQuestionResponses.map((item) => ({ id: item.questionId, text: '' }));
  const originalChanged = original && (original.schemeKey !== application.schemeKey || original.rationale !== application.rationale);

  return (
    <>
      <section className="node-detail-section">
        <h3>Walton scheme</h3>
        <div className="scheme-title">
          <strong>{schemeFullName(application, catalog)}</strong>
          {definition ? <span className="node-detail-muted"> {definition.name}</span> : null}
        </div>
        <div className="node-detail-badges">
          <span className={`badge badge-origin is-${application.origin}`}>{application.origin === 'human' ? '사람' : 'AI 제안'}</span>
          <span className={`badge scheme-status is-${application.status}`}>{SCHEME_STATUS_LABEL[application.status]}</span>
          {application.catalogVersion !== null ? <span className="badge badge-note">카탈로그 v{application.catalogVersion}</span> : null}
        </div>
        {definition?.description ? <p className="node-detail-muted">{definition.description}</p> : null}
        {definition?.sourceNote ? (
          <details className="node-detail-original">
            <summary>
              출처{definition.verification === 'needs-book-check' ? ' · 원서 대조 필요' : ''}
            </summary>
            <div className="node-detail-muted">{definition.sourceNote}</div>
          </details>
        ) : null}
        {application.schemeKey !== UNCLASSIFIED && application.schemeKey !== CUSTOM && !definition ? (
          <div className="annotation-warning">scheme 카탈로그에 없는 key: {application.schemeKey}</div>
        ) : null}
        {application.status === 'needs_review' ? (
          <div className="annotation-warning" role="status">
            재검토 필요: {(application.reviewReasons ?? []).join(' / ') || '연결 또는 본문이 바뀌었습니다'}
            <div className="node-detail-actions">
              <button type="button" onClick={() => onSave(confirmScheme(application, nowIso()))}>
                확인했고 그대로 유지
              </button>
              <button type="button" onClick={() => onEdit()}>
                다시 지정
              </button>
            </div>
          </div>
        ) : null}
        {application.errors?.length ? (
          <div className="annotation-warning">
            결과 검증에서 제외된 부분: {application.errors.join(' / ')}
          </div>
        ) : null}
      </section>

      <section className="node-detail-section">
        <h3>적용 이유</h3>
        {application.rationale ? <div className="node-detail-text">{application.rationale}</div> : <p className="node-detail-empty">적용 이유가 비어 있습니다.</p>}
      </section>

      <section className="node-detail-section">
        <h3>전제 → 결론</h3>
        <ul className="scheme-premises">
          {application.premiseBindings.map((binding, index) =>
            binding.nodeIds.map((nodeId) => (
              <li key={`${index}-${nodeId}`} className={premiseById.has(nodeId) ? '' : 'is-unassigned'}>
                <span className={`scheme-role ${binding.roleId ? '' : 'is-missing'}`}>{roleLabel(binding.roleId)}</span>
                {label(premiseById.get(nodeId), nodeId)}
              </li>
            )),
          )}
          {unbound.map((node) => (
            <li key={node.nodeId} className="is-unassigned">
              <span className="scheme-role is-missing">역할 없음</span>
              {label(node, node.nodeId)}
            </li>
          ))}
        </ul>
        {staleRefs.length > 0 ? <div className="annotation-warning">이 RA 로 더 이상 연결되지 않은 전제 참조 {staleRefs.length}개가 남아 있습니다.</div> : null}
        <ul className="scheme-premises">
          {(application.conclusionNodeIds.length > 0 ? application.conclusionNodeIds : conclusions.map((node) => node.nodeId)).map((nodeId) => (
            <li key={nodeId} className={conclusionById.has(nodeId) ? 'scheme-conclusion' : 'scheme-conclusion is-unassigned'}>
              <span className="scheme-role">{definition?.conclusionRole.label ?? '결론'}</span>
              {label(conclusionById.get(nodeId), nodeId)}
            </li>
          ))}
        </ul>
        {staleConclusions.length > 0 ? <div className="annotation-warning">결론 참조가 이 RA 가 가리키는 노드와 다릅니다.</div> : null}
      </section>

      {questions.length > 0 && application.schemeKey !== UNCLASSIFIED && application.schemeKey !== CUSTOM ? (
        <section className="node-detail-section">
          <h3>비판적 질문</h3>
          <ul className="scheme-questions">
            {questions.map((question) => {
              const answer = answers.get(question.id);
              const status: CriticalQuestionStatus = answer?.status ?? 'open';
              return (
                <li key={question.id} className={`is-${status}`}>
                  <div>
                    <span className={`cq-status is-${status}`}>{CQ_STATUS_LABEL[status]}</span> <strong>{question.id}</strong> {question.text}
                  </div>
                  {answer?.answer ? <div className="cq-answer">{answer.answer}</div> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="node-detail-section">
        <h3>메모</h3>
        {application.notes ? <div className="node-detail-text">{application.notes}</div> : <p className="node-detail-empty">메모 없음</p>}
      </section>

      {application.alternatives.length > 0 ? (
        <section className="node-detail-section">
          <h3>대안 후보</h3>
          <ul className="scheme-premises">
            {application.alternatives.map((alternative) => (
              <li key={alternative.schemeKey}>
                <span className="scheme-role">{findScheme(catalog, alternative.schemeKey)?.nameKo ?? alternative.schemeKey}</span>
                {alternative.rationale}
                <button type="button" className="link-button" onClick={() => onEdit(alternative.schemeKey)}>
                  이 scheme 으로 수정
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {originalChanged || (application.history?.length ?? 0) > 0 ? (
        <details className="node-detail-original">
          <summary>AI 원안·수정 이력</summary>
          {original ? (
            <div className="node-detail-muted">
              AI 원안: <strong>{schemeFullName(original, catalog)}</strong>
              {original.rationale ? ` — ${original.rationale}` : ''}
            </div>
          ) : null}
          <ul className="scheme-history">
            {(application.history ?? [])
              .slice()
              .reverse()
              .map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  {new Date(entry.at).toLocaleString()} · {entry.by === 'human' ? '사람' : '자동'} ·{' '}
                  {{ edit: '수정', confirm: '검토 확정', needs_review: '재검토 표시' }[entry.action]} · 이전:{' '}
                  {schemeFullName({ ...application, schemeKey: entry.previousKey, customSchemeName: entry.previousCustomName ?? null }, catalog)} (
                  {SCHEME_STATUS_LABEL[entry.previousStatus]}){entry.detail ? ` — ${entry.detail}` : ''}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      <div className="node-detail-actions">
        <button type="button" className="is-primary" onClick={() => onEdit()}>
          수정
        </button>
        {application.status === 'suggested' ? (
          <button type="button" onClick={() => onSave(confirmScheme(application, nowIso()))} title="내용은 그대로 두고 검토 완료로 표시">
            검토 확정
          </button>
        ) : null}
      </div>
    </>
  );
}

function NeighborSummary({ premises, conclusions }: { premises: NeighborNode[]; conclusions: NeighborNode[] }) {
  return (
    <ul className="scheme-premises">
      {premises.map((node) => (
        <li key={node.nodeId}>
          <span className="scheme-role">전제</span>
          {label(node, node.nodeId)}
        </li>
      ))}
      {conclusions.map((node) => (
        <li key={node.nodeId}>
          <span className="scheme-role">결론</span>
          {label(node, node.nodeId)}
        </li>
      ))}
      {premises.length === 0 && conclusions.length === 0 ? <li className="node-detail-empty">연결된 노드가 없습니다.</li> : null}
    </ul>
  );
}

function groupSchemes(schemes: SchemeDefinition[]): Array<[string, SchemeDefinition[]]> {
  const groups = new Map<string, SchemeDefinition[]>();
  for (const scheme of schemes) {
    if (!groups.has(scheme.group)) groups.set(scheme.group, []);
    groups.get(scheme.group)!.push(scheme);
  }
  return [...groups.entries()];
}

function SchemeEditor({
  application,
  premises,
  conclusions,
  initialKey,
  onCancel,
  onSubmit,
}: Props & { initialKey?: string; onCancel: () => void; onSubmit: (application: SchemeApplication | null) => void }) {
  const catalog = useCatalogStore((state) => state.schemes);
  const base = application ?? emptySchemeApplication(catalog?.schemeCatalogVersion ?? null);
  const startKey = initialKey ?? base.schemeKey;
  const [schemeKey, setSchemeKey] = useState(startKey);
  const [customName, setCustomName] = useState(base.customSchemeName ?? '');
  const [rationale, setRationale] = useState(base.rationale);
  const [notes, setNotes] = useState(base.notes);
  const [initialRoles] = useState<Record<string, string>>(() =>
    Object.fromEntries(base.premiseBindings.flatMap((binding) => binding.nodeIds.map((id) => [id, binding.roleId ?? '']))),
  );
  const [initialQuestions] = useState<Record<string, { status: CriticalQuestionStatus; answer: string }>>(() =>
    Object.fromEntries(base.criticalQuestionResponses.map((item) => [item.questionId, { status: item.status, answer: item.answer }])),
  );
  const [roles, setRoles] = useState(startKey === base.schemeKey ? initialRoles : {});
  const [questions, setQuestions] = useState(startKey === base.schemeKey ? initialQuestions : {});
  const [conclusionIds, setConclusionIds] = useState<string[]>(
    base.conclusionNodeIds.filter((id) => conclusions.some((node) => node.nodeId === id)).length > 0
      ? base.conclusionNodeIds.filter((id) => conclusions.some((node) => node.nodeId === id))
      : conclusions.map((node) => node.nodeId),
  );

  const definition = findScheme(catalog, schemeKey);
  const grouped = useMemo(() => groupSchemes(catalog?.schemes ?? []), [catalog]);
  const classified = schemeKey !== UNCLASSIFIED && schemeKey !== CUSTOM;

  const submit = () => {
    const validRoles = new Set(definition?.premiseRoles.map((role) => role.roleId) ?? []);
    const byRole = new Map<string | null, string[]>();
    for (const node of premises) {
      const role = roles[node.nodeId] && validRoles.has(roles[node.nodeId]) ? roles[node.nodeId] : null;
      // 역할 없는 전제도 이 RA 의 전제로 남긴다(분류하지 않은 사실을 기록).
      byRole.set(role, [...(byRole.get(role) ?? []), node.nodeId]);
    }
    const questionIds = new Set(definition?.criticalQuestions.map((question) => question.id) ?? []);
    const next: SchemeApplication = {
      ...base,
      schemeKey,
      catalogVersion: catalog?.schemeCatalogVersion ?? base.catalogVersion,
      rationale: rationale.trim(),
      notes: notes.trim(),
      customSchemeName: schemeKey === CUSTOM ? customName.trim() || null : null,
      premiseBindings: [...byRole.entries()].map(([roleId, nodeIds]) => ({ roleId, nodeIds })),
      conclusionNodeIds: conclusionIds.filter((id) => conclusions.some((node) => node.nodeId === id)),
      criticalQuestionResponses: classified
        ? Object.entries(questions)
            .filter(([id, item]) => questionIds.has(id) && (item.status !== 'open' || item.answer.trim()))
            .map(([questionId, item]) => ({ questionId, status: item.status, answer: item.answer.trim() }))
        : [],
      alternatives: base.alternatives.filter((alternative) => alternative.schemeKey !== schemeKey),
    };
    delete next.errors;
    onSubmit(humanSchemeEdit(application, next, nowIso()));
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
        <span>scheme 종류</span>
        <select
          value={schemeKey}
          onChange={(event) => {
            const next = event.target.value;
            setSchemeKey(next);
            // 같은 CQ 번호·역할 이름이라도 scheme 마다 뜻이 다르므로 원래 scheme 이 아니면 비운다.
            if (next === base.schemeKey) {
              setRoles(initialRoles);
              setQuestions(initialQuestions);
            } else {
              setRoles({});
              setQuestions({});
            }
          }}
          autoFocus
        >
          <option value={UNCLASSIFIED}>미분류 (적절한 scheme 없음)</option>
          <option value={CUSTOM}>직접 작성 (비표준)</option>
          {grouped.map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((item) => (
                <option key={item.schemeKey} value={item.schemeKey}>
                  {item.nameKo} ({item.name})
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {definition ? <small className="node-detail-muted">{definition.description}</small> : null}
        {catalog?.status === 'draft' ? <small className="node-detail-muted">scheme 카탈로그는 검토 전 초안입니다.</small> : null}
      </label>

      {schemeKey === CUSTOM ? (
        <label className="field">
          <span>scheme 이름</span>
          <input type="text" value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="예: 경험칙에 의한 논증" required />
        </label>
      ) : null}

      <label className="field">
        <span>적용 이유</span>
        <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={4} placeholder="전제들이 이 scheme 에 따라 결론을 어떻게 뒷받침하는지 적습니다." />
      </label>

      {classified ? (
        <fieldset className="field">
          <legend>전제 역할</legend>
          {premises.length === 0 ? <p className="node-detail-empty">이 RA 로 들어오는 전제 노드가 없습니다.</p> : null}
          {premises.map((node) => (
            <div key={node.nodeId} className="scheme-role-row">
              <select
                value={roles[node.nodeId] ?? ''}
                onChange={(event) => setRoles((current) => ({ ...current, [node.nodeId]: event.target.value }))}
                aria-label={`전제 역할: ${label(node, node.nodeId)}`}
                disabled={!definition || definition.premiseRoles.length === 0}
              >
                <option value="">(역할 미지정)</option>
                {definition?.premiseRoles.map((role) => (
                  <option key={role.roleId} value={role.roleId} title={role.template}>
                    {role.label}
                  </option>
                ))}
              </select>
              <span className="scheme-role-text">{label(node, node.nodeId)}</span>
            </div>
          ))}
          {definition ? (
            <details className="scheme-templates">
              <summary>scheme 형식 보기</summary>
              <ul>
                {definition.premiseRoles.map((role) => (
                  <li key={role.roleId}>
                    <strong>{role.label}</strong>: {role.template}
                  </li>
                ))}
                <li>
                  <strong>{definition.conclusionRole.label}</strong>: {definition.conclusionRole.template}
                </li>
              </ul>
            </details>
          ) : null}
        </fieldset>
      ) : null}

      {conclusions.length > 1 ? (
        <fieldset className="field">
          <legend>결론 노드</legend>
          {conclusions.map((node) => (
            <label key={node.nodeId} className="chip-toggle">
              <input
                type="checkbox"
                checked={conclusionIds.includes(node.nodeId)}
                onChange={(event) =>
                  setConclusionIds((current) => (event.target.checked ? [...current, node.nodeId] : current.filter((id) => id !== node.nodeId)))
                }
              />
              {label(node, node.nodeId)}
            </label>
          ))}
        </fieldset>
      ) : null}

      {classified && definition && definition.criticalQuestions.length > 0 ? (
        <fieldset className="field">
          <legend>비판적 질문</legend>
          {definition.criticalQuestions.map((question) => {
            const item = questions[question.id] ?? { status: 'open' as const, answer: '' };
            return (
              <div key={question.id} className="cq-edit">
                <div className="cq-edit-head">
                  <strong>{question.id}</strong> {question.text}
                </div>
                <div className="cq-edit-row">
                  <select
                    value={item.status}
                    onChange={(event) => setQuestions((current) => ({ ...current, [question.id]: { ...item, status: event.target.value as CriticalQuestionStatus } }))}
                    aria-label={`${question.id} 상태`}
                  >
                    {(['open', 'satisfied', 'challenged'] as const).map((status) => (
                      <option key={status} value={status}>
                        {CQ_STATUS_LABEL[status]}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={item.answer}
                    onChange={(event) => setQuestions((current) => ({ ...current, [question.id]: { ...item, answer: event.target.value } }))}
                    placeholder="판결문에 근거한 답"
                    aria-label={`${question.id} 답`}
                  />
                </div>
              </div>
            );
          })}
        </fieldset>
      ) : null}

      <label className="field">
        <span>메모</span>
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="scheme 적용에 대한 자유 메모" />
      </label>

      <div className="node-detail-actions">
        <button type="submit" className="is-primary" disabled={schemeKey === CUSTOM && !customName.trim()}>
          저장
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
        {application ? (
          <button type="button" className="is-danger" onClick={() => window.confirm('이 RA 의 scheme 정보를 지울까요?') && onSubmit(null)}>
            scheme 정보 지우기
          </button>
        ) : null}
        <span className="annotation-hint">저장하면 사람 수정·확정으로 기록됩니다</span>
      </div>
    </form>
  );
}
