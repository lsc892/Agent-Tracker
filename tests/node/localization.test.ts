import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { createTranslator, getLocale, languages, localizationBundle, localizationScripts, resolveLocale, setLocale, t } from '../../src/localization';
import { readConfiguration } from '../../src/configuration';
import { colorSettingsHtml, dashboardHtml, diagnosticsHtml } from '../../src/ui/html';
import { QuotaError } from '../../src/quota/types';
import { statusBarPresentation } from '../../src/ui/statusBarPresentation';
import korean from '../../localization/locales/ko.json';

test('language override takes precedence over VS Code, with regional resolution and Korean fallback', () => {
  for (const language of languages) {
    assert.equal(resolveLocale('auto', language.locale), language.locale);
    assert.equal(resolveLocale(language.locale, 'en'), language.locale);
  }
  for (const [input, expected] of [['EN-us', 'en'], ['fr_CA', 'fr'], ['zh-CN', 'zh'], ['zh-Hant', 'zh'], ['de-DE', 'ko'], ['../../en', 'ko']]) {
    assert.equal(resolveLocale('auto', input), expected);
  }
  const settings = { get<T>(key: string, fallback: T): T { return (key === 'language' ? 'ja' : fallback) as T; } };
  assert.equal(readConfiguration(settings, 'en').locale, 'ja');
  assert.equal(readConfiguration({get: (_key, fallback) => fallback}, 'fr').locale, 'fr');
});

test('missing translations fall back to Korean and interpolation preserves user text', () => {
  const instance = createTranslator('en', { 'common.settings': 'Settings' });
  assert.equal(instance.t('dashboard.allSessions'), korean['dashboard.allSessions']);
  assert.equal(instance.t('quota.lastUpdated', {value0: '<script>& $1'}), '마지막 갱신: <script>& $1');
  assert.equal(instance.t('common.settings'), 'Settings');
});

test('all panels render in each language and bootstrap data cannot break out of a script', () => {
  try {
    for (const language of languages) {
      setLocale(language.locale);
      for (const render of [dashboardHtml, diagnosticsHtml, colorSettingsHtml]) {
        const html = render('local/main.js', 'local/style.css', 'local:', 'safe');
        assert.match(html, new RegExp(`<html lang="${language.locale}">`));
        assert.match(html, /local\/i18next\.js/);
        assert.match(html, /local\/localization\.js/);
        assert.doesNotMatch(html, /<option[^>]*><span|unsafe-inline/);
        if (language.locale !== 'ko') assert.doesNotMatch(html, /[가-힣]/);
      }
    }
    const injected = '</script><script>throw new Error("executed")</script>&\u2028';
    const bootstrap = localizationScripts('local/main.js', 'safe', {locale:getLocale(),messages:{probe:injected}});
    assert.doesNotMatch(bootstrap, /<script>throw/);
    const context = {agentTrackerLocale:undefined as undefined | {messages:{probe:string}}};
    new Script(bootstrap.match(/<script nonce="safe">([\s\S]*?)<\/script>/)![1]).runInNewContext(context);
    assert.equal(context.agentTrackerLocale!.messages.probe, injected);
  } finally { setLocale('ko'); }
});

test('localized percentages and stored provider errors follow language changes', () => {
  const failure = new QuotaError('authentication', {key:'quota.claudeLoginRequired'});
  assert.match(failure.message, /로그인/);
  try {
    setLocale('zh');
    const state = {provider:'claude' as const, status:'ready' as const, refreshing:false, lastSuccessAt:0, error:null, nextAllowedAt:0,
      snapshot:{provider:'claude' as const,fetchedAt:0,windows:[{id:'five_hour',label:'5h',usedPercent:23,current:23,maximum:100,resetsAt:null,windowDurationMins:300}]}};
    assert.match(statusBarPresentation(state, 'remaining', 'compact').text, /剩余 77%/);
    assert.match(t(failure.translation!.key), /请登录 Claude Code/);
    setLocale('fr');
    assert.equal(t('quota.usedPercentage', {value0:23}), '23 % utilisé');
  } finally { setLocale('ko'); }
});

test('webview switches static copy, accessible labels and placeholders without changing form inputs', () => {
  const nodes = new Map<string, {textContent:string;dataset:Record<string,string>;attributes:Map<string,string>;setAttribute(key:string,value:string):void;getAttribute(key:string):string|undefined}>();
  for (const [name, attributes] of [['heading', {'data-i18n':'dashboard.heading'}], ['input', {'data-i18n-placeholder':'color.hexPlaceholder'}], ['aria', {'data-i18n-aria-label':'dashboard.usageStatistics'}], ['category', {'data-i18n-category':'subagent'}]] as const) {
    const node = {textContent:'original',dataset:{} as Record<string,string>,attributes:new Map<string,string>(Object.entries(attributes)),
      setAttribute(key:string,value:string) { this.attributes.set(key,value); }, getAttribute(key:string) { return this.attributes.get(key); }};
    if (name === 'heading') node.dataset.i18n = 'dashboard.heading';
    if (name === 'category') node.dataset.i18nCategory = 'subagent';
    nodes.set(name,node);
  }
  const document = {documentElement:{lang:'ko'}, querySelectorAll(selector:string) { return [...nodes.values()].filter(node=>node.attributes.has(selector.slice(1,-1))); }};
  const context = {document,agentTrackerLocale:{locale:'ko',messages:korean},updateAgentTrackerLocale:undefined as undefined | ((bundle: ReturnType<typeof localizationBundle>)=>boolean),agentTrackerI18n:undefined as ReturnType<typeof createTranslator> | undefined};
  new Script(readFileSync(join(__dirname,'../../../media/i18next.js'),'utf8')).runInNewContext(context);
  new Script(readFileSync(join(__dirname,'../../../media/localization.js'),'utf8')).runInNewContext(context);
  try {
    for (const language of languages) {
      setLocale(language.locale);
      context.updateAgentTrackerLocale!(localizationBundle());
      assert.equal(context.agentTrackerI18n!.language, language.locale);
      if (language.locale === 'ko') continue;
      assert.equal(nodes.get('heading')!.textContent, t('dashboard.heading'));
      assert.equal(nodes.get('input')!.attributes.get('placeholder'), t('color.hexPlaceholder'));
      assert.equal(nodes.get('aria')!.attributes.get('aria-label'), t('dashboard.usageStatistics'));
      assert.equal(nodes.get('category')!.attributes.get('aria-label'), t('dashboard.categoryStatistics',{value0:t('common.subagent')}));
    }
    assert.deepEqual(Object.entries(context.agentTrackerI18n!.store.data).filter(([, namespaces]) => namespaces.translation).map(([locale]) => locale), ['fr'], 'previous language bundles are released');
  } finally { setLocale('ko'); }
});
