import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import {
  acceptsConnection,
  componentKind,
  displayName,
  fieldSpec,
  orderedFields,
  outputTypes,
  outputsOf,
  promptVariables,
} from '../../pipeline/flowUtils';
import type { LfNode, SupportInfo } from '../../types/pipeline';
import { KIND_LABEL } from '../../types/pipeline';

export interface LfNodeData extends Record<string, unknown> {
  lfNode: LfNode;
  support?: SupportInfo;
  connected: string[];
  errorCount: number;
  isRelayInput: boolean;
  isRelayOutput: boolean;
}

export type LfFlowNode = Node<LfNodeData, 'lf'>;

function preview(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

/** Langflow 컴포넌트 노드. 흐름은 왼쪽(입력) → 오른쪽(출력). */
export function LfNodeView({ data, selected }: NodeProps<LfFlowNode>) {
  const node = data.lfNode;
  const kind = componentKind(node);
  const connected = new Set(data.connected);
  const inputs = orderedFields(node).filter(
    ([name, spec]) => name !== 'code' && acceptsConnection(spec) && spec.show !== false && (!spec.advanced || connected.has(name)),
  );
  const outputs = outputsOf(node);

  const facts: Array<[string, string]> = [];
  if (kind === 'llm') {
    for (const name of ['model_name', 'temperature', 'num_ctx', 'timeout']) {
      const value = fieldSpec(node, name)?.value;
      if (value !== undefined && value !== '') facts.push([String(fieldSpec(node, name)?.display_name ?? name), preview(value)]);
    }
  }
  if (kind === 'prompt') {
    const { variables, error } = promptVariables(String(fieldSpec(node, 'template')?.value ?? ''));
    facts.push(['변수', error ? '오류' : variables.map((v) => `{${v}}`).join(' ') || '없음']);
  }
  if (kind === 'custom') {
    for (const name of ['model_name', 'max_issues', 'max_concurrency']) {
      const value = fieldSpec(node, name)?.value;
      if (value !== undefined && value !== '') facts.push([String(fieldSpec(node, name)?.display_name ?? name), preview(value)]);
    }
  }

  return (
    <div className={`lf-node is-${kind} ${selected ? 'is-selected' : ''} ${data.errorCount > 0 ? 'has-errors' : ''}`}>
      <header className="lf-node-header">
        <span className={`lf-kind is-${kind}`}>{KIND_LABEL[kind]}</span>
        <span className="lf-node-title" title={node.id}>
          {displayName(node)}
        </span>
        {data.support?.level === 'partial' ? <span className="lf-flag" title={data.support.note}>부분 지원</span> : null}
        {data.isRelayInput ? <span className="lf-flag is-relay" title="중계 서버가 판결문을 넣는 입력">입력</span> : null}
        {data.isRelayOutput ? <span className="lf-flag is-relay" title="중계 서버가 결과를 읽는 출력">출력</span> : null}
        {data.errorCount > 0 ? <span className="lf-flag is-error">오류 {data.errorCount}</span> : null}
      </header>

      {facts.length > 0 ? (
        <dl className="lf-node-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="lf-node-ports">
        <ul className="lf-inputs">
          {inputs.map(([name, spec]) => (
            <li key={name} className={connected.has(name) ? 'is-connected' : ''} title={`입력 형식: ${(spec.input_types ?? []).join(', ') || spec.type}`}>
              <Handle type="target" position={Position.Left} id={name} className="lf-handle lf-handle-in" />
              <span>{String(spec.display_name ?? name)}</span>
              {spec.required ? <span className="lf-required">*</span> : null}
            </li>
          ))}
        </ul>
        <ul className="lf-outputs">
          {outputs.map((output) => (
            <li key={output.name} title={`출력 형식: ${outputTypes(output).join(', ')}`}>
              <span>{output.display_name ?? output.name}</span>
              <Handle type="source" position={Position.Right} id={output.name} className="lf-handle lf-handle-out" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
