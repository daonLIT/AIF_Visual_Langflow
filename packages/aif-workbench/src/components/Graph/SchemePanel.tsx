import { useMemo, useState } from 'react';
import { findScheme, useCatalogStore } from '../../store/catalogStore';
import type { ArgumentNodeType } from '../../types/argument';
import {
  CQ_STATUS_KEY,
  CUSTOM,
  ISSUE_RELATION_GROUP,
  SCHEME_STATUS_KEY,
  UNCLASSIFIED,
  confirmScheme,
  emptySchemeApplication,
  humanSchemeEdit,
  questionText,
  roleLabel as catalogRoleLabel,
  roleTemplate,
  schemeDescription,
  schemeFullName,
  schemeGroupName,
  schemeName,
  type CriticalQuestionStatus,
  type SchemeApplication,
  type SchemeDefinition,
} from '../../types/scheme';
import { t as translate, useLang, useT } from '../../i18n';

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
  if (!node) {
    return fallbackId
      ? translate('schemePanel.neighbor.unconnected', { nodeId: fallbackId })
      : translate('schemePanel.neighbor.missing');
  }
  const base = node.summary?.trim() || node.text;
  return `${base.length > 70 ? `${base.slice(0, 70)}…` : base}${node.accepted ? '' : translate('schemePanel.neighbor.draft')}`;
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
  const t = useT();
  const lang = useLang();
  const catalog = useCatalogStore((state) => state.schemes);

  if (!application) {
    return (
      <>
        <section className="node-detail-section">
          <h3>{t('schemePanel.title.walton')}</h3>
          <p className="node-detail-empty">{t('schemePanel.noScheme')}</p>
          <NeighborSummary premises={premises} conclusions={conclusions} />
        </section>
        <div className="node-detail-actions">
          <button type="button" className="is-primary" onClick={() => onEdit()}>
            {t('schemePanel.assign')}
          </button>
        </div>
      </>
    );
  }

  const definition = findScheme(catalog, application.schemeKey);
  const roleName = (roleId: string | null) => {
    if (!roleId) return t('schemePanel.role.unassigned');
    const role = definition?.premiseRoles.find((item) => item.roleId === roleId);
    return role ? catalogRoleLabel(role) : roleId;
  };
  const premiseById = new Map(premises.map((node) => [node.nodeId, node]));
  const conclusionById = new Map(conclusions.map((node) => [node.nodeId, node]));
  const bound = new Set(application.premiseBindings.flatMap((binding) => binding.nodeIds));
  const unbound = premises.filter((node) => !bound.has(node.nodeId));
  const staleRefs = [...bound].filter((id) => !premiseById.has(id));
  const staleConclusions = application.conclusionNodeIds.filter((id) => !conclusionById.has(id));
  const answers = new Map(application.criticalQuestionResponses.map((item) => [item.questionId, item]));
  const questions = definition?.criticalQuestions ?? application.criticalQuestionResponses.map((item) => ({ id: item.questionId, text: '' }));
  void lang; // 언어가 바뀌면 카탈로그 문구도 다시 읽는다.
  const originalChanged = original && (original.schemeKey !== application.schemeKey || original.rationale !== application.rationale);

  return (
    <>
      <section className="node-detail-section">
        {/* 쟁점 구조 관계는 Walton 논증 도식이 아니므로 제목을 나눈다. */}
        <h3>{definition?.group === ISSUE_RELATION_GROUP ? t('schemePanel.title.issueRelation') : t('schemePanel.title.walton')}</h3>
        <div className="scheme-title">
          <strong>{schemeFullName(application, catalog)}</strong>
          {definition && lang !== 'en' ? <span className="node-detail-muted"> {definition.name}</span> : null}
        </div>
        <div className="node-detail-badges">
          <span className={`badge badge-origin is-${application.origin}`}>
            {application.origin === 'human' ? t('schemePanel.origin.human') : t('schemePanel.origin.ai')}
          </span>
          <span className={`badge scheme-status is-${application.status}`}>{t(SCHEME_STATUS_KEY[application.status])}</span>
          {application.catalogVersion !== null ? (
            <span className="badge badge-note">{t('schemePanel.catalogVersion', { version: application.catalogVersion })}</span>
          ) : null}
        </div>
        {definition ? <p className="node-detail-muted">{schemeDescription(definition)}</p> : null}
        {definition?.sourceNote ? (
          <details className="node-detail-original">
            <summary>
              {t('schemePanel.source')}
              {definition.verification === 'needs-book-check' ? t('schemePanel.source.needsBookCheck') : ''}
            </summary>
            <div className="node-detail-muted">{definition.sourceNote}</div>
          </details>
        ) : null}
        {application.schemeKey !== UNCLASSIFIED && application.schemeKey !== CUSTOM && !definition ? (
          <div className="annotation-warning">{t('schemePanel.unknownKey', { key: application.schemeKey })}</div>
        ) : null}
        {application.status === 'needs_review' ? (
          <div className="annotation-warning" role="status">
            {t('schemePanel.needsReview', {
              reasons: (application.reviewReasons ?? []).join(' / ') || t('schemePanel.needsReview.default'),
            })}
            <div className="node-detail-actions">
              <button type="button" onClick={() => onSave(confirmScheme(application, nowIso()))}>
                {t('schemePanel.keepAsIs')}
              </button>
              <button type="button" onClick={() => onEdit()}>
                {t('schemePanel.reassign')}
              </button>
            </div>
          </div>
        ) : null}
        {application.errors?.length ? (
          <div className="annotation-warning">
            {t('schemePanel.errors', { errors: application.errors.join(' / ') })}
          </div>
        ) : null}
      </section>

      <section className="node-detail-section">
        <h3>{t('schemePanel.rationale')}</h3>
        {application.rationale ? (
          <div className="node-detail-text">{application.rationale}</div>
        ) : (
          <p className="node-detail-empty">{t('schemePanel.rationale.empty')}</p>
        )}
      </section>

      <section className="node-detail-section">
        <h3>{t('schemePanel.premiseConclusion')}</h3>
        <ul className="scheme-premises">
          {application.premiseBindings.map((binding, index) =>
            binding.nodeIds.map((nodeId) => (
              <li key={`${index}-${nodeId}`} className={premiseById.has(nodeId) ? '' : 'is-unassigned'}>
                <span className={`scheme-role ${binding.roleId ? '' : 'is-missing'}`}>{roleName(binding.roleId)}</span>
                {label(premiseById.get(nodeId), nodeId)}
              </li>
            )),
          )}
          {unbound.map((node) => (
            <li key={node.nodeId} className="is-unassigned">
              <span className="scheme-role is-missing">{t('schemePanel.role.none')}</span>
              {label(node, node.nodeId)}
            </li>
          ))}
        </ul>
        {staleRefs.length > 0 ? (
          <div className="annotation-warning">{t('schemePanel.staleRefs', { count: staleRefs.length })}</div>
        ) : null}
        <ul className="scheme-premises">
          {(application.conclusionNodeIds.length > 0 ? application.conclusionNodeIds : conclusions.map((node) => node.nodeId)).map((nodeId) => (
            <li key={nodeId} className={conclusionById.has(nodeId) ? 'scheme-conclusion' : 'scheme-conclusion is-unassigned'}>
              <span className="scheme-role">
                {definition ? catalogRoleLabel(definition.conclusionRole) : t('schemePanel.conclusion')}
              </span>
              {label(conclusionById.get(nodeId), nodeId)}
            </li>
          ))}
        </ul>
        {staleConclusions.length > 0 ? <div className="annotation-warning">{t('schemePanel.staleConclusions')}</div> : null}
      </section>

      {questions.length > 0 && application.schemeKey !== UNCLASSIFIED && application.schemeKey !== CUSTOM ? (
        <section className="node-detail-section">
          <h3>{t('schemePanel.criticalQuestions')}</h3>
          <ul className="scheme-questions">
            {questions.map((question) => {
              const answer = answers.get(question.id);
              const status: CriticalQuestionStatus = answer?.status ?? 'open';
              return (
                <li key={question.id} className={`is-${status}`}>
                  <div>
                    <span className={`cq-status is-${status}`}>{t(CQ_STATUS_KEY[status])}</span> <strong>{question.id}</strong>{' '}
                    {questionText(question)}
                  </div>
                  {answer?.answer ? <div className="cq-answer">{answer.answer}</div> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="node-detail-section">
        <h3>{t('schemePanel.notes')}</h3>
        {application.notes ? (
          <div className="node-detail-text">{application.notes}</div>
        ) : (
          <p className="node-detail-empty">{t('schemePanel.notes.empty')}</p>
        )}
      </section>

      {application.alternatives.length > 0 ? (
        <section className="node-detail-section">
          <h3>{t('schemePanel.alternatives')}</h3>
          <ul className="scheme-premises">
            {application.alternatives.map((alternative) => (
              <li key={alternative.schemeKey}>
                <span className="scheme-role">
                  {(() => {
                    const alternativeDefinition = findScheme(catalog, alternative.schemeKey);
                    return alternativeDefinition ? schemeName(alternativeDefinition) : alternative.schemeKey;
                  })()}
                </span>
                {alternative.rationale}
                <button type="button" className="link-button" onClick={() => onEdit(alternative.schemeKey)}>
                  {t('schemePanel.useAlternative')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {originalChanged || (application.history?.length ?? 0) > 0 ? (
        <details className="node-detail-original">
          <summary>{t('schemePanel.history')}</summary>
          {original ? (
            <div className="node-detail-muted">
              {t('schemePanel.history.original')}
              <strong>{schemeFullName(original, catalog)}</strong>
              {original.rationale ? ` — ${original.rationale}` : ''}
            </div>
          ) : null}
          <ul className="scheme-history">
            {(application.history ?? [])
              .slice()
              .reverse()
              .map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  {new Date(entry.at).toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR')} ·{' '}
                  {entry.by === 'human' ? t('schemePanel.history.by.human') : t('schemePanel.history.by.auto')} ·{' '}
                  {t(
                    (
                      {
                        edit: 'schemePanel.history.action.edit',
                        confirm: 'schemePanel.history.action.confirm',
                        needs_review: 'schemePanel.history.action.needsReview',
                        catalog_migration: 'schemePanel.history.action.migration',
                      } as const
                    )[entry.action],
                  )}{' '}
                  · {t('schemePanel.history.previous')}
                  {schemeFullName({ ...application, schemeKey: entry.previousKey, customSchemeName: entry.previousCustomName ?? null }, catalog)}
                  {entry.previousCatalogVersion
                    ? t('schemePanel.history.catalogVersion', { version: entry.previousCatalogVersion })
                    : ''}{' '}
                  ({t(SCHEME_STATUS_KEY[entry.previousStatus])})
                  {entry.detail ? ` — ${entry.detail}` : ''}
                  {entry.action === 'catalog_migration' && (entry.previousPremiseBindings?.length || entry.previousCriticalQuestionResponses?.length) ? (
                    <div className="node-detail-muted">
                      {entry.previousPremiseBindings?.length
                        ? t('schemePanel.history.previousRoles', {
                            roles: entry.previousPremiseBindings
                              .map(
                                (binding) =>
                                  `${binding.roleId ?? t('schemePanel.role.unassigned')}=${binding.nodeIds.join(', ')}`,
                              )
                              .join(' / '),
                          })
                        : ''}
                      {entry.previousCriticalQuestionResponses?.map((response) => (
                        <div key={response.questionId}>
                          {t('schemePanel.history.previousQuestion', {
                            questionId: response.questionId,
                            status: t(CQ_STATUS_KEY[response.status]),
                          })}
                          {response.answer ? `: ${response.answer}` : ''}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      <div className="node-detail-actions">
        <button type="button" className="is-primary" onClick={() => onEdit()}>
          {t('schemePanel.edit')}
        </button>
        {application.status === 'suggested' ? (
          <button type="button" onClick={() => onSave(confirmScheme(application, nowIso()))} title={t('schemePanel.confirm.title')}>
            {t('schemePanel.confirm')}
          </button>
        ) : null}
      </div>
    </>
  );
}

function NeighborSummary({ premises, conclusions }: { premises: NeighborNode[]; conclusions: NeighborNode[] }) {
  const t = useT();
  return (
    <ul className="scheme-premises">
      {premises.map((node) => (
        <li key={node.nodeId}>
          <span className="scheme-role">{t('schemePanel.premise')}</span>
          {label(node, node.nodeId)}
        </li>
      ))}
      {conclusions.map((node) => (
        <li key={node.nodeId}>
          <span className="scheme-role">{t('schemePanel.conclusion')}</span>
          {label(node, node.nodeId)}
        </li>
      ))}
      {premises.length === 0 && conclusions.length === 0 ? (
        <li className="node-detail-empty">{t('schemePanel.noNeighbors')}</li>
      ) : null}
    </ul>
  );
}

function groupSchemes(schemes: SchemeDefinition[]): Array<[string, SchemeDefinition[]]> {
  const groups = new Map<string, SchemeDefinition[]>();
  for (const scheme of schemes) {
    const group = schemeGroupName(scheme);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(scheme);
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
  const t = useT();
  const lang = useLang();
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
  // 카탈로그 이름은 언어에 따라 달라지므로 lang 도 의존성에 넣는다.
  const grouped = useMemo(() => groupSchemes(catalog?.schemes ?? []), [catalog, lang]);
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
        <span>{t('schemeEditor.kind')}</span>
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
          <option value={UNCLASSIFIED}>{t('schemeEditor.unclassified')}</option>
          <option value={CUSTOM}>{t('schemeEditor.custom')}</option>
          {grouped.map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((item) => (
                <option key={item.schemeKey} value={item.schemeKey}>
                  {t('schemeEditor.option', { nameKo: item.nameKo, name: item.name })}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {definition ? <small className="node-detail-muted">{schemeDescription(definition)}</small> : null}
        {catalog?.status === 'draft' ? <small className="node-detail-muted">{t('schemeEditor.draftCatalog')}</small> : null}
      </label>

      {schemeKey === CUSTOM ? (
        <label className="field">
          <span>{t('schemeEditor.customName')}</span>
          <input
            type="text"
            value={customName}
            onChange={(event) => setCustomName(event.target.value)}
            placeholder={t('schemeEditor.customName.placeholder')}
            required
          />
        </label>
      ) : null}

      <label className="field">
        <span>{t('schemePanel.rationale')}</span>
        <textarea
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          rows={4}
          placeholder={t('schemeEditor.rationale.placeholder')}
        />
      </label>

      {classified ? (
        <fieldset className="field">
          <legend>{t('schemeEditor.premiseRoles')}</legend>
          {premises.length === 0 ? <p className="node-detail-empty">{t('schemeEditor.noPremises')}</p> : null}
          {premises.map((node) => (
            <div key={node.nodeId} className="scheme-role-row">
              <select
                value={roles[node.nodeId] ?? ''}
                onChange={(event) => setRoles((current) => ({ ...current, [node.nodeId]: event.target.value }))}
                aria-label={t('schemeEditor.roleAria', { label: label(node, node.nodeId) })}
                disabled={!definition || definition.premiseRoles.length === 0}
              >
                <option value="">{t('schemeEditor.roleNone')}</option>
                {definition?.premiseRoles.map((role) => (
                  <option key={role.roleId} value={role.roleId} title={roleTemplate(role)}>
                    {catalogRoleLabel(role)}
                  </option>
                ))}
              </select>
              <span className="scheme-role-text">{label(node, node.nodeId)}</span>
            </div>
          ))}
          {definition ? (
            <details className="scheme-templates">
              <summary>{t('schemeEditor.templates')}</summary>
              <ul>
                {definition.premiseRoles.map((role) => (
                  <li key={role.roleId}>
                    <strong>{catalogRoleLabel(role)}</strong>: {roleTemplate(role)}
                  </li>
                ))}
                <li>
                  <strong>{catalogRoleLabel(definition.conclusionRole)}</strong>: {roleTemplate(definition.conclusionRole)}
                </li>
              </ul>
            </details>
          ) : null}
        </fieldset>
      ) : null}

      {conclusions.length > 1 ? (
        <fieldset className="field">
          <legend>{t('schemeEditor.conclusionNodes')}</legend>
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
          <legend>{t('schemePanel.criticalQuestions')}</legend>
          {definition.criticalQuestions.map((question) => {
            const item = questions[question.id] ?? { status: 'open' as const, answer: '' };
            return (
              <div key={question.id} className="cq-edit">
                <div className="cq-edit-head">
                  <strong>{question.id}</strong> {questionText(question)}
                </div>
                <div className="cq-edit-row">
                  <select
                    value={item.status}
                    onChange={(event) => setQuestions((current) => ({ ...current, [question.id]: { ...item, status: event.target.value as CriticalQuestionStatus } }))}
                    aria-label={t('schemeEditor.cqStatusAria', { questionId: question.id })}
                  >
                    {(['open', 'satisfied', 'challenged'] as const).map((status) => (
                      <option key={status} value={status}>
                        {t(CQ_STATUS_KEY[status])}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={item.answer}
                    onChange={(event) => setQuestions((current) => ({ ...current, [question.id]: { ...item, answer: event.target.value } }))}
                    placeholder={t('schemeEditor.cqAnswer.placeholder')}
                    aria-label={t('schemeEditor.cqAnswerAria', { questionId: question.id })}
                  />
                </div>
              </div>
            );
          })}
        </fieldset>
      ) : null}

      <label className="field">
        <span>{t('schemePanel.notes')}</span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          placeholder={t('schemeEditor.notes.placeholder')}
        />
      </label>

      <div className="node-detail-actions">
        <button type="submit" className="is-primary" disabled={schemeKey === CUSTOM && !customName.trim()}>
          {t('schemeEditor.save')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('schemeEditor.cancel')}
        </button>
        {application ? (
          <button type="button" className="is-danger" onClick={() => window.confirm(t('schemeEditor.clear.confirm')) && onSubmit(null)}>
            {t('schemeEditor.clear')}
          </button>
        ) : null}
        <span className="annotation-hint">{t('schemeEditor.saveHint')}</span>
      </div>
    </form>
  );
}
