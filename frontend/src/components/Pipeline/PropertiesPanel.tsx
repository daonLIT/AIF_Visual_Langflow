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
import type { LfFieldSpec, LfNode, LfSourceHandle, PipelineIssue } from '../../types/pipeline';
import { KIND_LABEL } from '../../types/pipeline';
import { FieldEditor } from './FieldEditor';

/** 언어 모델 컴포넌트에서 먼저 보여줄 설정 */
const LLM_PRIMARY = ['model_name', 'base_url', 'temperature', 'timeout', 'num_ctx', 'system_message', 'format'];

export function PropertiesPanel() {
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
          <p>컴포넌트를 선택하면 속성을 편집할 수 있습니다.</p>
          <ul>
            <li>포트 연결: 오른쪽 출력 점 → 왼쪽 입력 점으로 드래그 (형식이 맞는 입력만 허용)</li>
            <li>연결 해제·삭제: 선택 후 Delete</li>
            <li>추가: 왼쪽 목록에서 캔버스로 끌어다 놓기</li>
          </ul>
          <p className="lf-muted">
            컴포넌트 {current.summary.nodeCount}개 · 연결 {current.summary.edgeCount}개 · 비밀 필드 {current.secretFields.length}개(값은 서버에만 있음)
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
        <span className={`lf-kind is-${kind}`}>{KIND_LABEL[kind]}</span>
        <input
          className="lf-props-title"
          value={String(node.data.node.display_name ?? '')}
          onChange={(event) => updateNodeInfo(node.id, { display_name: event.target.value })}
          aria-label="표시 이름"
        />
      </header>
      <div className="lf-props-meta">
        <code>{node.id}</code> · {String(node.data.type)}
        {isRelay ? <span className="lf-flag is-relay">중계 서버 {node.id === current.relay.inputComponentId ? '입력' : '출력'}</span> : null}
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
          <h4>모델 설정</h4>
          {primary.map(([name, spec]) => (
            <FieldEditor key={name} name={name} spec={spec} connectedFrom={connections.get(name)} onChange={(value) => updateField(node.id, name, value)} />
          ))}
        </section>
      ) : null}

      {basic.length > 0 ? (
        <section className="lf-props-section">
          <h4>{kind === 'llm' ? '기타 설정' : '입력·설정'}</h4>
          {basic.map(([name, spec]) => (
            <FieldEditor key={name} name={name} spec={spec} connectedFrom={connections.get(name)} onChange={(value) => updateField(node.id, name, value)} />
          ))}
        </section>
      ) : null}

      {advanced.length > 0 ? (
        <section className="lf-props-section">
          <button type="button" className="link-button" onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? '고급 설정 접기' : `고급 설정 ${advanced.length}개 보기`}
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
        <button type="button" className="is-danger" disabled={isRelay} onClick={() => deleteNodes([node.id])} title={isRelay ? '중계 서버가 사용하는 컴포넌트입니다' : undefined}>
          컴포넌트 삭제
        </button>
      </div>
    </>
  );
}

function PromptEditor({ node, connections }: { node: LfNode; connections: Map<string, string[]> }) {
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
      <h4>프롬프트</h4>
      <textarea
        className="lf-prompt"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => changed && updatePrompt(node.id, text)}
        rows={16}
        spellCheck={false}
        aria-label="프롬프트 템플릿"
      />
      <div className="lf-field-row">
        <button type="button" disabled={!changed} onClick={() => updatePrompt(node.id, text)}>
          프롬프트 반영
        </button>
        <button type="button" disabled={!changed} onClick={() => setText(stored)}>
          되돌리기
        </button>
        <span className="lf-muted">{text.length.toLocaleString()}자</span>
      </div>
      {error ? <div className="lf-error">{error}</div> : null}
      <div className="lf-vars">
        변수:{' '}
        {variables.length === 0 ? <span className="lf-muted">없음</span> : null}
        {variables.map((name) => (
          <span key={name} className={`lf-var ${connections.has(name) ? 'is-connected' : ''}`} title={connections.get(name)?.join(', ') ?? '연결 없음 (직접 값 사용)'}>
            {`{${name}}`}
          </span>
        ))}
      </div>
      <small className="lf-field-info">
        {'{변수}'} 마다 입력 포트가 생깁니다. JSON 예시처럼 문자 그대로 중괄호가 필요하면 {'{{ }}'} 로 두 번 쓰세요.
      </small>
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
        {open ? '코드 편집 닫기' : '고급: 컴포넌트 코드 편집'}
      </button>
      {open ? (
        <>
          <div className="lf-warning">
            이 코드는 Langflow 서버에서 <strong>실행되는 코드</strong>입니다. 적용하면 다음 분석부터 그대로 실행됩니다. 입력·출력 정의를
            바꿨다면 [Langflow 로 재구성]으로 포트를 다시 만든 뒤 검증하세요.
          </div>
          <textarea className="lf-code-text" value={text} onChange={(event) => setText(event.target.value)} rows={22} spellCheck={false} aria-label="컴포넌트 코드" />
          <div className="lf-field-row">
            <button type="button" disabled={!changed} onClick={() => updateCode(node.id, text)}>
              코드 반영
            </button>
            <button type="button" disabled={!changed} onClick={() => setText(stored)}>
              되돌리기
            </button>
            <button
              type="button"
              disabled={!liveMode || changed || busy}
              onClick={() => void rebuildComponent(node.id)}
              title={liveMode ? (changed ? '먼저 코드 반영을 누르세요' : 'Langflow 가 코드로 입력·출력 포트를 다시 만듭니다') : 'live 모드에서만 사용할 수 있습니다'}
            >
              Langflow 로 재구성
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
