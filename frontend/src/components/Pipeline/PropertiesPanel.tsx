import { useMemo, useState } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';
import {
  componentKind,
  connectedFields,
  displayName,
  fieldSpec,
  orderedFields,
  parseHandle,
  promptVariables,
} from '../../pipeline/flowUtils';
import type { LfFieldSpec, LfNode, LfSourceHandle, PipelineIssue } from '@aif/workbench/types/pipeline';
import { KIND_KEY } from '@aif/workbench/types/pipeline';
import { FieldEditor } from './FieldEditor';
import { useT } from '@aif/workbench/i18n';

/** 언어 모델 컴포넌트에서 먼저 보여줄 설정 */
const LLM_PRIMARY = ['model_name', 'base_url', 'temperature', 'timeout', 'num_ctx', 'system_message', 'format'];

export function PropertiesPanel() {
  const t = useT();
  const data = usePipelineStore((state) => state.data);
  const current = usePipelineStore((state) => state.current);
  const selectedNodeId = usePipelineStore((state) => state.selectedNodeId);
  const localIssues = usePipelineStore((state) => state.localIssues);
  const serverIssues = usePipelineStore((state) => state.serverIssues);
  const node = data?.nodes.find((item) => item.id === selectedNodeId) ?? null;

  if (!data || !current) return <aside className="lf-props" />;
  if (!node) {
    return (
      <aside className="lf-props">
        <div className="lf-props-empty">
          <h3>{current.flow.name}</h3>
          <p>{t('lf.props.empty')}</p>
          <ul>
            <li>{t('lf.props.hint1')}</li>
            <li>{t('lf.props.hint2')}</li>
            <li>{t('lf.props.hint3')}</li>
          </ul>
          <p className="lf-muted">
            {t('lf.props.summary', {
              nodes: current.summary.nodeCount,
              edges: current.summary.edgeCount,
              secrets: current.secretFields.length,
            })}
          </p>
        </div>
      </aside>
    );
  }
  const issues = [...localIssues, ...(serverIssues ?? [])].filter((issue) => issue.nodeId === node.id);
  return (
    <aside className="lf-props" key={node.id}>
      <NodeProperties node={node} issues={issues} />
    </aside>
  );
}

function NodeProperties({ node, issues }: { node: LfNode; issues: PipelineIssue[] }) {
  const t = useT();
  const data = usePipelineStore((state) => state.data)!;
  const current = usePipelineStore((state) => state.current)!;
  const mode = usePipelineStore((state) => state.mode);
  const busy = usePipelineStore((state) => state.busy);
  const updateField = usePipelineStore((state) => state.updateField);
  const updateNodeInfo = usePipelineStore((state) => state.updateNodeInfo);
  const deleteNodes = usePipelineStore((state) => state.deleteNodes);
  const kind = componentKind(node);
  const support = current.support[node.id];
  const [showAdvanced, setShowAdvanced] = useState(false);

  const connections = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [field, edges] of connectedFields(data, node.id)) {
      map.set(
        field,
        edges.map((edge) => {
          const handle = parseHandle<LfSourceHandle>(edge.data?.sourceHandle ?? edge.sourceHandle);
          const source = data.nodes.find((item) => item.id === edge.source);
          return `${source ? displayName(source) : edge.source}.${handle?.name ?? '?'}`;
        }),
      );
    }
    return map;
  }, [data, node.id]);

  const fields = orderedFields(node).filter(([name, spec]) => {
    if (name === 'code') return false;
    if (kind === 'prompt' && (name === 'template' || ((node.data.node.custom_fields?.template ?? []) as string[]).includes(name))) return false;
    return spec.show !== false || connections.has(name);
  });
  const primary = kind === 'llm' ? LLM_PRIMARY.map((name) => fields.find(([field]) => field === name)).filter(Boolean) as Array<[string, LfFieldSpec]> : [];
  const primaryNames = new Set(primary.map(([name]) => name));
  const basic = fields.filter(([name, spec]) => !primaryNames.has(name) && !spec.advanced);
  const advanced = fields.filter(([name, spec]) => !primaryNames.has(name) && spec.advanced);
  const isRelay = node.id === current.relay.inputComponentId || node.id === current.relay.outputComponentId;

  return (
    <>
      <header className="lf-props-header">
        <span className={`lf-kind is-${kind}`}>{t(KIND_KEY[kind])}</span>
        <input
          className="lf-props-title"
          value={String(node.data.node.display_name ?? '')}
          onChange={(event) => updateNodeInfo(node.id, { display_name: event.target.value })}
          aria-label={t('lf.props.nameAria')}
        />
      </header>
      <div className="lf-props-meta">
        <code>{node.id}</code> · {String(node.data.type)}
        {isRelay ? (
          <span className="lf-flag is-relay">
            {t('lf.props.relay', {
              role: node.id === current.relay.inputComponentId ? t('lf.props.relay.input') : t('lf.props.relay.output'),
            })}
          </span>
        ) : null}
      </div>
      {support ? <p className={`lf-support is-${support.level}`}>{support.note}</p> : null}
      {issues.length > 0 ? (
        <ul className="lf-issues">
          {issues.map((issue, index) => (
            <li key={index} className={`is-${issue.level}`}>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      {kind === 'prompt' ? <PromptEditor node={node} connections={connections} /> : null}

      {primary.length > 0 ? (
        <section className="lf-props-section">
          <h4>{t('lf.props.modelSettings')}</h4>
          {primary.map(([name, spec]) => (
            <FieldEditor key={name} name={name} spec={spec} connectedFrom={connections.get(name)} onChange={(value) => updateField(node.id, name, value)} />
          ))}
        </section>
      ) : null}

      {basic.length > 0 ? (
        <section className="lf-props-section">
          <h4>{kind === 'llm' ? t('lf.props.otherSettings') : t('lf.props.inputSettings')}</h4>
          {basic.map(([name, spec]) => (
            <FieldEditor key={name} name={name} spec={spec} connectedFrom={connections.get(name)} onChange={(value) => updateField(node.id, name, value)} />
          ))}
        </section>
      ) : null}

      {advanced.length > 0 ? (
        <section className="lf-props-section">
          <button type="button" className="link-button" onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? t('lf.props.hideAdvanced') : t('lf.props.showAdvanced', { count: advanced.length })}
          </button>
          {showAdvanced
            ? advanced.map(([name, spec]) => (
                <FieldEditor key={name} name={name} spec={spec} connectedFrom={connections.get(name)} onChange={(value) => updateField(node.id, name, value)} />
              ))
            : null}
        </section>
      ) : null}

      {fieldSpec(node, 'code') ? <CodeEditor node={node} liveMode={mode === 'live'} busy={!!busy} /> : null}

      <div className="lf-props-actions">
        <button
          type="button"
          className="is-danger"
          disabled={isRelay}
          onClick={() => deleteNodes([node.id])}
          title={isRelay ? t('lf.props.delete.blocked') : undefined}
        >
          {t('lf.props.delete')}
        </button>
      </div>
    </>
  );
}

function PromptEditor({ node, connections }: { node: LfNode; connections: Map<string, string[]> }) {
  const t = useT();
  const updatePrompt = usePipelineStore((state) => state.updatePrompt);
  const updateField = usePipelineStore((state) => state.updateField);
  const stored = String(fieldSpec(node, 'template')?.value ?? '');
  const [text, setText] = useState(stored);
  const [base, setBase] = useState(stored);
  if (stored !== base) {
    // undo/redo·재구성으로 저장값이 바뀌면 편집 중 텍스트도 맞춘다.
    setBase(stored);
    setText(stored);
  }
  const { variables, error } = promptVariables(text);
  const changed = text !== stored;
  const customFields = (node.data.node.custom_fields?.template ?? []) as string[];

  return (
    <section className="lf-props-section">
      <h4>{t('lf.props.prompt')}</h4>
      <textarea
        className="lf-prompt"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => changed && updatePrompt(node.id, text)}
        rows={16}
        spellCheck={false}
        aria-label={t('lf.props.promptAria')}
      />
      <div className="lf-field-row">
        <button type="button" disabled={!changed} onClick={() => updatePrompt(node.id, text)}>
          {t('lf.props.promptApply')}
        </button>
        <button type="button" disabled={!changed} onClick={() => setText(stored)}>
          {t('lf.props.promptRevert')}
        </button>
        <span className="lf-muted">{t('lf.props.charCount', { count: text.length.toLocaleString() })}</span>
      </div>
      {error ? <div className="lf-error">{error}</div> : null}
      <div className="lf-vars">
        {t('lf.props.variables')}
        {variables.length === 0 ? <span className="lf-muted">{t('lf.node.none')}</span> : null}
        {variables.map((name) => (
          <span
            key={name}
            className={`lf-var ${connections.has(name) ? 'is-connected' : ''}`}
            title={connections.get(name)?.join(', ') ?? t('lf.props.noConnection')}
          >
            {`{${name}}`}
          </span>
        ))}
      </div>
      <small className="lf-field-info">{t('lf.props.promptHint')}</small>
      {customFields
        .filter((name) => !connections.has(name))
        .map((name) => {
          const spec = fieldSpec(node, name);
          return spec ? <FieldEditor key={name} name={name} spec={spec} onChange={(value) => updateField(node.id, name, value)} /> : null;
        })}
    </section>
  );
}

function CodeEditor({ node, liveMode, busy }: { node: LfNode; liveMode: boolean; busy: boolean }) {
  const t = useT();
  const updateCode = usePipelineStore((state) => state.updateCode);
  const rebuildComponent = usePipelineStore((state) => state.rebuildComponent);
  const stored = String(fieldSpec(node, 'code')?.value ?? '');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(stored);
  const [base, setBase] = useState(stored);
  if (stored !== base) {
    setBase(stored);
    setText(stored);
  }
  const changed = text !== stored;

  return (
    <section className="lf-props-section lf-code">
      <button type="button" className="link-button" onClick={() => setOpen((value) => !value)}>
        {open ? t('lf.code.close') : t('lf.code.open')}
      </button>
      {open ? (
        <>
          <div className="lf-warning">{t('lf.code.warning')}</div>
          <textarea
            className="lf-code-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={22}
            spellCheck={false}
            aria-label={t('lf.code.aria')}
          />
          <div className="lf-field-row">
            <button type="button" disabled={!changed} onClick={() => updateCode(node.id, text)}>
              {t('lf.code.apply')}
            </button>
            <button type="button" disabled={!changed} onClick={() => setText(stored)}>
              {t('lf.code.revert')}
            </button>
            <button
              type="button"
              disabled={!liveMode || changed || busy}
              onClick={() => void rebuildComponent(node.id)}
              title={
                liveMode
                  ? changed
                    ? t('lf.code.rebuild.applyFirst')
                    : t('lf.code.rebuild.title')
                  : t('lf.code.rebuild.liveOnly')
              }
            >
              {t('lf.code.rebuild')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
