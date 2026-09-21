/**
 * 검토 UI 상태 + 분석 실행 + 프로젝트 저장.
 *
 * 확정 그래프와 annotations 는 graphStore 가 (undo/redo 와 함께) 가진다.
 * 이 스토어는 그 위에서 검토 액션을 graphStore.commit 으로 묶어 실행하고,
 * 실행(run) 기록·문서 메타·검토 이력·선택 상태를 관리한다.
 */
import { create } from 'zustand';
import { api, ApiError, type ServerRunRecord } from '../api/client';
import { importAifOva } from '../io/importAifOva';
import { exportAifOva } from '../io/exportAifOva';
import type {
  AnalysisRunRecord,
  Annotation,
  AnnotationStatus,
  DocumentMeta,
  EvidenceSpan,
  ProjectFile,
  ReviewEvent,
} from '../types/annotation';
import { PROJECT_SCHEMA_VERSION, migrateProjectFile } from '../types/annotation';
import type { NodeFieldsPatch } from '../types/argument';
import { DocumentMatcher, rematchEvidence } from '../utils/evidence';
import { useGraphStore, nowIso } from './graphStore';
import { useCatalogStore } from './catalogStore';
import { applyGeneratedSummaries, expectationFor } from './graphRules';
import { t } from '../i18n';
import {
  acceptAnnotation,
  clearEvidenceReview,
  recomputeAcceptedStatus,
  importProposals,
  linkEvidence,
  makeEvent,
  previewBulkAccept,
  rejectAnnotation,
  resetAnnotation,
  resolveEvidenceCandidate,
  setDraftPosition,
  setDraftText,
  setDraftValue,
  unlinkEvidence,
  type AcceptOptions,
  type BulkAcceptPreview,
  type ReviewOutcome,
  type ReviewSnapshot,
} from './reviewLogic';

export type StatusFilter = AnnotationStatus | 'all';
export type KindFilter = 'all' | 'node' | 'edge';

const POLL_INTERVAL_MS = 1500;

export async function sha256Hex(text: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 비보안 컨텍스트(http://<LAN IP>) 대비: 해시 없이도 동작하되 서버 hash 검사는 실패할 수 있다.
  return '';
}

export type ServerLoadResult = { ok: true } | { ok: false; stale: true } | { ok: false; stale?: false; error: unknown };

// 서버 불러오기 요청 번호. 늦게 도착한 이전 응답이 새 프로젝트 화면을 덮어쓰지 않게 한다.
let serverLoadSeq = 0;

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toRunRecord(server: ServerRunRecord, previous?: AnalysisRunRecord): AnalysisRunRecord {
  return {
    runId: server.runId,
    status: server.status,
    createdAt: server.createdAt,
    startedAt: server.startedAt ?? null,
    finishedAt: server.finishedAt ?? null,
    documentId: server.documentId,
    documentVersion: server.documentVersion,
    documentHash: server.documentHash,
    namespace: server.namespace,
    mode: server.mode,
    flowId: server.flowId ?? null,
    error: server.error ?? null,
    summary: server.result?.summary ?? previous?.summary ?? null,
    warnings: server.result?.warnings ?? previous?.warnings ?? [],
    constraints: server.constraints,
    catalogs: server.catalogs ?? previous?.catalogs ?? null,
    pipeline: server.pipeline ?? previous?.pipeline ?? null,
    outcome: server.result?.outcome ?? previous?.outcome ?? null,
    purpose: server.purpose ?? previous?.purpose,
    stale: previous?.stale ?? false,
    imported: previous?.imported ?? false,
  };
}

interface AnnotationState {
  projectId: string;
  projectTitle: string;
  revision: number;
  document: DocumentMeta | null;
  runs: AnalysisRunRecord[];
  /** 결과를 아직 반영하지 않은 실행의 제안 (stale 실행용) */
  pendingProposals: Record<string, Annotation[]>;
  reviewEvents: ReviewEvent[];
  activeRunId: string | null;
  selectedAnnotationId: string | null;
  statusFilter: StatusFilter;
  kindFilter: KindFilter;
  showRejected: boolean;
  /** 서버에 저장한 이후 바뀐 것이 있는지 */
  dirty: boolean;
  lastSavedAt: string | null;
  notice: string | null;
  /** 폴링 중인 run */
  polling: string | null;
  /** 원문 패널이 스크롤할 근거 범위 (토큰으로 반복 요청 구분) */
  evidenceFocus: { start: number; end: number; token: number } | null;
  /** 요약 생성 요청 중인 노드 */
  summarizing: string[];
}

interface AnnotationActions {
  // 문서
  newDocument: (text: string, options?: { fileName?: string; caseId?: string | null }) => Promise<void>;
  replaceDocumentText: (text: string) => Promise<void>;
  attachDocumentMeta: (text: string) => Promise<void>;

  // 분석
  /** 판결문 분석. 52개 세부 쟁점 중 최대 3개는 flow 가 자동 선택한다. */
  startAnalysis: () => Promise<void>;
  cancelAnalysis: (runId: string) => Promise<void>;
  refreshRun: (runId: string) => Promise<void>;
  importStaleRun: (runId: string) => void;
  /** 다른 곳(파이프라인 탭 테스트 실행)에서 끝난 실행을 검토 데이터로 불러온다. 원문이 다르면 반영하지 않고 이유를 돌려준다. */
  importExternalRun: (server: ServerRunRecord) => string | null;
  setActiveRun: (runId: string | null) => void;

  // 검토
  accept: (id: string, options?: AcceptOptions) => void;
  reject: (id: string) => void;
  reset: (id: string) => void;
  editDraftText: (id: string, text: string) => void;
  /** 노드 제안의 본문·요약·스킴·쟁점 참조 수정 */
  editDraft: (id: string, patch: NodeFieldsPatch) => void;
  moveDraft: (id: string, x: number, y: number) => void;
  addEvidence: (id: string, span: EvidenceSpan) => void;
  removeEvidence: (id: string, index: number) => void;
  chooseEvidenceCandidate: (id: string, index: number, candidate: { start: number; end: number }) => void;
  /** 본문 수정으로 붙은 근거 재검토 표시를 확인 완료로 지운다 */
  confirmEvidenceReview: (id: string) => void;
  /** 노드 요약을 AI 로 생성 (live). 요청 뒤 본문·요약이 바뀐 노드에는 반영하지 않는다. */
  generateSummaries: (nodeIds: string[]) => Promise<void>;
  bulkPreview: () => BulkAcceptPreview | null;
  bulkAccept: (preview: BulkAcceptPreview) => void;

  // UI
  select: (id: string | null) => void;
  setStatusFilter: (filter: StatusFilter) => void;
  setKindFilter: (filter: KindFilter) => void;
  setShowRejected: (show: boolean) => void;
  setProjectTitle: (title: string) => void;
  setNotice: (notice: string | null) => void;
  focusEvidence: (span: { start: number | null; end: number | null }) => void;

  // 저장
  buildProjectFile: () => ProjectFile | null;
  saveToServer: () => Promise<void>;
  /** 서버 프로젝트를 연다. 나중에 시작한 불러오기가 있으면 이 응답은 버린다(stale). */
  loadFromServer: (projectId: string) => Promise<ServerLoadResult>;
  loadProjectFile: (project: ProjectFile, fileName?: string, options?: { isCurrent?: () => boolean }) => Promise<void>;
  resetProject: () => void;
}

export type AnnotationStore = AnnotationState & AnnotationActions;

const initialState: AnnotationState = {
  projectId: randomId('project'),
  projectTitle: '',
  revision: 0,
  document: null,
  runs: [],
  pendingProposals: {},
  reviewEvents: [],
  activeRunId: null,
  selectedAnnotationId: null,
  statusFilter: 'all',
  kindFilter: 'all',
  showRejected: false,
  dirty: false,
  lastSavedAt: null,
  notice: null,
  polling: null,
  evidenceFocus: null,
  summarizing: [],
};

function snapshotOf(): ReviewSnapshot | null {
  const { caseData, annotations, edgeIdHighWater } = useGraphStore.getState();
  if (!caseData) return null;
  return { caseData, annotations, edgeIdHighWater };
}

export const useAnnotationStore = create<AnnotationStore>((set, get) => {
  /** 검토 결과를 graphStore 히스토리 1단계로 커밋하고 이력을 남긴다. */
  const applyOutcome = (outcome: ReviewOutcome, structural = true) => {
    if (outcome.error) {
      useGraphStore.getState().setErrorMessage(outcome.error);
      return false;
    }
    const graph = useGraphStore.getState();
    graph.commit(outcome.snapshot.caseData, { annotations: outcome.snapshot.annotations, structural });
    useGraphStore.setState({ edgeIdHighWater: Math.max(graph.edgeIdHighWater, outcome.snapshot.edgeIdHighWater) });
    set((state) => ({
      reviewEvents: [...state.reviewEvents, ...outcome.events],
      dirty: true,
      notice: outcome.warnings.length > 0 ? outcome.warnings.join(' ') : state.notice,
    }));
    return true;
  };

  const withSnapshot = (fn: (snapshot: ReviewSnapshot) => ReviewOutcome, structural = true) => {
    const snapshot = snapshotOf();
    if (!snapshot) return;
    applyOutcome(fn(snapshot), structural);
  };

  let pollTimer: number | null = null;
  const stopPolling = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    set({ polling: null });
  };

  const upsertRun = (record: AnalysisRunRecord) =>
    set((state) => ({
      runs: state.runs.some((run) => run.runId === record.runId)
        ? state.runs.map((run) => (run.runId === record.runId ? record : run))
        : [record, ...state.runs],
    }));

  /** 성공한 실행의 제안을 검토 데이터에 넣는다. 원문이 바뀐 뒤 도착한 결과는 자동 반영하지 않는다. */
  const handleSucceeded = (server: ServerRunRecord) => {
    const state = get();
    const previous = state.runs.find((run) => run.runId === server.runId);
    if (previous?.imported) return;
    if (server.result?.outcome === 'no_issues') {
      // 근거 있는 세부 쟁점이 없으면 가짜 그래프를 만들지 않고 사유만 알린다.
      if (previous?.status === 'succeeded') return;
      const reason = server.result.summary.issueSelection?.reason;
      upsertRun({ ...toRunRecord(server, previous), stale: false, imported: false });
      set({
        activeRunId: server.runId,
        notice: t('annotation.notice.noIssues') + (reason ? t('annotation.notice.noIssues.reason', { reason }) : ''),
      });
      return;
    }
    const proposals = server.result?.annotations ?? [];
    const record = toRunRecord(server, previous);
    const currentHash = state.document?.hash ?? '';
    const currentVersion = state.document?.version ?? 0;
    if (server.documentHash !== currentHash || server.documentVersion !== currentVersion) {
      upsertRun({ ...record, stale: true, imported: false });
      set((s) => ({
        pendingProposals: { ...s.pendingProposals, [server.runId]: proposals },
        notice: t('annotation.notice.staleResult'),
      }));
      return;
    }
    importRun(record, proposals);
  };

  const importRun = (record: AnalysisRunRecord, proposals: Annotation[]) => {
    const snapshot = snapshotOf();
    if (!snapshot) return;
    const text = snapshot.caseData.text;
    const version = get().document?.version ?? record.documentVersion;
    const matcher = new DocumentMatcher(text);
    // 재분석: 기존 확정 그래프와 겹치지 않도록 초안 좌표를 오른쪽으로 밀어 둔다.
    const acceptedNodes = snapshot.caseData.nodes;
    let offsetX = 0;
    if (acceptedNodes.length > 0) {
      const maxAcceptedX = Math.max(...acceptedNodes.map((node) => node.x));
      const draftXs = proposals
        .filter((proposal): proposal is Annotation & { kind: 'node' } => proposal.kind === 'node')
        .map((proposal) => proposal.currentValue.x ?? 0);
      const minDraftX = draftXs.length > 0 ? Math.min(...draftXs) : 0;
      offsetX = maxAcceptedX + 400 - minDraftX;
    }
    // 다른 버전의 원문에 맞춰진 근거는 현재 원문에 다시 맞춘다.
    const adjusted = proposals.map((proposal) => {
      const evidence = rematchEvidence(text, proposal.evidence, version, matcher);
      if (proposal.kind === 'node' && offsetX !== 0) {
        const x = (proposal.currentValue.x ?? 0) + offsetX;
        return {
          ...proposal,
          evidence,
          originalValue: { ...proposal.originalValue, x },
          currentValue: { ...proposal.currentValue, x },
        };
      }
      return { ...proposal, evidence };
    }) as Annotation[];
    const imported = importProposals(snapshot, adjusted);
    if (imported.error) {
      useGraphStore.getState().setErrorMessage(imported.error);
      return;
    }
    const duplicateNotes = new Map(imported.duplicates);
    const stamped = imported.snapshot.annotations.map((annotation) =>
      duplicateNotes.has(annotation.id)
        ? { ...annotation, note: t('annotation.note.duplicate', { nodeId: duplicateNotes.get(annotation.id) ?? '' }) }
        : annotation,
    ) as Annotation[];
    useGraphStore.getState().commit(imported.snapshot.caseData, { annotations: stamped });
    useGraphStore.getState().requestFitView();
    upsertRun({ ...record, stale: false, imported: true });
    set((state) => {
      const pendingProposals = { ...state.pendingProposals };
      delete pendingProposals[record.runId];
      return {
        pendingProposals,
        activeRunId: record.runId,
        statusFilter: 'pending',
        reviewEvents: [
          ...state.reviewEvents,
          makeEvent('run-imported', { runId: record.runId, detail: t('annotation.event.proposals', { count: proposals.length }) }),
        ],
        dirty: true,
        notice:
          duplicateNotes.size > 0
            ? t('annotation.notice.duplicates', { count: duplicateNotes.size })
            : state.notice,
      };
    });
  };

  const handleServerRecord = (server: ServerRunRecord) => {
    const previous = get().runs.find((run) => run.runId === server.runId);
    if (server.status === 'succeeded') {
      handleSucceeded(server);
    } else {
      upsertRun(toRunRecord(server, previous));
    }
    if (server.status !== 'queued' && server.status !== 'running') stopPolling();
  };

  const startPolling = (runId: string) => {
    stopPolling();
    set({ polling: runId });
    const tick = async () => {
      try {
        const server = await api.getRun(runId);
        // 취소된 실행이나 사용자가 프로젝트를 초기화한 경우 반영하지 않는다.
        const local = get().runs.find((run) => run.runId === runId);
        if (!local) {
          stopPolling();
          return;
        }
        if (local.status === 'cancelled') {
          stopPolling();
          return;
        }
        handleServerRecord(server);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) stopPolling();
        set({ notice: t('annotation.error.runStatus', { message: (error as Error).message }) });
      }
    };
    pollTimer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick();
  };

  return {
    ...initialState,

    async newDocument(text, options = {}) {
      stopPolling();
      useGraphStore.getState().startDocument(text, options.fileName);
      const hash = await sha256Hex(text);
      set({
        ...initialState,
        projectId: randomId('project'),
        projectTitle: options.fileName?.replace(/\.[^.]+$/, '') ?? '',
        document: { id: randomId('doc'), version: 1, hash, caseId: options.caseId ?? null },
        dirty: true,
      });
    },

    async replaceDocumentText(text) {
      const graph = useGraphStore.getState();
      const document = get().document;
      if (!graph.caseData || !document) return;
      if (text === graph.caseData.text) return;
      const version = document.version + 1;
      const matcher = new DocumentMatcher(text);
      const annotations = graph.annotations.map((annotation) => ({
        ...annotation,
        evidence: rematchEvidence(text, annotation.evidence, version, matcher),
      })) as Annotation[];
      graph.replaceText(text, annotations);
      const hash = await sha256Hex(text);
      set((state) => ({
        document: { ...document, version, hash },
        reviewEvents: [...state.reviewEvents, makeEvent('document-changed', { detail: t('annotation.event.documentVersion', { version }) })],
        dirty: true,
        notice: t('annotation.notice.documentChanged'),
      }));
    },

    async attachDocumentMeta(text) {
      const hash = await sha256Hex(text);
      set({ document: { id: randomId('doc'), version: 1, hash, caseId: null } });
    },

    async startAnalysis() {
      const graph = useGraphStore.getState();
      const state = get();
      if (!graph.caseData || !graph.caseData.text.trim()) {
        graph.setErrorMessage(t('annotation.error.needText'));
        return;
      }
      let document = state.document;
      if (!document) {
        await get().attachDocumentMeta(graph.caseData.text);
        document = get().document!;
      }
      if (state.runs.some((run) => run.status === 'queued' || run.status === 'running')) {
        set({ notice: t('annotation.notice.alreadyRunning') });
        return;
      }
      const idempotencyKey = `${document.id}:${document.version}:${document.hash.slice(0, 16)}:${state.runs.length}`;
      try {
        const server = await api.createRun({
          text: graph.caseData.text,
          documentId: document.id,
          documentVersion: document.version,
          caseId: document.caseId ?? null,
          idempotencyKey,
        });
        upsertRun(toRunRecord(server));
        set({ notice: null });
        if (server.status === 'succeeded') handleServerRecord(server);
        else startPolling(server.runId);
      } catch (error) {
        const message = error instanceof ApiError ? `${error.message} (${error.code})` : (error as Error).message;
        graph.setErrorMessage(t('annotation.error.startFailed', { message }));
      }
    },

    async cancelAnalysis(runId) {
      // 로컬에서 먼저 취소 표시 → 이후 도착하는 응답은 무시된다.
      set((state) => ({
        runs: state.runs.map((run) =>
          run.runId === runId && (run.status === 'queued' || run.status === 'running')
            ? { ...run, status: 'cancelled', finishedAt: nowIso() }
            : run,
        ),
      }));
      stopPolling();
      try {
        const server = await api.cancelRun(runId);
        upsertRun({ ...toRunRecord(server), status: 'cancelled' });
      } catch (error) {
        set({ notice: t('annotation.error.cancelFailed', { message: (error as Error).message }) });
      }
    },

    async refreshRun(runId) {
      try {
        handleServerRecord(await api.getRun(runId));
      } catch (error) {
        set({ notice: t('annotation.error.fetchRunFailed', { message: (error as Error).message }) });
      }
    },

    importStaleRun(runId) {
      const state = get();
      const record = state.runs.find((run) => run.runId === runId);
      const proposals = state.pendingProposals[runId];
      if (!record || !proposals) return;
      importRun(record, proposals);
    },

    importExternalRun(server) {
      if (server.status !== 'succeeded' || !server.result) return t('annotation.import.onlySucceeded');
      if (server.result.outcome === 'no_issues') return t('annotation.import.noIssues');
      const state = get();
      if (!useGraphStore.getState().caseData || !state.document) return t('annotation.import.needCase');
      if (state.runs.some((run) => run.runId === server.runId && run.imported)) return t('annotation.import.already');
      if (server.documentHash !== state.document.hash) {
        return t('annotation.import.textMismatch');
      }
      importRun({ ...toRunRecord(server), documentVersion: state.document.version }, server.result.annotations);
      return null;
    },

    setActiveRun(runId) {
      set({ activeRunId: runId, selectedAnnotationId: null });
    },

    accept(id, options) {
      withSnapshot((snapshot) => acceptAnnotation(snapshot, id, options));
    },
    reject(id) {
      withSnapshot((snapshot) => rejectAnnotation(snapshot, id));
    },
    reset(id) {
      withSnapshot((snapshot) => resetAnnotation(snapshot, id));
    },
    editDraftText(id, text) {
      withSnapshot((snapshot) => setDraftText(snapshot, id, text));
    },
    editDraft(id, patch) {
      withSnapshot((snapshot) => setDraftValue(snapshot, id, patch));
    },
    moveDraft(id, x, y) {
      const snapshot = snapshotOf();
      if (!snapshot) return;
      const next = setDraftPosition(snapshot, id, x, y);
      if (next !== snapshot) {
        useGraphStore.getState().commit(next.caseData, { annotations: next.annotations, structural: false });
        set({ dirty: true });
      }
    },
    addEvidence(id, span) {
      withSnapshot((snapshot) => linkEvidence(snapshot, id, span), false);
    },
    removeEvidence(id, index) {
      withSnapshot((snapshot) => unlinkEvidence(snapshot, id, index), false);
    },
    chooseEvidenceCandidate(id, index, candidate) {
      withSnapshot((snapshot) => resolveEvidenceCandidate(snapshot, id, index, candidate), false);
    },
    confirmEvidenceReview(id) {
      withSnapshot((snapshot) => clearEvidenceReview(snapshot, id), false);
    },
    async generateSummaries(nodeIds) {
      const graph = useGraphStore.getState();
      if (!graph.caseData) return;
      const items: Array<{ nodeId: string; type: 'I' | 'ISSUE'; text: string }> = [];
      const expectations = [];
      for (const nodeId of nodeIds) {
        const node = graph.caseData.nodes.find((item) => item.id === nodeId);
        const proposal = graph.annotations.find((item) => item.kind === 'node' && item.nodeId === nodeId);
        const content = node ?? (proposal?.kind === 'node' ? proposal.currentValue : undefined);
        const type = node?.type ?? (proposal?.kind === 'node' ? proposal.currentValue.type : undefined);
        if (!content || (type !== 'I' && type !== 'ISSUE') || !content.text.trim()) continue;
        items.push({ nodeId, type, text: content.text });
        expectations.push(expectationFor(nodeId, content));
      }
      if (items.length === 0) return;
      set((state) => ({ summarizing: [...new Set([...state.summarizing, ...items.map((item) => item.nodeId)])] }));
      try {
        const response = await api.summaries(items);
        const current = useGraphStore.getState();
        if (!current.caseData) return;
        const result = applyGeneratedSummaries(current.caseData, current.annotations, response.summaries, expectations);
        if (result.applied.length > 0) {
          current.commit(result.caseData, { annotations: result.annotations.map(recomputeAcceptedStatus), structural: false });
        }
        const skipped = result.skipped.map((item) => `${item.nodeId}: ${item.reason}`);
        set((state) => ({
          dirty: state.dirty || result.applied.length > 0,
          reviewEvents:
            result.applied.length > 0
              ? [...state.reviewEvents, makeEvent('summary-generated', { detail: t('annotation.event.summaries', { count: result.applied.length }) })]
              : state.reviewEvents,
          notice:
            skipped.length > 0 || response.missing.length > 0
              ? [
                  result.applied.length > 0 ? t('annotation.notice.summariesApplied', { count: result.applied.length }) : '',
                  skipped.length > 0 ? t('annotation.notice.summariesSkipped', { reasons: skipped.join(' / ') }) : '',
                  response.missing.length > 0 ? t('annotation.notice.summariesMissing', { count: response.missing.length }) : '',
                ]
                  .filter(Boolean)
                  .join(' ')
              : t('annotation.notice.summariesApplied', { count: result.applied.length }),
        }));
      } catch (error) {
        const message = error instanceof ApiError ? `${error.message} (${error.code})` : (error as Error).message;
        useGraphStore.getState().setErrorMessage(t('annotation.error.summaryFailed', { message }));
      } finally {
        const done = new Set(items.map((item) => item.nodeId));
        set((state) => ({ summarizing: state.summarizing.filter((id) => !done.has(id)) }));
      }
    },
    bulkPreview() {
      const snapshot = snapshotOf();
      if (!snapshot) return null;
      return previewBulkAccept(snapshot, get().activeRunId);
    },
    bulkAccept(preview) {
      const graph = useGraphStore.getState();
      graph.commit(preview.snapshot.caseData, { annotations: preview.snapshot.annotations });
      useGraphStore.setState({ edgeIdHighWater: Math.max(graph.edgeIdHighWater, preview.snapshot.edgeIdHighWater) });
      set((state) => ({
        reviewEvents: [
          ...state.reviewEvents,
          makeEvent('bulk-accept', {
            runId: state.activeRunId ?? undefined,
            detail: t('annotation.event.bulkAccept', {
              nodes: preview.pendingNodeIds.length,
              edges: preview.pendingEdgeIds.length,
            }),
          }),
        ],
        dirty: true,
      }));
    },

    select(id) {
      set({ selectedAnnotationId: id });
    },
    setStatusFilter(filter) {
      set({ statusFilter: filter });
    },
    setKindFilter(filter) {
      set({ kindFilter: filter });
    },
    setShowRejected(show) {
      set({ showRejected: show });
    },
    setProjectTitle(title) {
      set({ projectTitle: title, dirty: true });
    },
    setNotice(notice) {
      set({ notice });
    },
    focusEvidence(span) {
      if (span.start === null || span.end === null) return;
      const previous = get().evidenceFocus;
      set({ evidenceFocus: { start: span.start, end: span.end, token: (previous?.token ?? 0) + 1 } });
    },

    buildProjectFile() {
      const graph = useGraphStore.getState();
      const state = get();
      if (!graph.caseData || !state.document) return null;
      const catalogs = useCatalogStore.getState();
      return {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        projectId: state.projectId,
        revision: state.revision,
        title: state.projectTitle || null,
        document: {
          id: state.document.id,
          text: graph.caseData.text,
          hash: state.document.hash,
          version: state.document.version,
          caseId: state.document.caseId ?? null,
        },
        // 확정 그래프만. pending/rejected 제안은 annotations 에만 남는다.
        acceptedGraph: exportAifOva(graph.caseData, { schemeCatalog: catalogs.schemes }),
        analysisRuns: state.runs,
        annotations: graph.annotations,
        reviewEvents: state.reviewEvents,
        analysisSettings: null,
        // 저장 시점의 카탈로그 버전. 실행별 버전은 analysisRuns[].catalogs / pipeline 에 있다.
        catalogs: {
          issueCatalogVersion: catalogs.issues?.catalogVersion ?? null,
          issueCatalogSourceSha256: catalogs.issues?.source.sha256 ?? null,
          schemeCatalogVersion: catalogs.schemes?.schemeCatalogVersion ?? null,
        },
        savedAt: null,
      };
    },

    async saveToServer() {
      const project = get().buildProjectFile();
      if (!project) {
        useGraphStore.getState().setErrorMessage(t('annotation.error.nothingToSave'));
        return;
      }
      try {
        const saved = await api.saveProject(project);
        set({
          revision: saved.revision,
          lastSavedAt: saved.savedAt,
          dirty: false,
          notice: t('annotation.notice.saved', { revision: saved.revision }),
        });
      } catch (error) {
        const message = error instanceof ApiError ? `${error.message} (${error.code})` : (error as Error).message;
        useGraphStore.getState().setErrorMessage(t('annotation.error.saveFailed', { message }));
      }
    },

    async loadFromServer(projectId) {
      const seq = ++serverLoadSeq;
      const isCurrent = () => seq === serverLoadSeq;
      try {
        const project = await api.loadProject(projectId);
        if (!isCurrent()) return { ok: false, stale: true };
        await get().loadProjectFile(project, undefined, { isCurrent });
        return isCurrent() ? { ok: true } : { ok: false, stale: true };
      } catch (error) {
        if (!isCurrent()) return { ok: false, stale: true };
        const message = error instanceof ApiError ? `${error.message} (${error.code})` : (error as Error).message;
        useGraphStore.getState().setErrorMessage(t('annotation.error.loadFailed', { message }));
        return { ok: false, error };
      }
    },

    async loadProjectFile(source, fileName, options) {
      const isCurrent = options?.isCurrent ?? (() => true);
      let project: ProjectFile;
      // 이전 카탈로그 scheme 전환에 대응표가 필요하다. 아직 못 읽었으면 먼저 읽고, 그래도 없으면 전환하지 않는다.
      if (!useCatalogStore.getState().schemes) await useCatalogStore.getState().load();
      const schemeCatalog = useCatalogStore.getState().schemes;
      const migratedAt = new Date().toISOString();
      try {
        project = migrateProjectFile(source, { schemeCatalog, migratedAt });
      } catch (error) {
        useGraphStore.getState().setErrorMessage((error as Error).message);
        return;
      }
      if (!isCurrent()) return;
      stopPolling();
      const imported = importAifOva({ ...project.acceptedGraph, text: project.document.text }, fileName, { schemeCatalog, migratedAt });
      const annotationsMigrated = project.annotations.some(
        (annotation) =>
          annotation.kind === 'node' &&
          (annotation.currentValue.schemeApplication?.history ?? []).some((entry) => entry.action === 'catalog_migration' && entry.at === migratedAt),
      );
      const graph = useGraphStore.getState();
      graph.loadSnapshot({ caseData: imported.case, annotations: project.annotations }, fileName ?? project.title ?? null);
      if (imported.warnings.length > 0) useGraphStore.setState({ importWarnings: imported.warnings });
      const hash = await sha256Hex(project.document.text);
      if (!isCurrent()) return;
      set({
        ...initialState,
        projectId: project.projectId,
        projectTitle: project.title ?? '',
        revision: project.revision,
        document: {
          id: project.document.id,
          version: project.document.version,
          hash: hash || project.document.hash,
          caseId: project.document.caseId ?? null,
        },
        runs: project.analysisRuns,
        reviewEvents: project.reviewEvents,
        activeRunId: project.analysisRuns.find((run) => run.imported)?.runId ?? null,
        // v1 파일을 v2 로 올렸거나 이전 형식 필드를 옮겼으면 저장이 필요하다.
        dirty:
          source.schemaVersion !== PROJECT_SCHEMA_VERSION || annotationsMigrated || imported.legacyConverted,
        lastSavedAt: project.savedAt ?? null,
      });
      if (annotationsMigrated && !imported.schemeCatalogMigrated) {
        set({ notice: t('annotation.notice.schemeMigrated') });
      }
      if (hash && hash !== project.document.hash) {
        set({ notice: t('annotation.notice.hashMismatch') });
      }
      // 아직 진행 중인 실행이 있으면 폴링 재개
      const active = project.analysisRuns.find((run) => run.status === 'queued' || run.status === 'running');
      if (active) startPolling(active.runId);
    },

    resetProject() {
      stopPolling();
      set({ ...initialState, projectId: randomId('project') });
    },
  };
});

/** 선택된 annotation */
export const selectSelectedAnnotation = (state: AnnotationStore): string | null => state.selectedAnnotationId;
