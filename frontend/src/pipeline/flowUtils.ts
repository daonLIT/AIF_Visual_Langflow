/**
 * Langflow flow data 편집용 순수 함수. backend/app/services/pipeline/flow_model.py 와 같은 규칙을 따른다.
 * - handle 문자열: 키를 정렬한 JSON 의 큰따옴표를 œ 로 바꾼 형식
 * - 프롬프트 변수: Python string.Formatter 규칙 ({{ }} 는 문자 그대로)
 * - 알 수 없는 필드는 복사만 하고 지우지 않는다
 */
import type {
  FlowDiff,
  ComponentKind,
  ComponentTemplate,
  LfEdge,
  LfFieldSpec,
  LfFlowData,
  LfNode,
  LfOutput,
  LfSourceHandle,
  LfTargetHandle,
  PipelineIssue,
} from '../types/pipeline';
import { SECRET_SENTINEL } from '../types/pipeline';
import { t } from '../i18n';

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) 와 같은 문자열 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function handleString(value: LfSourceHandle | LfTargetHandle): string {
  return stableStringify(value).replace(/"/g, 'œ');
}

export function parseHandle<T>(value: unknown): T | null {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value.replace(/œ/g, '"'));
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function templateOf(node: LfNode): Record<string, LfFieldSpec> {
  return (node.data?.node?.template ?? {}) as Record<string, LfFieldSpec>;
}

export function fieldSpec(node: LfNode, field: string): LfFieldSpec | undefined {
  const spec = templateOf(node)[field];
  return spec && typeof spec === 'object' ? spec : undefined;
}

export function componentKind(node: LfNode): ComponentKind {
  const type = String(node.data?.type ?? '');
  const template = templateOf(node);
  if (type === 'ChatOutput') return 'output';
  if (type === 'ChatInput' || type === 'TextInput') return 'input';
  if (template.template?._input_type === 'PromptInput' || type === 'Prompt Template') return 'prompt';
  if (type.toLowerCase().includes('ollama') || node.data?.node?.name === 'OllamaModel') return 'llm';
  if (type === 'CustomComponent') return 'custom';
  return 'generic';
}

export function displayName(node: LfNode): string {
  return String(node.data?.node?.display_name ?? node.data?.type ?? node.id);
}

export function isSecretField(spec: LfFieldSpec | undefined): boolean {
  return !!spec && (spec.password === true || spec._input_type === 'SecretStrInput');
}

/** 연결(엣지)을 받을 수 있는 입력 필드인지 */
export function acceptsConnection(spec: LfFieldSpec | undefined): boolean {
  return !!spec && ((Array.isArray(spec.input_types) && spec.input_types.length > 0) || spec.type === 'other');
}

/** field_order 순서 → 나머지 순으로 편집 가능한 필드 목록 */
export function orderedFields(node: LfNode): Array<[string, LfFieldSpec]> {
  const template = templateOf(node);
  const order = (node.data?.node?.field_order as string[] | undefined) ?? [];
  const names = [...order.filter((name) => name in template), ...Object.keys(template).filter((name) => !order.includes(name))];
  return names
    .filter((name) => !name.startsWith('_') && template[name] && typeof template[name] === 'object')
    .map((name) => [name, template[name]]);
}

export function outputsOf(node: LfNode): LfOutput[] {
  return ((node.data?.node?.outputs as LfOutput[] | undefined) ?? []).filter((output) => output && output.hidden !== true);
}

export function outputTypes(output: LfOutput): string[] {
  return output.types?.length ? output.types : output.selected ? [output.selected] : [];
}

export function connectedFields(data: LfFlowData, nodeId: string): Map<string, LfEdge[]> {
  const map = new Map<string, LfEdge[]>();
  for (const edge of data.edges) {
    if (edge.target !== nodeId) continue;
    const handle = parseHandle<LfTargetHandle>(edge.data?.targetHandle ?? edge.targetHandle);
    if (!handle) continue;
    if (!map.has(handle.fieldName)) map.set(handle.fieldName, []);
    map.get(handle.fieldName)!.push(edge);
  }
  return map;
}

export function canConnect(
  data: LfFlowData,
  sourceId: string,
  outputName: string,
  targetId: string,
  fieldName: string,
): { ok: boolean; reason?: string } {
  if (sourceId === targetId) return { ok: false, reason: t('flow.connect.sameNode') };
  const source = data.nodes.find((node) => node.id === sourceId);
  const target = data.nodes.find((node) => node.id === targetId);
  if (!source || !target) return { ok: false, reason: t('flow.connect.missingNode') };
  const output = outputsOf(source).find((item) => item.name === outputName);
  const spec = fieldSpec(target, fieldName);
  if (!output) return { ok: false, reason: t('flow.connect.missingOutput', { name: outputName }) };
  if (!spec || !acceptsConnection(spec)) return { ok: false, reason: t('flow.connect.notConnectable', { name: fieldName }) };
  const inputs = spec.input_types ?? [];
  if (inputs.length > 0 && !outputTypes(output).some((type) => inputs.includes(type))) {
    return { ok: false, reason: t('flow.connect.typeMismatch', { from: outputTypes(output).join('/'), to: inputs.join('/') }) };
  }
  const existing = connectedFields(data, targetId).get(fieldName) ?? [];
  if (existing.length > 0 && !spec.list) return { ok: false, reason: t('flow.connect.alreadyConnected', { name: fieldName }) };
  if (createsCycle(data, sourceId, targetId)) return { ok: false, reason: t('flow.connect.cycle') };
  return { ok: true };
}

function createsCycle(data: LfFlowData, sourceId: string, targetId: string): boolean {
  // target 에서 출발해 source 에 닿으면 순환
  const adjacency = new Map<string, string[]>();
  for (const edge of data.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge.target);
  }
  const stack = [targetId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function makeEdge(source: LfNode, outputName: string, target: LfNode, fieldName: string): LfEdge {
  const output = outputsOf(source).find((item) => item.name === outputName);
  const spec = fieldSpec(target, fieldName) ?? {};
  const sourceHandle: LfSourceHandle = {
    dataType: String(source.data.type),
    id: source.id,
    name: outputName,
    output_types: [output?.selected ?? outputTypes(output ?? { name: outputName })[0] ?? 'Message'],
  };
  const targetHandle: LfTargetHandle = {
    fieldName,
    id: target.id,
    inputTypes: (spec.input_types as string[] | undefined) ?? [],
    type: String(spec.type ?? 'str'),
  };
  return {
    animated: false,
    className: '',
    data: { sourceHandle, targetHandle },
    id: `xy-edge__${source.id}${handleString(sourceHandle)}-${target.id}${handleString(targetHandle)}`,
    selected: false,
    source: source.id,
    sourceHandle: handleString(sourceHandle),
    target: target.id,
    targetHandle: handleString(targetHandle),
  };
}

// ---- prompts ----
const PROMPT_INVALID = new Set([' ', ',', '.', ':', ';', '!', '?', '/', '\\', '(', ')', '[', ']', '"', "'"]);
const PROMPT_RESERVED = new Set(['code', 'input_variables', 'output_parser', 'partial_variables', 'template', 'template_format', 'validate_template']);

/** Python string.Formatter().parse 와 같은 방식으로 변수를 뽑는다. */
export function promptVariables(template: string): { variables: string[]; error: string | null } {
  const variables: string[] = [];
  let i = 0;
  while (i < template.length) {
    const char = template[i];
    if (char === '{') {
      if (template[i + 1] === '{') {
        i += 2;
        continue;
      }
      const close = template.indexOf('}', i + 1);
      const nextOpen = template.indexOf('{', i + 1);
      if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
        return { variables, error: t('flow.prompt.unclosed') };
      }
      const raw = template.slice(i + 1, close);
      const name = raw.split(/[!:]/, 1)[0];
      if (!variables.includes(name)) variables.push(name);
      i = close + 1;
      continue;
    }
    if (char === '}') {
      if (template[i + 1] === '}') {
        i += 2;
        continue;
      }
      return { variables, error: t('flow.prompt.unmatched') };
    }
    i += 1;
  }
  for (const name of variables) {
    if (name === '') return { variables, error: t('flow.prompt.emptyVariable') };
    if (/^\d/.test(name) || [...name].some((c) => PROMPT_INVALID.has(c))) {
      return { variables, error: t('flow.prompt.badName', { name: `{${name}}` }) };
    }
    if (PROMPT_RESERVED.has(name)) return { variables, error: t('flow.prompt.reserved', { name }) };
  }
  return { variables, error: null };
}

export function defaultPromptField(name: string, value: unknown = ''): LfFieldSpec {
  return {
    field_type: 'str',
    required: false,
    placeholder: '',
    list: false,
    show: true,
    multiline: true,
    value,
    fileTypes: [],
    file_path: '',
    name,
    display_name: name,
    advanced: false,
    api_editable: false,
    input_types: ['Message'],
    dynamic: false,
    info: '',
    load_from_db: false,
    title_case: false,
    type: 'str',
  };
}

/**
 * 프롬프트 텍스트를 바꾸고 변수 필드를 Langflow 의 process_prompt_template 과 같은 방식으로 맞춘다.
 * 문법 오류가 있으면 텍스트만 바꾸고 필드는 그대로 둔다(오류는 검증에서 보고).
 */
export function syncPromptFields(node: LfNode, templateText: string): { node: LfNode; error: string | null; removedFields: string[] } {
  const next = clone(node);
  const template = next.data.node.template as Record<string, LfFieldSpec>;
  template.template = { ...(template.template ?? {}), value: templateText };
  const { variables, error } = promptVariables(templateText);
  if (error) return { node: next, error, removedFields: [] };
  const customFields = { ...(next.data.node.custom_fields ?? {}) };
  const old = customFields.template ?? [];
  for (const name of variables) {
    const previous = template[name];
    template[name] = defaultPromptField(name, previous && typeof previous === 'object' ? previous.value ?? '' : '');
  }
  const removedFields = old.filter((name) => !variables.includes(name));
  for (const name of removedFields) delete template[name];
  customFields.template = [...variables];
  next.data.node.custom_fields = customFields;
  return { node: next, error: null, removedFields };
}

/** 없는 노드·필드·출력을 가리키는 엣지를 뺀다. */
export function removeDanglingEdges(data: LfFlowData): { data: LfFlowData; removed: LfEdge[] } {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const removed: LfEdge[] = [];
  const edges = data.edges.filter((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const sourceHandle = parseHandle<LfSourceHandle>(edge.data?.sourceHandle ?? edge.sourceHandle);
    const targetHandle = parseHandle<LfTargetHandle>(edge.data?.targetHandle ?? edge.targetHandle);
    const ok =
      !!source &&
      !!target &&
      !!sourceHandle &&
      !!targetHandle &&
      outputsOf(source).some((output) => output.name === sourceHandle.name) &&
      !!fieldSpec(target, targetHandle.fieldName);
    if (!ok) removed.push(edge);
    return ok;
  });
  return { data: removed.length > 0 ? { ...data, edges } : data, removed };
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Langflow 형식의 컴포넌트 ID: `${type}-${5자}` */
export function newNodeId(type: string, existing: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(existing);
  for (;;) {
    let suffix = '';
    for (let i = 0; i < 5; i += 1) suffix += ID_CHARS[Math.floor(random() * ID_CHARS.length)];
    const id = `${type}-${suffix}`;
    if (!used.has(id)) return id;
  }
}

/** 팔레트 템플릿으로 새 노드를 만든다. 템플릿의 마스킹된 비밀 값은 비운다(새 컴포넌트에는 원격 값이 없다). */
export function instantiateTemplate(
  template: ComponentTemplate,
  position: { x: number; y: number },
  existingIds: Iterable<string>,
): LfNode {
  const type = template.kind === 'custom' ? 'CustomComponent' : template.type;
  const id = newNodeId(type, existingIds);
  const info = clone(template.node);
  for (const spec of Object.values(info.template)) {
    if (spec && typeof spec === 'object' && (spec as LfFieldSpec).value === SECRET_SENTINEL) (spec as LfFieldSpec).value = '';
  }
  return {
    id,
    type: 'genericNode',
    position: { ...position },
    data: { id, type, node: info, showNode: true },
    selected: false,
  };
}

/** 즉시 피드백용 가벼운 검증. 적용 전에는 서버 검증을 반드시 거친다. */
export function validateLocal(data: LfFlowData, relay?: { inputComponentId: string; outputComponentId: string }): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const ids = new Set<string>();
  for (const node of data.nodes) {
    if (ids.has(node.id)) issues.push({ level: 'error', code: 'DUPLICATE_NODE', message: t('flow.issue.duplicateNode', { nodeId: node.id }), nodeId: node.id });
    ids.add(node.id);
    if (componentKind(node) === 'prompt') {
      const text = String(fieldSpec(node, 'template')?.value ?? '');
      const { variables, error } = promptVariables(text);
      if (error) issues.push({ level: 'error', code: 'PROMPT_SYNTAX', message: `${displayName(node)}: ${error}`, nodeId: node.id, field: 'template' });
      else
        for (const name of variables)
          if (!fieldSpec(node, name))
            issues.push({
              level: 'error',
              code: 'PROMPT_FIELD_MISSING',
              message: t('flow.issue.promptFieldMissing', { node: displayName(node), name: `{${name}}` }),
              nodeId: node.id,
              field: name,
            });
    }
  }
  const counts = new Map<string, number>();
  for (const edge of data.edges) {
    const source = data.nodes.find((node) => node.id === edge.source);
    const target = data.nodes.find((node) => node.id === edge.target);
    const sourceHandle = parseHandle<LfSourceHandle>(edge.data?.sourceHandle ?? edge.sourceHandle);
    const targetHandle = parseHandle<LfTargetHandle>(edge.data?.targetHandle ?? edge.targetHandle);
    if (!source || !target || !sourceHandle || !targetHandle) {
      issues.push({ level: 'error', code: 'EDGE_ENDPOINT', message: t('flow.issue.edgeEndpoint', { edgeId: edge.id }), edgeId: edge.id });
      continue;
    }
    const output = outputsOf(source).find((item) => item.name === sourceHandle.name);
    const spec = fieldSpec(target, targetHandle.fieldName);
    if (!output || !spec) {
      issues.push({
        level: 'error',
        code: 'EDGE_HANDLE',
        message: t('flow.issue.edgeHandle', {
          source: displayName(source),
          target: displayName(target),
          field: targetHandle.fieldName,
        }),
        edgeId: edge.id,
        nodeId: target.id,
      });
      continue;
    }
    const inputs = spec.input_types ?? [];
    if (inputs.length > 0 && !outputTypes(output).some((type) => inputs.includes(type))) {
      issues.push({
        level: 'error',
        code: 'EDGE_TYPE',
        message: t('flow.issue.edgeType', {
          source: displayName(source),
          target: displayName(target),
          field: targetHandle.fieldName,
        }),
        edgeId: edge.id,
        nodeId: target.id,
      });
    }
    const key = `${target.id}::${targetHandle.fieldName}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) > 1 && !spec.list) {
      issues.push({
        level: 'error',
        code: 'FIELD_MULTI_EDGE',
        message: t('flow.issue.multiEdge', { target: displayName(target), field: targetHandle.fieldName }),
        nodeId: target.id,
        field: targetHandle.fieldName,
      });
    }
  }
  if (relay) {
    if (!ids.has(relay.inputComponentId)) {
      issues.push({ level: 'error', code: 'RELAY_INPUT', message: t('flow.issue.relayInput', { id: relay.inputComponentId }) });
    }
    if (!ids.has(relay.outputComponentId)) {
      issues.push({ level: 'error', code: 'RELAY_OUTPUT', message: t('flow.issue.relayOutput', { id: relay.outputComponentId }) });
    }
  }
  return issues;
}

/** 실행에 영향을 주는 노드 내용 (위치·선택 상태 제외) */
function nodeFingerprint(node: LfNode): string {
  const { position: _position, selected: _selected, dragging: _dragging, positionAbsolute: _absolute, measured: _measured, ...rest } = node as LfNode & Record<string, unknown>;
  void _position;
  void _selected;
  void _dragging;
  void _absolute;
  void _measured;
  return JSON.stringify(rest);
}

/** 적용본(base)과 편집 중(current) flow 의 차이. 서버 diff_flow_data 와 같은 항목을 편집기에서 바로 계산한다. */
export function diffFlowData(base: LfFlowData, current: LfFlowData): FlowDiff {
  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const baseEdges = new Set(base.edges.map((edge) => edge.id));
  const currentEdges = new Set(current.edges.map((edge) => edge.id));
  const nodesChanged: string[] = [];
  const nodesMoved: string[] = [];
  for (const [id, node] of currentNodes) {
    const previous = baseNodes.get(id);
    if (!previous) continue;
    if (nodeFingerprint(previous) !== nodeFingerprint(node)) nodesChanged.push(id);
    if (previous.position.x !== node.position.x || previous.position.y !== node.position.y) nodesMoved.push(id);
  }
  const diff: FlowDiff = {
    nodesAdded: [...currentNodes.keys()].filter((id) => !baseNodes.has(id)),
    nodesRemoved: [...baseNodes.keys()].filter((id) => !currentNodes.has(id)),
    nodesChanged,
    nodesMoved,
    edgesAdded: [...currentEdges].filter((id) => !baseEdges.has(id)).length,
    edgesRemoved: [...baseEdges].filter((id) => !currentEdges.has(id)).length,
  };
  diff.sameExecution =
    diff.nodesAdded.length === 0 && diff.nodesRemoved.length === 0 && diff.nodesChanged.length === 0 && diff.edgesAdded === 0 && diff.edgesRemoved === 0;
  return diff;
}

export function describeDiff(diff: FlowDiff): string {
  if (diff.sameExecution) {
    return diff.nodesMoved.length > 0 ? t('flow.diff.moved', { count: diff.nodesMoved.length }) : t('flow.diff.same');
  }
  const parts = [
    diff.nodesChanged.length ? t('flow.diff.changed', { count: diff.nodesChanged.length }) : '',
    diff.nodesAdded.length ? t('flow.diff.added', { count: diff.nodesAdded.length }) : '',
    diff.nodesRemoved.length ? t('flow.diff.removed', { count: diff.nodesRemoved.length }) : '',
    diff.edgesAdded || diff.edgesRemoved ? t('flow.diff.edges', { added: diff.edgesAdded, removed: diff.edgesRemoved }) : '',
  ].filter(Boolean);
  return t('flow.diff.components', { parts: parts.join(' · ') });
}
