import { useI18nStore, useLang, useT } from '../../i18n';

/** 상단 한국어 / English 전환 버튼. 고른 언어는 localStorage 에 남는다. */
export function LanguageToggle() {
  const t = useT();
  const lang = useLang();
  const toggle = useI18nStore((state) => state.toggle);
  const next = lang === 'ko' ? 'en' : 'ko';

  return (
    <button
      type="button"
      className="lang-toggle"
      onClick={toggle}
      title={t('lang.toggle.title')}
      aria-label={t('lang.aria')}
      lang={next}
    >
      <span aria-hidden="true" className="lang-toggle-icon">
        文
      </span>
      {t('lang.toggle.label')}
    </button>
  );
}
