/**
 * 파이프라인 탭 상태. 논증 그래프(graphStore)와 별도의 스토어·undo/redo 를 쓴다.
 *
 * 흐름: flow 불러오기 → (프로덕션이면) 작업용 복제 → 편집 → 초안 저장 → 검증 → Langflow 에 적용 → 테스트 실행 → 이전 버전 복원
 * 편집은 Langflow 원본 노드 객체를 복사해 필요한 경로만 바꾸며, 서버 검증을 통과해야 적용된다.
 */
import { create } from 'zustand';
import { api, ApiError, pipelineApi, type ServerRunRecord, type TestRunPayload } from '@aif/workbench/api/client';
import {
  canConnect,
  clone,
  diffFlowData,
  fieldSpec,
  instantiateTemplate,
  makeEdge,
  removeDanglingEdges,
  syncPromptFields,
  validateLocal,
} from '../pipeline/flowUtils';
import type {
  ComponentTemplate,
  ConnectionStatusReport,
  FlowDiff,
  FlowHeader,
  FlowView,
  LfFlowData,
  LfNode,
  LfNodeInfo,
  PipelineIssue,
  PipelineVersion,
} from '@aif/workbench/types/pipeline';
import { useAnnotationStore, sha256Hex } from '@aif/workbench/store/annotationStore';
import { t } from '@aif/workbench/i18n';

const HISTORY_LIMIT = 50;
const TEST_POLL_MS = 2000;
/** 편집 후 이 시간 동안 추가 편집이 없으면 초안을 서버에 자동 저장한다(새로고침 후에도 유지). */
const AUTOSAVE_MS = 2500;

export interface PipelineMessage {
  kind: 'info' | 'success' | 'error';
  text: string;
  details?: string[];
}

export interface TestRunState {
  runId: string;
  flowId: string;
  status: string;
  record: ServerRunRecord | null;
  startedAt: number;
}

interface PipelineState {
  mode: string | null;
  flows: FlowHeader[];
  productionFlowId: string | null;
  analysisFlowId: string | null;
  current: FlowView | null;
  data: LfFlowData | null;
  /** 편집 기준 시점 (충돌 감지) */
  baseUpdatedAt: string | null;
  /** 편집 기준 실행 해시 (충돌 감지) */
  baseHash: string | null;
  /** Langflow 적용본과 다른 편집이 있음 */
  dirty: boolean;
  /** 마지막 편집이 서버 초안으로 저장됨 */
  draftSaved: boolean;
  draftSavedAt: string | null;
  /** 적용본 대비 차이 */
  diff: FlowDiff | null;
  selectedNodeId: string | null;
  past: LfFlowData[];
  future: LfFlowData[];
  localIssues: PipelineIssue[];
  serverIssues: PipelineIssue[] | null;
  templates: ComponentTemplate[];
  templateWarnings: string[];
  versions: PipelineVersion[];
  busy: string | null;
  message: PipelineMessage | null;
  testRun: TestRunState | null;
  connection: ConnectionStatusReport | null;
  /** 캔버스 재동기화 기준 (구조가 바뀔 때마다 증가) */
  version: number;
}

interface PipelineActions {
  loadFlows: () => Promise<void>;
  openFlow: (flowId: string) => Promise<void>;
  reload: () => Promise<void>;
  loadDraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
  cloneFlow: (name?: string) => Promise<void>;
  saveDraft: (note?: string, options?: { silent?: boolean }) => Promise<void>;
  validate: (checkCode?: boolean) => Promise<boolean>;
  /** 검증 → 적용(재조회 확인). test 를 주면 확인 뒤 바로 그 원문으로 테스트 실행 */
  apply: (note?: string, test?: { text: string } | null) => Promise<boolean>;
  loadVersions: () => Promise<void>;
  restoreVersion: (versionId: string) => Promise<void>;
  loadTemplates: () => Promise<void>;
  setAnalysisFlow: (flowId: string | null) => Promise<void>;
  runDiagnostics: () => Promise<void>;

  select: (nodeId: string | null) => void;
  addComponent: (templateKey: string, position: { x: number; y: number }) => string | null;
  deleteNodes: (nodeIds: string[]) => void;
  moveNodes: (positions: Array<{ id: string; x: number; y: number }>) => void;
  connect: (sourceId: string, outputName: string, targetId: string, fieldName: string) => boolean;
  deleteEdges: (edgeIds: string[]) => void;
  updateField: (nodeId: string, field: string, value: unknown) => void;
  updatePrompt: (nodeId: string, text: string) => void;
  updateNodeInfo: (nodeId: string, patch: Partial<Pick<LfNodeInfo, 'display_name' | 'description'>>) => void;
  updateCode: (nodeId: string, code: string) => void;
  rebuildComponent: (nodeId: string) => Promise<void>;
  undo: () => void;
  redo: () => void;

  startTestRun: (options: { text: string }) => Promise<void>;
  importTestRun: () => void;
  clearMessage: () => void;
}

export type PipelineStore = PipelineState & PipelineActions;

const initialState: PipelineState = {
  mode: null,
  flows: [],
  productionFlowId: null,
  analysisFlowId: null,
  current: null,
  data: null,
  baseUpdatedAt: null,
  baseHash: null,
  dirty: false,
  draftSaved: true,
  draftSavedAt: null,
  diff: null,
  selectedNodeId: null,
  past: [],
  future: [],
  localIssues: [],
  serverIssues: null,
  templates: [],
  templateWarnings: [],
  versions: [],
  busy: null,
  message: null,
  testRun: null,
  connection: null,
  version: 0,
};

function errorMessage(error: unknown, prefix: string): PipelineMessage {
  if (error instanceof ApiError) {
    const details = error.details.map((item) =>
      typeof item === 'string' ? item : (item as PipelineIssue)?.message ?? JSON.stringify(item),
    );
    return { kind: 'error', text: `${prefix}: ${error.message} (${error.code})`, details };
  }
  return { kind: 'error', text: `${prefix}: ${(error as Error).message}` };
}

/** 테스트 실행에 보낼 원문 식별자: 논증 그래프 탭 문서와 같으면 그 ID 를 써서 결과를 검토 제안으로 불러올 수 있게 한다. */
async function testPayload(text: string): Promise<TestRunPayload> {
  const document = useAnnotationStore.getState().document;
  const hash = await sha256Hex(text);
  const sameDocument = !!document && document.hash === hash;
  return {
    text,
    documentId: sameDocument ? document!.id : `pipeline-test-${hash.slice(0, 12)}`,
    documentVersion: sameDocument ? document!.version : 1,
    caseId: sameDocument ? (document!.caseId ?? null) : null,
  };
}

export const usePipelineStore = create<PipelineStore>((set, get) => {
  let pollTimer: number | null = null;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelAutosave = () => {
    if (autosaveTimer !== null) {
      globalThis.clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  };

  const scheduleAutosave = () => {
    cancelAutosave();
    autosaveTimer = globalThis.setTimeout(() => {
      autosaveTimer = null;
      const state = get();
      if (state.current && state.dirty && !state.draftSaved) void state.saveDraft(undefined, { silent: true });
    }, AUTOSAVE_MS);
  };

  const stopPolling = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const withBusy = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (get().busy) return undefined;
    set({ busy: label });
    try {
      return await fn();
    } finally {
      set({ busy: null });
    }
  };

  /** 서버 view 를 편집 상태로 들인다. */
  const adopt = (
    view: FlowView,
    options: { keepData?: LfFlowData | null; message?: PipelineMessage | null; base?: { updatedAt: string | null; hash: string | null } } = {},
  ) => {
    cancelAutosave();
    const data = options.keepData ?? clone(view.data);
    const diff = options.keepData ? diffFlowData(view.data, data) : null;
    set((state) => ({
      current: view,
      data,
      baseUpdatedAt: options.base ? options.base.updatedAt : view.flow.updatedAt,
      baseHash: options.base ? options.base.hash : view.hash,
      dirty: !!options.keepData && !diff?.sameExecution,
      draftSaved: true,
      draftSavedAt: view.draft?.savedAt ?? null,
      diff,
      past: [],
      future: [],
      selectedNodeId: data.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : null,
      localIssues: validateLocal(data, view.relay),
      serverIssues: null,
      version: state.version + 1,
      message: options.message === undefined ? state.message : options.message,
      flows: state.flows.some((flow) => flow.id === view.flow.id)
        ? state.flows.map((flow) => (flow.id === view.flow.id ? view.flow : flow))
        : [view.flow, ...state.flows],
    }));
  };

  /** 편집 1단계 (undo 기록) */
  const mutate = (fn: (data: LfFlowData) => LfFlowData, structural = true) => {
    const { data, past, current, version } = get();
    if (!data) return;
    const next = fn(data);
    if (next === data) return;
    set({
      data: next,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), data],
      future: [],
      dirty: true,
      draftSaved: false,
      diff: current ? diffFlowData(current.data, next) : null,
      localIssues: validateLocal(next, current?.relay),
      serverIssues: null,
      version: structural ? version + 1 : version,
    });
    scheduleAutosave();
  };

  /** 서버 실행 기록을 폴링해 테스트 실행 상태를 따라간다. */
  const followTestRun = (record: ServerRunRecord, flowId: string) => {
    stopPolling();
    set({ testRun: { runId: record.runId, flowId, status: record.status, record, startedAt: Date.now() } });
    const tick = async () => {
      const state = get().testRun;
      if (!state) return stopPolling();
      try {
        const next = await api.getRun(state.runId);
        set({ testRun: { ...state, status: next.status, record: next } });
        if (next.status !== 'queued' && next.status !== 'running') stopPolling();
      } catch (error) {
        stopPolling();
        set({ message: errorMessage(error, t('lfStore.error.testRunStatus')) });
      }
    };
    pollTimer = window.setInterval(() => void tick(), TEST_POLL_MS);
    void tick();
  };

  const replaceNode = (data: LfFlowData, nodeId: string, fn: (node: LfNode) => LfNode): LfFlowData => ({
    ...data,
    nodes: data.nodes.map((node) => (node.id === nodeId ? fn(node) : node)),
  });

  return {
    ...initialState,

    async loadFlows() {
      try {
        const list = await pipelineApi.listFlows();
        set({ flows: list.flows, mode: list.mode, productionFlowId: list.productionFlowId, analysisFlowId: list.analysisFlowId });
      } catch (error) {
        set({ message: errorMessage(error, t('lfStore.error.flowList')) });
      }
    },

    async openFlow(flowId) {
      await withBusy(t('lfStore.busy.loading'), async () => {
        try {
          const view = await pipelineApi.getFlow(flowId);
          if (view.draft) {
            // 새로고침·재접속 후에도 초안을 이어서 편집한다. 기준 시점은 초안을 만들 때의 값을 유지해 원격 변경을 덮어쓰지 않는다.
            const draft = await pipelineApi.getDraft(flowId);
            adopt(view, {
              keepData: draft.data,
              base: { updatedAt: draft.baseUpdatedAt ?? view.flow.updatedAt, hash: draft.baseHash ?? view.hash },
              message: view.draft.remoteChangedSinceDraft
                ? {
                    kind: 'error',
                    text: t('lfStore.draft.staleLoaded', { time: new Date(draft.savedAt).toLocaleString() }),
                  }
                : { kind: 'info', text: t('lfStore.draft.loaded', { time: new Date(draft.savedAt).toLocaleString() }) },
            });
          } else {
            adopt(view, { message: null });
          }
          set({ versions: [] });
          void get().loadTemplates();
        } catch (error) {
          set({ message: errorMessage(error, t('lfStore.error.flowLoad')) });
        }
      });
    },

    async reload() {
      const flowId = get().current?.flow.id;
      if (flowId) await get().openFlow(flowId);
      await get().loadFlows();
    },

    async loadDraft() {
      const current = get().current;
      if (!current) return;
      try {
        const draft = await pipelineApi.getDraft(current.flow.id);
        const stale =
          (draft.baseUpdatedAt && draft.baseUpdatedAt !== current.flow.updatedAt) || (draft.baseHash && draft.baseHash !== current.hash);
        adopt(current, {
          keepData: draft.data,
          // 초안의 기준 시점·해시를 유지해 원격 변경을 덮어쓰지 않게 한다.
          base: { updatedAt: draft.baseUpdatedAt ?? current.flow.updatedAt, hash: draft.baseHash ?? current.hash },
          message: stale
            ? { kind: 'error', text: t('lfStore.draft.staleNotice') }
            : { kind: 'info', text: t('lfStore.draft.loadedShort') },
        });
      } catch (error) {
        set({ message: errorMessage(error, t('lfStore.error.draftLoad')) });
      }
    },

    async discardDraft() {
      const current = get().current;
      if (!current) return;
      try {
        cancelAutosave();
        await pipelineApi.discardDraft(current.flow.id);
        await get().openFlow(current.flow.id);
        set({ message: { kind: 'info', text: t('lfStore.draft.discarded') } });
      } catch (error) {
        set({ message: errorMessage(error, t('lfStore.error.draftDiscard')) });
      }
    },

    async cloneFlow(name) {
      const { current, data, dirty } = get();
      if (!current) return;
      await withBusy(t('lfStore.busy.cloning'), async () => {
        try {
          const view = await pipelineApi.clone(current.flow.id, name);
          // 편집 중이던 내용이 있으면 복제본 위에 그대로 옮긴다(컴포넌트 ID 가 같다).
          adopt(view, {
            keepData: dirty ? data : null,
            message: {
              kind: 'success',
              text: t('lfStore.cloned', { name: view.flow.name }) + (dirty ? t('lfStore.cloned.moved') : ''),
            },
          });
          await get().loadFlows();
        } catch (error) {
          set({ message: errorMessage(error, t('lfStore.error.clone')) });
        }
      });
    },

    async saveDraft(note, options = {}) {
      const { current, data, baseUpdatedAt, baseHash } = get();
      if (!current || !data) return;
      cancelAutosave();
      const run = async () => {
        try {
          const result = await pipelineApi.saveDraft(current.flow.id, data, { updatedAt: baseUpdatedAt, hash: baseHash }, note);
          const latest = get();
          set({
            // 저장 요청 뒤 또 편집했으면 그 편집은 아직 저장되지 않은 상태로 둔다.
            draftSaved: latest.data === data,
            draftSavedAt: result.savedAt,
            ...(options.silent ? {} : { serverIssues: result.issues }),
            message: options.silent
              ? latest.message
              : { kind: 'success', text: t('lfStore.draft.saved', { time: new Date(result.savedAt).toLocaleTimeString() }) },
            current: latest.current && {
              ...latest.current,
              flow: { ...latest.current.flow, hasDraft: true },
              draft: { flowId: current.flow.id, baseUpdatedAt, baseHash, savedAt: result.savedAt, note: note ?? null },
            },
          });
          if (latest.data !== data) scheduleAutosave();
        } catch (error) {
          set({ message: errorMessage(error, options.silent ? t('lfStore.error.draftAutosave') : t('lfStore.error.draftSave')) });
        }
      };
      if (options.silent) await run();
      else await withBusy(t('lfStore.busy.savingDraft'), run);
    },

    async validate(checkCode = false) {
      const { current, data } = get();
      if (!current || !data) return false;
      const result = await withBusy(t('lfStore.busy.validating'), async () => {
        try {
          const response = await pipelineApi.validate(current.flow.id, data, checkCode);
          set({
            serverIssues: response.issues,
            message:
              response.errorCount === 0
                ? {
                    kind: 'success',
                    text: t('lfStore.validation.passed', { count: response.issues.filter((i) => i.level === 'warning').length }),
                  }
                : { kind: 'error', text: t('lfStore.validation.failed', { count: response.errorCount }) },
          });
          return response.errorCount === 0;
        } catch (error) {
          set({ message: errorMessage(error, t('lfStore.error.validate')) });
          return false;
        }
      });
      return result ?? false;
    },

    async apply(note, test) {
      const { current, data, baseUpdatedAt, baseHash } = get();
      if (!current || !data) return false;
      cancelAutosave();
      const payload = test?.text.trim() ? await testPayload(test.text) : null;
      const result = await withBusy(t('lfStore.busy.applying'), async () => {
        try {
          const view = await pipelineApi.apply(current.flow.id, data, { updatedAt: baseUpdatedAt, hash: baseHash }, { note, test: payload });
          const applied = view.applied;
          if (!applied?.verified) {
            // 서버가 확인하지 못한 적용은 성공으로 표시하지 않는다.
            set({ message: { kind: 'error', text: t('lfStore.apply.unverified') } });
            return false;
          }
          const warnings = applied.warnings ?? [];
          adopt(view, {
            message: {
              kind: 'success',
              text:
                t('lfStore.apply.done', { hash: applied.actualHash.slice(0, 19) }) +
                (applied.langflowSnapshotError ? t('lfStore.apply.noSnapshot') : '') +
                (view.testRun ? t('lfStore.apply.testStarted') : ''),
              details: warnings,
            },
          });
          set({ serverIssues: applied.issues ?? null });
          if (view.testRun) followTestRun(view.testRun, current.flow.id);
          await Promise.all([get().loadVersions(), get().loadFlows()]);
          return true;
        } catch (error) {
          const message = errorMessage(error, t('lfStore.error.apply'));
          if (error instanceof ApiError && error.code === 'VALIDATION') set({ serverIssues: error.details as PipelineIssue[] });
          set({ message });
          if (error instanceof ApiError && error.code === 'APPLY_NOT_VERIFIED') void get().loadVersions();
          return false;
        }
      });
      return result ?? false;
    },

    async loadVersions() {
      const current = get().current;
      if (!current) return;
      try {
        set({ versions: (await pipelineApi.versions(current.flow.id)).versions });
      } catch (error) {
        set({ message: errorMessage(error, t('lfStore.error.versions')) });
      }
    },

    async restoreVersion(versionId) {
      const { current } = get();
      if (!current) return;
      await withBusy(t('lfStore.busy.restoring'), async () => {
        try {
          // 복원은 현재 원격 flow 를 기준으로 한다(편집 중 내용은 버린다).
          cancelAutosave();
          const fresh = await pipelineApi.getFlow(current.flow.id);
          const view = await pipelineApi.restore(current.flow.id, versionId, { updatedAt: fresh.flow.updatedAt, hash: fresh.hash });
          adopt(view, { message: { kind: 'success', text: t('lfStore.restored') } });
          await get().loadVersions();
        } catch (error) {
          set({ message: errorMessage(error, t('lfStore.error.restore')) });
        }
      });
    },

    async loadTemplates() {
      const current = get().current;
      try {
        const result = await pipelineApi.componentTemplates(current?.flow.id);
        set({ templates: result.templates, templateWarnings: result.warnings });
      } catch (error) {
        set({ templateWarnings: [errorMessage(error, t('lfStore.error.templates')).text] });
      }
    },

    async setAnalysisFlow(flowId) {
      try {
        const result = await pipelineApi.setAnalysisFlow(flowId);
        set({
          analysisFlowId: result.analysisFlowId,
          message: {
            kind: 'success',
            text: flowId ? t('lfStore.analysisFlow.set') : t('lfStore.analysisFlow.cleared'),
          },
        });
        await get().loadFlows();
      } catch (error) {
        set({ message: errorMessage(error, t('lfStore.error.analysisFlow')) });
      }
    },

    async runDiagnostics() {
      await withBusy(t('lfStore.busy.diagnostics'), async () => {
        try {
          set({ connection: await api.connectionStatus() });
        } catch (error) {
          set({ message: errorMessage(error, t('lfStore.error.diagnostics')) });
        }
      });
    },

    select(nodeId) {
      set({ selectedNodeId: nodeId });
    },

    addComponent(templateKey, position) {
      const { data, templates } = get();
      const template = templates.find((item) => item.key === templateKey);
      if (!data || !template) return null;
      const node = instantiateTemplate(template, position, data.nodes.map((item) => item.id));
      mutate((current) => ({ ...current, nodes: [...current.nodes, node] }));
      set({ selectedNodeId: node.id });
      return node.id;
    },

    deleteNodes(nodeIds) {
      const relay = get().current?.relay;
      const blocked = nodeIds.filter((id) => id === relay?.inputComponentId || id === relay?.outputComponentId);
      if (blocked.length > 0) {
        set({ message: { kind: 'error', text: t('lfStore.error.relayDelete', { ids: blocked.join(', ') }) } });
      }
      const removing = new Set(nodeIds.filter((id) => !blocked.includes(id)));
      if (removing.size === 0) return;
      mutate((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => !removing.has(node.id)),
        edges: current.edges.filter((edge) => !removing.has(edge.source) && !removing.has(edge.target)),
      }));
      if (removing.has(get().selectedNodeId ?? '')) set({ selectedNodeId: null });
    },

    moveNodes(positions) {
      const byId = new Map(positions.map((item) => [item.id, item]));
      mutate((current) => {
        let moved = false;
        const nodes = current.nodes.map((node) => {
          const next = byId.get(node.id);
          if (!next || (next.x === node.position.x && next.y === node.position.y)) return node;
          moved = true;
          return { ...node, position: { x: next.x, y: next.y } };
        });
        return moved ? { ...current, nodes } : current;
      }, false);
    },

    connect(sourceId, outputName, targetId, fieldName) {
      const data = get().data;
      if (!data) return false;
      const check = canConnect(data, sourceId, outputName, targetId, fieldName);
      if (!check.ok) {
        set({ message: { kind: 'error', text: t('lfStore.error.connect', { reason: check.reason ?? '' }) } });
        return false;
      }
      const source = data.nodes.find((node) => node.id === sourceId)!;
      const target = data.nodes.find((node) => node.id === targetId)!;
      mutate((current) => ({ ...current, edges: [...current.edges, makeEdge(source, outputName, target, fieldName)] }));
      return true;
    },

    deleteEdges(edgeIds) {
      const removing = new Set(edgeIds);
      mutate((current) => {
        const edges = current.edges.filter((edge) => !removing.has(edge.id));
        return edges.length === current.edges.length ? current : { ...current, edges };
      });
    },

    updateField(nodeId, field, value) {
      mutate(
        (current) =>
          replaceNode(current, nodeId, (node) => {
            const spec = fieldSpec(node, field);
            if (!spec || JSON.stringify(spec.value) === JSON.stringify(value)) return node;
            const next = clone(node);
            (next.data.node.template[field] as { value: unknown }).value = value;
            return next;
          }),
        false,
      );
    },

    updatePrompt(nodeId, text) {
      let removed: string[] = [];
      mutate((current) => {
        const withNode = replaceNode(current, nodeId, (node) => {
          const result = syncPromptFields(node, text);
          removed = result.removedFields;
          return result.node;
        });
        // 없어진 변수 필드에 걸린 연결은 함께 뺀다.
        return removeDanglingEdges(withNode).data;
      });
      if (removed.length > 0) {
        set({ message: { kind: 'info', text: t('lfStore.variablesRemoved', { names: removed.join(', ') }) } });
      }
    },

    updateNodeInfo(nodeId, patch) {
      mutate(
        (current) =>
          replaceNode(current, nodeId, (node) => ({ ...node, data: { ...node.data, node: { ...node.data.node, ...patch } } })),
        true,
      );
    },

    updateCode(nodeId, code) {
      get().updateField(nodeId, 'code', code);
    },

    async rebuildComponent(nodeId) {
      const data = get().data;
      const node = data?.nodes.find((item) => item.id === nodeId);
      const code = node ? fieldSpec(node, 'code')?.value : undefined;
      if (!node || typeof code !== 'string') return;
      await withBusy(t('lfStore.busy.rebuilding'), async () => {
        try {
          const result = await pipelineApi.rebuildComponent(code, node.data.node);
          let removed = 0;
          mutate((current) => {
            const withNode = replaceNode(current, nodeId, (item) => {
              const next = clone(item);
              // 표시 이름·위치 등 편집기 값은 유지하고 template/outputs 는 Langflow 가 만든 것으로 바꾼다.
              next.data.node = { ...result.node, display_name: item.data.node.display_name ?? result.node.display_name };
              return next;
            });
            const cleaned = removeDanglingEdges(withNode);
            removed = cleaned.removed.length;
            return cleaned.data;
          });
          set({
            message: {
              kind: 'success',
              text:
                t('lfStore.rebuilt') +
                (removed > 0 ? t('lfStore.rebuilt.removed', { count: removed }) : '') +
                t('lfStore.rebuilt.tail'),
            },
          });
        } catch (error) {
          set({ message: errorMessage(error, t('lfStore.error.rebuild')) });
        }
      });
    },

    undo() {
      const { past, data, future, current, version } = get();
      if (past.length === 0 || !data) return;
      const previous = past[past.length - 1];
      set({
        data: previous,
        past: past.slice(0, -1),
        future: [data, ...future].slice(0, HISTORY_LIMIT),
        dirty: true,
        draftSaved: false,
        diff: current ? diffFlowData(current.data, previous) : null,
        localIssues: validateLocal(previous, current?.relay),
        serverIssues: null,
        version: version + 1,
      });
      scheduleAutosave();
    },

    redo() {
      const { future, data, past, current, version } = get();
      if (future.length === 0 || !data) return;
      const [next, ...rest] = future;
      set({
        data: next,
        future: rest,
        past: [...past, data].slice(-HISTORY_LIMIT),
        dirty: true,
        draftSaved: false,
        diff: current ? diffFlowData(current.data, next) : null,
        localIssues: validateLocal(next, current?.relay),
        serverIssues: null,
        version: version + 1,
      });
      scheduleAutosave();
    },

    async startTestRun({ text }) {
      const { current, dirty, testRun } = get();
      if (!current) return;
      if (testRun && (testRun.status === 'queued' || testRun.status === 'running')) return;
      if (!text.trim()) {
        set({ message: { kind: 'error', text: t('lfStore.error.noTestText') } });
        return;
      }
      if (dirty) {
        set({ message: { kind: 'info', text: t('lfStore.test.savedFlow') } });
      }
      try {
        const record = await pipelineApi.test(current.flow.id, await testPayload(text));
        followTestRun(record, current.flow.id);
      } catch (error) {
        set({ message: errorMessage(error, t('lfStore.error.testStart')) });
      }
    },

    importTestRun() {
      const record = get().testRun?.record;
      if (!record) return;
      const problem = useAnnotationStore.getState().importExternalRun(record);
      set({
        message: problem
          ? { kind: 'error', text: problem }
          : { kind: 'success', text: t('lfStore.test.imported') },
      });
    },

    clearMessage() {
      set({ message: null });
    },
  };
});
