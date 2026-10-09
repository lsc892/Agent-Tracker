(() => {
  'use strict';
  const engine = globalThis.i18next.createInstance();
  const initial = globalThis.agentTrackerLocale;
  engine.init({ initAsync: false, lng: initial.locale, fallbackLng: false, keySeparator: false,
    resources: { [initial.locale]: { translation: initial.messages } },
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' } });
  delete globalThis.agentTrackerLocale;
  globalThis.agentTrackerI18n = engine;
  globalThis.updateAgentTrackerLocale = bundle => {
    if (!bundle || bundle.locale === engine.language) return false;
    engine.removeResourceBundle(engine.language, 'translation');
    engine.addResourceBundle(bundle.locale, 'translation', bundle.messages);
    engine.changeLanguage(bundle.locale);
    document.documentElement.lang = bundle.locale;
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = engine.t(node.dataset.i18n);
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        node.setAttribute(attribute, engine.t(node.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    for (const node of document.querySelectorAll('[data-i18n-category]')) {
      node.setAttribute('aria-label', engine.t('dashboard.categoryStatistics', {value0: engine.t(`common.${node.dataset.i18nCategory}`)}));
    }
    return true;
  };
})();
