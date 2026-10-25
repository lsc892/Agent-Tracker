// 번역 사전·사용처를 검증하고 manifest 번역과 실행용 다국어 자산을 동기화한다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { configurationManifest } = require('./configuration.cjs');
const root = path.join(__dirname, '..');
const check = process.argv.includes('--check');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const languages = read('localization/languages.json');
const base = read('localization/locales/ko.json');
const placeholders = value => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort().join(',');
const localePattern = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/;
function write(file, value) {
  const target = path.join(root, file);
  const expected = JSON.stringify(value, null, 2) + '\n';
  if (!check) { fs.writeFileSync(target, expected); return; }
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== expected) throw new Error(`${file} is stale. Run npm run localization:sync.`);
}
const catalogs = new Map();
const localeIds = new Set();
/**
 * 책임: 지원 언어 사전의 완전성과 치환 규칙을 검증한다.
 * 알고리즘: 언어 ID·별칭 중복, 원문과의 키 집합·placeholder 일치, 빈 번역·미번역 한글을 검사한 뒤 유효 사전만 등록한다.
 */
for (const language of languages) {
  if (!localePattern.test(language.locale) || localeIds.has(language.locale)
    || !Array.isArray(language.vscodeLocales) || !language.vscodeLocales.every(alias => localePattern.test(alias))) {
    throw new Error('Invalid or duplicate locale');
  }
  localeIds.add(language.locale);
  const catalog = read(`localization/locales/${language.locale}.json`);
  if (Object.keys(catalog).length !== Object.keys(base).length) throw new Error(`${language.locale}: translation key count differs`);
  for (const [key, source] of Object.entries(base)) {
    if (typeof catalog[key] !== 'string' || !catalog[key].trim()) throw new Error(`${language.locale}: missing ${key}`);
    if (placeholders(source) !== placeholders(catalog[key])) throw new Error(`${language.locale}: mismatched placeholders in ${key}`);
    if (language.locale !== 'ko' && /[가-힣]/.test(catalog[key])) throw new Error(`${language.locale}: untranslated Korean in ${key}`);
  }
  for (const key of Object.keys(catalog)) if (!Object.hasOwn(base, key)) throw new Error(`${language.locale}: unknown ${key}`);
  catalogs.set(language.locale, catalog);
}
const pkg = read('package.json');
pkg.contributes.configuration = configurationManifest(languages);
write('package.json', pkg);
const manifestKeys = [...new Set(JSON.stringify(pkg).match(/%[\w.]+%/g))].map(token => token.slice(1, -1));
for (const language of languages) {
  const catalog = catalogs.get(language.locale);
  const manifest = Object.fromEntries(manifestKeys.map(key => {
    if (!Object.hasOwn(catalog, key)) throw new Error(`Unknown manifest key: ${key}`);
    return [key, catalog[key]];
  }));
  for (const alias of new Set([language.locale, ...language.vscodeLocales])) write(`localization/package.nls.${alias}.json`, manifest);
  // VS Code treats the base manifest catalog as the default (English) UI.
  // Runtime strings still use the Korean source catalog and fallback.
  if (language.locale === 'en') write('localization/package.nls.json', manifest);
}
function files(dir) {
  return fs.readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap(item => item.isDirectory()
    ? files(`${dir}/${item.name}`) : [`${dir}/${item.name}`]);
}
/**
 * 책임: 실행 코드와 HTML의 번역 사용이 사전과 일치하는지 확인한다.
 * 알고리즘: TypeScript AST로 UI 문자열·t 호출·QuotaError의 키와 인자를 검사하고 HTML의 data-i18n 참조도 사전에 대조한다.
 */
for (const file of [...files('src'), ...files('media')].filter(file => /\.(ts|js)$/.test(file) && !file.includes('localization/') && !file.endsWith('i18next.js'))) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function validateUsage(key, variables) {
    if (!Object.hasOwn(base, key)) throw new Error(`${file}: unknown translation key ${key}`);
    if (variables && !ts.isObjectLiteralExpression(variables)) return;
    const names = variables ? variables.properties.map(property => property.name?.getText(tree)).sort().join(',') : '';
    const expected = placeholders(base[key]).replace(/[{}]/g, '');
    if (names !== expected) throw new Error(`${file}: mismatched arguments for ${key}`);
  }
  function validateQuotaErrorUsage(node) {
    if (!(ts.isNewExpression(node) && node.expression.getText(tree) === 'QuotaError' && node.arguments?.[1]
      && ts.isObjectLiteralExpression(node.arguments[1]))) return;
    const properties = node.arguments[1].properties;
    const key = properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'key');
    const values = properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'values');
    if (!key || !ts.isStringLiteral(key.initializer)) return;
    validateUsage(key.initializer.text, values?.initializer);
  }
  /**
   * 책임: 소스 안의 번역 호출과 UI 문자열을 구문 단위로 검사한다.
   * 알고리즘: AST를 재귀 순회해 문자열의 미이관 한글을 찾고 t·QuotaError의 리터럴 키와 치환 인자를 원문 사전과 대조한다.
   */
  function walk(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && /[가-힣]/.test(node.text) && !file.startsWith('src/summary/db/')) {
      throw new Error(`${file}: move UI text to the Korean catalog`);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const key = node.arguments[0].text;
      validateUsage(key, node.arguments[1]);
    }
    validateQuotaErrorUsage(node);
    ts.forEachChild(node, walk);
  }
  walk(tree);
  for (const match of source.matchAll(/data-i18n(?:-(?:aria-label|title|placeholder))?="([\w.]+)"/g)) {
    if (!Object.hasOwn(base, match[1])) throw new Error(`${file}: unknown HTML translation key ${match[1]}`);
  }
}
if (!check) {
  const vendor = path.dirname(require.resolve('i18next/package.json'));
  fs.rmSync(path.join(root, 'dist/src/localization/locales'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'dist/src/localization/languages.json'), { force: true });
  fs.mkdirSync(path.join(root, 'dist/src/localization'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/localization/locales'), { recursive: true });
  fs.copyFileSync(path.join(vendor, 'dist/cjs/i18next.js'), path.join(root, 'dist/src/localization/i18next.cjs'));
  fs.copyFileSync(path.join(vendor, 'dist/umd/i18next.min.js'), path.join(root, 'media/i18next.js'));
  fs.copyFileSync(path.join(vendor, 'LICENSE'), path.join(root, 'media/i18next.LICENSE.txt'));
  for (const language of languages) fs.copyFileSync(path.join(root, `localization/locales/${language.locale}.json`),
    path.join(root, `dist/localization/locales/${language.locale}.json`));
}
console.log(`Localization ${check ? 'checked' : 'generated'}: ${languages.length} languages, ${Object.keys(base).length} keys.`);
