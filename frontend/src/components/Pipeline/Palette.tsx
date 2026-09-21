import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { usePipelineStore } from '../../store/pipelineStore';
import type { ComponentKind, ComponentTemplate } from '../../types/pipeline';
import { KIND_KEY } from '../../types/pipeline';
import { useT } from '../../i18n';
import { PALETTE_MIME } from './PipelineCanvas';

const KIND_ORDER: ComponentKind[] = ['prompt', 'llm', 'custom', 'input', 'output', 'generic'];

/** 추가할 수 있는 컴포넌트 목록. 현재 flow 에 있는 컴포넌트는 설정을 복사한 새 컴포넌트로 추가된다. */
export function Palette() {
  const t = useT();
  const templates = usePipelineStore((state) => state.templates);
  const warnings = usePipelineStore((state) => state.templateWarnings);
  const current = usePipelineStore((state) => state.current);
  const addComponent = usePipelineStore((state) => state.addComponent);
  const { screenToFlowPosition } = useReactFlow();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map<ComponentKind, ComponentTemplate[]>();
    for (const template of templates) {
      if (needle && !`${template.displayName} ${template.type} ${template.description}`.toLowerCase().includes(needle)) continue;
      if (!map.has(template.kind)) map.set(template.kind, []);
      map.get(template.kind)!.push(template);
    }
    return KIND_ORDER.filter((kind) => map.has(kind)).map((kind) => [kind, map.get(kind)!] as const);
  }, [templates, query]);

  if (!current) return <aside className="lf-palette" />;

  return (
    <aside className="lf-palette" aria-label={t('lf.palette.aria')}>
      <h3>{t('lf.palette.title')}</h3>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('lf.palette.search')}
        aria-label={t('lf.palette.searchAria')}
      />
      {warnings.map((warning, index) => (
        <div key={index} className="lf-muted lf-small">
          {warning}
        </div>
      ))}
      {groups.map(([kind, items]) => (
        <section key={kind}>
          <h4>{t(KIND_KEY[kind])}</h4>
          <ul>
            {items.map((template) => (
              <li key={template.key}>
                <button
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(PALETTE_MIME, template.key);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => {
                    // 클릭하면 화면 가운데 근처에 추가한다.
                    const canvas = document.querySelector('.pipeline-canvas')?.getBoundingClientRect();
                    const position = canvas
                      ? screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 3 })
                      : { x: 0, y: 0 };
                    addComponent(template.key, position);
                  }}
                  title={t('lf.palette.itemTitle', {
                    description: template.description || template.type,
                    source: template.source === 'flow' ? t('lf.palette.sourceFlow') : t('lf.palette.sourceDefault'),
                  })}
                >
                  <span className="lf-palette-name">{template.displayName}</span>
                  <span className="lf-palette-source">
                    {template.source === 'flow' ? t('lf.palette.copy') : t('lf.palette.default')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
