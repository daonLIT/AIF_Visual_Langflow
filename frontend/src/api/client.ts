/**
 * 중계 서버(/api) 호출. 개발 중에는 Vite proxy 가 backend 로 전달한다.
 * 브라우저는 Langflow 주소·API 키를 알지 못한다.
 */
import type { AnalysisRunRecord, Annotation, ProjectFile, RunSummary } from '../types/annotation';
import type { RawCaseJson } from '../types/rawJson';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string[];

  constructor(status: number, code: string, message: string, details: string[] = []) {
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
    namespace: string;
    graph: RawCaseJson;
    annotations: Annotation[];
    summary: RunSummary;
    warnings: string[];
  } | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '중계 서버에 연결할 수 없습니다. backend 가 실행 중인지 확인하세요.');
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'BAD_RESPONSE', '서버 응답을 해석할 수 없습니다.');
    }
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: string[] } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? `서버 오류 (${response.status})`,
      error?.details ?? [],
    );
  }
  return body as T;
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  createRun: (payload: {
    text: string;
    documentId: string;
    documentVersion: number;
    caseId?: string | null;
    idempotencyKey?: string;
  }) => request<ServerRunRecord>('/api/analysis-runs', { method: 'POST', body: JSON.stringify(payload) }),

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
