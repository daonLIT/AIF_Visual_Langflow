import { useState } from 'react';
import { isSecretField } from '../../pipeline/flowUtils';
import type { LfFieldSpec } from '@aif/workbench/types/pipeline';
import { SECRET_SENTINEL } from '@aif/workbench/types/pipeline';
import { useT } from '@aif/workbench/i18n';

interface Props {
  name: string;
  spec: LfFieldSpec;
  /** 이 필드에 연결된 출력 설명 (있으면 값 대신 연결 정보를 보여준다) */
  connectedFrom?: string[];
  onChange: (value: unknown) => void;
}

function optionLabel(option: unknown): string {
  return typeof option === 'string' ? option : JSON.stringify(option);
}

/** Langflow template 필드 하나의 값 편집기. 형식을 모르는 필드는 JSON 으로 편집한다. */
export function FieldEditor({ name, spec, connectedFrom, onChange }: Props) {
  const t = useT();
  const label = String(spec.display_name ?? name);
  const info = typeof spec.info === 'string' && spec.info ? spec.info : undefined;

  if (connectedFrom && connectedFrom.length > 0) {
    return (
      <div className="lf-field">
        <span className="lf-field-label" title={info}>
          {label}
        </span>
        <span className="lf-field-connected">{t('lf.field.connected', { sources: connectedFrom.join(', ') })}</span>
      </div>
    );
  }

  return (
    <div className="lf-field">
      <span className="lf-field-label" title={info}>
        {label}
        {spec.required ? <span className="lf-required">*</span> : null}
        <code className="lf-field-name">{name}</code>
      </span>
      <FieldInput name={name} spec={spec} onChange={onChange} />
      {info ? <small className="lf-field-info">{info}</small> : null}
    </div>
  );
}

function FieldInput({ name, spec, onChange }: { name: string; spec: LfFieldSpec; onChange: (value: unknown) => void }) {
  const t = useT();
  const value = spec.value;
  const type = String(spec.type ?? '');
  const inputType = String(spec._input_type ?? '');

  if (isSecretField(spec)) return <SecretInput value={value} onChange={onChange} />;

  if (type === 'bool' || typeof value === 'boolean') {
    return <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} aria-label={name} />;
  }

  if (Array.isArray(spec.options) && spec.options.length > 0 && (type === 'str' || inputType === 'DropdownInput')) {
    const options = spec.options.map(optionLabel);
    const current = typeof value === 'string' ? value : '';
    return (
      <div className="lf-field-row">
        <select value={options.includes(current) ? current : '__custom__'} onChange={(event) => event.target.value !== '__custom__' && onChange(event.target.value)} aria-label={name}>
          {!options.includes(current) ? <option value="__custom__">{current || t('lf.field.customOption')}</option> : null}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {spec.combobox || !options.includes(current) ? (
          <input
            type="text"
            value={current}
            onChange={(event) => onChange(event.target.value)}
            aria-label={t('lf.field.customAria', { name })}
            placeholder={t('lf.field.customPlaceholder')}
          />
        ) : null}
      </div>
    );
  }

  if (type === 'int' || type === 'float' || type === 'slider' || inputType === 'IntInput' || inputType === 'FloatInput' || inputType === 'SliderInput') {
    const integer = type === 'int' || inputType === 'IntInput';
    const range = spec.range_spec;
    return (
      <input
        type="number"
        value={typeof value === 'number' ? value : value === null || value === undefined || value === '' ? '' : Number(value)}
        step={range?.step ?? (integer ? 1 : 0.01)}
        min={range?.min}
        max={range?.max}
        onChange={(event) => {
          if (event.target.value === '') return onChange(integer ? 0 : 0);
          const parsed = integer ? Math.round(Number(event.target.value)) : Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        aria-label={name}
      />
    );
  }

  if (type === 'str' || type === 'prompt' || typeof value === 'string') {
    const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
    if (spec.multiline || text.length > 80 || text.includes('\n')) {
      return <textarea value={text} rows={Math.min(14, Math.max(3, text.split('\n').length + 1))} onChange={(event) => onChange(event.target.value)} aria-label={name} spellCheck={false} />;
    }
    return <input type="text" value={text} onChange={(event) => onChange(event.target.value)} aria-label={name} />;
  }

  return <JsonInput value={value} onChange={onChange} name={name} />;
}

function SecretInput({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const masked = value === SECRET_SENTINEL;
  if (!editing) {
    return (
      <div className="lf-field-row">
        <span className="lf-secret">
          {masked ? t('lf.secret.kept') : value ? t('lf.secret.new') : t('lf.secret.empty')}
        </span>
        <button type="button" onClick={() => setEditing(true)}>
          {t('lf.secret.enter')}
        </button>
        {value ? (
          <button type="button" onClick={() => onChange('')}>
            {t('lf.secret.clear')}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="lf-field-row">
      <input
        type="password"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        autoComplete="off"
        aria-label={t('lf.secret.aria')}
      />
      <button
        type="button"
        onClick={() => {
          if (draft) onChange(draft);
          setEditing(false);
          setDraft('');
        }}
      >
        {t('lf.confirm')}
      </button>
      <button type="button" onClick={() => setEditing(false)}>
        {t('lf.cancel')}
      </button>
    </div>
  );
}

function JsonInput({ value, onChange, name }: { value: unknown; onChange: (value: unknown) => void; name: string }) {
  const t = useT();
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="lf-json">
      <textarea
        value={text}
        rows={Math.min(12, text.split('\n').length + 1)}
        spellCheck={false}
        aria-label={`${name} (JSON)`}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
      />
      <div className="lf-field-row">
        <button
          type="button"
          onClick={() => {
            try {
              onChange(JSON.parse(text));
              setError(null);
            } catch (parseError) {
              setError((parseError as Error).message);
            }
          }}
        >
          {t('lf.json.apply')}
        </button>
        {error ? <span className="lf-error">{error}</span> : <small className="lf-field-info">{t('lf.json.hint')}</small>}
      </div>
    </div>
  );
}
