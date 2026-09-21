/**
 * 중계 서버(/api) 호출. 개발 중에는 Vite proxy 가 backend 로 전달한다.
 * 다른 출처의 서버를 부를 때는 호스트가 configureWorkbench({ apiBase }) 로 주소를 준다.
 * 브라우저는 Langflow 주소·API 키를 알지 못한다.
 */
import type { AnalysisRunRecord, Annotation, ProjectFile, RunSummary } from '../types/annotation';
import type {
  ComponentTemplate,
  ConnectionStatusReport,
  DraftRecord,
  FlowList,
  FlowView,
  LfFlowData,
  LfNodeInfo,
  PipelineIssue,
  PipelineVersion,
} from '../types/pipeline';
import type { RawCaseJson } from '../types/rawJson';
import type { IssueCatalog, SchemeCatalog } from '../types/scheme';
import { currentLang, t } from '../i18n';
import { workbenchHost } from '../host';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 서버가 준 상세 목록 (문자열 또는 파이프라인 검증 항목) */
  readonly details: unknown[];

  constructor(status: number, code: string, message: string, details: unknown[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface HealthInfo {
  status: string;
  langflow: {
    langflowMode: string;
    flowIdConfigured: boolean;
    apiKeyConfigured: boolean;
    timeoutSeconds: number;
    maxConcurrency: number;
  };
  activeRuns: number;
}

export interface ServerRunRecord extends AnalysisRunRecord {
  cancelRequested?: boolean;
  result?: {
    /** graph: 제안 그래프, no_issues: 근거 있는 세부 쟁점이 없어 그래프 없음 */
    outcome: 'graph' | 'no_issues';
    namespace: string;
    graph: RawCaseJson | null;
    annotations: Annotation[];
    summary: RunSummary;
    warnings: string[];
  } | null;
}

export interface TestRunPayload {
  text: string;
  documentId?: string | null;
  documentVersion?: number;
  caseId?: string | null;
}

export interface SummariesResponse {
  summaries: Array<{ nodeId: string; summary: string; summaryOrigin: 'ai'; textHash: string }>;
  missing: string[];
  model?: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const host = workbenchHost();
    response = await fetch(`${host.apiBase}${path}`, {
      ...init,
      credentials: init?.credentials ?? host.credentials,
      // 서버 오류·경고 문구를 지금 화면 언어로 받는다.
      headers: { 'Content-Type': 'application/json', 'Accept-Language': currentLang(), ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', t('api.error.network'));
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'BAD_RESPONSE', t('api.error.badResponse'));
    }
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown[] } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? t('api.error.status', { status: response.status }),
      error?.details ?? [],
    );
  }
  return body as T;
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  issueCatalog: () => request<IssueCatalog>('/api/catalogs/issues'),
  schemeCatalog: () => request<SchemeCatalog>('/api/catalogs/schemes'),
  connectionStatus: () => request<ConnectionStatusReport>('/api/connections/status'),

  /** 분석 실행. 쟁점은 사용자가 고르지 않는다: flow 가 52개 세부 쟁점 중 최대 3개를 자동 선택한다. */
  createRun: (payload: {
    text: string;
    documentId: string;
    documentVersion: number;
    caseId?: string | null;
    idempotencyKey?: string;
    flowId?: string | null;
    purpose?: 'analysis' | 'pipeline-test';
  }) => request<ServerRunRecord>('/api/analysis-runs', { method: 'POST', body: JSON.stringify(payload) }),

  /** 요청 시 요약 생성 (live 전용). 응답의 textHash 로 늦게 도착한 요약을 거른다. */
  summaries: (items: Array<{ nodeId: string; type: 'I' | 'ISSUE'; text: string }>, flowId?: string | null) =>
    request<SummariesResponse>('/api/summaries', { method: 'POST', body: JSON.stringify({ items, flowId: flowId ?? null }) }),

  getRun: (runId: string) => request<ServerRunRecord>(`/api/analysis-runs/${encodeURIComponent(runId)}`),

  cancelRun: (runId: string) =>
    request<ServerRunRecord>(`/api/analysis-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),

  saveProject: (project: ProjectFile) =>
    request<{ projectId: string; revision: number; savedAt: string }>(
      `/api/projects/${encodeURIComponent(project.projectId)}`,
      { method: 'PUT', body: JSON.stringify(project) },
    ),

  loadProject: (projectId: string) => request<ProjectFile>(`/api/projects/${encodeURIComponent(projectId)}`),

  listProjects: () =>
    request<{ projects: Array<{ projectId: string; revision: number; updatedAt: string; title?: string | null }> }>(
      '/api/projects',
    ),
};

const flowPath = (flowId: string) => `/api/pipelines/${encodeURIComponent(flowId)}`;

/** 파이프라인 편집 API. Langflow 호출과 API 키는 서버에만 있다. */
export const pipelineApi = {
  listFlows: () => request<FlowList>('/api/pipelines'),
  getFlow: (flowId: string) => request<FlowView>(flowPath(flowId)),
  clone: (flowId: string, name?: string) =>
    request<FlowView>(`${flowPath(flowId)}/clone`, { method: 'POST', body: JSON.stringify({ name: name ?? null }) }),
  getDraft: (flowId: string) => request<DraftRecord>(`${flowPath(flowId)}/draft`),
  saveDraft: (flowId: string, data: LfFlowData, base: { updatedAt: string | null; hash: string | null }, note?: string) =>
    request<{ flowId: string; savedAt: string; issues: PipelineIssue[] }>(`${flowPath(flowId)}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ data, baseUpdatedAt: base.updatedAt, baseHash: base.hash, note: note ?? null }),
    }),
  discardDraft: (flowId: string) => request<{ ok: boolean }>(`${flowPath(flowId)}/draft`, { method: 'DELETE' }),
  validate: (flowId: string, data: LfFlowData, checkCode = false) =>
    request<{ issues: PipelineIssue[]; errorCount: number; codeChecks: Array<{ nodeId: string; errors: string[] }> }>(
      `${flowPath(flowId)}/validate`,
      { method: 'POST', body: JSON.stringify({ data, checkCode }) },
    ),
  /** 충돌 검사 → 백업 → 저장 → Langflow 재조회로 확인. test 를 주면 확인 뒤 바로 테스트 실행을 시작한다. */
  apply: (
    flowId: string,
    data: LfFlowData,
    base: { updatedAt: string | null; hash: string | null },
    options: { note?: string; test?: TestRunPayload | null } = {},
  ) =>
    request<FlowView & { testRun?: ServerRunRecord }>(`${flowPath(flowId)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ data, baseUpdatedAt: base.updatedAt, baseHash: base.hash, note: options.note ?? null, test: options.test ?? null }),
    }),
  /** Langflow 에 저장된 flow 로 테스트 실행 */
  test: (flowId: string, payload: TestRunPayload) =>
    request<ServerRunRecord>(`${flowPath(flowId)}/test`, { method: 'POST', body: JSON.stringify(payload) }),
  versions: (flowId: string) => request<{ versions: PipelineVersion[] }>(`${flowPath(flowId)}/versions`),
  restore: (flowId: string, versionId: string, base: { updatedAt: string | null; hash: string | null }) =>
    request<FlowView>(`${flowPath(flowId)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ versionId, baseUpdatedAt: base.updatedAt, baseHash: base.hash }),
    }),
  componentTemplates: (flowId?: string) =>
    request<{ templates: ComponentTemplate[]; warnings: string[] }>(
      `/api/pipeline-components/templates${flowId ? `?flowId=${encodeURIComponent(flowId)}` : ''}`,
    ),
  rebuildComponent: (code: string, frontendNode: LfNodeInfo | null) =>
    request<{ node: LfNodeInfo; type: string }>('/api/pipeline-components/rebuild', {
      method: 'POST',
      body: JSON.stringify({ code, frontendNode }),
    }),
  setAnalysisFlow: (flowId: string | null) =>
    request<{ analysisFlowId: string | null; productionFlowId: string | null }>('/api/pipeline-settings/analysis-flow', {
      method: 'PUT',
      body: JSON.stringify({ flowId }),
    }),
};
