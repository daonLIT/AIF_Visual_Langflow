/**
 * 파이프라인 편집(Langflow flow data) 타입.
 * 노드·엣지는 Langflow 가 저장한 원래 객체를 그대로 들고 다닌다. 편집기는 필요한 경로만 바꾸고
 * 알 수 없는 필드는 건드리지 않는다. (backend/app/services/pipeline/flow_model.py 와 같은 규칙)
 */

export interface LfFieldSpec {
  type?: string;
  _input_type?: string;
  display_name?: string;
  name?: string;
  value?: unknown;
  show?: boolean;
  advanced?: boolean;
  required?: boolean;
  multiline?: boolean;
  password?: boolean;
  list?: boolean;
  info?: string;
  input_types?: string[];
  options?: unknown[];
  combobox?: boolean;
  range_spec?: { min?: number; max?: number; step?: number };
  load_from_db?: boolean;
  [key: string]: unknown;
}

export interface LfOutput {
  name: string;
  display_name?: string;
  types?: string[];
  selected?: string;
  method?: string;
  group_outputs?: boolean;
  hidden?: boolean | null;
  [key: string]: unknown;
}

export interface LfNodeInfo {
  display_name?: string;
  description?: string;
  template: Record<string, LfFieldSpec | unknown>;
  outputs?: LfOutput[];
  custom_fields?: Record<string, string[]>;
  field_order?: string[];
  base_classes?: string[];
  [key: string]: unknown;
}

export interface LfNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: {
    id: string;
    type: string;
    node: LfNodeInfo;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LfSourceHandle {
  dataType: string;
  id: string;
  name: string;
  output_types: string[];
}

export interface LfTargetHandle {
  fieldName: string;
  id: string;
  inputTypes: string[];
  type: string;
}

export interface LfEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  data?: { sourceHandle?: LfSourceHandle; targetHandle?: LfTargetHandle; [key: string]: unknown };
  [key: string]: unknown;
}

export interface LfFlowData {
  nodes: LfNode[];
  edges: LfEdge[];
  [key: string]: unknown;
}

export type ComponentKind = 'input' | 'prompt' | 'llm' | 'custom' | 'output' | 'generic';

export interface SupportInfo {
  kind: ComponentKind;
  level: 'full' | 'partial';
  note: string;
}

export interface FlowHeader {
  id: string;
  name: string;
  description: string;
  updatedAt: string | null;
  folderId?: string | null;
  tags: string[];
  isProduction: boolean;
  isAnalysisFlow: boolean;
  isWorkingCopy: boolean;
  sourceFlowId?: string | null;
  hasDraft: boolean;
  isRunSnapshot?: boolean;
}

/** 초안과 Langflow 적용본의 차이 (위치 이동은 실행에 영향 없음) */
export interface FlowDiff {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: string[];
  nodesMoved: string[];
  edgesAdded: number;
  edgesRemoved: number;
  sameExecution?: boolean;
}

export interface ModelSetting {
  componentId: string;
  displayName?: string;
  model_name?: unknown;
  base_url?: unknown;
  temperature?: unknown;
  [key: string]: unknown;
}

export interface FlowView {
  flow: FlowHeader;
  data: LfFlowData;
  support: Record<string, SupportInfo>;
  secretFields: Array<{ nodeId: string; field: string }>;
  summary: { nodeCount: number; edgeCount: number; kinds: Record<string, number> };
  /** 실행 해시 (위치 제외). 충돌 감지·버전 고정에 쓴다. */
  hash: string;
  models: ModelSetting[];
  relay: {
    inputComponentId: string;
    outputComponentId: string;
    configuredInputComponentId?: string;
    configuredOutputComponentId?: string;
    notes?: string[];
    errors?: string[];
  };
  draft: {
    flowId: string;
    baseUpdatedAt: string | null;
    baseHash?: string | null;
    savedAt: string;
    note: string | null;
    /** 초안을 만든 뒤 Langflow 의 flow 가 바뀌었는지 */
    remoteChangedSinceDraft?: boolean;
    diff?: FlowDiff;
  } | null;
  applied?: {
    versionId: string;
    backupVersionId: string;
    /** Langflow 에서 다시 읽어 보낸 내용과 같은지 확인했는지 */
    verified: boolean;
    expectedHash: string;
    actualHash: string;
    langflowSnapshotError: string | null;
    warnings: string[];
    issues: PipelineIssue[];
  };
}

export interface FlowList {
  mode: string;
  productionFlowId: string | null;
  analysisFlowId: string | null;
  flows: FlowHeader[];
}

export interface PipelineIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  field?: string;
}

export interface PipelineVersion {
  versionId: string;
  flowId: string;
  kind: 'backup' | 'applied' | 'restored' | 'cloned' | string;
  createdAt: string;
  note: string | null;
  remoteUpdatedAt: string | null;
  dataHash?: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
}

export interface ComponentTemplate {
  key: string;
  type: string;
  displayName: string;
  description: string;
  kind: ComponentKind;
  source: 'flow' | 'langflow';
  category?: string;
  node: LfNodeInfo;
}

export interface DraftRecord {
  flowId: string;
  baseUpdatedAt: string | null;
  baseHash?: string | null;
  savedAt: string;
  note: string | null;
  data: LfFlowData;
}

/** 설정 존재 여부와 실제 연결 결과를 구분한 확인 결과 (/api/connections/status) */
export interface ConnectionStatusReport {
  mode: string;
  checks: Array<{ name: string; ok: boolean | null; detail: string }>;
}

export const SECRET_SENTINEL = '__AIF_SECRET_MASKED__';

export const KIND_LABEL: Record<ComponentKind, string> = {
  input: '입력',
  prompt: '프롬프트',
  llm: '언어 모델',
  custom: '커스텀',
  output: '출력',
  generic: '기타',
};
