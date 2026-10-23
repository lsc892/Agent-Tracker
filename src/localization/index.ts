import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { i18n } from 'i18next';
import korean from '../../localization/locales/ko.json';
import languages from '../../localization/languages.json';

// Build copies the runtime into the VSIX; no node_modules are needed at runtime.
const engine = require('./i18next.cjs') as typeof import('i18next');
export { languages };
export type TranslationKey = keyof typeof korean;
export type TranslationValues = Record<string, string | number>;
export interface LocalizedMessage { key: TranslationKey; values?: TranslationValues }
export interface LocalizationBundle { locale: string; messages: Record<string, string> }

/**
 * 책임: 사용자·편집기 언어를 지원하는 번역 목록에 연결한다.
 * 알고리즘: 명시 설정을 우선해 표기를 정규화하고 전체 locale·언어 코드 순으로 찾으며 미지원 언어는 영어로 대체한다.
 */
export function resolveLocale(setting: unknown, editorLanguage: string): string {
  const candidate = typeof setting === 'string' && setting !== 'auto' ? setting : editorLanguage;
  const normalized = candidate.trim().toLowerCase().replaceAll('_', '-');
  // Regional variants share a catalog. Chinese UI is the simplified catalog.
  return languages.find(language => language.locale === normalized)?.locale
    ?? languages.find(language => language.locale === normalized.split('-')[0])?.locale ?? 'en';
}

/**
 * 책임: 독립된 번역 인스턴스와 누락 문구의 대체 언어를 구성한다.
 * 알고리즘: 선택 언어 사전과 한국어 원문을 동기 등록하고 점이 포함된 키와 중괄호 치환 규칙을 사용한다.
 */
export function createTranslator(locale: string, override?: Record<string, string>): i18n {
  const resolved = resolveLocale(locale, 'ko');
  const messages = override ?? (resolved === 'ko' ? korean
    : JSON.parse(readFileSync(join(__dirname, '../../localization/locales', `${resolved}.json`), 'utf8')) as Record<string, string>);
  const instance = engine.createInstance();
  void instance.init({
    initAsync: false, lng: resolved, fallbackLng: 'ko', keySeparator: false,
    resources: { ko: { translation: korean }, [resolved]: { translation: messages } },
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
  });
  return instance;
}

let current = createTranslator('ko');
export function setLocale(locale: string): void {
  const resolved = resolveLocale(locale, 'ko');
  if (resolved !== current.language) current = createTranslator(resolved);
}
export function getLocale(): string { return current.language; }
export function t(key: TranslationKey, values?: TranslationValues): string {
  return String(current.t(key, values));
}
export function localizationBundle(): LocalizationBundle {
  return { locale: getLocale(), messages: { ...korean, ...current.getResourceBundle(getLocale(), 'translation') } };
}

/**
 * 책임: 번역 데이터와 실행 스크립트를 Webview에 안전하게 전달한다.
 * 알고리즘: JSON의 script 종료·구분 문자를 이스케이프하고 HTML 속성을 인코딩한 nonce·경로로 스크립트를 조립한다.
 */
export function localizationScripts(scriptUri: string, nonce: string, bundle = localizationBundle()): string {
  const serialized = JSON.stringify(bundle).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const escape = (value: string): string => value.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const directory = scriptUri.slice(0, scriptUri.lastIndexOf('/') + 1);
  return `<script nonce="${escape(nonce)}">globalThis.agentTrackerLocale=${serialized};</script>`
    + `<script nonce="${escape(nonce)}" src="${escape(directory)}i18next.js"></script>`
    + `<script nonce="${escape(nonce)}" src="${escape(directory)}localization.js"></script>`;
}
