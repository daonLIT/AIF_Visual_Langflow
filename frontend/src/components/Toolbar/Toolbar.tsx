import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useAnnotationStore } from '../../store/annotationStore';
import { downloadCaseJson } from '../../io/exportAifOva';
import type { ProjectFile } from '../../types/annotation';
import { JudgmentInputDialog } from '../Analysis/JudgmentInputDialog';
import { AnalysisStatus } from '../Analysis/AnalysisStatus';
import { api } from '../../api/client';

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** 프로젝트 저장/불러오기 메뉴 */
function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const [serverProjects, setServerProjects] = useState<Array<{ projectId: string; title?: string | null; revision: number; updatedAt: string }>>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const caseData = useGraphStore((state) => state.caseData);
  const dirty = useAnnotationStore((state) => state.dirty);
  const revision = useAnnotationStore((state) => state.revision);
  const buildProjectFile = useAnnotationStore((state) => state.buildProjectFile);
  const saveToServer = useAnnotationStore((state) => state.saveToServer);
  const loadFromServer = useAnnotationStore((state) => state.loadFromServer);
  const loadProjectFile = useAnnotationStore((state) => state.loadProjectFile);
  const setErrorMessage = useGraphStore((state) => state.setErrorMessage);

  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', key);
    api
      .listProjects()
      .then((result) => setServerProjects(result.projects))
      .catch(() => setServerProjects([]));
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const saveFile = () => {
    const project = buildProjectFile();
    if (!project) {
      setErrorMessage('저장할 프로젝트가 없습니다.');
      return;
    }
    downloadJson(`${project.title || project.projectId}.project.json`, project);
    setOpen(false);
  };

  const openFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as ProjectFile;
      if (!parsed || parsed.schemaVersion === undefined || !parsed.document || !parsed.acceptedGraph) {
        throw new Error('프로젝트 파일 형식이 아닙니다 (schemaVersion/document/acceptedGraph 필요).');
      }
      await loadProjectFile(parsed, file.name);
    } catch (error) {
      setErrorMessage(`프로젝트 열기 실패: ${(error as Error).message}`);
    }
    setOpen(false);
  };

  return (
    <div className="menu-anchor" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="프로젝트 저장 / 불러오기"
      >
        프로젝트{dirty ? ' •' : ''}
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="menu-title">현재 프로젝트 {revision > 0 ? `(서버 revision ${revision})` : '(서버 미저장)'}</div>
          <button type="button" role="menuitem" className="menu-item" disabled={!caseData} onClick={() => { void saveToServer(); setOpen(false); }}>
            서버에 저장
          </button>
          <button type="button" role="menuitem" className="menu-item" disabled={!caseData} onClick={saveFile}>
            파일로 저장 (.project.json)
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => fileRef.current?.click()}>
            프로젝트 파일 열기
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openFile(file);
              event.target.value = '';
            }}
          />
          <div className="menu-title">서버 프로젝트</div>
          {serverProjects.length === 0 ? (
            <div className="menu-hint">저장된 프로젝트가 없거나 서버에 연결되지 않았습니다.</div>
          ) : (
            serverProjects.slice(0, 10).map((project) => (
              <button
                key={project.projectId}
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  void loadFromServer(project.projectId);
                  setOpen(false);
                }}
                title={project.projectId}
              >
                {project.title || project.projectId} <span className="menu-meta">rev {project.revision}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Toolbar() {
  const caseData = useGraphStore((state) => state.caseData);
  const fileName = useGraphStore((state) => state.fileName);
  const isLayouting = useGraphStore((state) => state.isLayouting);
  const canUndo = useGraphStore((state) => state.past.length > 0);
  const canRedo = useGraphStore((state) => state.future.length > 0);

  const loadFromJsonText = useGraphStore((state) => state.loadFromJsonText);
  const runAutoLayout = useGraphStore((state) => state.runAutoLayout);
  const runValidation = useGraphStore((state) => state.runValidation);
  const requestFitView = useGraphStore((state) => state.requestFitView);
  const undo = useGraphStore((state) => state.undo);
  const redo = useGraphStore((state) => state.redo);

  const projectTitle = useAnnotationStore((state) => state.projectTitle);
  const resetProject = useAnnotationStore((state) => state.resetProject);
  const attachDocumentMeta = useAnnotationStore((state) => state.attachDocumentMeta);

  const inputRef = useRef<HTMLInputElement>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const hasCase = caseData !== null;

  const loadJson = async (source: string, name: string) => {
    resetProject();
    await loadFromJsonText(source, name);
    const loaded = useGraphStore.getState().caseData;
    if (loaded) await attachDocumentMeta(loaded.text);
  };

  const handleFile = async (file: File) => {
    await loadJson(await file.text(), file.name);
  };

  const loadSample = async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}sample/sample-case.json`);
    await loadJson(await response.text(), 'sample-case.json');
  };

  return (
    <header className="toolbar">
      <div className="toolbar-title">
        <span className="toolbar-app">법적 논증 그래프 검토</span>
        <span className="toolbar-file">{projectTitle || fileName || '불러온 파일 없음'}</span>
      </div>

      <div className="toolbar-actions">
        <button type="button" className="is-primary" onClick={() => setInputOpen(true)}>
          판결문 입력
        </button>
        <AnalysisStatus />

        <span className="toolbar-divider" />

        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.target.value = '';
          }}
        />
        <button type="button" onClick={() => inputRef.current?.click()} title="AIF/OVA JSON 불러오기">
          JSON 불러오기
        </button>
        <button type="button" onClick={() => void loadSample()} title="예제 판결문 JSON 열기">
          예제 열기
        </button>

        <span className="toolbar-divider" />

        <button type="button" disabled={!hasCase} onClick={requestFitView}>
          화면 맞춤
        </button>
        <button
          type="button"
          disabled={!hasCase || isLayouting}
          onClick={() => void runAutoLayout()}
        >
          {isLayouting ? '정렬 중...' : '자동 정렬'}
        </button>
        <button type="button" disabled={!hasCase} onClick={runValidation}>
          검증
        </button>

        <span className="toolbar-divider" />

        <button type="button" disabled={!canUndo} onClick={undo} title="실행 취소 (Ctrl+Z)">
          되돌리기
        </button>
        <button type="button" disabled={!canRedo} onClick={redo} title="다시 실행 (Ctrl+Shift+Z)">
          다시 실행
        </button>

        <span className="toolbar-divider" />

        <ProjectMenu />
        <button
          type="button"
          disabled={!hasCase}
          onClick={() => caseData && downloadCaseJson(caseData)}
          title="확정된 그래프만 AIF/OVA 형식으로 내보냅니다 (미검토·거절 제안 제외)"
        >
          AIF/OVA 내보내기
        </button>
      </div>

      {inputOpen ? <JudgmentInputDialog onClose={() => setInputOpen(false)} /> : null}
    </header>
  );
}
