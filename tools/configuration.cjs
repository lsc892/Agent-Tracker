// 공통 TypeScript 설정 정의로 VS Code manifest의 설정 항목을 생성한다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/**
 * 책임: 공통 TypeScript 설정 정의로 VS Code manifest를 생성한다.
 * 알고리즘: tsc 실행 전 import 없는 schema만 메모리에서 변환·평가하고 공통 트리를 순회해 언어 선택지와 category별 정렬 속성을 만든다.
 */
function configurationManifest(languages) {
  const filename = path.join(__dirname, '../src/configuration/schema.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInThisContext(`(function(exports) { ${compiled.outputText}\n})`, { filename })(exports);
  const { settingCategories, settingDefinitions, mapSettings } = exports;
  const sections = Object.fromEntries(Object.entries(settingCategories).map(([category, metadata]) =>
    [category, { id: `agentTracker.${category}`, ...metadata, properties: {} }]));
  mapSettings(settingDefinitions, (definition, key) => {
    const { category, enumSource, ...property } = definition;
    if (enumSource === 'languages') {
      property.enum = [definition.default, ...languages.map(language => language.locale)];
      property.enumItemLabels = ['%manifest.languageAuto%', ...languages.map(language => language.label)];
    }
    sections[category].properties[`agentTracker.${key}`] = property;
  });
  for (const section of Object.values(sections)) {
    section.properties = Object.fromEntries(Object.entries(section.properties)
      .sort(([, left], [, right]) => (left.order ?? 0) - (right.order ?? 0)));
  }
  return Object.values(sections);
}

module.exports = { configurationManifest };
